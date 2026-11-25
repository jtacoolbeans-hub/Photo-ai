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
 *   POST / with { tts: "words to say", voice?: "Kore", model?: "..." }
 *     -> an audio/wav file of Gemini reading the words (the app plays it like music,
 *        which works even when the iPhone's silent switch is on).
 *   GEMINI_TTS_MODEL (Text, optional) default voice model, e.g. gemini-2.5-flash-preview-tts
 */

const WORKER_VERSION = 3;
const DEFAULT_MODEL = 'gemini-flash-latest';
const DEFAULT_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const MAX_BODY_BYTES = 15 * 1024 * 1024; // ~15 MB of JSON (base64 photo)
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '')
      .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
    const originOk = allowed.length === 0 || allowed.includes(origin);

    const cors = {
      'Access-Control-Allow-Origin': allowed.length === 0 ? '*' : (originOk ? origin : allowed[0]),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
      'Access-Control-Max-Age': '86400',
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
      });
    }

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!originOk) return json({ error: 'Origin not allowed: ' + origin }, 403);
    if (!env.APP_TOKEN) return json({ error: 'Worker is missing the APP_TOKEN secret' }, 500);
    if (!tokenOk) return json({ error: 'Wrong or missing app token' }, 401);
    if (!env.GEMINI_API_KEY) return json({ error: 'Worker is missing the GEMINI_API_KEY secret' }, 500);

    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_BODY_BYTES) return json({ error: 'Image too large' }, 413);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Body must be JSON' }, 400);
    }

    if (typeof body.tts === 'string') return handleTts(env, body, cors, json);

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
    for (const model of models) {
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

// Text -> speech with Gemini, returned as a WAV file.
async function handleTts(env, body, cors, json) {
  const text = String(body.tts).trim().slice(0, 3000);
  if (!text) return json({ error: 'No text to speak' }, 400);
  const model = String(body.model || env.GEMINI_TTS_MODEL || DEFAULT_TTS_MODEL);
  if (!/^[a-z0-9][a-z0-9.\-]{1,63}$/i.test(model)) return json({ error: 'Bad voice model name' }, 400);
  const voice = /^[A-Za-z]{2,24}$/.test(String(body.voice || '')) ? String(body.voice) : 'Kore';
  const payload = {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  };
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
    return json({ error: e && e.name === 'AbortError' ? 'Gemini voice timed out' : 'Could not reach Gemini' }, 504);
  } finally { clearTimeout(timer); }
  if (!res.ok) return json({ error: (data && data.error && data.error.message) || ('Gemini HTTP ' + res.status) }, 502);
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  const part = parts.find((p) => p.inlineData || p.inline_data);
  const inl = part && (part.inlineData || part.inline_data);
  if (!inl || !inl.data) return json({ error: 'Gemini returned no audio' }, 502);
  const mime = String(inl.mimeType || inl.mime_type || '');
  const bytes = b64ToBytes(inl.data);
  const rate = +((/rate=(\d+)/.exec(mime) || [])[1] || 24000);
  const wav = /wav/i.test(mime) ? bytes : pcmToWav(bytes, rate);
  return new Response(wav, { headers: { ...cors, 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Gemini-Ms': String(Date.now() - t0) } });
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
