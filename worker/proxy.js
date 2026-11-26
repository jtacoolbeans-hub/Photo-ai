/**
 * Card-reader proxy — a Cloudflare Worker.
 *
 * WHAT IT DOES (plain language):
 *   Your phone sends a photo to this Worker. The Worker adds your secret
 *   Gemini API key (which lives ONLY inside Cloudflare, never in GitHub),
 *   asks Gemini to read the photo, and sends the text back to your phone.
 *
 * SETTINGS YOU ADD IN THE CLOUDFLARE DASHBOARD (not in this file):
 *   GEMINI_API_KEY  (Secret)  your key from Google AI Studio
 *   APP_TOKEN       (Secret)  a long password you make up; the phone app must
 *                             send it, so strangers can't spend your Gemini credit
 *   ALLOWED_ORIGIN  (Text)    e.g. https://jtacoolbeans-hub.github.io
 *                             (comma-separate several; leave empty to allow any)
 *   GEMINI_MODEL    (Text, optional) default model, e.g. gemini-flash-latest
 *   GROQ_API_KEY    (Secret, optional) your key from console.groq.com. When it is set, Groq reads the
 *                             card FIRST and Gemini is only the fallback (Groq busy, failed or timed out).
 *   GROQ_MODEL      (Text, optional) Groq vision model(s), comma-separated, best first
 *
 * API:
 *   GET  /   -> health check: { ok, hasKey, hasToken, tokenOk }
 *   POST /   -> body JSON:
 *     { image: "<base64 or data: URL>", mimeType: "image/jpeg",
 *       prompt: "...", models?: ["first-choice", "backup"], generationConfig?: {...},
 *       timeoutMs?: 15000 }
 *     Tries each model in turn if one is busy or fails. If a model rejects the
 *     optional settings ("invalid argument"), it retries with basic settings.
 *     returns { text, model, finishReason, geminiMs, usage, attempts }
 *     answerers?: ["groq", "gemini"]  who to ask, in order (default: Groq first if GROQ_API_KEY is set, then Gemini)
 *     groqModels?: ["meta-llama/llama-4-scout-17b-16e-instruct"]
 *   POST / with { tts: "words to say", voice?: "Kore", model?: "...", stream?: true }
 *     stream: true -> raw 16-bit PCM (audio/L16) sent piece by piece as Gemini makes it,
 *     so the phone can start playing almost at once. Falls back to a whole WAV file.
 *     -> an audio/wav file of Gemini reading the words (the app plays it like music,
 *        which works even when the iPhone's silent switch is on).
 *   GEMINI_TTS_MODEL (Text, optional) default voice model(s), comma-separated: each model has its own free quota,
 *     and when one is used up the next is tried
 *   POST / with { tts: "words", engine: "dg", dgVoice?: "aura-2-thalia-en" } -> Deepgram voice (streamed raw audio).
 *     Needs a secret named DEEPGRAM_API_KEY. New Deepgram accounts get free credit with no card.
 *   POST / with { tts: "words", engine: "cf" } -> Cloudflare Workers AI voice instead of Gemini.
 *     Needs a Workers AI binding (Worker -> Settings -> Bindings -> Add -> Workers AI). Any name works.
 *     cfModel may be one model or a comma-separated list; retired/missing models are skipped automatically.
 */

