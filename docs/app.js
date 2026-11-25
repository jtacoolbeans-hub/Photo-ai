/* Card Assistant — show app.
 *
 * How it works, in order:
 *   1. The camera runs all the time. A few times a second we look at a tiny grey
 *      copy of the crop area and measure MOTION (how much changed since last look).
 *   2. When ARMED and the picture has been still for a few checks, we look at a
 *      short window of frames, score each for SHARPNESS, and keep the sharpest.
 *   3. If the best one is sharp enough (so not an empty box or a blur), we send it
 *      to Gemini through your Cloudflare Worker.
 *   4. The reply "Q: … / A: …" is spoken into your earbud. "NONE" means unreadable.
 *      Slow or failed replies trigger your stall line.
 *   5. We then wait for the card to change (movement) before reading again.
 *   Every capture is logged (thumbnail, sharpness, timing, reply) for review.
 */
'use strict';

const APP_VERSION = '1.3.0';
const MIN_WORKER_VERSION = 2;

// The first version of the prompt. Phones that saved it get the new one automatically.
const OLD_PROMPT_V1 =
  'The photo shows a paper card with a printed audience question. Read the question and answer it for a ' +
  'stage performer who will hear your answer through an earbud.\n' +
  'Reply in exactly this format and nothing else:\n' +
  'Q: <the question, exactly as printed>\n' +
  'A: <a short spoken answer, one or two plain sentences, no lists, symbols or markdown>\n' +
  'If you cannot read the question with confidence, reply with just: NONE';

const PROMPT_QUESTION =
  'The photo shows a paper card with a printed question. A stage performer will hear your answer through an earbud.\n' +
  'Find the question. If more than one question is visible, use the first one, nearest the top.\n' +
  'Reply in exactly this format and nothing else:\n' +
  'Q: <the question, shortened to at most 15 words>\n' +
  'A: <the answer: one or two short sentences to be spoken aloud, plain words only, no lists, symbols or markdown>\n' +
  'Always give your best answer, even if the print is small or slightly unclear. ' +
  'Reply with just the word NONE only if no question can be read at all.';

// General-purpose: respond to whatever is on the card, not just questions.
const PROMPT_ANYTHING =
  "The photo shows a card held up during a live show. Your reply is spoken into the performer's earbud, so it must be quick and natural.\n" +
  'Whatever is on the card — a question, a word, a name, a topic, a statement, a number, a prompt or an instruction — respond to it directly ' +
  'and helpfully, like a quick-witted friend. If it asks something, answer it. If it is a topic, name or word, say something short, ' +
  'interesting or funny about it. If it is an instruction, carry it out. If several things are written, deal with the first one, nearest the top.\n' +
  'Reply in exactly this format and nothing else:\n' +
  'Q: <what the card says, in at most 12 words>\n' +
  'A: <your reply to be spoken aloud: one to three short sentences, plain words only, no lists, symbols or markdown>\n' +
  'Always give your best reply, even if the print is small or slightly unclear. ' +
  'Reply with just the word NONE only if nothing on the card can be read at all.';
const DEFAULT_PROMPT = PROMPT_ANYTHING;
const PROMPTS = { anything: PROMPT_ANYTHING, question: PROMPT_QUESTION };

// How quickly a card is read once it is placed. "Still checks" must pass, then the sharpest of N frames is sent.
const PRESETS = {
  fastest: { stillFrames: 1, windowFrames: 1, watchFps: 5, activeFps: 12 },
  fast:    { stillFrames: 2, windowFrames: 2, watchFps: 4, activeFps: 10 },
  careful: { stillFrames: 3, windowFrames: 4, watchFps: 3, activeFps: 8 },
};
const CUE_KEYS = ['start', 'ready', 'disarmed', 'captured', 'thinking', 'answer', 'failed'];

const DEFAULTS = {
  workerUrl: '', token: '',
  models: 'gemini-3.5-flash, gemini-flash-latest',
  mediaResolution: 'MEDIA_RESOLUTION_HIGH', thinking: 'minimal', maxTokens: 1024,
  prompt: DEFAULT_PROMPT, style: '',
  maxSide: 2048, jpegQuality: 85,
  timeoutSec: 8, stallLine: 'Great question. Give me just a second with that one.',
  lateAnswer: true, lateSec: 15, retryNone: 1,
  voiceURI: '', rate: 1.0, toneVol: 0.3, speakQuestion: false, thinkTicks: true,
  btnSingle: 'toggle', btnDouble: 'capture', btnTriple: 'repeat', autoArm: false, keyboard: true,
  camId: '', res: '1920x1440', camFps: 15, zoom: null, torch: false,
  useCrop: true, crop: { x: 0.1, y: 0.15, w: 0.8, h: 0.7 },
  motionThresh: 4, sharpMin: 60, changeThresh: 10, cooldownSec: 4,
  idleFps: 1, ...PRESETS.fast,
};
for (const k of CUE_KEYS) DEFAULTS['cue_' + k] = 'tone';

