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

const APP_VERSION = '1.17.0';
const MIN_WORKER_VERSION = 5;
const RECOMMENDED_WORKER_VERSION = 11; // 11 = Claude, Groq and Gemini in the order you choose

// The first version of the prompt. Phones that saved it get the new one automatically.
const OLD_PROMPT_V1 =
  'The photo shows a paper card with a printed audience question. Read the question and answer it for a ' +
  'stage performer who will hear your answer through an earbud.\n' +
  'Reply in exactly this format and nothing else:\n' +
  'Q: <the question, exactly as printed>\n' +
  'A: <a short spoken answer, one or two plain sentences, no lists, symbols or markdown>\n' +
  'If you cannot read the question with confidence, reply with just: NONE';

const OLD_QUESTION_V2 =
  'The photo shows a paper card with a printed question. A stage performer will hear your answer through an earbud.\n' +
  'Find the question. If more than one question is visible, use the first one, nearest the top.\n' +
  'Reply in exactly this format and nothing else:\n' +
  'Q: <the question, shortened to at most 15 words>\n' +
  'A: <the answer: one or two short sentences to be spoken aloud, plain words only, no lists, symbols or markdown>\n' +
  'Always give your best answer, even if the print is small or slightly unclear. ' +
  'Reply with just the word NONE only if no question can be read at all.';

// General-purpose: respond to whatever is on the card, not just questions.
const OLD_ANYTHING_V3 =
  "The photo shows a card held up during a live show. Your reply is spoken into the performer's earbud, so it must be quick and natural.\n" +
  'Whatever is on the card — a question, a word, a name, a topic, a statement, a number, a prompt or an instruction — respond to it directly ' +
  'and helpfully, like a quick-witted friend. If it asks something, answer it. If it is a topic, name or word, say something short, ' +
  'interesting or funny about it. If it is an instruction, carry it out. If several things are written, deal with the first one, nearest the top.\n' +
  'Reply in exactly this format and nothing else:\n' +
  'Q: <what the card says, in at most 12 words>\n' +
  'A: <your reply to be spoken aloud: one to three short sentences, plain words only, no lists, symbols or markdown>\n' +
  'Always give your best reply, even if the print is small or slightly unclear. ' +
  'Reply with just the word NONE only if nothing on the card can be read at all.';
const OLD_MULTI_V4 =
  'If the card or page has several questions or items, handle EVERY one, in order from top to bottom.\n' +
  'Reply in exactly this format and nothing else, one pair per item (just Q1/A1 if there is only one):\n' +
  'Q1: <item 1, in at most 12 words>\n' +
  'A1: <your reply to item 1: one to three short sentences to be spoken aloud, plain words only, no lists, symbols or markdown>\n' +
  'Q2: <item 2>\nA2: <reply to item 2>\n(and so on)\n' +
  'Always give your best reply, even if the print is small or slightly unclear. ' +
  'Reply with just the word NONE only if nothing on the card can be read at all.';
const OLD_ANYTHING_V4 =
  "The photo shows a card or page held up during a live show. Your reply is spoken into the performer's earbud, so it must be quick and natural.\n" +
  'Whatever is written — a question, a word, a name, a topic, a statement, a number, a prompt or an instruction — respond to it directly ' +
  'and helpfully, like a quick-witted friend. If it asks something, answer it. If it is a topic, name or word, say something short, ' +
  'interesting or funny about it. If it is an instruction, carry it out.\n' + OLD_MULTI_V4;
const OLD_QUESTION_V4 =
  'The photo shows a paper card or page with printed questions. A stage performer will hear your answers through an earbud.\n' +
  'Answer each question correctly and briefly.\n' + OLD_MULTI_V4;
const OLD_MULTI_V5 =
  'If the card or page has several questions or items, handle EVERY one, in order from top to bottom.\n' +
  'Reply in exactly this format and nothing else, one pair per item (just Q1/A1 if there is only one):\n' +
  'Q1: <item 1, in at most 12 words>\n' +
  'A1: <your reply to item 1: one to three short sentences to be spoken aloud, plain words only, no lists, symbols or markdown>\n' +
  'Q2: <item 2>\nA2: <reply to item 2>\n(and so on)\n' +
  'Always give your best reply, even if the print is small or slightly unclear. ' +
  'Reply with just the word NONE if nothing on the card can be read, OR if the photo does not show a card or page at all ' +
  '(for example it shows a room, a TV screen, a person or an object): never describe or comment on what else is in the picture.';
const OLD_ANYTHING_V5 =
  "The photo shows a card or page held up during a live show. Your reply is spoken into the performer's earbud, so it must be quick and natural.\n" +
  'Whatever is written — a question, a word, a name, a topic, a statement, a number, a prompt or an instruction — respond to it directly ' +
  'and helpfully, like a quick-witted friend. If it asks something, answer it. If it is a topic, name or word, say something short, ' +
  'interesting or funny about it. If it is an instruction, carry it out.\n' + OLD_MULTI_V5;
const OLD_QUESTION_V5 =
  'The photo shows a paper card or page with printed questions. A stage performer will hear your answers through an earbud.\n' +
  'Answer each question correctly and briefly.\n' + OLD_MULTI_V5;
const MULTI_FORMAT =
  'If the card or page has several questions or items, handle EVERY one, in order from top to bottom.\n' +
  'Reply in exactly this format and nothing else, one pair per item (just Q1/A1 if there is only one). Start your reply immediately with "Q1:": ' +
  'never write an introduction, a heading, "---" lines or markdown, and do not repeat the question inside the answer:\n' +
  'Q1: <item 1, in at most 12 words>\n' +
  'A1: <your reply to item 1: one to three short sentences to be spoken aloud, plain words only, no lists, symbols or markdown>\n' +
  'Q2: <item 2>\nA2: <reply to item 2>\n(and so on)\n' +
  'Always give your best reply, even if the print is small or slightly unclear. ' +
  'Reply with just the word NONE if nothing on the card can be read, OR if the photo does not show a card or page at all ' +
  '(for example it shows a room, a TV screen, a person or an object): never describe or comment on what else is in the picture.';
const PROMPT_ANYTHING =
  "The photo shows a card or page held up during a live show. Your reply is spoken into the performer's earbud, so it must be quick and natural.\n" +
  'Whatever is written — a question, a word, a name, a topic, a statement, a number, a prompt or an instruction — respond to it directly ' +
  'and helpfully, like a quick-witted friend. If it asks something, answer it. If it is a topic, name or word, say something short, ' +
  'interesting or funny about it. If it is an instruction, carry it out.\n' + MULTI_FORMAT;
const PROMPT_QUESTION =
  'The photo shows a paper card or page with printed questions. A stage performer will hear your answers through an earbud.\n' +
  'Answer each question correctly and briefly.\n' + MULTI_FORMAT;
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
  answerOrder: ['claude', 'groq', 'gemini'], answerOn: { claude: true, groq: true, gemini: true }, // priority blocks: top answers first
  claudeModels: '', claudeEffort: 'medium', claudeMaxTokens: 16000,
  answerer: 'groq', groqModels: '', groqReasoning: 'medium', groqTemp: 0.6, groqMaxTokens: 2548, geminiTemp: 0, // Groq first (if the Worker has GROQ_API_KEY), Gemini as the fallback
  models: 'gemini-3.5-flash, gemini-flash-latest',
  mediaResolution: 'MEDIA_RESOLUTION_HIGH', thinking: 'minimal', maxTokens: 2048,
  prompt: DEFAULT_PROMPT, style: '', allItems: true,
  voiceEngine: 'device', dgVoice: 'aura-2-thalia-en', cfModel: '@cf/deepgram/aura-1', cfVoice: 'luna', ttsVoice: 'Kore', ttsModel: 'gemini-2.5-flash-preview-tts, gemini-2.5-pro-preview-tts',
  maxVoiceChars: 500, deviceFallback: true, cacheClips: true, deviceMode: 4, pauseLoopForSpeech: true, audioSessionMode: 'playback', freezeMode: 'speech',
  maxSide: 2048, jpegQuality: 85,
  timeoutSec: 8, stallLine: 'Great question. Give me just a second with that one.',
  lateAnswer: true, lateSec: 15, retryNone: 1,
  voiceURI: '', rate: 1.0, toneVol: 0.3, speakQuestion: false, thinkTicks: true,
  btnSingle: 'toggle', btnDouble: 'capture', btnTriple: 'repeat', autoArm: false, keyboard: true, gamepad: true, binds: {}, sayReady: true, pressOverrides: true,
  camId: '', res: '1920x1440', camFps: 15, zoom: null, torch: false,
  useCrop: true, crop: { x: 0.1, y: 0.15, w: 0.8, h: 0.7 },
  motionThresh: 4, sharpMin: 20, changeThresh: 10, cooldownSec: 4,
  pageDetect: 'broad', minPagePct: 2, focusWaitSec: 2, emptyRef: null,
  idleFps: 1, ...PRESETS.fast,
};
for (const k of CUE_KEYS) DEFAULTS['cue_' + k] = 'tone';

