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
 *       prompt: "...", model?: "...", generationConfig?: {...}, timeoutMs?: 15000 }
 *     returns { text, model, finishReason, geminiMs, usage }
 */

const DEFAULT_MODEL = 'gemini-flash-latest';
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
        hasKey: !!env.GEMINI_API_KEY,
        hasToken: !!env.APP_TOKEN,
        tokenOk,
        originOk,
        defaultModel: env.GEMINI_MODEL || DEFAULT_MODEL,
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

    let image = String(body.image || '');
    let mimeType = String(body.mimeType || 'image/jpeg');
    const m = image.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) { mimeType = m[1]; image = m[2]; }
    if (!image) return json({ error: 'No image' }, 400);
    if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) return json({ error: 'Unsupported image type' }, 400);

    const prompt = String(body.prompt || 'Transcribe all text in this image exactly.').slice(0, 4000);
    const model = String(body.model || env.GEMINI_MODEL || DEFAULT_MODEL);
    if (!/^[a-z0-9][a-z0-9.\-]{1,63}$/i.test(model)) return json({ error: 'Bad model name' }, 400);

    const generationConfig = cleanGenConfig(body.generationConfig);
    const timeoutMs = clamp(Number(body.timeoutMs) || 20000, 2000, 60000);

    const payload = {
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: mimeType, data: image } },
          { text: prompt },
        ],
      }],
      generationConfig,
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    let res, data;
    try {
      res = await fetch(GEMINI_BASE + encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      clearTimeout(timer);
      const timedOut = e && e.name === 'AbortError';
      return json({ error: timedOut ? 'Gemini timed out' : 'Could not reach Gemini', geminiMs: Date.now() - t0 }, 504);
    }
    clearTimeout(timer);
    const geminiMs = Date.now() - t0;

    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || ('Gemini HTTP ' + res.status);
      return json({ error: msg, status: res.status, geminiMs, model }, 502);
    }

    const cand = (data.candidates || [])[0] || {};
    const parts = (cand.content && cand.content.parts) || [];
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();

    return json({
      text,
      model,
      finishReason: cand.finishReason || null,
      blockReason: (data.promptFeedback && data.promptFeedback.blockReason) || null,
      geminiMs,
      usage: data.usageMetadata || null,
    });
  },
};

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