const WORKER_VERSION = 9;
const DEFAULT_GROQ_MODELS = ['meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct'];
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'gemini-flash-latest';
const DEFAULT_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
// Cloudflare Workers AI voices, best first. Models get retired from time to time, so we try them in turn,
// skip any that are gone, and remember which ones work.
const CF_TTS_MODELS = ['@cf/deepgram/aura-1', '@cf/deepgram/aura-2-en', '@cf/myshell-ai/melotts']; // cheapest first: the free allowance is only 10,000 units a day
const MAX_BODY_BYTES = 15 * 1024 * 1024; // ~15 MB of JSON (base64 photo)
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '')
      .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
    const originOk = allowed.length === 0 || allowed.includes(origin);

    const cors = {
      'Access-Control-Allow-Origin': allowed.length === 0 ? '*' : (originOk ? origin : allowed[0]),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
      'Access-Control-Max-Age': '86400',
      'Access-Control-Expose-Headers': 'X-Tts-Mode, X-Gemini-Ms, X-Cf-Model',
      'Vary': 'Origin',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const token = request.headers.get('X-App-Token') || '';
    const tokenOk = !!env.APP_TOKEN && safeEqual(token, env.APP_TOKEN);

    if (request.method === 'GET') {
      return json({
        ok: true,
        service: 'card-reader-proxy',
        version: WORKER_VERSION,
        hasKey: !!env.GEMINI_API_KEY,
        hasToken: !!env.APP_TOKEN,
        tokenOk,
        originOk,
        defaultModel: env.GEMINI_MODEL || DEFAULT_MODEL,
        tts: true,
        ai: !!getAI(env),
        dg: !!env.DEEPGRAM_API_KEY,
        groq: !!env.GROQ_API_KEY,
        groqModels: groqModelList(env, null),
      });
    }

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!originOk) return json({ error: 'Origin not allowed: ' + origin }, 403);
    if (!env.APP_TOKEN) return json({ error: 'Worker is missing the APP_TOKEN secret' }, 500);
    if (!tokenOk) return json({ error: 'Wrong or missing app token' }, 401);
    if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) return json({ error: 'Worker is missing the GEMINI_API_KEY (or GROQ_API_KEY) secret' }, 500);

    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_BODY_BYTES) return json({ error: 'Image too large' }, 413);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Body must be JSON' }, 400);
    }

    if (typeof body.tts === 'string') {
      if (body.engine === 'cf') return handleCfTts(env, body, cors, json);
      if (body.engine === 'dg') return handleDgTts(env, body, cors, json);
      return handleTts(env, body, cors, json, ctx);
    }

    let image = String(body.image || '');
    let mimeType = String(body.mimeType || 'image/jpeg');
    const m = image.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) { mimeType = m[1]; image = m[2]; }
    if (!image) return json({ error: 'No image' }, 400);
    if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) return json({ error: 'Unsupported image type' }, 400);

    const prompt = String(body.prompt || 'Transcribe all text in this image exactly.').slice(0, 4000);

    // Models to try, in order. "models" (list) wins over "model" (single).
    let models = Array.isArray(body.models) ? body.models : [body.model || env.GEMINI_MODEL || DEFAULT_MODEL];
    models = models.map((m) => String(m || '').trim()).filter(Boolean).slice(0, 4);
    if (!models.length) models = [env.GEMINI_MODEL || DEFAULT_MODEL];
    for (const m of models) {
      if (!/^[a-z0-9][a-z0-9.\-]{1,63}$/i.test(m)) return json({ error: 'Bad model name: ' + m }, 400);
    }

    const generationConfig = cleanGenConfig(body.generationConfig);
    const timeoutMs = clamp(Number(body.timeoutMs) || 20000, 2000, 60000);
    const deadline = Date.now() + timeoutMs;
    const imagePart = { inline_data: { mime_type: mimeType, data: image } };

    const t0 = Date.now();
    const attempts = [];

    // Who reads the card, in order. Groq first (fast, generous free tier) when its key is set; Gemini is the fallback.
    let answerers = Array.isArray(body.answerers) ? body.answerers.map(String).filter((a) => a === 'groq' || a === 'gemini') : ['groq', 'gemini'];
    if (!answerers.length) answerers = ['groq', 'gemini'];
    if (!env.GROQ_API_KEY) answerers = answerers.filter((a) => a !== 'groq');
    if (!env.GEMINI_API_KEY) answerers = answerers.filter((a) => a !== 'gemini');
    if (!answerers.length) return json({ error: answersMissing(body.answerers) }, 500);

    if (answerers[0] === 'groq') {
      // Leave Gemini some time if it is the fallback: Groq gets at most ~60% of the time allowed.
      const groqDeadline = answerers.includes('gemini') ? t0 + Math.max(2500, timeoutMs * 0.6) : deadline;
      for (const model of groqModelList(env, body.groqModels)) {
        const remaining = Math.min(groqDeadline, deadline) - Date.now();
        if (remaining < 500) break;
        const r = await callGroq(env.GROQ_API_KEY, model, mimeType, image, prompt, generationConfig, remaining);
        attempts.push({ model: 'groq:' + model, status: r.status, ms: r.ms, error: r.error || undefined });
        if (r.ok) return json({ text: r.text, model: 'groq/' + model, engine: 'groq', finishReason: r.finishReason, geminiMs: Date.now() - t0, usage: r.usage, attempts });
        if (r.status === 401 || r.status === 403) break; // bad key: other Groq models won't help
      }
      if (!answerers.includes('gemini')) models.length = 0; // Groq only, and it failed
    }

    for (const model of (answerers.includes('gemini') ? models : [])) {
      // Try with the full settings; if Gemini says "invalid argument" (400),
      // retry once with only the basic settings (some models reject extras).
      for (const cfg of [generationConfig, basicGenConfig(generationConfig)]) {
        const remaining = deadline - Date.now();
        if (remaining < 500) break;
        const r = await callGemini(env.GEMINI_API_KEY, model, imagePart, prompt, cfg, remaining);
        attempts.push({ model, status: r.status, ms: r.ms, error: r.error || undefined, simplified: cfg !== generationConfig || undefined });
        if (r.ok) {
          return json({
            text: r.text,
            model,
            finishReason: r.finishReason,
            blockReason: r.blockReason,
            geminiMs: Date.now() - t0,
            usage: r.usage,
            attempts,
          });
        }
        if (r.status === 400 && cfg === generationConfig && JSON.stringify(cfg) !== JSON.stringify(basicGenConfig(cfg))) continue;
        break; // busy / timeout / other error -> next model
      }
      if (deadline - Date.now() < 500) break;
    }

    const last = attempts[attempts.length - 1] || {};
    const timedOut = last.status === 504;
    return json({
      error: last.error || 'No model answered',
      status: last.status || 0,
      geminiMs: Date.now() - t0,
      attempts,
    }, timedOut ? 504 : 502);
  },
};