// ---------------------------------------------------------------- settings
const LS_KEY = 'cardAssistant.settings.v1';
const SETTINGS_VER = 14;
let S = loadSettings();
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch {}
  if ((saved.v || 1) < SETTINGS_VER) {
    if ((saved.v || 1) < 14 && (saved.deviceMode === 1 || saved.deviceMode == null)) saved.deviceMode = 4; // 1.14.1: silence everything else while the iPhone voice talks
    // Older versions saved every default as if you had chosen it. Drop anything still equal to an OLD
    // default so the improved defaults apply. Values you really changed are kept.
    if ((saved.v || 1) < 2) {
      const old = { thinking: '', res: 'max', stillFrames: 3, windowFrames: 4, watchFps: 3, activeFps: 8 };
      for (const k in old) if (saved[k] === old[k]) delete saved[k];
    }
    if ([OLD_PROMPT_V1, OLD_QUESTION_V2, OLD_ANYTHING_V3, OLD_ANYTHING_V4, OLD_QUESTION_V4, OLD_ANYTHING_V5, OLD_QUESTION_V5].includes(saved.prompt)) delete saved.prompt;
    if ((saved.v || 1) < 4 && saved.maxTokens === 1024) delete saved.maxTokens; // longer pages need room for many answers
    if ((saved.v || 1) < 13 && saved.voiceEngine === 'auto') delete saved.voiceEngine; // the iPhone voice works (and is unlimited and free): it is the default now
    if ((saved.v || 1) < 11) { // the free Cloudflare allowance is small: use the cheaper model, and 'auto' picks the best voice you have
      if (saved.voiceEngine === 'cf' || saved.voiceEngine === 'gemini') delete saved.voiceEngine;
      if (saved.cfModel === '@cf/deepgram/aura-2-en') delete saved.cfModel;
    }
    if ((saved.v || 1) < 10 && saved.sharpMin === 60) delete saved.sharpMin; // now a 'focus target', not a gate: pages with little text must still count
    if ((saved.v || 1) < 8) { // Cloudflare retired MeloTTS: move to Aura, whose speaker names differ
      if (!saved.cfModel || /melotts/i.test(saved.cfModel)) delete saved.cfModel;
      if (saved.cfVoice === 'angus') delete saved.cfVoice;
    }
    if ((saved.v || 1) < 7 && saved.voiceEngine !== 'device') delete saved.voiceEngine; // Gemini voice hit its free limits: Cloudflare voice is the default now
    if ((saved.v || 1) < 6) delete saved.voiceEngine; // the iPhone voice turned out silent while the camera runs: Gemini voice is the default now
    if ((saved.v || 1) < 5) delete saved.pauseLoopForSpeech; // now on by default: the background sound was cutting into speech
    saved.v = SETTINGS_VER;
    try { localStorage.setItem(LS_KEY, JSON.stringify(saved)); } catch {}
  }
  if (!Array.isArray(saved.answerOrder)) { // 1.17: the old "Answer with" choice becomes priority blocks (Claude added on top for testing)
    saved.answerOrder = ['claude', 'groq', 'gemini'];
    saved.answerOn = { claude: true, groq: saved.answerer !== 'gemini', gemini: saved.answerer !== 'groqOnly' };
  }
  const order = saved.answerOrder.filter((w) => DEFAULTS.answerOrder.includes(w));
  for (const w of DEFAULTS.answerOrder) if (!order.includes(w)) order.push(w); // a new answerer added later goes at the bottom
  saved.answerOrder = order;
  return { ...DEFAULTS, ...saved, v: SETTINGS_VER, crop: { ...DEFAULTS.crop, ...(saved.crop || {}) }, binds: { ...(saved.binds || {}) },
           answerOn: { ...DEFAULTS.answerOn, ...(saved.answerOn || {}) } };
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
  if (['stallLine', 'voiceEngine', 'ttsVoice', 'ttsModel', 'cfModel', 'cfVoice', 'dgVoice', 'workerUrl', 'token'].includes(k)) { resetEngines(); checkWorker().then(prewarmVoice); }
  if (k === 'audioSessionMode') setAudioSession();
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
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    actx.onstatechange = () => {
      sev('Web Audio ' + actx.state);
      // Only wake it when nothing is being said: on iOS, waking Web Audio mid-sentence silently kills the iPhone voice.
      if (running && !audioQuiet && !deviceSpeaking && loopHold === 0 && actx.state !== 'running' && actx.state !== 'closed') actx.resume().catch(() => {});
    };
  }
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
  if (speaking || loopHold > 0) { sev('beep "' + name + '" skipped (speaking)'); return Promise.resolve(); } // never beep over the voice
  return beepNow(name);
}
function beepNow(name) {
  const seq = TONES[name]; if (!seq) return Promise.resolve();
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
let speaking = false, deviceSpeaking = false, speakProg = null, speechChain = Promise.resolve(), speechNote = '';
let speechEpoch = 0; // goes up when STOP is pressed: anything queued before that is dropped
const liveSources = new Set(); // Web Audio voice pieces now playing, so STOP can cut them off
function stopAllAudio() {
  speechEpoch++;
  speechChain = Promise.resolve();
  try { speechSynthesis.cancel(); } catch {}
  for (const src of liveSources) { try { src.stop(); } catch {} }
  liveSources.clear();
  voiceClock = 0; speaking = false; speakProg = null;
  sev('all sound stopped');
}
const liveUtterances = new Set(); // keep references: Safari can drop an utterance that gets garbage-collected mid-speech
let loopPausedForSpeech = false, loopHold = 0, loopResumeTimer = null, audioQuiet = false;
// Put Web Audio (the beeps) to sleep before the iPhone voice talks, and wake it only after speech is over.
function quietWebAudio() { if (actx && actx.state === 'running') { audioQuiet = true; actx.suspend().catch(() => {}); sev('beeps paused for the voice'); } else if (actx) audioQuiet = true; }
function wakeAudio() { audioQuiet = false; if (actx && actx.state !== 'running' && actx.state !== 'closed') return actx.resume().catch(() => {}); return Promise.resolve(); }
// Recent sound events, for "Copy sound log" — shows exactly what interrupted the voice.
const sevents = [];
function sev(t) { sevents.push(new Date().toTimeString().slice(0, 8) + '.' + String(Date.now() % 1000).padStart(3, '0') + '  ' + t); if (sevents.length > 120) sevents.shift(); }
// While anything is being said, the background loop is held: paused (by default) and NEVER restarted, so it
// can't cut into the voice. It resumes 0.8 s after the last thing is said (not between sentences or items).
// How the iPhone voice is played. iOS decides whether speech is audible (e.g. with the silent switch on) from what else the page is
// doing with sound, so there are several set-ups; the "iPhone voice lab" finds the one that is audible on this phone.
const LAB_VARIANTS = [
  { id: 1, loop: 'play',  wa: 'run',   session: 'playback',       label: 'background sound ON, beeps ON' },
  { id: 2, loop: 'play',  wa: 'quiet', session: 'playback',       label: 'background sound ON, beeps asleep' },
  { id: 3, loop: 'pause', wa: 'run',   session: 'playback',       label: 'background sound OFF, beeps ON' },
  { id: 4, loop: 'pause', wa: 'quiet', session: 'playback',       label: 'background sound OFF, beeps asleep' },
  { id: 5, loop: 'play',  wa: 'run',   session: 'transient-solo', label: 'background sound ON, "speech-prompt" audio mode' },
  { id: 6, loop: 'play',  wa: 'run',   session: 'auto',           label: 'normal audio mode (follows the silent switch)' },
  { id: 7, loop: 'play',  wa: 'run',   session: 'playback',       label: 'short pieces, one sentence at a time', chunk: true },
];
function deviceMode() { return LAB_VARIANTS.find((v) => v.id === +S.deviceMode) || LAB_VARIANTS[0]; }
function holdLoop(forDevice) {
  loopHold++; clearTimeout(loopResumeTimer);
  const pauseIt = forDevice ? deviceMode().loop === 'pause' : S.pauseLoopForSpeech;
  if (pauseIt && keepAlive && !keepAlive.paused) { loopPausedForSpeech = true; keepAlive.pause(); sev('background sound paused for speech'); }
}
function releaseLoop() {
  loopHold = Math.max(0, loopHold - 1);
  if (loopHold > 0) return;
  clearTimeout(loopResumeTimer);
  loopResumeTimer = setTimeout(() => {
    if (loopHold > 0) return;
    loopPausedForSpeech = false;
    wakeAudio();
    if (running && keepAlive && keepAlive.paused) { keepAlive.play().catch(() => {}); sev('background sound resumed'); }
  }, 800);
}
function playLoop() { if (keepAlive && loopHold === 0 && !loopPausedForSpeech) keepAlive.play().catch(() => {}); }

// Queue something to be said. Long text is split into sentences (iOS can cut off long utterances).
function cleanSpeech(text) { // make written text sound right: no "---" lines, markdown, "m^2", "×", "≈", "°"
  return String(text || '')
    .replace(/\\(?:text|mathrm|mathbf|operatorname)\{([^}]*)\}/g, '$1')
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '$1 over $2').replace(/\\sqrt\{([^}]*)\}/g, 'square root of $1')
    .replace(/\\(omega|pi|theta|alpha|beta|gamma|delta|mu|sigma|lambda|phi)\b/g, ' $1 ').replace(/\\(?:cdot|times)\b/g, ' times ')
    .replace(/\\[a-zA-Z]+/g, ' ').replace(/\^\{([^}]*)\}/g, ' to the power $1 ').replace(/_\{([^}]*)\}/g, ' $1 ').replace(/[$]|[{}]/g, '')
    .replace(/^\s*[-=_*~]{3,}\s*$/gm, ' ')
    .replace(/[*_#`>]/g, '')
    .replace(/\^2(?![\d])/g, ' squared').replace(/\^3(?![\d])/g, ' cubed').replace(/\^\(?(-?[\d.]+)\)?/g, ' to the power $1')
    .replace(/×/g, ' times ').replace(/÷/g, ' divided by ').replace(/≈/g, ' about ').replace(/≤/g, ' at most ').replace(/≥/g, ' at least ')
    .replace(/°/g, ' degrees').replace(/[→⇒➜]/g, ' ').replace(/\s+–\s+|\s+—\s+/g, ', ')
    .replace(/\s+/g, ' ').trim();
}
function speak(text) {
  text = cleanSpeech(text);
  if (!text) return Promise.resolve();
  if (netVoice()) {
    // Long text is cut into short pieces (a whole paragraph in one request is slow and often times out).
    // Cloudflare voice: every piece is requested NOW, all at once, and played in order: the first piece starts
    // as soon as it is ready while the rest are still being made. Gemini voice: one at a time (3 a minute free).
    const pieces = voiceChunks(text);
    const first = voiceOrder()[0];
    const jobs = isParallel(first) ? pieces.map((c) => voiceJob(c, { engine: first })) : [];
    const ep = speechEpoch;
    speechChain = speechChain.then(async () => {
      if (ep !== speechEpoch) return;
      speaking = true; setSub();
      sev('speaking ' + pieces.length + ' piece' + (pieces.length > 1 ? 's' : '') + ', ' + text.length + ' characters');
      try { for (let i = 0; i < pieces.length && ep === speechEpoch; i++) { speakProg = { i: i + 1, n: pieces.length }; setSub(); await playVoice(pieces[i], jobs[i], i < pieces.length - 1, ep); } }
      finally { if (ep === speechEpoch) { speaking = false; speakProg = null; setSub(); } }
    });
    return speechChain;
  }
  const chunks = splitSpeech(text);
  const ep = speechEpoch;
  speechChain = speechChain.then(async () => { if (ep !== speechEpoch) return; holdLoop(true); try { for (const ch of chunks) { if (ep !== speechEpoch) break; await speakDeviceNow(ch); } } finally { releaseLoop(); } });
  return speechChain;
}
// Cut text into pieces at sentence ends: a short first piece (so sound starts quickly), longer ones after.
function voiceChunks(text, firstMax = 110, restMax = 200) {
  text = cleanSpeech(text);
  const sents = text.replace(/([.!?])\s+/g, '$1\u0001').split('\u0001').map((x) => x.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  const max = () => (out.length ? restMax : firstMax);
  for (let sent of sents) {
    while (sent.length > max()) { // one very long sentence: cut at a comma, semicolon or space
      const lim = max();
      let cut = Math.max(sent.lastIndexOf(', ', lim), sent.lastIndexOf('; ', lim), sent.lastIndexOf(' ', lim));
      if (cut < 25) cut = lim;
      if (cur) { out.push(cur); cur = ''; }
      out.push(sent.slice(0, cut + 1).trim()); sent = sent.slice(cut + 1).trim();
    }
    if (!sent) continue;
    if (!cur) cur = sent;
    else if ((cur + ' ' + sent).length <= max()) cur += ' ' + sent;
    else { out.push(cur); cur = sent; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [text];
}
function splitSpeech(text) {
  const parts = text.replace(/([.!?])\s+/g, '$1\u0001').split('\u0001'); // split at sentence ends, not inside "7.21"
  const out = []; let cur = '';
  for (const p of parts) { if (cur && (cur + ' ' + p).length > 220) { out.push(cur); cur = p; } else cur = cur ? cur + ' ' + p : p; }
  if (cur) out.push(cur);
  return out.flatMap((x) => x.length <= 300 ? [x] : (x.match(/.{1,280}(\s|$)/g) || [x]).map((y) => y.trim()).filter(Boolean));
}

// The iPhone's own voice (speechSynthesis). Resolves with what happened, for the audio check.
function deviceChunks(text) { // short pieces (one sentence or so): iOS keeps these alive much better than one long utterance
  const parts = String(text).match(/[^.!?;:\n]+[.!?;:]*\s*/g) || [text], out = [];
  for (const p of parts) { const t = p.trim(); if (!t) continue; if (out.length && (out[out.length - 1] + ' ' + t).length <= 90) out[out.length - 1] += ' ' + t; else out.push(t); }
  return out;
}
async function speakDevice(text) { // piece by piece; if a piece dies, report exactly how far we got
  const pieces = deviceChunks(text); let off = 0, any = false; const ep = speechEpoch;
  for (const piece of pieces) {
    if (ep !== speechEpoch) return { started: any, died: false, error: '', spokenChars: text.length, failed: false, cancelled: true };
    const at = text.indexOf(piece, off), r = await speakDeviceNow(piece);
    if (ep !== speechEpoch) return { started: any, died: false, error: '', spokenChars: text.length, failed: false, cancelled: true };
    if (r.started) any = true;
    if (!r.started || r.died || r.error) return { started: any, died: r.started, error: r.error, spokenChars: Math.max(0, at) + (r.died ? Math.min(r.spokenChars || 0, piece.length) : 0), failed: true };
    off = at + piece.length;
  }
  return { started: any, died: false, error: '', spokenChars: text.length, failed: false };
}
function speakDeviceNow(text) {
  return new Promise((resolve) => {
    let done = false, started = false, tries = 0, cur = null, kick = null, poll = null, errName = '', died = false, gotB = false, lastB = 0, spoke = 0;
    deviceSpeaking = true;
    const ep = speechEpoch;
    const dm = deviceMode();
    try { if (navigator.audioSession) navigator.audioSession.type = dm.session; } catch {}
    if (dm.loop === 'play' && keepAlive && keepAlive.paused && running) keepAlive.play().catch(() => {});
    if (dm.wa === 'quiet') quietWebAudio(); else { audioQuiet = false; if (actx && actx.state !== 'running') actx.resume().catch(() => {}); }
    // Generous time limit from the word count (≈140 words a minute, plus margin). If iOS gets stuck, we STOP it
    // (so the next sentence isn't queued behind a stuck one) and move on.
    const words = text.split(/\s+/).length;
    const limit = Math.max(5000, 2000 + words / 2.3 * 1000 / (S.rate || 1) * 1.35);
    const total = setTimeout(() => {
      if (started) died = true;
      sev(started ? 'voice stuck — stopping it' : 'voice never started — giving up on this line');
      if (!started) { speechNote = 'Speech is not starting — run Speech & sounds → Audio check'; }
      try { speechSynthesis.cancel(); } catch {}
      finish();
    }, limit);
    const finish = () => {
      if (done) return; done = true; speaking = false; deviceSpeaking = false; clearTimeout(total); clearTimeout(kick); clearInterval(poll);
      setAudioSession(); // back to the normal audio mode
      setSub(); resolve({ started, error: errName, died, spokenChars: spoke });
    };
    const say = () => {
      tries++;
      const u = cur = new SpeechSynthesisUtterance(text);
      liveUtterances.add(u);
      const v = speechSynthesis.getVoices().find((x) => x.voiceURI === S.voiceURI);
      if (v) u.voice = v;
      u.lang = (v && v.lang) || 'en-US';
      u.rate = S.rate || 1; u.volume = 1;
      const short = '"' + text.slice(0, 24) + (text.length > 24 ? '…"' : '"');
      u.onstart = () => { if (cur !== u) return; started = true; lastB = Date.now(); sev('voice started ' + short); if (/not starting/.test(speechNote)) speechNote = ''; clearTimeout(kick); };
      u.onboundary = (e) => { if (cur !== u) return; gotB = true; lastB = Date.now(); spoke = e.charIndex || 0; };
      u.onpause = () => sev('voice PAUSED by iOS ' + short);
      u.onresume = () => sev('voice resumed ' + short);
      const end = () => { liveUtterances.delete(u); if (cur === u) finish(); };
      u.onend = () => { sev('voice ended ' + short); end(); };
      u.onerror = (e) => { if (cur === u) { errName = (e && e.error) || 'error'; sev('voice error ' + errName + ' ' + short); } end(); };
      try { if (speechSynthesis.paused) speechSynthesis.resume(); speechSynthesis.speak(u); } catch (e) { errName = e.message; finish(); return; }
      // iOS doesn't always send "ended": once it has started, notice for ourselves when it stops talking.
      clearInterval(poll);
      poll = setInterval(() => {
        if (done || cur !== u || !started) return;
        // iOS can take the audio away ~1–3 s in and never say so: words stop arriving. Notice fast, stop it, hand the rest on.
        if (gotB && Date.now() - lastB > 2500 && (speechSynthesis.speaking || speechSynthesis.pending)) {
          if (!/\s/.test(text.slice(spoke).trim())) { // it reached the last word and iOS just never said "done": that's finished, not dead
            sev('voice reached the last word ' + short + ' — treating it as finished'); liveUtterances.delete(u);
            try { speechSynthesis.cancel(); } catch {} finish(); return;
          }
          died = true; sev('voice DIED after ' + spoke + ' of ' + text.length + ' characters — taking over'); liveUtterances.delete(u);
          try { speechSynthesis.cancel(); } catch {} finish(); return;
        }
        if (!speechSynthesis.speaking && !speechSynthesis.pending) { sev('voice finished ' + short + ' (no end event)'); liveUtterances.delete(u); finish(); }
      }, 300);
      kick = setTimeout(() => {
        if (started || done) return;
        if (ep !== speechEpoch) { finish(); return; } // STOP was pressed: don't retry
        // iOS sometimes skips the "started" event while it IS talking: never cut that off
        if (speechSynthesis.speaking && !speechSynthesis.pending) { started = true; sev('no start event, but it is talking — leaving it alone'); return; }
        sev('voice did not start — retrying');
        if (tries < 2) { try { speechSynthesis.cancel(); } catch {} cur = null; setTimeout(say, 500); } // iOS drops a speak() that comes right after cancel()
        else { speechNote = 'Speech is not starting — run Speech & sounds → Audio check'; setSub(); }
      }, 2000); // iOS normally starts within about half a second
    };
    speaking = true; setSub();
    // Anything still "talking" now is a leftover (we say one thing at a time): clear it so we don't queue behind it.
    if (speechSynthesis.speaking || speechSynthesis.pending) { sev('cleared leftover speech'); try { speechSynthesis.cancel(); } catch {} setTimeout(say, 150); }
    else say();
  });
}

// Gemini voice, streamed. The Worker passes the audio on piece by piece as Gemini makes it; we play each piece
// the moment it arrives, back to back, through Web Audio (the route the beeps use, which you can hear).
// Finished voices are kept, so the stall line, "Number 1…" and repeats are instant.
const voiceJobs = new Map();
// What has been spent today (Cloudflare's free allowance resets at 00:00 UTC), so you can see it coming.
const USAGE_KEY = 'cardAssistant.usage.v1';
const utcDay = () => new Date().toISOString().slice(0, 10);
const freshUsage = () => ({ day: utcDay(), dg: 0, cf: 0, gemini: 0, neurons: 0 });
let usage = (() => { try { const u = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}'); if (u.day === utcDay()) return { ...freshUsage(), ...u }; } catch {} return freshUsage(); })();
function addUsage(k, n) {
  if (usage.day !== utcDay()) usage = freshUsage();
  usage[k] = (usage[k] || 0) + n;
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(usage)); } catch {}
}
const neuronRate = (model) => (/aura-2/i.test(model) ? 2.73 : /aura/i.test(model) ? 1.36 : /melo/i.test(model) ? 0.02 : 1.5); // Cloudflare units per character (about)
function usageText() {
  const bits = [];
  if (usage.cf) bits.push('Cloudflare ' + usage.cf.toLocaleString() + ' characters ≈ ' + Math.round(usage.neurons).toLocaleString() + ' of 10,000 free units (' + Math.round(usage.neurons / 100) + '%)');
  if (usage.dg) bits.push('Deepgram ' + usage.dg.toLocaleString() + ' characters');
  if (usage.gemini) bits.push('Gemini voice ' + usage.gemini + ' lines');
  return 'Voice used today: ' + (bits.join(' · ') || 'nothing yet');
}
// Short lines (the stall line, "Number 1.", "Ready") are made once and kept on the phone, so they never cost anything again.
let vdbp = null;
function vdb() {
  if (!vdbp) vdbp = new Promise((res, rej) => { const r = indexedDB.open('cardAssistantVoice', 1); r.onupgradeneeded = () => r.result.createObjectStore('clips'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return vdbp;
}
async function clipGet(key) {
  const d = await vdb();
  return new Promise((res) => {
    const q = d.transaction('clips').objectStore('clips').get(key);
    q.onsuccess = () => { const v = q.result; if (!v) return res(null); const i16 = new Int16Array(v.pcm), f = new Float32Array(i16.length); for (let i = 0; i < f.length; i++) f[i] = i16[i] / 32768; res({ data: f, rate: v.rate, model: v.model }); };
    q.onerror = () => res(null);
  });
}
async function clipPut(key, job) {
  const total = job.chunks.reduce((a, c) => a + c.data.length, 0);
  if (!total || total > 24000 * 14) return;
  const i16 = new Int16Array(total); let o = 0;
  for (const c of job.chunks) for (let i = 0; i < c.data.length; i++) i16[o++] = Math.max(-32768, Math.min(32767, Math.round(c.data[i] * 32767)));
  const d = await vdb();
  await new Promise((res) => { const tx = d.transaction('clips', 'readwrite'), st = tx.objectStore('clips'); st.put({ pcm: i16.buffer, rate: job.chunks[0].rate, model: job.model || '', at: Date.now() }, key); const c = st.count(); c.onsuccess = () => { if (c.result > 150) st.clear(); }; tx.oncomplete = res; tx.onerror = res; });
}
async function clipClear() { const d = await vdb(); return new Promise((res) => { const tx = d.transaction('clips', 'readwrite'); tx.objectStore('clips').clear(); tx.oncomplete = res; tx.onerror = res; }); }

async function clipClear() { const d = await vdb(); return new Promise((res) => { const tx = d.transaction('clips', 'readwrite'); tx.objectStore('clips').clear(); tx.oncomplete = res; tx.onerror = res; }); }

let workerInfo = null; // what the Worker said about itself (version, Cloudflare voice connected?)
// Ask the Worker what it can do, so we never send a Cloudflare voice request to an old Worker
// (an old Worker would quietly pass it to Gemini and use up the Gemini quota).
async function checkWorker() {
  if (!S.workerUrl) return null;
  try {
    const r = await fetch(S.workerUrl.trim().replace(/\/$/, ''), { headers: { 'X-App-Token': S.token.trim() } });
    workerInfo = await r.json();
  } catch { return workerInfo; } // offline: leave things as they were
  engineDown.dg = workerInfo.dg ? '' : ((workerInfo.version || 1) < 8 ? 'needs the newest Worker (proxy.js)' : 'not set up (no DEEPGRAM_API_KEY secret)');
  if ((workerInfo.version || 1) < MIN_WORKER_VERSION) engineDown.cf = 'Worker is out of date — paste the new proxy.js into Cloudflare';
  else if (!workerInfo.ai) engineDown.cf = 'not connected — add a Workers AI binding to the Worker';
  else engineDown.cf = '';
  sev('Worker v' + (workerInfo.version || '?') + (workerInfo.ai ? ', Cloudflare voice connected' : ', no Cloudflare voice') + (workerInfo.dg ? ', Deepgram voice set up' : '') + ', answers: ' + (answerers().filter((w) => workerInfo[w === 'gemini' ? 'hasKey' : w]).join(' → ') || 'nobody has a key!'));
  renderAnswerBlocks();
  setSub();
  return workerInfo;
}
const engineDown = { dg: '', cf: '', gemini: '', device: '' }; // set when an engine can't be used this session (daily limit, not connected)
function netVoice() { return !!S.workerUrl; } // the voice chain (iPhone voice and/or online voices) is used when a Worker is set up
const isParallel = (e) => e === 'cf' || e === 'dg'; // these are cheap and quick enough to start all at once
const engineBackoff = { dg: 0, cf: 0, gemini: 0, device: 0 }, engineFails = { dg: 0, cf: 0, gemini: 0, device: 0 }; // temporary pauses (a failing voice isn't hammered)
function resetEngines() { for (const e of Object.keys(engineDown)) { engineDown[e] = ''; engineBackoff[e] = 0; engineFails[e] = 0; } }
function voiceOrder() { // your choice first, the others as backup. "iPhone voice": it first, the online voices only if it will not start.
  if (!S.workerUrl) return ['device']; // no Worker: only the iPhone voice is possible
  const net = ['dg', 'cf', 'gemini'];
  const pref = S.voiceEngine === 'device' ? ['device', ...net]
    : S.voiceEngine === 'auto' ? [...net, 'device']
    : [S.voiceEngine, ...net.filter((e) => e !== S.voiceEngine), 'device'];
  const list = pref.filter((e) => (e === 'device' ? (S.voiceEngine === 'device' || S.deviceFallback !== false) : !engineDown[e]));
  const live = list.filter((e) => Date.now() >= engineBackoff[e]);
  return live.length ? live : list; // if every voice is pausing, still try rather than stay silent
}
function quotaWaitMs(m) { // "retry in 53.3s" -> 53300
  const r = /retry in ([\d.]+h)?([\d.]+m)?([\d.]+s)?/i.exec(String(m || ''));
  if (!r) return 60000;
  return ((parseFloat(r[1] || 0) * 3600) + (parseFloat(r[2] || 0) * 60) + parseFloat(r[3] || 0)) * 1000 || 60000;
}
function isQuota(m) { return /quota|exceeded|rate.?limit|RESOURCE_EXHAUSTED|\b429\b|daily free allocation|neurons|\b4006\b|insufficient credits|\(HTTP 402\)/i.test(String(m || '')); }
const nextUtcMidnight = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
// Turn Google's long error texts into one short line.
function friendlyError(m) {
  m = String(m || '');
  if (/daily free allocation|neurons|\b4006\b/i.test(m)) return 'Cloudflare free daily limit used up (10,000 units) — resets at ' + nextUtcMidnight() + ' your time';
  if (/Deepgram/i.test(m) && /insufficient credits|\b402\b/i.test(m)) return 'Deepgram credit is used up — add credit, or use another voice';
  if (/Deepgram/i.test(m) && /\b40[13]\b|invalid credentials/i.test(m)) return 'Deepgram rejected the key — check the DEEPGRAM_API_KEY secret';
  if (isQuota(m)) {
    const what = /per day|PerDay/i.test(m) ? 'daily' : /per minute|PerMinute/i.test(m) ? 'per-minute' : '';
    const model = (/model: ([\w.\-]+)/.exec(m) || [])[1];
    const r = /retry in ([\d.]+h)?([\d.]+m)?([\d.]+s)?/i.exec(m);
    let wait = '';
    if (r && (r[1] || r[2] || r[3])) {
      const h = parseInt(r[1] || '0', 10), mi = parseInt(r[2] || '0', 10), se = Math.round(parseFloat(r[3] || '0'));
      wait = h ? ' — resets in ' + h + ' h ' + mi + ' m' : mi ? ' — resets in ' + mi + ' min' : ' — try again in ' + se + ' s';
    }
    return 'Gemini free ' + (what ? what + ' ' : '') + 'limit reached' + (model ? ' (' + model + ')' : '') + wait;
  }
  if (/no model worked/i.test(m)) return 'no Cloudflare voice model worked — ' + m.split('—').slice(1).join('—').trim().slice(0, 140);
  if (/deprecat|retired/i.test(m)) return 'voice model retired' + (/@cf\/[\w.\-\/]+/.exec(m) ? ' (' + /@cf\/[\w.\-\/]+/.exec(m)[0] + ')' : '') + ' — update the Worker (proxy.js)';
  return m.length > 160 ? m.slice(0, 157) + '…' : m;
}
// Say one line with the first voice that works; skip a voice for the rest of the session if it is out of quota.
async function playVoice(text, firstJob, more = false, ep = speechEpoch) {
  const errs = [];
  for (const eng of voiceOrder()) {
    if (ep !== speechEpoch) return; // STOP pressed
    if (eng === 'device') { // last resort: the iPhone's own voice (unlimited and free)
      holdLoop(true);
      try {
        const r = await speakDevice(text);
        if (ep !== speechEpoch) return;
        if (!r.failed) { if (/^Voice/.test(speechNote)) speechNote = ''; return; }
        if (r.started) { // it spoke part of it, then iOS cut it off: the online voice carries on from there, not from the start
          const rest = text.slice(Math.max(0, r.spokenChars)).trim();
          errs.push('iPhone voice stopped part-way');
          engineBackoff.device = Date.now() + 60000; sev('iPhone voice stopped after ' + r.spokenChars + ' characters — online voice continues; iPhone voice rests 1 min');
          if (!rest) return;
          text = rest; firstJob = null;
        } else {
          errs.push('iPhone voice did not start');
          engineBackoff.device = Date.now() + 60000; sev('iPhone voice did not start — using the online voices for the next minute');
        }
      }
      finally { releaseLoop(); }
      continue;
    }
    const tries = eng === 'gemini' ? [{ stream: true }, { stream: false }] : [{}, { retry: true }]; // Cloudflare / Deepgram: one more go if a piece times out
    for (const t of tries) {
      const job = (firstJob && !firstJob.failed && firstJob.engine === eng && t.stream !== false && !t.retry) ? firstJob : voiceJob(text, { engine: eng, ...t });
      try {
        await playJob(job, more, ep);
        if (/^Voice/.test(speechNote)) speechNote = '';
        return;
        engineFails[eng] = 0;
      } catch (e) {
        const msg = friendlyError(e.message), who = { dg: 'Deepgram', cf: 'Cloudflare', gemini: 'Gemini' }[eng];
        errs.push(who + ': ' + msg);
        sev(who + ' voice failed: ' + String(e.message).slice(0, 300));
        if (/not connected|not set up|out of date|DEEPGRAM_API_KEY/i.test(e.message) || (isQuota(e.message) && /per.?day|PerDay|daily|insufficient credits|\(HTTP 402\)/i.test(e.message))) { engineDown[eng] = msg; break; }
        if (isQuota(e.message)) { engineBackoff[eng] = Date.now() + Math.min(quotaWaitMs(e.message) + 2000, 120000); break; } // per-minute: wait it out
        if (++engineFails[eng] >= 2) { engineBackoff[eng] = Date.now() + 45000; engineFails[eng] = 0; sev(who + ' voice paused for 45 s after repeated failures'); break; }
      }
    }
  }
  if (ep !== speechEpoch) return;
  if (!errs.length) { // every voice was already ruled out this session: say why
    if (engineDown.dg && S.voiceEngine === 'dg') errs.push('Deepgram: ' + engineDown.dg);
    if (engineDown.cf) errs.push('Cloudflare: ' + engineDown.cf);
    if (engineDown.gemini) errs.push('Gemini: ' + engineDown.gemini);
  }
  speechNote = 'Voice failed — ' + (errs.join(' · ') || 'no voice available');
  await beepNow('failed');
}
function voiceJob(text, opts = {}) {
  text = cleanSpeech(text);
  const engine = opts.engine || voiceOrder().find((e) => e !== 'device') || 'cf';
  const stream = engine === 'gemini' && opts.stream !== false;
  const key = engine + '|' + (engine === 'cf' ? S.cfModel + '|' + S.cfVoice : engine === 'dg' ? S.dgVoice : S.ttsVoice + '|' + S.ttsModel) + '|' + text;
  const have = voiceJobs.get(key);
  if (have && !have.failed && !opts.nocache) return have;
  const job = { text, engine, chunks: [], done: false, failed: null, mode: '', t0: performance.now(), firstMs: 0, totalMs: 0, waiters: [] };
  const wake = () => { job.waiters.splice(0).forEach((f) => f()); };
  job.wait = () => new Promise((r) => job.waiters.push(r));
  voiceJobs.set(key, job);
  if (voiceJobs.size > 80) voiceJobs.delete(voiceJobs.keys().next().value);
  (async () => {
    const ctrl = new AbortController();
    let tm = setTimeout(() => ctrl.abort(), engine === 'gemini' ? 25000 : 15000); // time allowed until the first data
    const idle = () => { clearTimeout(tm); tm = setTimeout(() => ctrl.abort(), 12000); }; // then: no data for 12 s means stalled (a long piece may take longer than that in total)
    try {
      const cached = S.cacheClips !== false && !opts.nocache && text.length <= 160 ? await clipGet(key).catch(() => null) : null;
      if (cached) { // made before and kept on the phone: free and instant
        job.mode = 'saved on this phone'; job.model = cached.model || ''; job.firstMs = Math.round(performance.now() - job.t0);
        job.chunks.push({ data: cached.data, rate: cached.rate }); wake();
      } else {
      addUsage(engine === 'gemini' ? 'gemini' : engine, engine === 'gemini' ? 1 : text.length);
      const r = await fetch(S.workerUrl.trim().replace(/\/$/, ''), {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'X-App-Token': S.token.trim() },
        body: JSON.stringify(engine === 'cf' ? { tts: text, engine: 'cf', cfModel: S.cfModel, cfVoice: S.cfVoice } : engine === 'dg' ? { tts: text, engine: 'dg', dgVoice: S.dgVoice } : { tts: text, voice: S.ttsVoice, model: S.ttsModel, stream }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'HTTP ' + r.status); }
      const ct = r.headers.get('Content-Type') || '';
      job.model = r.headers.get('X-Cf-Model') || '';
      if (engine === 'cf') addUsage('neurons', text.length * neuronRate(job.model));
      if (/L16|pcm/i.test(ct) && r.body && r.body.getReader) {
        job.mode = 'streamed';
        const rate = +((/rate=(\d+)/.exec(ct) || [])[1] || 24000);
        const reader = r.body.getReader();
        let carry = null;
        for (;;) {
          const { done, value } = await reader.read();
          idle();
          if (value && value.length) {
            let bytes = value;
            if (carry) { const m = new Uint8Array(carry.length + bytes.length); m.set(carry); m.set(bytes, carry.length); bytes = m; carry = null; }
            if (bytes.length % 2) { carry = bytes.slice(bytes.length - 1); bytes = bytes.subarray(0, bytes.length - 1); }
            if (bytes.length) {
              const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), n = bytes.length / 2, f = new Float32Array(n);
              for (let i = 0; i < n; i++) f[i] = dv.getInt16(i * 2, true) / 32768;
              if (!job.firstMs) job.firstMs = Math.round(performance.now() - job.t0);
              job.chunks.push({ data: f, rate }); wake();
            }
          }
          if (done) break;
        }
      } else if (/audio/i.test(ct)) {
        job.mode = 'whole file';
        const ab = await r.arrayBuffer();
        const buf = await new Promise((res, rej) => audioCtx().decodeAudioData(ab, res, rej));
        job.firstMs = Math.round(performance.now() - job.t0);
        job.chunks.push({ data: buf.getChannelData(0), rate: buf.sampleRate }); wake();
      } else throw new Error('Worker is out of date — paste the new proxy.js into Cloudflare');
      if (!job.chunks.length) throw new Error('no audio came back');
      if (S.cacheClips !== false && text.length <= 160) clipPut(key, job).catch(() => {});
      }
    } catch (e) {
      job.failed = e.name === 'AbortError' ? new Error('timed out') : e;
      if (voiceJobs.get(key) === job) voiceJobs.delete(key);
    } finally { clearTimeout(tm); job.totalMs = Math.round(performance.now() - job.t0); job.done = true; wake(); }
  })();
  return job;
}
// Make sure Web Audio is really running before we play (iOS can leave it suspended or "interrupted").
async function ensureAudioRunning() {
  const c = audioCtx();
  audioQuiet = false;
  for (let i = 0; i < 4 && c.state !== 'running'; i++) { try { await c.resume(); } catch {} if (c.state !== 'running') await sleep(150); }
  if (c.state !== 'running') sev('Web Audio would not start (' + c.state + ')');
  return c;
}
// Play a voice as its pieces arrive, gap-free. Resolves after the last piece has played.
let voiceClock = 0; // when the previous piece of audio ends, so the next piece starts exactly then
async function playJob(job, more = false, ep = speechEpoch) {
  const c = await ensureAudioRunning();
  let i = 0, t = 0, any = false;
  for (;;) {
    if (ep !== speechEpoch) return; // STOP pressed
    while (i < job.chunks.length) {
      const ch = job.chunks[i++];
      const b = c.createBuffer(1, ch.data.length, ch.rate);
      b.getChannelData(0).set(ch.data);
      const src = c.createBufferSource(); src.buffer = b; src.connect(c.destination);
      liveSources.add(src); src.onended = () => liveSources.delete(src);
      if (!any) t = Math.max(c.currentTime + 0.05, voiceClock); else if (t < c.currentTime + 0.01) t = c.currentTime + 0.01;
      src.start(t); t += b.duration;
      if (!any) sev('voice "' + job.text.slice(0, 24) + '" — ' + (job.mode || '?') + (job.model ? ' [' + job.model.split('/').pop() + ']' : '') + ', first sound after ' + job.firstMs + ' ms');
      any = true;
    }
    if (job.done) break;
    await job.wait();
  }
  if (!any) throw job.failed || new Error('no audio');
  voiceClock = t;
  // Wait until the audio has really played (by the audio clock, which stops if iOS interrupts it), waking it if it was
  // interrupted. If another piece follows, come back a moment BEFORE this one ends so the next is already queued.
  const wantEnd = more ? t - 0.25 : t + 0.06;
  const guard = performance.now() + Math.max(2500, (t - c.currentTime) * 3000 + 4000);
  while (c.currentTime < wantEnd && performance.now() < guard && ep === speechEpoch) {
    if (c.state !== 'running' && c.state !== 'closed') { sev('Web Audio ' + c.state + ' while speaking — waking it'); await c.resume().catch(() => {}); }
    await sleep(80);
  }
}
function prewarmVoice() { // make the short fixed lines in advance (once ever: they are then kept on the phone)
  if (!netVoice() || voiceOrder()[0] === 'device') return; // the iPhone voice is instant and free: nothing to prepare
  const eng = voiceOrder().find((e) => e !== 'device'); if (!eng) return;
  voiceJob(S.stallLine, { engine: eng, stream: false });
  if (isParallel(eng)) for (let n = 1; n <= 6; n++) voiceJob('Number ' + n + '.', { engine: eng }); // Gemini: too few free requests to spare
}

// Must run inside a tap or key press: it "unlocks" speech and sound on iOS.
function unlockSpeech() {
  try {
    const u = new SpeechSynthesisUtterance('Ready');
    const v = speechSynthesis.getVoices().find((x) => x.voiceURI === S.voiceURI);
    if (v) u.voice = v;
    u.lang = (v && v.lang) || 'en-US'; u.volume = (S.sayReady && S.voiceEngine === 'device') ? 1 : 0.01;
    liveUtterances.add(u); u.onend = u.onerror = () => liveUtterances.delete(u);
    speechSynthesis.speak(u);
  } catch {}
  setAudioSession();
}
function setAudioSession() { // "playback" lets sound play even with the ringer switch on silent (iOS 16.4+)
  try { if (navigator.audioSession) navigator.audioSession.type = S.voiceEngine === 'device' ? deviceMode().session : (S.audioSessionMode === 'auto' ? 'auto' : 'playback'); } catch {}
}
function updateSpeechInfo() {
  $('speechInfo').textContent = 'Voices on this phone: ' + speechSynthesis.getVoices().length + (speechNote ? '\n⚠ ' + speechNote : '');
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
    keepAlive.addEventListener('pause', () => {
      if (loopPausedForSpeech || loopHold > 0) return; // our own pause, or iOS paused it for the voice: leave it
      sev('background sound paused by iOS');
      if (running) setTimeout(playLoop, 300);
    });
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
  playLoop();
  try { navigator.mediaSession.playbackState = 'playing'; } catch {}
  const action = { single: S.btnSingle, double: S.btnDouble, triple: S.btnTriple }[press];
  doAction(action, 'earbud-' + press);
}
function doAction(action, source) {
  if (!running) return;
  if (action === 'toggle') setArmed(!armed);
  else if (action === 'capture') forceCapture(source);
  else if (action === 'repeat') repeatLast();
  else if (action === 'stop') stopCurrent(source);
  else if (action === 'stopPause') stopCurrent(source, true);
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
let settleUntil = 0, restartingSince = 0, hiddenAt = 0;
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

async function startCamera(opts = {}) {
  if (camBusy) throw new Error('camera is busy');
  camBusy = true; restartingSince = Date.now();
  try { await openCamera(opts); } finally { camBusy = false; }
}
async function openCamera(opts = {}) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; track = null;
  if (!opts.fast) await sleep(200); // give iOS a moment to release the camera (skipped inside a tap, which must be quick)
  let v;
  if (safeMode) v = { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } };
  else {
    const [W, H] = S.res === 'max' ? [4032, 3024] : S.res.split('x').map(Number);
    v = { width: { ideal: W }, height: { ideal: H }, frameRate: { ideal: +S.camFps || 15 } };
    if (S.camId) v.deviceId = { exact: S.camId }; else v.facingMode = { ideal: 'environment' };
  }
  try {
    // iOS can leave getUserMedia hanging forever when it's called while the app is in the background or just coming
    // back: give up after 10 s (and throw away a camera that turns up late) so the next try isn't blocked behind it.
    const ask = navigator.mediaDevices.getUserMedia({ audio: false, video: v });
    let late = false;
    stream = await Promise.race([ask, sleep(10000).then(() => { late = true; const e = new Error('camera did not answer'); e.name = 'TimeoutError'; throw e; })]);
    ask.then((st) => { if (late) st.getTracks().forEach((t) => t.stop()); }, () => {});
  } catch (e) {
    if (S.camId && !safeMode && e.name !== 'NotAllowedError') { S.camId = ''; saveSettings(); return openCamera(opts); } // saved camera gone: fall back
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
  settleUntil = performance.now() + 1200; // let exposure and focus settle before anything is judged or read
  setupCamControls(caps);
  listCameras();
  prevGrey = null;
  $('camInfo').textContent = (t.label || 'Camera') + ' · ' + vid.videoWidth + '×' + vid.videoHeight + (safeMode ? ' · safe mode' : '');
}

// Tries again if the camera froze, went black, was stopped, or iOS blocked it after you left the app.
// iOS often refuses to give the camera back until you touch the page again, so when it refuses we show a
// "tap to reconnect" panel (any tap or key press then reconnects inside that gesture) and keep retrying quietly.
let camLost = false, autoRetries = 0, retryTimer = null;
async function restartCamera(reason) {
  if (restarting || camBusy || !running) return;
  if (reason === 'picture black' && Date.now() - lastRestartAt < 20000) return;
  restarting = true; restartingSince = Date.now(); clearTimeout(retryTimer);
  const gesture = /^(manual|tap|key)/.test(reason);
  // only a frozen/black/stopped camera that keeps failing falls back to 720p; coming back to the app never does
  const quick = !gesture && !/^(returned|page restored|auto)/.test(reason) && Date.now() - lastRestartAt < 30000;
  lastRestartAt = Date.now(); camRestarts++;
  camNote = 'Restarting camera (' + reason + ')…'; setSub();
  logCapture({ t: Date.now(), trigger: 'watchdog', status: 'camera', reply: 'Camera restarted: ' + reason, error: '', latencyMs: 0 });
  let lastErr = null;
  const plan = quick ? [true] : [false, false, true];
  for (let i = 0; i < plan.length; i++) {
    safeMode = plan[i];
    try {
      await startCamera({ fast: gesture && i === 0 });
      camNote = safeMode ? 'Camera in safe mode (720p)' : '';
      camLost = false; autoRetries = 0; showCamLost(false);
      prevGrey = null; stillCount = 0; restarting = false; lastRestartAt = Date.now(); setSub();
      return;
    } catch (e) {
      lastErr = e; camNote = 'Camera error: ' + (e.message || e.name); setSub();
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) break; // a lower resolution cannot fix a permission block
      await sleep(1200);
    }
  }
  safeMode = false; restarting = false; camLost = true;
  logCapture({ t: Date.now(), trigger: 'watchdog', status: 'camera', reply: 'Camera could not reconnect: ' + (lastErr ? lastErr.name + ' — ' + lastErr.message : ''), error: '', latencyMs: 0 });
  showCamLost(true, lastErr);
  // quiet background retries with longer gaps, then every 30 s for as long as the app is open
  const d = [3000, 6000, 12000, 20000][autoRetries++] || 30000;
  retryTimer = setTimeout(() => { if (camLost && !document.hidden) restartCamera('auto retry'); }, d);
}
function showCamLost(on, err) {
  $('camLost').hidden = !on;
  if (!on) return;
  $('camLostWhy').textContent = (err && err.name === 'NotAllowedError')
    ? 'iOS blocked the camera after you left the app.' : 'The camera did not come back.';
  camNote = 'Camera disconnected — tap the orange panel or press any key'; setSub();
}
function unstick() { // a restart that has hung (iOS paused it while the app was away) must not block the next one
  if ((restarting || camBusy) && restartingSince && Date.now() - restartingSince > 20000) { sev('camera restart was stuck — clearing it'); restarting = false; camBusy = false; }
}
function gestureReconnect() { unstick(); if (camLost && running && !restarting && !camBusy) restartCamera('tap'); }
document.addEventListener('click', gestureReconnect, true);
document.addEventListener('keydown', (e) => {
  unstick();
  if (!camLost || !running || restarting || camBusy || learning) return;
  e.preventDefault(); e.stopImmediatePropagation(); // this press reconnects the camera; it doesn't also arm / capture
  restartCamera('key');
}, true);

// Watchdog: runs on its own timer, separate from the capture loop.
setInterval(() => {
  unstick();
  if (!running || restarting || camBusy || camLost || document.hidden) return;
  const now = performance.now();
  if (now < settleUntil) return;
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
// ---------------------------------------------------------------- page detection
// Runs on the phone, on the small picture used for motion, so it costs no Gemini calls. It asks "is there a
// page / card in view?" without looking at text, so blurry pages, nearly blank pages and small index cards count.
const PAGE_PRESETS = {
  broad:  { minFill: 0.45, minContrast: 22, maxSat: 0.70, paleMean: 95, edgeDiv: 20, minL: 55, maxChroma: 15 },
  strict: { minFill: 0.70, minContrast: 45, maxSat: 0.40, paleMean: 130, edgeDiv: 10, minL: 80, maxChroma: 9 },
};
let lastPage = { present: true, frac: 0, bbox: null, reason: '', method: '' }, smoothBox = null;
let lastRGBA = null, learnEmpty = null, refCache = { key: '', ref: null };

function otsuThreshold(hist, n) {
  let sumAll = 0; for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = -1, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}
// Largest connected blob of "on" pixels in a mask (4-connected). Returns area, bounding box, member list.
function largestBlob(mask, w, h, sat) {
  const n = w * h, seen = new Uint8Array(n), stack = new Int32Array(n), order = new Int32Array(n);
  let ptr = 0, best = null;
  for (let s0 = 0; s0 < n; s0++) {
    if (!mask[s0] || seen[s0]) continue;
    const start = ptr; let sp = 0, area = 0, sumSat = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    stack[sp++] = s0; seen[s0] = 1;
    while (sp) {
      const q = stack[--sp]; order[ptr++] = q; area++; sumSat += sat[q];
      const x = q % w, y = (q / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; stack[sp++] = q - 1; }
      if (x < w - 1 && mask[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; stack[sp++] = q + 1; }
      if (y > 0 && mask[q - w] && !seen[q - w]) { seen[q - w] = 1; stack[sp++] = q - w; }
      if (y < h - 1 && mask[q + w] && !seen[q + w]) { seen[q + w] = 1; stack[sp++] = q + w; }
    }
    if (!best || area > best.area) best = { start, end: ptr, area, sumSat, x0, y0, x1, y1 };
  }
  return best ? { ...best, order } : null;
}
const normBox = (b, w, h) => ({ x0: b.x0 / w, y0: b.y0 / h, x1: (b.x1 + 1) / w, y1: (b.y1 + 1) / h });

// data = RGBA pixels (w×h). P = preset. ref = saved picture of the empty view (or null). minArea = smallest accepted
// share of the picture (0–1). Returns { present, frac, bbox, reason, method }.
function detectPage(data, w, h, P, ref, minArea) {
  const n = w * h, L = new Uint8Array(n), sat = new Uint8Array(n), hist = new Uint32Array(256);
  const cu = new Int16Array(n), cv = new Int16Array(n); // colour (red-green, yellow-blue): paper has ONE colour, a blanket has many
  let sum = 0, sumSat = 0;
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const r = data[i], g = data[i + 1], b = data[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
    L[j] = l; hist[l]++; sum += l;
    const sv = mx ? ((mx - mn) * 255 / mx) | 0 : 0; sat[j] = sv; sumSat += sv;
    cu[j] = r - g; cv[j] = ((r + g) >> 1) - b;
  }
  const mean = sum / n, meanSat = sumSat / n / 255;
  const pct = (q) => { let acc = 0; const t = Math.ceil(n * q); for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= t) return i; } return 255; };
  // Wide percentiles on purpose: a small index card covers only a few percent of the picture, and must not vanish into "flat".
  const p5 = pct(0.005), p10 = pct(0.10), p95 = pct(0.995);
  const no = (reason, method = 'auto') => ({ present: false, frac: 0, bbox: null, reason, method });
  // 1. a saved picture of the empty view: anything that differs from it is "something in the box"
  if (ref && ref.L.length === n) {
    const off = p10 - ref.p10, mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = Math.abs(L[i] - (ref.L[i] + off)) > 28 ? 1 : 0;
    const blob = largestBlob(mask, w, h, sat), frac = blob ? blob.area / n : 0;
    return frac >= minArea
      ? { present: true, frac, bbox: normBox(blob, w, h), reason: 'differs from the empty view', method: 'empty view' }
      : { present: false, frac, bbox: null, reason: 'matches the empty view', method: 'empty view' };
  }
  // 2. no empty view saved: look for a paper-like region (bright, plain, boxy, with a clear edge)
  if (mean < 20 && p95 < 60) return no('too dark');
  if (p95 - p5 < 28) { // flat picture: nothing stands out. A pale, plain picture is a blank page filling the view.
    const pale = mean >= P.paleMean && meanSat <= P.maxSat;
    return pale ? { present: true, frac: 1, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, reason: 'a pale page fills the view', method: 'auto' } : no('flat picture, no page');
  }
  const T = otsuThreshold(hist, n);
  let nf = 0, sf = 0, nb = 0, sb = 0;
  for (let i = 0; i < n; i++) { if (L[i] > T) { nf++; sf += L[i]; } else { nb++; sb += L[i]; } }
  if (!nf || !nb) return no('flat picture, no page');
  const contrast = sf / nf - sb / nb;
  if (contrast < P.minContrast) return no('nothing clearly brighter than the background');
  const mask = new Uint8Array(n); for (let i = 0; i < n; i++) mask[i] = L[i] > T ? 1 : 0;
  const blob = largestBlob(mask, w, h, sat);
  if (!blob) return no('no bright region');
  const frac = blob.area / n, bw = blob.x1 - blob.x0 + 1, bh = blob.y1 - blob.y0 + 1, fill = blob.area / (bw * bh);
  const avgSat = blob.sumSat / blob.area / 255;
  let lsum = 0, gsum = 0, gcount = 0, usum = 0, vsum = 0;
  for (let k = blob.start; k < blob.end; k++) {
    const q = blob.order[k]; lsum += L[q]; usum += cu[q]; vsum += cv[q];
    const x = q % w, y = (q / w) | 0;
    if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
    if (mask[q - 1] && mask[q + 1] && mask[q - w] && mask[q + w]) continue; // not on the edge of the region
    const gx = (L[q + 1] - L[q - 1]) / 2, gy = (L[q + w] - L[q - w]) / 2;
    gsum += Math.sqrt(gx * gx + gy * gy); gcount++;
  }
  const meanL = lsum / blob.area, edge = gcount ? gsum / gcount : Infinity;
  const u0 = usum / blob.area, v0 = vsum / blob.area; let dev = 0; // how much the colour wanders inside the region
  for (let k = blob.start; k < blob.end; k++) { const q = blob.order[k]; dev += Math.abs(cu[q] - u0) + Math.abs(cv[q] - v0); }
  const chroma = dev / blob.area / 2;
  const base = { frac, bbox: normBox(blob, w, h), method: 'auto', chroma: Math.round(chroma) };
  if (frac < minArea) return { ...base, present: false, reason: 'bright region is too small (' + (frac * 100).toFixed(1) + '%)' };
  if (fill < P.minFill) return { ...base, present: false, reason: 'bright region is not boxy' };
  if (avgSat > P.maxSat) return { ...base, present: false, reason: 'too colourful to be paper' };
  if (chroma > P.maxChroma) return { ...base, present: false, reason: 'several colours (' + Math.round(chroma) + '), paper is one plain colour' };
  if (meanL < P.minL) return { ...base, present: false, reason: 'region is too dim' };
  if (edge < contrast / P.edgeDiv) return { ...base, present: false, reason: 'soft glow, no clear edge' };
  return { ...base, present: true, reason: 'paper-like region' };
}
function pageSig(w, h) {
  const c = S.useCrop ? [S.crop.x, S.crop.y, S.crop.w, S.crop.h].map((v) => v.toFixed(3)).join(',') : 'full';
  return c + '|' + video.videoWidth + 'x' + video.videoHeight + '|' + w + 'x' + h;
}
function emptyRefFor(w, h) {
  const r = S.emptyRef;
  if (!r || r.sig !== pageSig(w, h) || r.w !== w || r.h !== h) return null;
  if (refCache.key !== r.b64) { try { const bin = atob(r.b64), L = new Uint8Array(bin.length); for (let i = 0; i < L.length; i++) L[i] = bin.charCodeAt(i); refCache = { key: r.b64, ref: { L, p10: r.p10 } }; } catch { return null; } }
  return refCache.ref;
}
let pageYes = 0, pageNo = 0, pageStable = false;
function detectCurrent() {
  if (S.pageDetect === 'off' || !lastRGBA) { pageYes = pageNo = 0; pageStable = false; return (lastPage = { present: true, frac: 0, bbox: null, reason: 'page detection is off', method: 'off' }); }
  const P = PAGE_PRESETS[S.pageDetect] || PAGE_PRESETS.broad;
  const minArea = Math.max(0.2, +S.minPagePct || 2, S.pageDetect === 'strict' ? 6 : 0) / 100;
  const raw = detectPage(lastRGBA.data, lastRGBA.w, lastRGBA.h, P, emptyRefFor(lastRGBA.w, lastRGBA.h), minArea);
  // One odd frame (a flicker, a hand passing) must not flip the answer: a page "appears" after 2 sightings in a
  // row and "goes" after 3 misses in a row.
  if (raw.present) { pageYes++; pageNo = 0; } else { pageNo++; pageYes = 0; }
  if (!pageStable && pageYes >= 2) pageStable = true;
  if (pageStable && pageNo >= 3) pageStable = false;
  lastPage = { ...raw, rawPresent: raw.present, present: pageStable };
  if (!pageStable && raw.present) lastPage.reason = 'seeing a page… (confirming)';
  return lastPage;
}
// "Learn empty view": averages a few pictures of the empty box and remembers them.
function startLearnEmpty() { learnEmpty = { left: 6, acc: null }; $('emptyInfo').textContent = 'Learning… keep the box empty and still.'; }
function feedLearnEmpty(g, w, h) {
  if (!learnEmpty) return;
  if (!learnEmpty.acc) learnEmpty.acc = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) learnEmpty.acc[i] += g[i];
  if (--learnEmpty.left > 0) return;
  const L = new Uint8Array(w * h), hist = new Uint32Array(256);
  for (let i = 0; i < L.length; i++) { L[i] = Math.round(learnEmpty.acc[i] / 6); hist[L[i]]++; }
  let acc = 0, p10 = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= L.length * 0.1) { p10 = i; break; } }
  let b64 = ''; for (let i = 0; i < L.length; i += 4096) b64 += String.fromCharCode.apply(null, L.subarray(i, i + 4096));
  S.emptyRef = { sig: pageSig(w, h), w, h, p10, b64: btoa(b64), at: Date.now() };
  saveSettings(); learnEmpty = null; refCache = { key: '', ref: null }; updateEmptyInfo();
}
function updateEmptyInfo() {
  const el = $('emptyInfo'); if (!el || learnEmpty) return;
  const r = S.emptyRef;
  if (!r) { el.textContent = 'No empty view saved: the app looks for a paper-like region by itself.'; return; }
  const ok = lastRGBA && r.sig === pageSig(lastRGBA.w, lastRGBA.h);
  el.textContent = 'Empty view saved ' + new Date(r.at).toLocaleTimeString() + (ok ? ' — in use (anything that differs counts as a page).' : ' — NOT in use: the crop box or camera changed, learn it again.');
}

// Motion: average brightness change per pixel (0–255) on a tiny 160px-wide copy.
function measureMotion(r) {
  const w = 160, h = Math.max(8, Math.round(160 * r.sh / r.sw));
  if (anCanvas.width !== w || anCanvas.height !== h) { anCanvas.width = w; anCanvas.height = h; prevGrey = null; }
  anCtx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
  const img = anCtx.getImageData(0, 0, w, h), d = img.data, g = new Float32Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  lastRGBA = { data: d, w, h };
  feedLearnEmpty(g, w, h);
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
let movedWhileBusy = false, skipNote = '', skipNoteAt = 0, readNote = '', softSince = 0, readCount = 0;
let lastMotion = 0, lastSharp = 0, checks = 0, checksAt = performance.now(), fpsShown = 0;
let last = { q: '', a: '', text: '' };
let loopTimer = null;

function setArmed(on) {
  armed = on;
  if (on) { if (phase !== 'busy') phase = 'watch'; stillCount = 0; collect = null; needChange = false; noneRetries = 0; tone('ready'); }
  else { if (phase !== 'busy') phase = 'idle'; collect = null; tone('disarmed'); }
  $('btnArm').innerHTML = armed ? '⏸ PAUSE AUTO<small>auto reads on — tap to pause</small>' : '▶ AUTO<small>auto reads paused — tap to start</small>';
  try { localStorage.setItem(RESUME_KEY, JSON.stringify({ at: Date.now(), armed })); } catch {}
  $('btnArm').classList.toggle('armed', armed);
  setSub();
}

function currentFps() {
  if (learnEmpty) return 8;
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
  if (performance.now() < settleUntil) { prevGrey = null; stillCount = 0; return; } // camera just (re)started: recalibrate first
  if (frozen) return; // picture frozen after a capture: no checking, nothing can trip a new read
  // Never act on a stale picture (a frozen feed would just be read again and again):
  if (hasRVFC && !document.body.classList.contains('showmode') && performance.now() - lastFrameAt > 2500) return;
  const r = cropRect();
  const motion = measureMotion(r);
  lastMotion = motion; checks++;
  const still = motion < S.motionThresh;
  const pg = detectCurrent(); // is there a page / card in view? (no Gemini call)
  if (motion > S.changeThresh && motion < 255) { needChange = false; softSince = 0; if (phase === 'busy') movedWhileBusy = true; } // card moved / changed

  if (phase === 'watch') {
    stillCount = still && pg.present ? stillCount + 1 : 0; // nothing is read until a page is in view and still
    if (!pg.present) softSince = 0;
    const allowed = !needChange && Date.now() >= nextAutoAt;
    if (allowed && stillCount >= S.stillFrames) {
      collect = { n: 0, best: -1, forced: false, source: 'auto', motion };
      phase = 'collect';
    }
  }
  if (phase === 'collect') {
    if (!collect.forced && (!still || !pg.present)) { phase = 'watch'; collect = null; stillCount = 0; }
    else {
      const sh = measureSharpness(r); lastSharp = sh;
      if (sh > collect.best) { collect.best = sh; grabBest(r); }
      collect.n++;
      if (collect.n >= (collect.forced ? 3 : S.windowFrames)) {
        const c = collect; collect = null;
        if (c.forced || c.best >= S.sharpMin) { softSince = 0; phase = 'busy'; handleCapture(c); }
        else {
          // A page IS in view but it is soft (blurry, or very little writing on it). Give the camera a moment to focus,
          // then send it anyway: a nearly blank card or a card with one word has few sharp edges but still counts.
          const waited = softSince ? Date.now() - softSince : 0;
          if (!softSince) softSince = Date.now();
          if (waited >= (+S.focusWaitSec || 0) * 1000) { softSince = 0; c.soft = true; phase = 'busy'; handleCapture(c); }
          else {
            skipNote = 'Page found — waiting for focus (sharpness ' + Math.round(c.best) + ', target ' + S.sharpMin + ')'; skipNoteAt = Date.now();
            phase = 'watch'; stillCount = S.stillFrames; // come straight back for another look
          }
        }
      }
    }
  } else if (checks % 3 === 0) {
    lastSharp = measureSharpness(r); // keeps the meter alive for tuning
  }
  updateMeters(still);
}

// STOP / RESET: silence everything, drop the read in progress, unfreeze the picture. The card that was being read is
// not read again until it changes. pauseAuto: also pause automatic reads.
let capEpoch = 0, capAbort = null, capTimers = [], lastForceAt = 0;
function stopCurrent(why = 'button', pauseAuto = false) {
  if (!running) return;
  capEpoch++;
  if (capAbort) { try { capAbort.abort(); } catch {} capAbort = null; }
  capTimers.forEach((t) => { clearTimeout(t); clearInterval(t); }); capTimers = [];
  stopAllAudio();
  unfreezeView();
  collect = null; softSince = 0; noneRetries = 0; stillCount = 0; movedWhileBusy = false;
  needChange = true; nextAutoAt = Date.now() + 800;
  phase = armed ? 'watch' : 'idle';
  if (pauseAuto && armed) setArmed(false); else beepNow('disarmed');
  logCapture({ t: Date.now(), trigger: String(why), status: 'stopped', reply: pauseAuto ? 'Stopped + auto reads paused' : 'Stopped / reset', error: '', latencyMs: 0 });
  setSub();
}
function forceCapture(source = 'button') {
  if (!running) return;
  if (phase === 'busy' || frozen || speaking) {
    // A button press wins over whatever is happening (an auto read, an answer being spoken): stop it and read now.
    if (!S.pressOverrides || Date.now() - lastForceAt < 800) return;
    stopCurrent('capture override (' + source + ')');
  }
  lastForceAt = Date.now();
  collect = { n: 0, best: -1, forced: true, source, motion: lastMotion };
  phase = 'collect';
  loop();
}

// ---------------------------------------------------------------- one capture -> Gemini -> speech
async function handleCapture(c) {
  const my = capEpoch;
  try { await runCapture(c, my); }
  catch (e) { // whatever goes wrong, never leave the app stuck on "busy"
    console.warn(e);
    if (my !== capEpoch) return; // STOP was pressed: it has already tidied up
    logCapture({ t: Date.now(), trigger: c.source, status: 'fail', sharp: Math.round(c.best), motion: +(c.motion || 0).toFixed(1),
                 error: 'App error: ' + e.message, reply: '', latencyMs: 0 });
    try { await tone('failed'); await speak(S.stallLine); } catch {}
    finish(true);
  }
}

// After a capture the picture freezes (shows the photo that was sent) and checking stops, until the answer
// arrives or has been spoken. When it unfreezes, the next picture is compared with the one from BEFORE the
// freeze: same card -> nothing happens; a new card -> it is read.
let frozen = false;
function freezeView() {
  if (S.freezeMode === 'off' || !video.videoWidth) return;
  try {
    const c = document.createElement('canvas'), w = 480;
    c.width = w; c.height = Math.round(w * video.videoHeight / video.videoWidth);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    $('frozenShot').src = c.toDataURL('image/jpeg', 0.7);
  } catch {}
  $('frozenShot').hidden = false; $('frozenTag').hidden = false;
  $('frozenTag').textContent = S.freezeMode === 'answer' ? '❄ Frozen until the answer arrives' : '❄ Frozen until the answer is spoken';
  frozen = true;
}
function unfreezeView() {
  if (!frozen) return;
  frozen = false; $('frozenShot').hidden = true; $('frozenTag').hidden = true;
  stillCount = 0;
}

async function runCapture(c, my) {
  const gone = () => my !== capEpoch; // STOP (or a new button capture) took over
  capAbort = new AbortController();
  freezeView();
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
    pagePct: Math.round((lastPage.frac || 0) * 100), pageNote: lastPage.reason || '', soft: !!c.soft,
  };
  readCount++;
  setState('thinking');
  const timeoutMs = ((+S.timeoutSec || 8) + (S.lateAnswer ? (+S.lateSec || 0) : 0)) * 1000;
  const pending = callWorker(dataUrl, timeoutMs, capAbort); // send first, beep while it uploads
  tone('thinking');

  let ticker = S.thinkTicks ? setInterval(() => tone('thinking'), 2000) : null;
  let stalled = false;
  const stallTimer = setTimeout(async () => {
    if (gone()) return;
    stalled = true; clearInterval(ticker); ticker = null;
    setState('stalling');
    await tone('failed'); speak(S.stallLine);
  }, (+S.timeoutSec || 8) * 1000);
  capTimers = [stallTimer, ticker];

  const res = await pending;
  clearTimeout(stallTimer); clearInterval(ticker); capTimers = [];
  if (gone()) return; // stopped while thinking: say nothing
  capAbort = null;
  if (S.freezeMode === 'answer') unfreezeView();
  entry.latencyMs = Math.round(performance.now() - t0);
  entry.geminiMs = res.geminiMs; entry.model = res.model || ''; entry.attempts = res.attempts;
  entry.reply = res.text || ''; entry.error = res.error || '';

  const parsed = res.ok ? parseReply(res.text) : null;
  let next; // what to do once the entry is logged
  readNote = !res.ok && isQuota(res.error) ? 'Card reading: ' + friendlyError(res.error) + ' — add more models or turn on billing' : '';
  if (!res.ok) { entry.status = 'fail'; next = 'stall'; }
  else if (!parsed) {
    if (c.source === 'auto' && noneRetries < (+S.retryNone || 0) && !stalled) { entry.status = 'none-retry'; next = 'retry'; }
    else { entry.status = 'none'; next = 'stall'; }
  } else if (c.source === 'auto' && parsed.q && parsed.q === last.q && !stalled) { entry.status = 'duplicate'; next = 'skip'; }
  else {
    entry.status = stalled ? 'late-answer' : 'answer'; next = 'speak';
    entry.items = parsed.items.length;
    last = { q: parsed.q, a: parsed.a, items: parsed.items, text: res.text };
    if (netVoice() && isParallel(voiceOrder()[0])) itemTexts(parsed.items).forEach((t) => voiceChunks(t).forEach((c) => voiceJob(c, { engine: voiceOrder()[0] }))); // start making the voice now
  }
  logCapture(entry); // logged BEFORE speaking, so it is saved even if something interrupts the speech
  showLast(entry);

  if (next === 'retry') { noneRetries++; finish(false, true); } // try again with the next still window
  else if (next === 'stall') { if (!stalled) { await tone('failed'); if (gone()) return; await speak(S.stallLine); } if (!gone()) finish(true); }
  else if (next === 'skip') finish(true);
  else {
    await speechChain; // let the stall line finish first
    if (gone()) return;
    await tone('answer');
    if (gone()) return;
    await speakItems(parsed.items);
    if (!gone()) finish(true);
  }
}

function finish(waitForChange, retry = false) {
  const wasFrozen = frozen;
  unfreezeView();
  if (!retry) noneRetries = 0;
  needChange = waitForChange && (wasFrozen || !movedWhileBusy); // while frozen we did not watch; the next picture decides
  movedWhileBusy = false;
  nextAutoAt = Date.now() + (retry ? 500 : (+S.cooldownSec || 0) * 1000);
  stillCount = 0;
  phase = armed ? 'watch' : 'idle';
  setSub();
}

// Reads "Q1: … / A1: … / Q2: … / A2: …" (or plain "Q:/A:", or unlabeled text) into a list of items.
function parseReply(text) {
  text = String(text || '').trim();
  if (!text || /^\W*NONE\W*$/i.test(text) || /^NONE\b/i.test(text)) return null;
  const items = []; let cur = null, field = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim(); if (!line || /^[-=_*~\s]{3,}$/.test(line)) continue; // blank lines and ---- rules
    let m;
    if ((m = line.match(/^\W*Q\s*\d*\s*:\s*(.*)$/i))) { cur = { q: unmark(m[1]), a: '' }; items.push(cur); field = 'q'; }
    else if ((m = line.match(/^\W*A\s*\d*\s*:\s*(.*)$/i))) {
      if (!cur || cur.a) { cur = { q: '', a: '' }; items.push(cur); }
      cur.a = unmark(m[1]); field = 'a';
    } else if (cur && field) cur[field] = (cur[field] ? cur[field] + ' ' : '') + unmark(line);
    else { cur = { q: '', a: line, pre: !items.length || items.every((x) => x.pre) }; items.push(cur); field = 'a'; } // no labels at all: it's the answer
  }
  const labeled = items.some((it) => !it.pre);
  const good = items.filter((it) => it.a && !/^NONE\.?$/i.test(it.a) && !(labeled && it.pre)); // text before the first Q1: is just an introduction
  if (!good.length) return null;
  return { q: good.map((it) => it.q).filter(Boolean).join(' | '), a: displayItems(good), items: good };
}
function unmark(t) { return String(t).replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim(); } // drop **bold** marks etc.
function displayItems(items) {
  if (items.length === 1) return items[0].a;
  return items.map((it, i) => (i + 1) + '. ' + (it.q ? it.q + '\n→ ' : '') + it.a).join('\n\n');
}
// Longest thing we will speak in one go (characters). Keeps the free voice allowance going and the show moving.
let lastBudgetNote = 0;
function budgetTexts(list) {
  // The cap exists to protect the tiny free allowances (Cloudflare, Gemini). Deepgram and the iPhone voice read everything.
  const first = netVoice() ? voiceOrder()[0] : 'device';
  const max = (first === 'cf' || first === 'gemini') ? (+S.maxVoiceChars || 0) : 0; if (!max) return list;
  const out = []; let total = 0;
  for (const t of list) {
    if (total + t.length <= max) { out.push(t); total += t.length; continue; }
    const room = max - total;
    if (room > 60) { const cut = t.lastIndexOf('. ', room); out.push(cut > 30 ? t.slice(0, cut + 1) : t.slice(0, room)); }
    if (Date.now() - lastBudgetNote > 3000) sev('answer shortened to fit the ' + max + '-character voice limit');
    lastBudgetNote = Date.now();
    break;
  }
  return out;
}
function itemTexts(items) { // exactly what gets spoken, in order
  const many = items.length > 1, out = [], gem = netVoice() && isParallel(voiceOrder()[0]); // separate ready-made "Number 1." only with the Cloudflare / Deepgram voice
  items.forEach((it, i) => {
    const lead = many ? 'Number ' + (i + 1) + '.' : '';
    if (gem && lead) out.push(lead); // ready-made, plays instantly while the answer is being voiced
    const pre = !gem && lead ? lead + ' ' : '';
    if (S.speakQuestion && it.q) { out.push(pre + it.q); out.push(it.a); } else out.push(pre + it.a);
  });
  return budgetTexts(out);
}
function speakItems(items) { itemTexts(items).forEach((t) => speak(t)); return speechChain; }

function answerers() { return S.answerOrder.filter((w) => S.answerOn[w]); }
async function callWorker(dataUrl, timeoutMs, outer) {
  if (!S.workerUrl) return { ok: false, error: 'No Worker URL set' };
  const models = String(S.models || '').split(',').map((m) => m.trim()).filter(Boolean);
  const generationConfig = { temperature: Math.min(2, Math.max(0, +S.geminiTemp || 0)), maxOutputTokens: Math.max(256, +S.maxTokens || 1024) };
  const groq = { temperature: Math.min(2, Math.max(0, +S.groqTemp || 0)), maxTokens: Math.max(64, Math.min(8192, +S.groqMaxTokens || 2548)) };
  if (S.groqReasoning) groq.reasoningEffort = S.groqReasoning;
  const claude = { effort: S.claudeEffort || 'medium', maxTokens: Math.max(1024, Math.min(32000, +S.claudeMaxTokens || 16000)) };
  const claudeModels = String(S.claudeModels || '').split(',').map((m) => m.trim()).filter(Boolean);
  if (S.mediaResolution) generationConfig.mediaResolution = S.mediaResolution;
  if (S.thinking === 'budget0') generationConfig.thinkingConfig = { thinkingBudget: 0 };
  else if (S.thinking) generationConfig.thinkingConfig = { thinkingLevel: S.thinking };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs + 1500);
  if (outer) outer.signal.addEventListener('abort', () => ctrl.abort());
  const groqModels = String(S.groqModels || '').split(',').map((m) => m.trim()).filter(Boolean);
  try {
    const r = await fetch(S.workerUrl.trim().replace(/\/$/, ''), {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-App-Token': S.token.trim() },
      body: JSON.stringify({ image: dataUrl, prompt: S.prompt + (S.allItems ? '' : '\n\nOnly handle the FIRST item on the card, nearest the top.') + (S.style && S.style.trim() ? '\n\nExtra instructions from the performer: ' + S.style.trim() : ''), models, generationConfig, timeoutMs, answerers: answerers(), groq, claude, ...(claudeModels.length ? { claudeModels } : {}), ...(groqModels.length ? { groqModels } : {}) }),
    });
    const j = await r.json().catch(() => ({ error: 'Bad reply from Worker (HTTP ' + r.status + ')' }));
    return { ...j, ok: r.ok && !j.error };
  } catch (e) {
    return { ok: false, cancelled: !!(outer && outer.signal.aborted), error: e.name === 'AbortError' ? (outer && outer.signal.aborted ? 'Stopped' : 'Timed out') : 'Network error: ' + e.message };
  } finally { clearTimeout(timer); }
}

function repeatLast() {
  if (last.items && last.items.length) { tone('answer').then(() => speakItems(last.items)); }
  else if (last.a) { tone('answer').then(() => speak(last.a)); }
  else tone('failed');
}

// ---------------------------------------------------------------- UI updates
const STATE_STYLE = {
  off: ['Not started', '#555'], idle: ['Auto paused', '#777'], watch: ['Auto on — watching', '#4caf50'],
  collect: ['Card still — picking sharpest', '#ffb300'], captured: ['Captured', '#ffb300'],
  thinking: ['Thinking…', '#4fa3ff'], stopped: ['Stopped', '#777'], stalling: ['Slow — stall line', '#ff5252'],
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
  if (speaking) bits.push(speakProg && speakProg.n > 1 ? 'speaking ' + speakProg.i + ' of ' + speakProg.n : 'speaking');
  if (armed && phase === 'watch' && !lastPage.present && !needChange && S.pageDetect !== 'off') bits.push('no page in view (' + lastPage.reason + ')');
  if (readNote) bits.push('⚠ ' + readNote);
  if (speechNote) bits.push('⚠ ' + speechNote);
  $('sub').textContent = bits.join(' · ');
}
function updateMeters(still) {
  const now = performance.now();
  if (now - checksAt > 2000) { fpsShown = checks * 1000 / (now - checksAt); checks = 0; checksAt = now; updateEmptyInfo(); }
  if (document.body.classList.contains('showmode')) return; // nothing to draw
  $('mMotion').textContent = lastMotion >= 255 ? '–' : lastMotion.toFixed(1);
  $('mMotion').style.color = still ? 'var(--ok)' : 'var(--fg)';
  $('barMotion').style.width = Math.min(100, lastMotion / (S.changeThresh * 2) * 100) + '%';
  $('mSharp').textContent = Math.round(lastSharp);
  $('mSharp').style.color = lastSharp >= S.sharpMin ? 'var(--ok)' : 'var(--fg)';
  $('barSharp').style.width = Math.min(100, lastSharp / (S.sharpMin * 3 || 1) * 100) + '%';
  $('mStill').textContent = stillCount + '/' + S.stillFrames;
  $('mFps').textContent = fpsShown ? fpsShown.toFixed(1) : '–';
  const pm = $('mPage'); pm.textContent = S.pageDetect === 'off' ? 'off' : lastPage.present ? '✓ ' + Math.round(lastPage.frac * 100) + '%' : '✕';
  pm.style.color = S.pageDetect !== 'off' && lastPage.present ? 'var(--ok)' : 'var(--fg)';
  const pb = $('pageBox');
  let bb = lastPage.present && S.pageDetect !== 'off' && lastPage.bbox;
  if (bb) { // ease the outline toward the new box instead of jumping
    smoothBox = smoothBox ? { x0: smoothBox.x0 + (bb.x0 - smoothBox.x0) * 0.5, y0: smoothBox.y0 + (bb.y0 - smoothBox.y0) * 0.5, x1: smoothBox.x1 + (bb.x1 - smoothBox.x1) * 0.5, y1: smoothBox.y1 + (bb.y1 - smoothBox.y1) * 0.5 } : { ...bb };
    bb = smoothBox;
  } else smoothBox = null;
  if (bb && !(bb.x0 <= 0.001 && bb.y0 <= 0.001 && bb.x1 >= 0.999 && bb.y1 >= 0.999)) {
    const c = S.useCrop ? S.crop : { x: 0, y: 0, w: 1, h: 1 };
    pb.style.left = (c.x + bb.x0 * c.w) * 100 + '%'; pb.style.top = (c.y + bb.y0 * c.h) * 100 + '%';
    pb.style.width = (bb.x1 - bb.x0) * c.w * 100 + '%'; pb.style.height = (bb.y1 - bb.y0) * c.h * 100 + '%'; pb.hidden = false;
  } else pb.hidden = true;
  $('readsInfo').textContent = 'Cards read this session: ' + readCount;
  $('usageInfo').textContent = usageText();
  $('pageWhy').textContent = S.pageDetect === 'off' ? 'Page detection is off.' : 'Page: ' + (lastPage.present ? '✓ ' : '✕ ') + lastPage.reason + (lastPage.method === 'empty view' ? ' [vs empty view]' : '') + (lastPage.chroma != null ? ' · colour spread ' + lastPage.chroma : '');
  renderState(); setSub();
}
let lastFull = null, readerPx = 28;
function showLast(e) {
  const isAns = e.status === 'answer' || e.status === 'late-answer';
  const info = new Date(e.t).toLocaleTimeString() + ' · ' + (e.latencyMs / 1000).toFixed(1) + ' s · sharp ' + e.sharp +
    ' · ' + e.kb + ' KB · ' + (e.model || '');
  $('lastQ').textContent = last.q ? 'Card: ' + last.q : '';
  $('lastA').textContent = isAns ? last.a : '(' + e.status + ') ' + friendlyError(e.error || e.reply || '');
  if (isAns && last.items && last.items.length > 1) $('lastQ').textContent = last.items.length + ' items on this card';
  $('lastInfo').textContent = info;
  lastFull = { card: isAns && last.items && last.items.length > 1 ? last.items.length + ' items' : last.q, answer: isAns ? last.a : '', raw: e.reply || e.error || '', status: e.status, info };
  if (!$('reader').hidden) renderReader();
}
function renderReader() {
  const f = lastFull || { card: '', answer: '', raw: '', info: '', status: '' };
  $('rCard').textContent = f.card ? 'Card: ' + f.card : '';
  $('rAnswer').textContent = f.answer || '(' + (f.status || 'nothing yet') + ')';
  $('rAnswer').style.fontSize = readerPx + 'px';
  $('rRaw').textContent = f.raw || '';
  $('rInfo').textContent = f.info || '';
}
function openReader() { renderReader(); $('reader').hidden = false; }
function closeReader() { $('reader').hidden = true; }
$('btnReader').onclick = openReader; $('lastA').onclick = openReader; $('rClose').onclick = closeReader;
$('rBig').onclick = () => { readerPx = Math.min(64, readerPx + 4); renderReader(); };
$('rSmall').onclick = () => { readerPx = Math.max(14, readerPx - 4); renderReader(); };

// ---------------------------------------------------------------- buttons
$('btnStart').onclick = async () => {
  if (running) return;
  $('btnStart').disabled = true; $('sub').textContent = 'Starting camera…';
  // These must happen inside a tap on iOS to unlock sound and speech:
  audioCtx(); unlockSpeech(); // iOS ignores speech until the page has spoken once DURING a tap, so always do it here (silently, unless the iPhone voice is chosen)
  setupMediaSession();
  try { await startCamera(); }
  catch (e) {
    $('sub').textContent = 'Camera error: ' + e.message; $('btnStart').disabled = false; return;
  }
  running = true; phase = 'idle';
  await requestWakeLock();
  ['btnArm', 'btnForce', 'btnRepeat', 'btnStop', 'btnShow', 'btnCam'].forEach((id) => { $(id).disabled = false; });
  $('resumeBox').hidden = true;
  $('btnStart').innerHTML = '● RUNNING<small>camera on</small>';
  $('btnStart').classList.remove('pri'); $('btnStart').classList.add('running');
  $('placeholder').style.display = 'none';
  $('stage').classList.add('on');
  drawCropBox();
  await tone('start');
  if (netVoice()) { await checkWorker(); prewarmVoice(); if (S.sayReady && isParallel(voiceOrder()[0])) speak('Ready'); }
  if (S.autoArm || resumeArmed) setArmed(true);
  resumeArmed = false;
  loop();
};
$('btnArm').onclick = () => setArmed(!armed);
$('btnStop').onclick = () => stopCurrent('button');
(function stopLongPress() { // hold STOP for ~0.7 s: stop AND pause automatic reads
  let t = null, held = false;
  const b = $('btnStop');
  b.addEventListener('pointerdown', () => { held = false; t = setTimeout(() => { held = true; stopCurrent('button (held)', true); }, 700); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => clearTimeout(t)));
  b.addEventListener('click', (e) => { if (held) { e.stopImmediatePropagation(); held = false; } }, true);
})();
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
$('btnLearnEmpty').onclick = () => { if (!running) { $('emptyInfo').textContent = 'Tap START first, then learn the empty view.'; return; } startLearnEmpty(); };
$('btnClearClips').onclick = async () => { await clipClear(); voiceJobs.clear(); $('clipInfo').textContent = 'Saved voice clips forgotten.'; };
$('btnClearEmpty').onclick = () => { S.emptyRef = null; saveSettings(); refCache = { key: '', ref: null }; updateEmptyInfo(); };
$('btnTestVoice').onclick = () => {
  audioCtx(); setAudioSession(); speechNote = '';
  speak('This is how answers will sound in your earbud.').then(updateSpeechInfo); updateSpeechInfo();
};
// ---------------------------------------------------------------- audio check
// Plays a beep and four numbered voices; you tick which you heard and the app switches to what works.
let acReport = '';
let acTests = [];
async function runAudioCheck() {
  audioCtx(); unlockSpeech(); // inside the tap, so iOS allows sound and speech
  const out = $('acOut'), lines = [];
  const log = (t) => { lines.push(t); out.textContent = lines.join('\n'); acReport = lines.join('\n'); };
  const banner = (t) => { $('acBanner').textContent = t; };
  $('acHeard').hidden = true; $('btnAudioCheck').disabled = true; $('acMsg').textContent = '';
  log('App ' + APP_VERSION + ' · ' + (navigator.userAgent.match(/(iPhone|iPad)[^;)]*|OS [\d_]+|Version\/[\d.]+/g) || [navigator.userAgent.slice(0, 60)]).join(' · '));
  await speechChain; // don't talk over an answer that is still being spoken
  await checkWorker();
  const c = await ensureAudioRunning();
  log('Audio mode: ' + (navigator.audioSession ? navigator.audioSession.type : 'not supported') + ' · Web Audio: ' + c.state +
      ' · background sound: ' + (keepAlive && !keepAlive.paused ? 'playing' : 'off') + ' · camera: ' + (track && track.readyState === 'live' ? 'on' : 'off'));
  log(usageText());
  // Which voices to try: only ones that can work. (Gemini voice only if you chose it: its free limit is about 10 lines a day.)
  acTests = [{ kind: 'beep', name: 'Beep' }];
  if (S.workerUrl && workerInfo) {
    if (workerInfo.dg) acTests.push({ kind: 'dg', name: 'Deepgram voice' });
    if (workerInfo.ai) acTests.push({ kind: 'cf', name: 'Cloudflare voice' });
    if (S.voiceEngine === 'gemini') acTests.push({ kind: 'gemini', name: 'Gemini voice' });
  }
  acTests.push({ kind: 'device', name: 'iPhone voice' });
  acTests.forEach((t, i) => { t.n = i + 1; });
  const total = acTests.length, names = ['', 'One', 'Two', 'Three', 'Four', 'Five'];
  for (const t of acTests) {
    banner(t.n + ' of ' + total + ' — ' + t.name);
    if (t.kind === 'beep') { await beepNow('answer'); await sleep(600); log('1. Beep — played (Web Audio ' + c.state + ')'); continue; }
    if (t.kind === 'device') {
      holdLoop(true); // same set-up as a real answer (set-up 4 turns the background sound off while it talks)
      let r; try { r = await speakDeviceNow(names[t.n] + '. iPhone voice.'); } finally { releaseLoop(); }
      log(t.n + '. iPhone voice — ' + (r.started ? 'started' + (r.error ? ', then error: ' + r.error : ' and finished') : 'did NOT start' + (r.error ? ' (' + r.error + ')' : '')));
      await wakeAudio(); continue;
    }
    try {
      const job = voiceJob(names[t.n] + '. ' + t.name + '.', { engine: t.kind, stream: t.kind === 'gemini', nocache: true });
      await playJob(job);
      log(t.n + '. ' + t.name + (job.model ? ' (' + job.model + ')' : '') + ' — played, ' + job.mode + ', first sound after ' + job.firstMs + ' ms');
    } catch (e) { log(t.n + '. ' + t.name + ' — FAILED: ' + friendlyError(e.message)); }
    await sleep(300);
  }
  const list = $('acHeardList'); list.innerHTML = '';
  for (const t of acTests) { const l = document.createElement('label'); l.className = 'chk'; l.innerHTML = '<input type="checkbox" id="acH' + t.n + '"> ' + t.n + ' — ' + t.name.toLowerCase(); list.appendChild(l); }
  banner('Done — tick the numbers you heard'); $('acHeard').hidden = false; $('btnAudioCheck').disabled = false;
}
// ---------------------------------------------------------------- iPhone voice lab
let labReport = '';
async function applyDeviceMode(v) {
  try { if (navigator.audioSession) navigator.audioSession.type = v.session; } catch {}
  if (v.loop === 'play') { loopPausedForSpeech = false; if (keepAlive && keepAlive.paused) await keepAlive.play().catch(() => {}); }
  else if (keepAlive && !keepAlive.paused) { loopPausedForSpeech = true; keepAlive.pause(); }
  if (v.wa === 'run') { audioQuiet = false; await ensureAudioRunning(); } else quietWebAudio();
  await sleep(300);
}
async function runLab() {
  audioCtx(); unlockSpeech(); // inside the tap
  const out = $('labOut'), lines = [];
  const log = (t) => { lines.push(t); out.textContent = lines.join('\n'); labReport = lines.join('\n'); };
  const banner = (t) => { $('labBanner').textContent = t; };
  $('labHeard').hidden = true; $('btnLab').disabled = true; $('labMsg').textContent = '';
  const prev = S.deviceMode, names = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'], LONG = ' This is a longer sentence to see whether the voice survives past three seconds. It keeps going with a few more words, and then it stops. Now the last short one.';
  log('App ' + APP_VERSION + ' · ' + (navigator.userAgent.match(/(iPhone|iPad)[^;)]*|OS [\d_]+|Version\/[\d.]+/g) || [navigator.userAgent.slice(0, 60)]).join(' · '));
  log('Audio mode: ' + (navigator.audioSession ? navigator.audioSession.type : 'not supported') + ' · voices: ' + speechSynthesis.getVoices().length + ' · camera: ' + (track && track.readyState === 'live' ? 'on' : 'off'));
  await speechChain;
  if (speechSynthesis.speaking || speechSynthesis.pending) { try { speechSynthesis.cancel(); } catch {} await sleep(500); } // iOS drops a speak() that comes right after cancel()
  await ensureAudioRunning();
  for (const v of LAB_VARIANTS) {
    banner('Voice ' + v.id + ' of ' + LAB_VARIANTS.length + ' — ' + v.label);
    S.deviceMode = v.id; // speakDeviceNow plays in whatever set-up this says
    holdLoop(true);
    await applyDeviceMode(v);
    const txt = 'Voice ' + names[v.id] + '.' + LONG, r = v.chunk ? await speakDevice(txt) : await speakDeviceNow(txt);
    releaseLoop();
    log(v.id + '. ' + v.label + ' — ' + (r.died ? 'DIED after ' + (r.spokenChars || 0) + ' of ' + txt.length + ' characters' : r.started ? 'started' + (r.error ? ', then error: ' + r.error : ' and finished (' + txt.length + ' characters)') : 'did NOT start' + (r.error ? ' (' + r.error + ')' : '')));
    await sleep(900);
  }
  S.deviceMode = prev; setAudioSession(); await wakeAudio(); playLoop();
  const list = $('labList'); list.innerHTML = '';
  for (const v of LAB_VARIANTS) { const l = document.createElement('label'); l.className = 'chk'; l.innerHTML = '<input type="checkbox" id="labH' + v.id + '"> ' + v.id + ' — ' + v.label; list.appendChild(l); }
  banner('Done — tick the numbers you heard'); $('labHeard').hidden = false; $('btnLab').disabled = false;
}
function syncInputs(keys) {
  for (const k of keys) { const el = document.querySelector('[data-k=' + k + ']'); if (!el) continue; if (el.type === 'checkbox') el.checked = !!S[k]; else el.value = S[k]; }
}
$('btnAudioCheck').onclick = () => { runAudioCheck().catch((e) => { $('acBanner').textContent = 'Audio check error: ' + e.message; $('btnAudioCheck').disabled = false; }); };
$('acApply').onclick = () => {
  const heard = new Set(acTests.filter((t) => { const el = $('acH' + t.n); return el && el.checked; }).map((t) => t.kind));
  let msg;
  if (heard.has('dg')) { S.voiceEngine = 'auto'; msg = 'Set: automatic — the Deepgram voice first, then Cloudflare, Gemini and the iPhone voice as backup.'; }
  else if (heard.has('cf')) { S.voiceEngine = 'cf'; msg = 'Set: Cloudflare voice. Its free allowance is small (about 7,000 characters a day); a Deepgram key would give you far more (see the README).'; }
  else if (heard.has('gemini')) { S.voiceEngine = 'gemini'; msg = 'Set: Gemini voice. Its free limit is small (about 10 lines a day).'; }
  else if (heard.has('device')) { S.voiceEngine = 'device'; S.pauseLoopForSpeech = true; S.audioSessionMode = 'playback'; msg = 'Set: iPhone voice (unlimited and free).'; }
  else msg = 'Nothing worked yet. Check: the silent switch on the left side of the phone (orange = silent), the volume while something plays, and Control Center → the audio-output icon is set to your earbuds. Then run the check again.';
  if (!heard.has('beep')) msg += ' You also did not hear the beep — check the volume and that the earbuds are the audio output.';
  saveSettings(); syncInputs(['voiceEngine', 'pauseLoopForSpeech', 'audioSessionMode']); setAudioSession();
  resetEngines(); checkWorker().then(prewarmVoice);
  acReport += '\nHeard: ' + (acTests.filter((t) => heard.has(t.kind)).map((t) => t.n).join(', ') || 'nothing') + '\n' + msg;
  $('acMsg').textContent = msg;
};
$('btnLab').onclick = () => { runLab().catch((e) => { $('labBanner').textContent = 'Lab error: ' + e.message; $('btnLab').disabled = false; S.deviceMode = S.deviceMode || 1; }); };
$('labApply').onclick = () => {
  const ids = LAB_VARIANTS.filter((v) => { const el = $('labH' + v.id); return el && el.checked; }).map((v) => v.id);
  let msg;
  if (ids.length) {
    S.deviceMode = ids[0]; S.voiceEngine = 'device'; S.deviceFallback = true;
    msg = 'Set: iPhone voice, set-up ' + ids[0] + ' (' + LAB_VARIANTS[ids[0] - 1].label + '). It is unlimited and free. If answers sound late or quiet, switch back under Speech & sounds → Voice engine.';
  } else msg = 'Nothing was audible. Flip the silent switch (left side of the phone: show orange = silent, hide orange = sound), make sure the earbuds are the audio output in Control Center, and run the lab again. Then use Copy report and paste it to Claude.';
  saveSettings(); syncInputs(['voiceEngine']); setAudioSession(); resetEngines();
  labReport += '\nHeard: ' + (ids.join(', ') || 'nothing') + '\n' + msg;
  $('labMsg').textContent = msg;
};
$('labCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(labReport + '\n--- recent sound events ---\n' + sevents.join('\n')); $('labMsg').textContent = 'Copied — paste it into the chat.'; }
  catch { $('labMsg').textContent = 'Could not copy automatically — long-press the report above to select it.'; }
};
$('acCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(acReport + '\n--- recent sound events ---\n' + sevents.join('\n')); $('acMsg').textContent = 'Copied — paste it into the chat.'; }
  catch { $('acMsg').textContent = 'Could not copy automatically — long-press the report above to select it.'; }
};
$('btnCopyEvents').onclick = async () => {
  const txt = 'App ' + APP_VERSION + ' · voice: ' + S.voiceEngine + ' · pause background: ' + S.pauseLoopForSpeech + '\n' + sevents.join('\n');
  try { await navigator.clipboard.writeText(txt); $('speechInfo').textContent = 'Sound log copied — paste it into the chat.'; }
  catch { $('speechInfo').textContent = txt; }
};
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
  checkWorker().then(prewarmVoice); // re-check what the Worker can do (e.g. after pasting new code)
  try {
    const j = await (await fetch(S.workerUrl.trim().replace(/\/$/, ''), { headers: { 'X-App-Token': S.token.trim() } })).json();
    const lines = [
      (j.hasKey ? '✅' : (j.groq || j.claude ? 'ℹ' : '❌')) + ' Gemini key stored in Worker',
      (j.tokenOk ? '✅' : '❌') + ' App token matches',
      (j.originOk ? '✅' : '❌') + ' This page is allowed',
      ((j.version || 1) >= MIN_WORKER_VERSION ? '✅ Worker is up to date' : '❌ Worker is OUT OF DATE — paste the new worker/proxy.js into Cloudflare'),
      ((j.version || 1) < MIN_WORKER_VERSION ? '❌ Cloudflare voice needs the new Worker code first' : j.ai ? '✅ Cloudflare voice connected' : '❌ Cloudflare voice not connected — add a Workers AI binding (see README)'),
      ((j.version || 1) < 11 ? '❌ Claude needs the newest Worker code (proxy.js v11) — paste it into Cloudflare' : j.claude ? '✅ Claude key stored' : 'ℹ Claude not set up (add an ANTHROPIC_API_KEY secret, see README)'),
      ((j.version || 1) < 9 ? '❌ Groq needs the newest Worker code' : j.groq ? '✅ Groq key stored' : 'ℹ Groq not set up (add a GROQ_API_KEY secret, see README)'),
      '➜ Answer order: ' + (answerers().map((w) => ({ claude: 'Claude', groq: 'Groq', gemini: 'Gemini' })[w] + (({ claude: j.claude, groq: j.groq, gemini: j.hasKey })[w] ? '' : ' (no key, skipped)')).join(' → ') || 'everything is switched off!'),
      (j.dg ? '✅ Deepgram voice set up' : (j.version || 1) >= 8 ? 'ℹ Deepgram voice not set up (optional, free credit: see the README)' : ''),
      ((j.version || 1) >= MIN_WORKER_VERSION && (j.version || 1) < RECOMMENDED_WORKER_VERSION ? '⚠ Worker v' + j.version + ' — paste the newest proxy.js (Deepgram voice, cheaper Cloudflare voice, more Gemini voice models)' : ''),
    ];
    out.textContent = lines.filter(Boolean).join('\n');
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
  if (k === 'x' || k === 'Backspace') return () => stopCurrent('key-' + k.toLowerCase());
  if (k === 'z') return () => stopCurrent('key-z', true);
  if (k === 'Escape') return () => { if (!$('reader').hidden) closeReader(); else setShowMode(false); };
  return null;
}
function typingInField(e) { return e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName); }
document.addEventListener('keydown', (e) => {
  if (learning && !e.repeat && !/^(Shift|Control|Alt|Meta)/.test(e.key)) {
    e.preventDefault();
    if (e.key === 'Escape') { stopLearning(); $('learnMsg').textContent = 'Cancelled.'; } else learned('k:' + e.code);
    return;
  }
  if (!S.keyboard || e.ctrlKey || e.metaKey || e.altKey || typingInField(e)) return;
  const bound = boundAction('k:' + e.code);
  if (bound) { e.preventDefault(); if (!e.repeat) runBound(bound); return; }
  const act = keyAction(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  if (!act) return;
  e.preventDefault(); // stops Space from scrolling the page or clicking a focused button
  if (!e.repeat) act();
});
document.addEventListener('keyup', (e) => {
  if (!S.keyboard || typingInField(e) || e.key !== ' ') return;
  e.preventDefault(); // some browsers click a focused button on Space *release*
});

// ---------------------------------------------------------------- learn your own buttons (8BitDo etc.)
// A controller can show up two ways: as a KEYBOARD (its buttons send keys) or as a GAMEPAD (Safari's gamepad
// support). Both work the same: tap Learn, press the button, and it is remembered.
const BIND_ACTIONS = [['toggle', 'Auto reads on / pause'], ['capture', 'Capture now (overrides auto)'], ['repeat', 'Repeat last answer'],
                      ['stop', 'Stop / reset (silence, unfreeze)'], ['stopPause', 'Stop + pause auto reads'],
                      ['show', 'Show mode on / off'], ['camera', 'Restart camera']];
const PAD_DEFAULTS = { 'g:b0': 'toggle', 'g:b1': 'capture', 'g:b3': 'repeat' }; // standard layout: A, B, Y
let learning = null, learnTimer = null, padPrev = null, padName = '';
function bindLabel(b) {
  if (b.startsWith('k:')) return 'Key ' + b.slice(2);
  let m = b.match(/^g:b(\d+)$/); if (m) return 'Controller button ' + m[1];
  m = b.match(/^g:a(\d+)([+-])$/); return m ? 'Controller stick/pad ' + m[1] + m[2] : b;
}
function boundAction(b) { for (const [k] of BIND_ACTIONS) if ((S.binds[k] || []).includes(b)) return k; return null; }
function runBound(action) {
  if (!running) { if (action === 'toggle') $('btnStart').click(); return; }
  if (action === 'toggle') setArmed(!armed);
  else if (action === 'capture') forceCapture('bound');
  else if (action === 'repeat') repeatLast();
  else if (action === 'stop') stopCurrent('bound');
  else if (action === 'stopPause') stopCurrent('bound', true);
  else if (action === 'show') setShowMode(!document.body.classList.contains('showmode'));
  else if (action === 'camera') restartCamera('manual');
}
function buildBindUI() {
  const box = $('bindList'); box.innerHTML = '';
  for (const [k, label] of BIND_ACTIONS) {
    const row = document.createElement('div'); row.className = 'bindrow';
    const lab = document.createElement('b'); lab.textContent = label;
    const cur = document.createElement('span'); cur.className = 'hint';
    cur.textContent = (S.binds[k] || []).map(bindLabel).join(', ') || 'not set';
    const learn = document.createElement('button'); learn.textContent = 'Learn';
    learn.onclick = () => startLearning(k);
    const clr = document.createElement('button'); clr.textContent = 'Clear';
    clr.onclick = () => { S.binds[k] = []; saveSettings(); buildBindUI(); };
    row.append(lab, cur, learn, clr); box.appendChild(row);
  }
}
function startLearning(act) {
  learning = act; padPrev = null; clearTimeout(learnTimer);
  $('learnMsg').textContent = 'Now press a key or a controller button… (15 seconds)';
  learnTimer = setTimeout(() => { if (learning) { stopLearning(); $('learnMsg').textContent = 'Nothing pressed — cancelled.'; } }, 15000);
}
function stopLearning() { learning = null; clearTimeout(learnTimer); }
function learned(b) {
  const act = learning; stopLearning();
  for (const [k] of BIND_ACTIONS) S.binds[k] = (S.binds[k] || []).filter((x) => x !== b); // one button, one job
  S.binds[act] = [...(S.binds[act] || []), b]; saveSettings(); buildBindUI();
  $('learnMsg').textContent = 'Saved: ' + bindLabel(b) + ' → ' + BIND_ACTIONS.find((x) => x[0] === act)[1];
}
function padPoll() {
  if (document.hidden || !navigator.getGamepads || (!S.gamepad && !learning)) return;
  const now = {}; let name = '';
  for (const gp of navigator.getGamepads()) {
    if (!gp) continue;
    name = gp.id;
    gp.buttons.forEach((b, i) => { if (b.pressed) now['g:b' + i] = 1; });
    gp.axes.forEach((v, i) => { if (v > 0.7 && v <= 1.01) now['g:a' + i + '+'] = 1; else if (v < -0.7 && v >= -1.01) now['g:a' + i + '-'] = 1; });
  }
  if (name !== padName) { // a controller appeared or left: start from a clean baseline so held/resting inputs don't fire
    padName = name; padPrev = null;
    $('padInfo').textContent = name ? 'Controller seen: ' + name : 'No controller seen yet — press a button on it.';
  }
  if (padPrev) for (const k in now) if (!padPrev[k]) padPress(k);
  padPrev = now;
}
function padPress(k) {
  if (learning) { learned(k); return; }
  if (!S.gamepad || !running) return; // a controller can't START the app: iOS needs a real tap or key for that
  if (camLost) { unstick(); if (!restarting && !camBusy) restartCamera('pad'); return; }
  const a = boundAction(k) || PAD_DEFAULTS[k]; if (a) runBound(a);
}
setInterval(padPoll, 60);

// ---------------------------------------------------------------- lifecycle
// Leaving the app (swipe away / lock) and coming back: iOS freezes or takes the camera while you're away, and after a
// while it may refuse to give it back without a tap. On return: clear anything stuck, wake sound and the earbud
// buttons, and reconnect the camera; if iOS wants a tap first, the orange panel says so and ANY tap or key reconnects.
// If iOS threw the whole page away while you were gone, the page offers "tap or press any key to resume".
const RESUME_KEY = 'cardAssistant.resume.v1';
let resumeArmed = false;
function markRunning() { if (running) try { localStorage.setItem(RESUME_KEY, JSON.stringify({ at: Date.now(), armed })); } catch {} }
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    hiddenAt = Date.now(); markRunning();
    if (running && phase === 'collect') { collect = null; phase = armed ? 'watch' : 'idle'; } // don't finish a half-taken shot on return
    return;
  }
  if (!running) return;
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  sev('back in the app after ' + Math.round(away / 1000) + ' s');
  unstick(); autoRetries = 0; clearTimeout(retryTimer);
  if (!wakeLock) requestWakeLock();
  setupMediaSession(); // iOS can drop the earbud-button handlers while the page is in the background
  playLoop();
  setAudioSession();
  wakeAudio();
  prevGrey = null; stillCount = 0; smoothBox = null;
  if (away > 5000) needChange = true; // don't re-read the card that was already in view when you left
  setTimeout(() => { unstick(); if (camLost) showCamLost(true); restartCamera('returned to app'); }, 600); // iOS usually freezes the camera while the app is away
});
window.addEventListener('pageshow', (e) => { if (e.persisted && running) { unstick(); restartCamera('page restored'); } });
window.addEventListener('pagehide', markRunning);
setInterval(markRunning, 30000);
(function offerResume() { // the page was reloaded by iOS while a session was running: one tap or key brings it back
  let r = null; try { r = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null'); } catch {}
  if (!r || Date.now() - r.at > 2 * 3600 * 1000) return;
  const box = $('resumeBox'); if (!box) return;
  box.hidden = false;
  const go = (e) => {
    if (running || box.hidden) return off();
    if (e && e.target && e.target.closest && e.target.closest('details, input, select, textarea, a')) return; // using settings
    if (e && e.type === 'keydown') e.preventDefault();
    resumeArmed = !!r.armed; off(); $('btnStart').click();
  };
  const off = () => { document.removeEventListener('click', go, true); document.removeEventListener('keydown', go, true); };
  document.addEventListener('click', go, true); document.addEventListener('keydown', go, true);
  $('resumeNo').onclick = (e) => { e.stopPropagation(); box.hidden = true; off(); try { localStorage.removeItem(RESUME_KEY); } catch {} };
})();

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

// ---------------------------------------------------------------- who reads the card: priority blocks
const ANSWER_NAMES = { claude: 'Claude', groq: 'Groq', gemini: 'Gemini' };
function renderAnswerBlocks() {
  const box = $('answerBlocks'); if (!box) return;
  const keyOf = (w) => (workerInfo ? !!workerInfo[w === 'gemini' ? 'hasKey' : w] : null);
  const order = S.answerOrder, firstOn = order.find((w) => S.answerOn[w] && keyOf(w) !== false); // who will really answer first
  order.forEach((w, i) => {
    const b = box.querySelector('[data-who="' + w + '"]'); if (!b) return;
    box.appendChild(b); // DOM order follows the saved order
    b.querySelector('.anum').textContent = i + 1;
    b.querySelector('.aup').disabled = i === 0;
    b.querySelector('.adown').disabled = i === order.length - 1;
    b.querySelector('.aon').checked = !!S.answerOn[w];
    b.classList.toggle('off', !S.answerOn[w]);
    b.classList.toggle('first', w === firstOn);
    const k = b.querySelector('.akey');
    const has = keyOf(w);
    k.textContent = has == null ? '' : has ? '● key set' : '● no key';
    k.className = 'akey' + (has == null ? '' : has ? ' ok' : ' no');
  });
  const on = answerers();
  $('answerSummary').textContent = on.length ? 'Order now: ' + on.map((w) => ANSWER_NAMES[w] + (keyOf(w) === false ? ' (no key, skipped)' : '')).join(' → ') : '⚠ Everything is switched off: cards can\'t be read.';
}
function wireAnswerBlocks() {
  const box = $('answerBlocks'); if (!box) return;
  box.querySelectorAll('.ablock').forEach((b) => {
    const w = b.dataset.who;
    const move = (d) => {
      const o = S.answerOrder.slice(), i = o.indexOf(w), j = i + d;
      if (j < 0 || j >= o.length) return;
      [o[i], o[j]] = [o[j], o[i]]; S.answerOrder = o; saveSettings(); renderAnswerBlocks();
    };
    b.querySelector('.aup').onclick = () => move(-1);
    b.querySelector('.adown').onclick = () => move(1);
    b.querySelector('.aon').onchange = (e) => { S.answerOn = { ...S.answerOn, [w]: e.target.checked }; saveSettings(); renderAnswerBlocks(); };
    b.querySelector('.aname').onclick = () => { const body = b.querySelector('.abody'); body.hidden = !body.hidden; };
  });
  renderAnswerBlocks();
}

function init() {
  wireAnswerBlocks();
  buildCueSettings();
  buildBindUI();
  updateSpeechInfo();
  speechSynthesis.addEventListener && speechSynthesis.addEventListener('voiceschanged', updateSpeechInfo);
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