// ---------------------------------------------------------------- settings
const LS_KEY = 'cardAssistant.settings.v1';
const SETTINGS_VER = 3;
let S = loadSettings();
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch {}
  if ((saved.v || 1) < SETTINGS_VER) {
    // Older versions saved every default as if you had chosen it. Drop anything still equal to an OLD
    // default so the improved defaults apply. Values you really changed are kept.
    if ((saved.v || 1) < 2) {
      const old = { thinking: '', res: 'max', stillFrames: 3, windowFrames: 4, watchFps: 3, activeFps: 8 };
      for (const k in old) if (saved[k] === old[k]) delete saved[k];
    }
    if (saved.prompt === OLD_PROMPT_V1 || saved.prompt === PROMPT_QUESTION) delete saved.prompt;
    saved.v = SETTINGS_VER;
    try { localStorage.setItem(LS_KEY, JSON.stringify(saved)); } catch {}
  }
  return { ...DEFAULTS, ...saved, v: SETTINGS_VER, crop: { ...DEFAULTS.crop, ...(saved.crop || {}) } };
}
function saveSettings() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch {} }

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bindSettings() {
  document.querySelectorAll('[data-k]').forEach((el) => {
    const k = el.dataset.k;
    const v = S[k];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v;
    el.addEventListener('change', () => {
      let nv;
      if (el.type === 'checkbox') nv = el.checked;
      else if (el.type === 'number') { nv = parseFloat(el.value); if (isNaN(nv)) { nv = DEFAULTS[k]; el.value = nv; } }
      else nv = el.value;
      S[k] = nv; saveSettings(); onSettingChanged(k); syncPreset();
    });
  });
}
function onSettingChanged(k) {
  if (k === 'camId' || k === 'res' || k === 'camFps') { safeMode = false; if (running) startCamera().catch((e) => { camNote = 'Camera error: ' + e.message; setSub(); }); }
  if (k === 'torch') applyTorch();
  if (k === 'useCrop') drawCropBox();
}

// ---------------------------------------------------------------- capture log (IndexedDB)
const DB_NAME = 'cardAssistantLog', STORE = 'captures', MAX_LOG = 400;
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function logCapture(entry) {
  try {
    const d = await db();
    await new Promise((res, rej) => {
      const tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).add(entry);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    // keep the log from growing forever
    const tx = d.transaction(STORE, 'readwrite'), st = tx.objectStore(STORE);
    const cr = st.count();
    cr.onsuccess = () => {
      let extra = cr.result - MAX_LOG;
      if (extra <= 0) return;
      st.openCursor().onsuccess = (e) => { const c = e.target.result; if (c && extra-- > 0) { c.delete(); c.continue(); } };
    };
  } catch (e) { console.warn('log failed', e); }
}

// ---------------------------------------------------------------- sounds
let actx = null;
const TONES = {
  start:    [[523, .07], [659, .07], [784, .12]],
  ready:    [[660, .08], [880, .14]],
  disarmed: [[880, .08], [523, .16]],
  captured: [[1320, .05]],
  thinking: [[440, .05]],
  answer:   [[784, .07], [1047, .12]],
  failed:   [[311, .14], [0, .06], [233, .22]],
};
function audioCtx() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state !== 'running') actx.resume().catch(() => {});
  return actx;
}
const CUES = [['start', 'App started'], ['ready', 'Armed'], ['disarmed', 'Disarmed'], ['captured', 'Card captured'],
              ['thinking', 'Waiting for Gemini (tick)'], ['answer', 'Answer coming'], ['failed', 'Failed / stall line']];
// iPhone Safari has no web vibration. Where a browser does (e.g. Android), "Vibrate" cues work.
const CAN_VIBRATE = typeof navigator.vibrate === 'function';
const VIBES = { start: [80], ready: [40, 40, 40], disarmed: [120], captured: [30], thinking: [15], answer: [60, 40, 60], failed: [200, 80, 200] };
function tone(name) {
  let mode = S['cue_' + name] || 'tone';
  if (!CAN_VIBRATE && (mode === 'vibrate' || mode === 'both')) mode = 'tone';
  if (CAN_VIBRATE && (mode === 'vibrate' || mode === 'both')) { try { navigator.vibrate(VIBES[name] || [50]); } catch {} }
  const seq = TONES[name];
  if (mode === 'off' || mode === 'vibrate' || !seq || !(S.toneVol > 0)) return Promise.resolve();
  let total = 0;
  try {
    const c = audioCtx(); let t = c.currentTime + 0.02;
    for (const [f, d] of seq) {
      if (f > 0) {
        const o = c.createOscillator(), g = c.createGain();
        o.type = name === 'failed' ? 'triangle' : 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(Math.max(0.001, S.toneVol), t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g).connect(c.destination); o.start(t); o.stop(t + d + 0.02);
      }
      t += d + 0.03; total += d + 0.03;
    }
  } catch {}
  return sleep(total * 1000 + 30);
}

// ---------------------------------------------------------------- speech
let speaking = false, speechChain = Promise.resolve();
function speak(text) {
  text = String(text || '').replace(/[*_#`>]/g, '').trim();
  if (!text) return Promise.resolve();
  speechChain = speechChain.then(() => new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = speechSynthesis.getVoices().find((x) => x.voiceURI === S.voiceURI);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = S.rate || 1;
    let done = false;
    const finish = () => { if (done) return; done = true; speaking = false; clearTimeout(guard); setSub(); resolve(); };
    // iOS sometimes never fires "end"; don't let that freeze the app
    const guard = setTimeout(() => { speechSynthesis.cancel(); finish(); }, 4000 + text.length * 120 / (S.rate || 1));
    u.onend = finish; u.onerror = finish;
    speaking = true; setSub();
    speechSynthesis.speak(u);
  }));
  return speechChain;
}
function loadVoices() {
  const sel = $('voiceSel'), vs = speechSynthesis.getVoices();
  if (!vs.length) return;
  sel.innerHTML = '<option value="">System default</option>';
  vs.filter((v) => /^en/i.test(v.lang)).concat(vs.filter((v) => !/^en/i.test(v.lang))).forEach((v) => {
    const o = document.createElement('option'); o.value = v.voiceURI; o.textContent = v.name + ' (' + v.lang + ')';
    sel.appendChild(o);
  });
  sel.value = S.voiceURI || '';
}