function answersMissing(asked) {
  return Array.isArray(asked) && asked.length === 1 && asked[0] === 'groq'
    ? 'Groq is not set up: add a secret named GROQ_API_KEY to this Worker' : 'Worker is missing the GEMINI_API_KEY secret';
}
function groqModelList(env, asked) {
  const list = Array.isArray(asked) && asked.length ? asked : String(env.GROQ_MODEL || '').split(',');
  const out = list.map((m) => String(m || '').trim()).filter((m) => /^[a-z0-9][a-z0-9.\-_\/]{1,100}$/i.test(m)).slice(0, 3);
  return out.length ? out : DEFAULT_GROQ_MODELS;
}
// Groq (OpenAI-style chat API) with the photo attached. Groq accepts base64 photos up to 4 MB.
async function callGroq(key, model, mimeType, image, prompt, generationConfig, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + image } },
        ] }],
        temperature: generationConfig.temperature || 0,
        max_completion_tokens: Math.min(8192, generationConfig.maxOutputTokens || 1024),
      }),
    });
    const data = await res.json().catch(() => ({}));
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, status: res.status, error: 'Groq: ' + ((data.error && data.error.message) || 'HTTP ' + res.status), ms };
    const ch = (data.choices || [])[0] || {};
    const text = String((ch.message && ch.message.content) || '').trim();
    if (!text) return { ok: false, status: 502, error: 'Groq: empty reply', ms };
    return { ok: true, status: 200, ms, text, finishReason: ch.finish_reason || null, usage: data.usage || null };
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    return { ok: false, status: timedOut ? 504 : 0, error: timedOut ? 'Groq timed out' : 'Could not reach Groq', ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

// Text -> speech with Cloudflare Workers AI (no Google quota; uses the account's free daily allowance).
// The Workers AI binding, whatever name it was given in the dashboard (AI, Voice, …).
function getAI(env) {
  if (env.AI && typeof env.AI.run === 'function') return env.AI;
  for (const v of Object.values(env || {})) if (v && typeof v === 'object' && typeof v.run === 'function') return v;
  return null;
}
const cfBad = new Map(); // model -> when it was found retired/missing (remembered for a while in this Worker)
const CF_GONE = /deprecat|retired|no such model|not found|unknown model|does not exist|\b50(28|07|06)\b/i;
async function cfBytes(out) {
  if (out && typeof out.getReader === 'function') return new Uint8Array(await new Response(out).arrayBuffer());
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (out instanceof Uint8Array) return out;
  if (out && typeof out.audio === 'string') return b64ToBytes(out.audio);
  return null;
}
// One model, with the input shape its family expects. Returns audio bytes or throws.
async function cfTry(AI, model, text, voice) {
  const aura = /aura|deepgram/i.test(model);
  const inputs = aura
    ? [{ text, speaker: voice, encoding: 'mp3' }, { text, encoding: 'mp3' }]  // second: without the speaker, in case that name isn't valid for this model
    : [{ prompt: text, lang: 'en' }, { text }];
  let lastErr;
  for (let i = 0; i < inputs.length; i++) {
    if (aura && i === 1 && !voice) break;
    try {
      const bytes = await cfBytes(await AI.run(model, inputs[i]));
      if (bytes && bytes.length >= 100) return bytes;
      lastErr = new Error('returned no audio');
    } catch (e) {
      lastErr = e;
      if (CF_GONE.test((e && e.message) || '')) break; // the model itself is gone: other input shapes won't help
    }
  }
  throw lastErr || new Error('failed');
}
// If every known model is gone, ask Cloudflare which text-to-speech models exist now (if the binding can tell us).
async function cfDiscover(AI) {
  try {
    if (typeof AI.models !== 'function') return [];
    const res = await AI.models({ search: 'tts' });
    const arr = Array.isArray(res) ? res : (res && (res.result || res.models)) || [];
    return arr.map((m) => String(m.name || m.id || m || '')).filter((n) => /^@cf\/[\w.\-\/]{3,80}$/.test(n) && /tts|aura|melo|speech|voice/i.test(n)).slice(0, 6);
  } catch { return []; }
}
async function handleCfTts(env, body, cors, json) {
  const AI = getAI(env);
  if (!AI) return json({ error: 'Cloudflare voice is not connected: add a Workers AI binding to this Worker' }, 501);
  const text = String(body.tts).trim().slice(0, 2000);
  if (!text) return json({ error: 'No text to speak' }, 400);
  const voice = /^[a-z\-]{2,30}$/.test(String(body.cfVoice || '')) ? String(body.cfVoice) : 'luna';
  const wanted = String(body.cfModel || '').split(',').map((m) => m.trim()).filter((m) => /^@cf\/[\w.\-\/]{3,80}$/.test(m));
  const t0 = Date.now(), errs = [], tried = new Set();
  const attempt = async (model) => {
    if (tried.has(model)) return null;
    tried.add(model);
    if (cfBad.has(model) && Date.now() - cfBad.get(model) < 15 * 60 * 1000) { errs.push(model + ': retired (skipped)'); return null; }
    try {
      const bytes = await cfTry(AI, model, text, voice);
      const ct = (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46) ? 'audio/wav' : 'audio/mpeg';
      return new Response(bytes, { headers: { ...cors, 'Content-Type': ct, 'Cache-Control': 'no-store', 'X-Tts-Mode': 'file', 'X-Cf-Model': model, 'X-Gemini-Ms': String(Date.now() - t0) } });
    } catch (e) {
      const msg = ((e && e.message) || String(e)).slice(0, 140);
      errs.push(model + ': ' + msg);
      if (CF_GONE.test(msg)) cfBad.set(model, Date.now());
      return null;
    }
  };
  for (const m of [...wanted, ...CF_TTS_MODELS]) { const r = await attempt(m); if (r) return r; }
  for (const m of await cfDiscover(AI)) { const r = await attempt(m); if (r) return r; }
  return json({ error: 'Cloudflare voice: no model worked — ' + errs.join(' | ') }, 502);
}

// Text -> speech with Gemini, returned as a WAV file. "model" may be a comma-separated list: each Gemini model has its
// own free quota, so when one is used up (or doesn't exist) the next is tried.
async function handleTts(env, body, cors, json, ctx) {
  const text = String(body.tts).trim().slice(0, 3000);
  if (!text) return json({ error: 'No text to speak' }, 400);
  const models = String(body.model || env.GEMINI_TTS_MODEL || DEFAULT_TTS_MODEL).split(',').map((m) => m.trim()).filter(Boolean).slice(0, 4);
  for (const m of models) if (!/^[a-z0-9][a-z0-9.\-]{1,63}$/i.test(m)) return json({ error: 'Bad voice model name' }, 400);
  const voice = /^[A-Za-z]{2,24}$/.test(String(body.voice || '')) ? String(body.voice) : 'Kore';
  const payload = {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  };
  const errs = []; let last = null;
  for (const model of models) {
    if (body.stream) {
      const streamed = await ttsStream(env, model, payload, cors, ctx);
      if (streamed) return streamed; // otherwise fall through to a whole file
    }
    const r = await ttsFile(env, model, payload, cors);
    if (r.ok) return r.response;
    errs.push(model + ': ' + r.error); last = r;
    if (!(r.status === 429 || r.status === 404 || /quota|exceeded|not found|RESOURCE_EXHAUSTED/i.test(r.error))) break; // only quota / missing models are worth another model
  }
  return json({ error: models.length > 1 ? errs.join(' | ') : last.error }, last && last.status === 504 ? 504 : 502);
}
async function ttsFile(env, model, payload, cors) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  const t0 = Date.now();
  let res, data;
  try {
    res = await fetch(GEMINI_BASE + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(payload), signal: ctrl.signal,
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, status: 504, error: e && e.name === 'AbortError' ? 'Gemini voice timed out' : 'Could not reach Gemini' };
  } finally { clearTimeout(timer); }
  if (!res.ok) return { ok: false, status: res.status, error: (data && data.error && data.error.message) || ('Gemini HTTP ' + res.status) };
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  const part = parts.find((p) => p.inlineData || p.inline_data);
  const inl = part && (part.inlineData || part.inline_data);
  if (!inl || !inl.data) return { ok: false, status: 502, error: 'Gemini returned no audio' };
  const mime = String(inl.mimeType || inl.mime_type || '');
  const bytes = b64ToBytes(inl.data);
  const rate = +((/rate=(\d+)/.exec(mime) || [])[1] || 24000);
  const wav = /wav/i.test(mime) ? bytes : pcmToWav(bytes, rate);
  return { ok: true, response: new Response(wav, { headers: { ...cors, 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Tts-Mode': 'file', 'X-Cf-Model': model, 'X-Gemini-Ms': String(Date.now() - t0) } }) };
}
// Deepgram voice (Aura): very fast, streamed as raw 16-bit audio. New Deepgram accounts come with free credit.
async function handleDgTts(env, body, cors, json) {
  if (!env.DEEPGRAM_API_KEY) return json({ error: 'Deepgram voice is not set up: add a secret named DEEPGRAM_API_KEY to this Worker' }, 501);
  const text = String(body.tts).trim().slice(0, 2000);
  if (!text) return json({ error: 'No text to speak' }, 400);
  const model = /^aura(-2)?-[a-z0-9\-]{2,30}$/i.test(String(body.dgVoice || '')) ? String(body.dgVoice) : 'aura-2-thalia-en';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch('https://api.deepgram.com/v1/speak?model=' + encodeURIComponent(model) + '&encoding=linear16&container=none&sample_rate=24000', {
      method: 'POST',
      headers: { 'Authorization': 'Token ' + env.DEEPGRAM_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }), signal: ctrl.signal,
    });
  } catch (e) { clearTimeout(timer); return json({ error: e && e.name === 'AbortError' ? 'Deepgram timed out' : 'Could not reach Deepgram' }, 504); }
  clearTimeout(timer); // we have the headers; the audio then streams straight through
  if (!res.ok || !res.body) {
    let msg = ''; try { msg = await res.text(); } catch {}
    try { const j = JSON.parse(msg); msg = j.err_msg || j.error || j.message || msg; } catch {}
    return json({ error: 'Deepgram voice failed (HTTP ' + res.status + '): ' + String(msg || res.statusText).slice(0, 200) }, 502);
  }
  return new Response(res.body, { headers: { ...cors, 'Content-Type': 'audio/L16;rate=24000', 'Cache-Control': 'no-store', 'X-Tts-Mode': 'stream', 'X-Cf-Model': model } });
}
// Streaming voice: ask Gemini for its "server-sent events" stream and pass each audio piece straight on.
// Returns null (so the caller makes a whole file instead) if streaming isn't available or gives no audio.
async function ttsStream(env, model, payload, cors, ctx) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch(GEMINI_BASE + encodeURIComponent(model) + ':streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(payload), signal: ctrl.signal,
    });
  } catch { clearTimeout(timer); return null; }
  if (!res.ok || !res.body) { clearTimeout(timer); try { await res.text(); } catch {} return null; }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', rate = 24000;
  const parseEvent = (ev) => {
    const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data) return [];
    let j; try { j = JSON.parse(data); } catch { return []; }
    const out = [];
    for (const c of (j.candidates || [])) for (const p of ((c.content || {}).parts || [])) {
      const inl = p.inlineData || p.inline_data;
      if (inl && inl.data) {
        const m = /rate=(\d+)/.exec(String(inl.mimeType || inl.mime_type || '')); if (m) rate = +m[1];
        out.push(b64ToBytes(inl.data));
      }
    }
    return out;
  };
  const nextAudio = async () => { // the audio pieces from the next event(s); null when the stream ends
    for (;;) {
      const m = /\r?\n\r?\n/.exec(buf);
      if (m) { const ev = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length); const out = parseEvent(ev); if (out.length) return out; continue; }
      const { done, value } = await reader.read();
      if (done) { const out = buf.trim() ? parseEvent(buf) : []; buf = ''; return out.length ? out : null; }
      buf += dec.decode(value, { stream: true });
    }
  };
  let first = null;
  try { first = await nextAudio(); } catch {}
  if (!first) { clearTimeout(timer); try { reader.cancel(); } catch {} return null; }
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const pump = (async () => {
    try {
      for (const b of first) await w.write(b);
      let more;
      while ((more = await nextAudio())) for (const b of more) await w.write(b);
    } catch {} finally { clearTimeout(timer); try { await w.close(); } catch {} }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(pump);
  return new Response(readable, { headers: { ...cors, 'Content-Type': 'audio/L16;rate=' + rate, 'Cache-Control': 'no-store', 'X-Tts-Mode': 'stream' } });
}
function b64ToBytes(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function pcmToWav(pcm, rate) { // 16-bit mono PCM -> WAV
  const buf = new ArrayBuffer(44 + pcm.length), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.length, true);
  new Uint8Array(buf, 44).set(pcm);
  return buf;
}

async function callGemini(key, model, imagePart, prompt, generationConfig, timeoutMs) {
  const payload = {
    contents: [{ role: 'user', parts: [imagePart, { text: prompt }] }],
    generationConfig,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(GEMINI_BASE + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    const ms = Date.now() - t0;
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || ('Gemini HTTP ' + res.status);
      return { ok: false, status: res.status, error: msg, ms };
    }
    const cand = (data.candidates || [])[0] || {};
    const parts = (cand.content && cand.content.parts) || [];
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
    return {
      ok: true, status: 200, ms, text,
      finishReason: cand.finishReason || null,
      blockReason: (data.promptFeedback && data.promptFeedback.blockReason) || null,
      usage: data.usageMetadata || null,
    };
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    return { ok: false, status: timedOut ? 504 : 0, error: timedOut ? 'Gemini timed out' : 'Could not reach Gemini', ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

function basicGenConfig(cfg) {
  return { temperature: cfg.temperature, maxOutputTokens: cfg.maxOutputTokens };
}

// Only pass through settings we understand, so the app can't send anything odd.
function cleanGenConfig(gc) {
  const out = { temperature: 0, maxOutputTokens: 400 };
  if (!gc || typeof gc !== 'object') return out;
  if (typeof gc.temperature === 'number') out.temperature = clamp(gc.temperature, 0, 2);
  if (typeof gc.maxOutputTokens === 'number') out.maxOutputTokens = clamp(Math.round(gc.maxOutputTokens), 16, 4096);
  if (typeof gc.mediaResolution === 'string' && /^MEDIA_RESOLUTION_[A-Z]+$/.test(gc.mediaResolution)) {
    out.mediaResolution = gc.mediaResolution;
  }
  if (gc.thinkingConfig && typeof gc.thinkingConfig === 'object') {
    const tc = {};
    if (typeof gc.thinkingConfig.thinkingBudget === 'number') tc.thinkingBudget = Math.round(gc.thinkingConfig.thinkingBudget);
    if (typeof gc.thinkingConfig.thinkingLevel === 'string' && /^[a-z]+$/i.test(gc.thinkingConfig.thinkingLevel)) {
      tc.thinkingLevel = gc.thinkingConfig.thinkingLevel;
    }
    if (Object.keys(tc).length) out.thinkingConfig = tc;
  }
  return out;
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

// Compare strings without leaking how many characters matched.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