// ---------------------------------------------------------------- earbud buttons (Media Session)
// iOS only sends earbud button presses to a page that is "playing" audio, so we
// loop an inaudible sound file and listen for play/pause/next/previous.
let keepAlive = null, lastCmdAt = 0;
function silentWavUrl(sec = 4) {
  const rate = 8000, n = rate * sec, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i % 2 ? 1 : -1, true); // ~-90 dB: inaudible
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function setupMediaSession() {
  if (!keepAlive) {
    keepAlive = new Audio(silentWavUrl());
    keepAlive.loop = true;
    keepAlive.addEventListener('pause', () => { if (running) setTimeout(() => keepAlive.play().catch(() => {}), 300); });
  }
  keepAlive.play().catch(() => {});
  const ms = navigator.mediaSession;
  if (!ms) { $('mediaInfo').textContent = 'This browser does not support earbud buttons (Media Session).'; return; }
  try { ms.metadata = new MediaMetadata({ title: 'Card Assistant', artist: 'Ready' }); } catch {}
  const set = (action, press) => { try { ms.setActionHandler(action, () => earbud(press)); } catch {} };
  set('play', 'single'); set('pause', 'single');
  set('nexttrack', 'double'); set('previoustrack', 'triple');
  try { ms.playbackState = 'playing'; } catch {}
  $('mediaInfo').textContent = 'Earbud buttons active.';
}
function earbud(press) {
  const now = Date.now();
  if (now - lastCmdAt < 400) return; // ignore bounces
  lastCmdAt = now;
  if (keepAlive) keepAlive.play().catch(() => {});
  try { navigator.mediaSession.playbackState = 'playing'; } catch {}
  const action = { single: S.btnSingle, double: S.btnDouble, triple: S.btnTriple }[press];
  doAction(action, 'earbud-' + press);
}
function doAction(action, source) {
  if (!running) return;
  if (action === 'toggle') setArmed(!armed);
  else if (action === 'capture') forceCapture(source);
  else if (action === 'repeat') repeatLast();
}

// ---------------------------------------------------------------- wake lock
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; setSub(); });
    }
  } catch { wakeLock = null; }
  setSub();
}

// ---------------------------------------------------------------- camera
let stream = null, track = null;
let video = $('video');
let lastFrameAt = performance.now(), lastCT = 0, lastCTAt = performance.now(), blackSince = 0, mutedSince = 0;
let camBusy = false, restarting = false, lastRestartAt = 0, camRestarts = 0, camNote = '', safeMode = false;
const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

// A brand-new <video> element every time avoids iOS cases where the old one stays frozen or black.
function freshVideoElement() {
  const old = video, v = document.createElement('video');
  v.id = 'video'; v.setAttribute('playsinline', ''); v.playsInline = true; v.muted = true; v.autoplay = true;
  old.parentNode.replaceChild(v, old);
  video = v;
  if (hasRVFC) { // fires once per new picture; if it stops, the feed is frozen
    const cb = () => { if (video !== v) return; lastFrameAt = performance.now(); v.requestVideoFrameCallback(cb); };
    v.requestVideoFrameCallback(cb);
  }
  return v;
}

async function startCamera() {
  if (camBusy) throw new Error('camera is busy');
  camBusy = true;
  try { await openCamera(); } finally { camBusy = false; }
}
async function openCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; track = null;
  await sleep(200); // give iOS a moment to release the camera
  let v;
  if (safeMode) v = { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } };
  else {
    const [W, H] = S.res === 'max' ? [4032, 3024] : S.res.split('x').map(Number);
    v = { width: { ideal: W }, height: { ideal: H }, frameRate: { ideal: +S.camFps || 15 } };
    if (S.camId) v.deviceId = { exact: S.camId }; else v.facingMode = { ideal: 'environment' };
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: v });
  } catch (e) {
    if (S.camId && !safeMode) { S.camId = ''; saveSettings(); return openCamera(); } // saved camera gone: fall back
    throw e;
  }
  const t = track = stream.getVideoTracks()[0];
  t.addEventListener('ended', () => { if (t === track && running && !restarting && !camBusy) restartCamera('camera stopped'); });
  const vid = freshVideoElement();
  vid.srcObject = stream;
  lastFrameAt = lastCTAt = performance.now(); lastCT = 0; blackSince = 0; mutedSince = 0;
  await vid.play().catch(() => {});
  const caps = t.getCapabilities ? t.getCapabilities() : {};
  if (!safeMode && S.res === 'max' && caps.width && caps.height) {
    try { await t.applyConstraints({ width: { ideal: caps.width.max }, height: { ideal: caps.height.max }, frameRate: { ideal: +S.camFps || 15 } }); } catch {}
  }
  for (let i = 0; i < 30 && !vid.videoWidth; i++) await sleep(100);
  setupCamControls(caps);
  listCameras();
  prevGrey = null;
  $('camInfo').textContent = (t.label || 'Camera') + ' · ' + vid.videoWidth + '×' + vid.videoHeight + (safeMode ? ' · safe mode' : '');
}

// Tries again if the camera froze, went black, was stopped, or iOS muted it.
// After a quick second failure it falls back to a plain 720p picture.
async function restartCamera(reason) {
  if (restarting || camBusy || !running) return;
  if (reason === 'picture black' && Date.now() - lastRestartAt < 20000) return;
  restarting = true;
  const quick = reason !== 'manual' && Date.now() - lastRestartAt < 30000;
  lastRestartAt = Date.now(); camRestarts++;
  camNote = 'Restarting camera (' + reason + ')…'; setSub();
  logCapture({ t: Date.now(), trigger: 'watchdog', status: 'camera', reply: 'Camera restarted: ' + reason, error: '', latencyMs: 0 });
  for (const safe of (quick ? [true] : [false, false, true])) {
    safeMode = safe;
    try {
      await startCamera();
      camNote = safe ? 'Camera in safe mode (720p)' : '';
      prevGrey = null; stillCount = 0; restarting = false; lastRestartAt = Date.now(); setSub();
      return;
    } catch (e) { camNote = 'Camera error: ' + e.message; setSub(); await sleep(1500); }
  }
  restarting = false; camNote = 'Camera failed — tap the Camera ↻ button'; setSub(); tone('failed');
}

// Watchdog: runs on its own timer, separate from the capture loop.
setInterval(() => {
  if (!running || restarting || camBusy || document.hidden) return;
  const now = performance.now();
  if (video.paused && video.srcObject) video.play().catch(() => {});
  if (video.currentTime !== lastCT) { lastCT = video.currentTime; lastCTAt = now; }
  if (track && track.muted) { if (!mutedSince) mutedSince = now; } else mutedSince = 0;
  const showing = document.body.classList.contains('showmode');
  const frozen = showing ? now - lastCTAt > 4000 : ((hasRVFC && now - lastFrameAt > 4000) || now - lastCTAt > 4000);
  if (!track || track.readyState !== 'live') restartCamera('camera stopped');
  else if (mutedSince && now - mutedSince > 3000) restartCamera('camera muted by iOS');
  else if (frozen) restartCamera('picture frozen');
  else if (blackSince && now - blackSince > 4000) restartCamera('picture black');
}, 1500);

function setupCamControls(caps) {
  if (caps.zoom) {
    const z = $('zoom');
    z.min = caps.zoom.min; z.max = caps.zoom.max; z.step = caps.zoom.step || 0.1;
    z.value = S.zoom != null ? S.zoom : (track.getSettings().zoom || caps.zoom.min);
    $('zoomVal').textContent = (+z.value).toFixed(1) + '×';
    $('zoomRow').style.display = '';
    if (S.zoom != null) track.applyConstraints({ advanced: [{ zoom: +S.zoom }] }).catch(() => {});
  } else $('zoomRow').style.display = 'none';
  $('torchRow').style.display = caps.torch ? '' : 'none';
  applyTorch();
}
function applyTorch() {
  if (!track) return;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  if (caps.torch) track.applyConstraints({ advanced: [{ torch: !!S.torch }] }).catch(() => {});
}
async function listCameras() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const sel = $('camSel');
    sel.innerHTML = '<option value="">Back camera (default)</option>';
    devs.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || 'Camera ' + (i + 1); sel.appendChild(o); });
    sel.value = [...sel.options].some((o) => o.value === S.camId) ? S.camId : '';
  } catch {}
}
$('zoom').addEventListener('input', () => {
  const z = +$('zoom').value; S.zoom = z; saveSettings();
  $('zoomVal').textContent = z.toFixed(1) + '×';
  if (track) track.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => {});
});

// ---------------------------------------------------------------- crop box
function cropRect() {
  const c = S.useCrop ? S.crop : { x: 0, y: 0, w: 1, h: 1 };
  const vw = video.videoWidth, vh = video.videoHeight;
  return { sx: Math.round(c.x * vw), sy: Math.round(c.y * vh), sw: Math.max(8, Math.round(c.w * vw)), sh: Math.max(8, Math.round(c.h * vh)) };
}
function drawCropBox() {
  const b = $('cropBox');
  if (!S.useCrop) { b.style.display = 'none'; return; }
  b.style.display = '';
  b.style.left = S.crop.x * 100 + '%'; b.style.top = S.crop.y * 100 + '%';
  b.style.width = S.crop.w * 100 + '%'; b.style.height = S.crop.h * 100 + '%';
}
(function cropDrawing() {
  const stage = $('stage'); let drawing = false, start = null;
  const pos = (e) => { const r = stage.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  $('btnDraw').onclick = () => { drawing = !drawing; stage.classList.toggle('drawing', drawing); $('drawLbl').textContent = drawing ? 'Done' : 'Crop box'; };
  $('btnCropReset').onclick = () => { S.useCrop = false; saveSettings(); document.querySelector('[data-k=useCrop]').checked = false; drawCropBox(); prevGrey = null; };
  stage.addEventListener('pointerdown', (e) => { if (!drawing) return; start = pos(e); stage.setPointerCapture(e.pointerId); e.preventDefault(); });
  stage.addEventListener('pointermove', (e) => {
    if (!drawing || !start) return;
    const p = pos(e);
    S.crop = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    S.useCrop = true; drawCropBox();
  });
  stage.addEventListener('pointerup', () => {
    if (!drawing || !start) return; start = null;
    if (S.crop.w < 0.05 || S.crop.h < 0.05) S.crop = { ...DEFAULTS.crop };
    document.querySelector('[data-k=useCrop]').checked = true;
    saveSettings(); drawCropBox(); prevGrey = null;
  });
})();

// ---------------------------------------------------------------- image measurements
const anCanvas = document.createElement('canvas'), anCtx = anCanvas.getContext('2d', { willReadFrequently: true });
const shCanvas = document.createElement('canvas'), shCtx = shCanvas.getContext('2d', { willReadFrequently: true });
const bestCanvas = document.createElement('canvas'), bestCtx = bestCanvas.getContext('2d');
let prevGrey = null;

function greyOf(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return g;
}
// Motion: average brightness change per pixel (0–255) on a tiny 160px-wide copy.
function measureMotion(r) {
  const w = 160, h = Math.max(8, Math.round(160 * r.sh / r.sw));
  if (anCanvas.width !== w || anCanvas.height !== h) { anCanvas.width = w; anCanvas.height = h; prevGrey = null; }
  anCtx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
  const g = greyOf(anCtx, w, h);
  let bright = 0; for (let i = 0; i < g.length; i++) bright += g[i];
  if (bright / g.length < 2) { if (!blackSince) blackSince = performance.now(); } else blackSince = 0;
  let m = 0;
  if (prevGrey && prevGrey.length === g.length) { for (let i = 0; i < g.length; i++) m += Math.abs(g[i] - prevGrey[i]); m /= g.length; }
  else m = 255;
  prevGrey = g;
  return m;
}
// Sharpness: variance of the Laplacian on an 800px-wide copy (same scale as test.html).
function measureSharpness(r) {
  const w = Math.min(800, r.sw), h = Math.max(8, Math.round(w * r.sh / r.sw));
  if (shCanvas.width !== w || shCanvas.height !== h) { shCanvas.width = w; shCanvas.height = h; }
  shCtx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
  const g = greyOf(shCtx, w, h);
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1, k = y * w + 1; x < w - 1; x++, k++) {
    const l = g[k - w] + g[k + w] + g[k - 1] + g[k + 1] - 4 * g[k];
    s += l; s2 += l * l; n++;
  }
  const mean = s / n; return s2 / n - mean * mean;
}
function grabBest(r) {
  const scale = Math.min(1, (+S.maxSide || 2048) / Math.max(r.sw, r.sh));
  bestCanvas.width = Math.round(r.sw * scale); bestCanvas.height = Math.round(r.sh * scale);
  bestCtx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, bestCanvas.width, bestCanvas.height);
}
function thumbOf(canvas, max = 480) {
  const s = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const t = document.createElement('canvas'); t.width = Math.round(canvas.width * s); t.height = Math.round(canvas.height * s);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.6);
}

// ---------------------------------------------------------------- state machine
// phase: 'idle' (disarmed) | 'watch' | 'collect' | 'busy' (thinking/speaking)
let running = false, armed = false, phase = 'idle';
let stillCount = 0, collect = null, needChange = false, nextAutoAt = 0, noneRetries = 0;
let movedWhileBusy = false, skipNote = '', skipNoteAt = 0;
let lastMotion = 0, lastSharp = 0, checks = 0, checksAt = performance.now(), fpsShown = 0;
let last = { q: '', a: '', text: '' };
let loopTimer = null;

function setArmed(on) {
  armed = on;
  if (on) { if (phase !== 'busy') phase = 'watch'; stillCount = 0; collect = null; needChange = false; noneRetries = 0; tone('ready'); }
  else { if (phase !== 'busy') phase = 'idle'; collect = null; tone('disarmed'); }
  $('btnArm').innerHTML = armed ? '■ DISARM<small>armed — watching</small>' : '● ARM<small>earbud: single press</small>';
  $('btnArm').classList.toggle('armed', armed);
  setSub();
}

function currentFps() {
  if (phase === 'collect') return +S.activeFps || 8;
  if (!armed) return +S.idleFps || 1;
  if ((phase === 'watch' && (stillCount > 0 || lastMotion > S.motionThresh))) return +S.activeFps || 8;
  return +S.watchFps || 3;
}

function loop() {
  clearTimeout(loopTimer);
  if (!running) return;
  try { tick(); } catch (e) { console.warn(e); }
  loopTimer = setTimeout(loop, 1000 / currentFps());
}

function tick() {
  if (!video.videoWidth || document.hidden || restarting || camBusy) return;
  // Never act on a stale picture (a frozen feed would just be read again and again):
  if (hasRVFC && !document.body.classList.contains('showmode') && performance.now() - lastFrameAt > 2500) return;
  const r = cropRect();
  const motion = measureMotion(r);
  lastMotion = motion; checks++;
  const still = motion < S.motionThresh;
  if (motion > S.changeThresh) { needChange = false; if (phase === 'busy') movedWhileBusy = true; } // card moved / changed

  if (phase === 'watch') {
    stillCount = still ? stillCount + 1 : 0;
    const allowed = !needChange && Date.now() >= nextAutoAt;
    if (allowed && stillCount >= S.stillFrames) {
      collect = { n: 0, best: -1, forced: false, source: 'auto', motion };
      phase = 'collect';
    }
  }
  if (phase === 'collect') {
    if (!collect.forced && !still) { phase = 'watch'; collect = null; stillCount = 0; }
    else {
      const sh = measureSharpness(r); lastSharp = sh;
      if (sh > collect.best) { collect.best = sh; grabBest(r); }
      collect.n++;
      if (collect.n >= (collect.forced ? 3 : S.windowFrames)) {
        const c = collect; collect = null;
        if (c.forced || c.best >= S.sharpMin) { phase = 'busy'; handleCapture(c); }
        else { // blank or blurry: tell the display why, then wait for a change
          skipNote = 'Not sent: sharpness ' + Math.round(c.best) + ' is below the minimum ' + S.sharpMin; skipNoteAt = Date.now();
          phase = 'watch'; stillCount = 0; needChange = true;
        }
      }
    }
  } else if (checks % 3 === 0) {
    lastSharp = measureSharpness(r); // keeps the meter alive for tuning
  }
  updateMeters(still);
}

function forceCapture(source = 'button') {
  if (!running || phase === 'busy') return;
  collect = { n: 0, best: -1, forced: true, source, motion: lastMotion };
  phase = 'collect';
  loop();
}

// ---------------------------------------------------------------- one capture -> Gemini -> speech
async function handleCapture(c) {
  try { await runCapture(c); }
  catch (e) { // whatever goes wrong, never leave the app stuck on "busy"
    console.warn(e);
    logCapture({ t: Date.now(), trigger: c.source, status: 'fail', sharp: Math.round(c.best), motion: +(c.motion || 0).toFixed(1),
                 error: 'App error: ' + e.message, reply: '', latencyMs: 0 });
    try { await tone('failed'); await speak(S.stallLine); } catch {}
    finish(true);
  }
}

async function runCapture(c) {
  setState('captured');
  movedWhileBusy = false;
  tone('captured');
  const t0 = performance.now();
  if (bestCanvas.width < 8 || bestCanvas.height < 8) throw new Error('empty picture');
  const q = Math.min(95, Math.max(50, +S.jpegQuality || 85)) / 100;
  const dataUrl = bestCanvas.toDataURL('image/jpeg', q);
  const entry = {
    t: Date.now(), trigger: c.source, sharp: Math.round(c.best), motion: +c.motion.toFixed(1),
    w: bestCanvas.width, h: bestCanvas.height, kb: Math.round(dataUrl.length * 0.75 / 1024),
    thumb: thumbOf(bestCanvas), cam: video.videoWidth + '×' + video.videoHeight,
    frameAge: Math.round(performance.now() - lastFrameAt),
  };
  setState('thinking');
  const timeoutMs = ((+S.timeoutSec || 8) + (S.lateAnswer ? (+S.lateSec || 0) : 0)) * 1000;
  const pending = callWorker(dataUrl, timeoutMs); // send first, beep while it uploads
  tone('thinking');

  let ticker = S.thinkTicks ? setInterval(() => tone('thinking'), 2000) : null;
  let stalled = false;
  const stallTimer = setTimeout(async () => {
    stalled = true; clearInterval(ticker); ticker = null;
    setState('stalling');
    await tone('failed'); speak(S.stallLine);
  }, (+S.timeoutSec || 8) * 1000);

  const res = await pending;
  clearTimeout(stallTimer); clearInterval(ticker);
  entry.latencyMs = Math.round(performance.now() - t0);
  entry.geminiMs = res.geminiMs; entry.model = res.model || ''; entry.attempts = res.attempts;
  entry.reply = res.text || ''; entry.error = res.error || '';

  const parsed = res.ok ? parseReply(res.text) : null;
  let next; // what to do once the entry is logged
  if (!res.ok) { entry.status = 'fail'; next = 'stall'; }
  else if (!parsed) {
    if (c.source === 'auto' && noneRetries < (+S.retryNone || 0) && !stalled) { entry.status = 'none-retry'; next = 'retry'; }
    else { entry.status = 'none'; next = 'stall'; }
  } else if (c.source === 'auto' && parsed.q && parsed.q === last.q && !stalled) { entry.status = 'duplicate'; next = 'skip'; }
  else {
    entry.status = stalled ? 'late-answer' : 'answer'; next = 'speak';
    last = { q: parsed.q, a: parsed.a, text: res.text };
  }
  logCapture(entry); // logged BEFORE speaking, so it is saved even if something interrupts the speech
  showLast(entry);

  if (next === 'retry') { noneRetries++; finish(false, true); } // try again with the next still window
  else if (next === 'stall') { if (!stalled) { await tone('failed'); await speak(S.stallLine); } finish(true); }
  else if (next === 'skip') finish(true);
  else {
    await speechChain; // let the stall line finish first
    await tone('answer');
    if (S.speakQuestion && parsed.q) await speak(parsed.q);
    await speak(parsed.a);
    finish(true);
  }
}

function finish(waitForChange, retry = false) {
  if (!retry) noneRetries = 0;
  needChange = waitForChange && !movedWhileBusy;
  movedWhileBusy = false;
  nextAutoAt = Date.now() + (retry ? 500 : (+S.cooldownSec || 0) * 1000);
  stillCount = 0;
  phase = armed ? 'watch' : 'idle';
  setSub();
}

function parseReply(text) {
  text = String(text || '').trim();
  if (!text || /^\W*NONE\W*$/i.test(text) || /^NONE\b/i.test(text)) return null;
  const qm = text.match(/^\W*Q\s*:\s*(.+)$/im);
  const am = text.match(/^\W*A\s*:\s*([\s\S]+)$/im);
  const a = (am ? am[1] : text).replace(/^\W*Q\s*:.*$/im, '').trim();
  if (!a || /^NONE$/i.test(a)) return null;
  return { q: qm ? qm[1].trim() : '', a };
}

async function callWorker(dataUrl, timeoutMs) {
  if (!S.workerUrl) return { ok: false, error: 'No Worker URL set' };
  const models = String(S.models || '').split(',').map((m) => m.trim()).filter(Boolean);
  const generationConfig = { temperature: 0, maxOutputTokens: Math.max(256, +S.maxTokens || 1024) };
  if (S.mediaResolution) generationConfig.mediaResolution = S.mediaResolution;
  if (S.thinking === 'budget0') generationConfig.thinkingConfig = { thinkingBudget: 0 };
  else if (S.thinking) generationConfig.thinkingConfig = { thinkingLevel: S.thinking };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs + 1500);
  try {
    const r = await fetch(S.workerUrl.trim().replace(/\/$/, ''), {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-App-Token': S.token.trim() },
      body: JSON.stringify({ image: dataUrl, prompt: S.prompt + (S.style && S.style.trim() ? '\n\nExtra instructions from the performer: ' + S.style.trim() : ''), models, generationConfig, timeoutMs }),
    });
    const j = await r.json().catch(() => ({ error: 'Bad reply from Worker (HTTP ' + r.status + ')' }));
    return { ...j, ok: r.ok && !j.error };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Timed out' : 'Network error: ' + e.message };
  } finally { clearTimeout(timer); }
}

function repeatLast() {
  if (last.a) { tone('answer').then(() => speak(last.a)); }
  else tone('failed');
}

// ---------------------------------------------------------------- UI updates
const STATE_STYLE = {
  off: ['Not started', '#555'], idle: ['Disarmed', '#777'], watch: ['Armed — watching', '#4caf50'],
  collect: ['Card still — picking sharpest', '#ffb300'], captured: ['Captured', '#ffb300'],
  thinking: ['Thinking…', '#4fa3ff'], stalling: ['Slow — stall line', '#ff5252'],
};
let shownState = 'off', lastStateTxt = '';
function setState(s) { shownState = s; renderState(); }
function renderState() {
  const st = phase === 'busy' ? shownState : (running ? phase : 'off');
  const [txt, col] = STATE_STYLE[st] || [st, '#555'];
  if (txt === lastStateTxt) return;
  lastStateTxt = txt;
  $('stateText').textContent = txt; document.documentElement.style.setProperty('--state', col);
  $('showTxt').textContent = txt;
  try { navigator.mediaSession.metadata = new MediaMetadata({ title: 'Card Assistant', artist: txt }); } catch {}
}
function setSub() {
  renderState();
  if (!running) return;
  const bits = [];
  bits.push(wakeLock ? 'Screen lock: held' : 'Screen lock: NOT held (set Auto-Lock to Never)');
  if (camNote) bits.unshift(camNote);
  if (skipNote && Date.now() - skipNoteAt < 8000) bits.push(skipNote);
  if (needChange && armed && phase === 'watch') bits.push('waiting for card to change');
  if (speaking) bits.push('speaking');
  $('sub').textContent = bits.join(' · ');
}
function updateMeters(still) {
  const now = performance.now();
  if (now - checksAt > 2000) { fpsShown = checks * 1000 / (now - checksAt); checks = 0; checksAt = now; }
  if (document.body.classList.contains('showmode')) return; // nothing to draw
  $('mMotion').textContent = lastMotion >= 255 ? '–' : lastMotion.toFixed(1);
  $('mMotion').style.color = still ? 'var(--ok)' : 'var(--fg)';
  $('barMotion').style.width = Math.min(100, lastMotion / (S.changeThresh * 2) * 100) + '%';
  $('mSharp').textContent = Math.round(lastSharp);
  $('mSharp').style.color = lastSharp >= S.sharpMin ? 'var(--ok)' : 'var(--fg)';
  $('barSharp').style.width = Math.min(100, lastSharp / (S.sharpMin * 3 || 1) * 100) + '%';
  $('mStill').textContent = stillCount + '/' + S.stillFrames;
  $('mFps').textContent = fpsShown ? fpsShown.toFixed(1) : '–';
  renderState(); setSub();
}
function showLast(e) {
  $('lastQ').textContent = last.q ? 'Card: ' + last.q : '';
  $('lastA').textContent = (e.status === 'answer' || e.status === 'late-answer') ? last.a : '(' + e.status + ') ' + (e.error || e.reply || '');
  $('lastInfo').textContent = new Date(e.t).toLocaleTimeString() + ' · ' + (e.latencyMs / 1000).toFixed(1) + ' s · sharp ' + e.sharp +
    ' · ' + e.kb + ' KB · ' + (e.model || '');
}

// ---------------------------------------------------------------- buttons
$('btnStart').onclick = async () => {
  if (running) return;
  $('btnStart').disabled = true; $('sub').textContent = 'Starting camera…';
  // These must happen inside a tap on iOS to unlock sound and speech:
  audioCtx(); speechSynthesis.speak(new SpeechSynthesisUtterance(' '));
  setupMediaSession();
  try { await startCamera(); }
  catch (e) {
    $('sub').textContent = 'Camera error: ' + e.message; $('btnStart').disabled = false; return;
  }
  running = true; phase = 'idle';
  await requestWakeLock();
  ['btnArm', 'btnForce', 'btnRepeat', 'btnShow', 'btnCam'].forEach((id) => { $(id).disabled = false; });
  $('btnStart').innerHTML = '● RUNNING<small>camera on</small>';
  $('btnStart').classList.remove('pri'); $('btnStart').classList.add('running');
  $('placeholder').style.display = 'none';
  $('stage').classList.add('on');
  drawCropBox();
  await tone('start');
  if (S.autoArm) setArmed(true);
  loop();
};
$('btnArm').onclick = () => setArmed(!armed);
$('btnForce').onclick = () => forceCapture('button');
$('btnRepeat').onclick = repeatLast;
function setShowMode(on) {
  document.body.classList.toggle('showmode', on); $('show').style.display = on ? 'block' : 'none';
}
$('btnShow').onclick = () => setShowMode(true);
(function exitShow() { // double-tap the black screen to leave show mode
  let lastTap = 0;
  $('show').addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 400) setShowMode(false);
    lastTap = now;
  });
})();
$('btnCam').onclick = () => restartCamera('manual');
$('btnTestVoice').onclick = () => { audioCtx(); speak('This is how answers will sound in your earbud.'); };
$('btnPromptReset').onclick = () => { S.prompt = DEFAULT_PROMPT; saveSettings(); document.querySelector('[data-k=prompt]').value = S.prompt; syncPreset(); };
$('btnResetAll').onclick = () => {
  if (!confirm('Reset every setting (including Worker URL and token)?')) return;
  try { localStorage.removeItem(LS_KEY); } catch {}
  location.reload();
};
$('btnTestConn').onclick = async () => {
  const out = $('connOut');
  if (!S.workerUrl) { out.textContent = 'Enter the Worker URL first.'; return; }
  out.textContent = 'Checking…';
  try {
    const j = await (await fetch(S.workerUrl.trim().replace(/\/$/, ''), { headers: { 'X-App-Token': S.token.trim() } })).json();
    const lines = [
      (j.hasKey ? '✅' : '❌') + ' Gemini key stored in Worker',
      (j.tokenOk ? '✅' : '❌') + ' App token matches',
      (j.originOk ? '✅' : '❌') + ' This page is allowed',
      ((j.version || 1) >= MIN_WORKER_VERSION ? '✅ Worker is up to date' : '❌ Worker is OUT OF DATE — paste the new worker/proxy.js into Cloudflare'),
    ];
    out.textContent = lines.join('\n');
  } catch (e) { out.textContent = '❌ Could not reach the Worker: ' + e.message; }
};

// ---------------------------------------------------------------- keyboard / Bluetooth clicker
// Page-turner clickers and keyboards just send ordinary keys. Space/Enter act like a single earbud
// press, →/Page Down like a double press, ←/Page Up like a triple press (so they follow your
// "Earbud buttons" choices). Letters are fixed: A arm/disarm, C capture, R repeat, S show mode, K camera.
const KEY_PRESS = { ' ': 'single', Enter: 'single', ArrowRight: 'double', PageDown: 'double', n: 'double',
                    ArrowLeft: 'triple', PageUp: 'triple', p: 'triple' };
function keyAction(k) {
  if (!running) return (k === ' ' || k === 'Enter' || k === 's') ? () => $('btnStart').click() : null;
  if (KEY_PRESS[k]) { const a = { single: S.btnSingle, double: S.btnDouble, triple: S.btnTriple }[KEY_PRESS[k]]; return () => doAction(a, 'key-' + (k === ' ' ? 'space' : k.toLowerCase())); }
  if (k === 'a') return () => setArmed(!armed);
  if (k === 'c') return () => forceCapture('key-c');
  if (k === 'r') return repeatLast;
  if (k === 's') return () => setShowMode(!document.body.classList.contains('showmode'));
  if (k === 'k') return () => restartCamera('manual');
  if (k === 'Escape') return () => setShowMode(false);
  return null;
}
function typingInField(e) { return e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName); }
document.addEventListener('keydown', (e) => {
  if (!S.keyboard || e.ctrlKey || e.metaKey || e.altKey || typingInField(e)) return;
  const act = keyAction(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  if (!act) return;
  e.preventDefault(); // stops Space from scrolling the page or clicking a focused button
  if (!e.repeat) act();
});
document.addEventListener('keyup', (e) => {
  if (!S.keyboard || typingInField(e) || e.key !== ' ') return;
  e.preventDefault(); // some browsers click a focused button on Space *release*
});

// ---------------------------------------------------------------- lifecycle
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !running) return;
  if (!wakeLock) requestWakeLock();
  if (keepAlive) keepAlive.play().catch(() => {});
  restartCamera('returned to app'); // iOS usually freezes the camera while the app is away
});
window.addEventListener('pageshow', (e) => { if (e.persisted && running) restartCamera('page restored'); });

function buildCueSettings() {
  const box = $('cueList');
  const opts = CAN_VIBRATE ? [['tone', 'Sound'], ['vibrate', 'Vibrate'], ['both', 'Sound + vibrate'], ['off', 'Off']] : [['tone', 'Sound'], ['off', 'Off']];
  box.innerHTML = '';
  for (const [k, label] of CUES) {
    const row = document.createElement('div'); row.className = 'cuerow';
    const lab = document.createElement('span'); lab.textContent = label;
    const sel = document.createElement('select'); sel.dataset.k = 'cue_' + k;
    opts.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); });
    const b = document.createElement('button'); b.textContent = '▶'; b.title = 'Try it'; b.onclick = () => tone(k);
    row.append(lab, sel, b); box.appendChild(row);
  }
  $('vibNote').textContent = CAN_VIBRATE ? '' :
    "Vibration isn't available on this phone: iPhone Safari doesn't let web pages vibrate it. You can still turn any cue Off, or lower the tone volume.";
}
function syncPreset() {
  const ps = $('promptPreset');
  if (ps) ps.value = Object.keys(PROMPTS).find((n) => PROMPTS[n] === S.prompt) || 'custom';
  const sel = $('speedPreset'); if (!sel) return;
  const m = Object.keys(PRESETS).find((n) => Object.keys(PRESETS[n]).every((k) => +S[k] === PRESETS[n][k]));
  sel.value = m || 'custom';
}
$('promptPreset').addEventListener('change', () => {
  const t = PROMPTS[$('promptPreset').value]; if (!t) return;
  S.prompt = t; saveSettings(); document.querySelector('[data-k=prompt]').value = t;
});
$('speedPreset').addEventListener('change', () => {
  const p = PRESETS[$('speedPreset').value]; if (!p) return;
  for (const k in p) { S[k] = p[k]; const el = document.querySelector('[data-k=' + k + ']'); if (el) el.value = p[k]; }
  saveSettings();
});

function init() {
  buildCueSettings();
  bindSettings();
  syncPreset();
  drawCropBox();
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
  $('about').textContent = 'App version ' + APP_VERSION + '\nNeeds Worker version ' + MIN_WORKER_VERSION + ' or newer.';
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  renderState();
}
init();
