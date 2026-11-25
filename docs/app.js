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

const APP_VERSION = '1.7.0';
const MIN_WORKER_VERSION = 2;

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
const MULTI_FORMAT =
  'If the card or page has several questions or items, handle EVERY one, in order from top to bottom.\n' +
  'Reply in exactly this format and nothing else, one pair per item (just Q1/A1 if there is only one):\n' +
  'Q1: <item 1, in at most 12 words>\n' +
  'A1: <your reply to item 1: one to three short sentences to be spoken aloud, plain words only, no lists, symbols or markdown>\n' +
  'Q2: <item 2>\nA2: <reply to item 2>\n(and so on)\n' +
  'Always give your best reply, even if the print is small or slightly unclear. ' +
  'Reply with just the word NONE only if nothing on the card can be read at all.';
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
  models: 'gemini-3.5-flash, gemini-flash-latest',
  mediaResolution: 'MEDIA_RESOLUTION_HIGH', thinking: 'minimal', maxTokens: 2048,
  prompt: DEFAULT_PROMPT, style: '', allItems: true,
  voiceEngine: 'device', ttsVoice: 'Kore', ttsModel: 'gemini-2.5-flash-preview-tts', pauseLoopForSpeech: true, audioSessionMode: 'playback', freezeMode: 'speech',
  maxSide: 2048, jpegQuality: 85,
  timeoutSec: 8, stallLine: 'Great question. Give me just a second with that one.',
  lateAnswer: true, lateSec: 15, retryNone: 1,
  voiceURI: '', rate: 1.0, toneVol: 0.3, speakQuestion: false, thinkTicks: true,
  btnSingle: 'toggle', btnDouble: 'capture', btnTriple: 'repeat', autoArm: false, keyboard: true, gamepad: true, binds: {}, sayReady: true,
  camId: '', res: '1920x1440', camFps: 15, zoom: null, torch: false,
  useCrop: true, crop: { x: 0.1, y: 0.15, w: 0.8, h: 0.7 },
  motionThresh: 4, sharpMin: 60, changeThresh: 10, cooldownSec: 4,
  idleFps: 1, ...PRESETS.fast,
};
for (const k of CUE_KEYS) DEFAULTS['cue_' + k] = 'tone';

// ---------------------------------------------------------------- settings
const LS_KEY = 'cardAssistant.settings.v1';
const SETTINGS_VER = 5;
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
    if ([OLD_PROMPT_V1, OLD_QUESTION_V2, OLD_ANYTHING_V3].includes(saved.prompt)) delete saved.prompt;
    if ((saved.v || 1) < 4 && saved.maxTokens === 1024) delete saved.maxTokens; // longer pages need room for many answers
    if ((saved.v || 1) < 5) delete saved.pauseLoopForSpeech; // now on by default: the background sound was cutting into speech
    saved.v = SETTINGS_VER;
    try { localStorage.setItem(LS_KEY, JSON.stringify(saved)); } catch {}
  }
  return { ...DEFAULTS, ...saved, v: SETTINGS_VER, crop: { ...DEFAULTS.crop, ...(saved.crop || {}) }, binds: { ...(saved.binds || {}) } };
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
  if (k === 'stallLine' || k === 'voiceEngine' || k === 'ttsVoice' || k === 'ttsModel') { geminiVoiceDown = false; voiceFails = 0; prewarmVoice(); }
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
      if (running && !audioQuiet && !speaking && loopHold === 0 && actx.state !== 'running' && actx.state !== 'closed') actx.resume().catch(() => {});
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
let speaking = false, speechChain = Promise.resolve(), speechNote = '';
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
function holdLoop() {
  loopHold++; clearTimeout(loopResumeTimer);
  if (S.pauseLoopForSpeech && keepAlive && !keepAlive.paused) { loopPausedForSpeech = true; keepAlive.pause(); sev('background sound paused for speech'); }
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
function cleanSpeech(text) { return String(text || '').replace(/[*_#`>]/g, '').replace(/\s+/g, ' ').trim(); }
function speak(text) {
  text = cleanSpeech(text);
  if (!text) return Promise.resolve();
  if (S.voiceEngine === 'gemini' && S.workerUrl && !geminiVoiceDown) {
    const buf = geminiVoiceBuffer(text); // starts generating NOW, while anything earlier is still being spoken
    buf.catch(() => {});
    speechChain = speechChain.then(async () => {
      speaking = true; setSub(); holdLoop();
      try { const ab = await buf; await wakeAudio(); await playBuffer(ab); voiceFails = 0; if (/Gemini voice/.test(speechNote)) speechNote = ''; }
      catch (e) {
        voiceFails++; if (voiceFails >= 2) geminiVoiceDown = true;
        sev('Gemini voice failed: ' + e.message);
        speechNote = 'Gemini voice failed (' + e.message + ') — used the iPhone voice instead';
        for (const ch of splitSpeech(text)) await speakDeviceNow(ch);
      } finally { speaking = false; setSub(); releaseLoop(); }
    });
    return speechChain;
  }
  const chunks = splitSpeech(text);
  speechChain = speechChain.then(async () => { holdLoop(); try { for (const ch of chunks) await speakDeviceNow(ch); } finally { releaseLoop(); } });
  return speechChain;
}
function splitSpeech(text) {
  const parts = text.replace(/([.!?])\s+/g, '$1\u0001').split('\u0001'); // split at sentence ends, not inside "7.21"
  const out = []; let cur = '';
  for (const p of parts) { if (cur && (cur + ' ' + p).length > 220) { out.push(cur); cur = p; } else cur = cur ? cur + ' ' + p : p; }
  if (cur) out.push(cur);
  return out.flatMap((x) => x.length <= 300 ? [x] : (x.match(/.{1,280}(\s|$)/g) || [x]).map((y) => y.trim()).filter(Boolean));
}

// The iPhone's own voice (speechSynthesis). Resolves with what happened, for the audio check.
function speakDeviceNow(text) {
  return new Promise((resolve) => {
    let done = false, started = false, tries = 0, cur = null, kick = null, poll = null, errName = '';
    quietWebAudio();
    // Generous time limit from the word count (≈140 words a minute, plus margin). If iOS gets stuck, we STOP it
    // (so the next sentence isn't queued behind a stuck one) and move on.
    const words = text.split(/\s+/).length;
    const limit = Math.max(6000, 2500 + words / 2.3 * 1000 / (S.rate || 1) * 1.6);
    const total = setTimeout(() => {
      sev(started ? 'voice stuck — stopping it' : 'voice never started — giving up on this line');
      if (!started) { speechNote = 'Speech is not starting — run Speech & sounds → Audio check'; }
      try { speechSynthesis.cancel(); } catch {}
      finish();
    }, limit);
    const finish = () => {
      if (done) return; done = true; speaking = false; clearTimeout(total); clearTimeout(kick); clearInterval(poll);
      setSub(); resolve({ started, error: errName });
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
      u.onstart = () => { if (cur !== u) return; started = true; sev('voice started ' + short); if (/not starting/.test(speechNote)) speechNote = ''; clearTimeout(kick); };
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
        if (!speechSynthesis.speaking && !speechSynthesis.pending) { sev('voice finished ' + short + ' (no end event)'); liveUtterances.delete(u); finish(); }
      }, 300);
      kick = setTimeout(() => {
        if (started || done) return;
        // iOS sometimes skips the "started" event while it IS talking: never cut that off
        if (speechSynthesis.speaking && !speechSynthesis.pending) { started = true; sev('no start event, but it is talking — leaving it alone'); return; }
        sev('voice did not start — retrying');
        if (tries < 2) { try { speechSynthesis.cancel(); } catch {} cur = null; setTimeout(say, 200); }
        else { speechNote = 'Speech is not starting — run Speech & sounds → Audio check'; setSub(); }
      }, 3000);
    };
    speaking = true; setSub();
    // Anything still "talking" now is a leftover (we say one thing at a time): clear it so we don't queue behind it.
    if (speechSynthesis.speaking || speechSynthesis.pending) { sev('cleared leftover speech'); try { speechSynthesis.cancel(); } catch {} setTimeout(say, 150); }
    else say();
  });
}

// Gemini voice: the Worker returns a WAV file; we decode it and play it through Web Audio (same route as the beeps).
const voiceCache = new Map(); // text -> Promise<AudioBuffer>, so the stall line and repeats are instant
let voiceFails = 0, geminiVoiceDown = false, lastTtsMs = 0;
function geminiVoiceBuffer(text) {
  text = cleanSpeech(text);
  const key = S.ttsVoice + '|' + S.ttsModel + '|' + text;
  if (voiceCache.has(key)) return voiceCache.get(key);
  const p = (async () => {
    const t0 = performance.now(), ctrl = new AbortController(), tm = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(S.workerUrl.trim().replace(/\/$/, ''), {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'X-App-Token': S.token.trim() },
        body: JSON.stringify({ tts: text, voice: S.ttsVoice, model: S.ttsModel }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'HTTP ' + r.status); }
      if (!/audio/.test(r.headers.get('Content-Type') || '')) throw new Error('Worker is out of date (no voice support) — paste the new proxy.js');
      const ab = await r.arrayBuffer();
      if (ab.byteLength < 100) throw new Error('empty audio');
      const buf = await new Promise((res, rej) => audioCtx().decodeAudioData(ab, res, rej));
      lastTtsMs = Math.round(performance.now() - t0);
      return buf;
    } catch (e) { throw e.name === 'AbortError' ? new Error('timed out') : e; }
    finally { clearTimeout(tm); }
  })();
  voiceCache.set(key, p);
  p.catch(() => voiceCache.delete(key));
  if (voiceCache.size > 60) voiceCache.delete(voiceCache.keys().next().value);
  return p;
}
function playBuffer(buf) {
  return new Promise((resolve) => {
    const c = audioCtx(), src = c.createBufferSource();
    src.buffer = buf; src.connect(c.destination);
    const guard = setTimeout(() => { sev('Gemini clip guard timeout'); resolve(); }, buf.duration * 1000 + 6000);
    src.onended = () => { clearTimeout(guard); sev('Gemini clip ended'); resolve(); };
    sev('Gemini clip playing (' + buf.duration.toFixed(1) + ' s)');
    src.start();
  });
}
function prewarmVoice() { // make the lines we know in advance, so they play instantly
  if (S.voiceEngine !== 'gemini' || !S.workerUrl || !actx) return;
  geminiVoiceBuffer(S.stallLine).catch(() => {});
}

// Must run inside a tap or key press: it "unlocks" speech and sound on iOS.
function unlockSpeech() {
  try {
    const u = new SpeechSynthesisUtterance('Ready');
    const v = speechSynthesis.getVoices().find((x) => x.voiceURI === S.voiceURI);
    if (v) u.voice = v;
    u.lang = (v && v.lang) || 'en-US'; u.volume = (S.sayReady && S.voiceEngine !== 'gemini') ? 1 : 0;
    liveUtterances.add(u); u.onend = u.onerror = () => liveUtterances.delete(u);
    speechSynthesis.speak(u);
  } catch {}
  setAudioSession();
}
function setAudioSession() { // "playback" lets sound play even with the ringer switch on silent (iOS 16.4+)
  try { if (navigator.audioSession) navigator.audioSession.type = S.audioSessionMode === 'auto' ? 'auto' : 'playback'; } catch {}
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

async function startCamera(opts = {}) {
  if (camBusy) throw new Error('camera is busy');
  camBusy = true;
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
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: v });
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
  restarting = true; clearTimeout(retryTimer);
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
  if (autoRetries < 5) { // quiet background retries with longer gaps
    const d = [3000, 6000, 12000, 20000, 30000][autoRetries++];
    retryTimer = setTimeout(() => { if (camLost && !document.hidden) restartCamera('auto retry'); }, d);
  }
}
function showCamLost(on, err) {
  $('camLost').hidden = !on;
  if (!on) return;
  $('camLostWhy').textContent = (err && err.name === 'NotAllowedError')
    ? 'iOS blocked the camera after you left the app.' : 'The camera did not come back.';
  camNote = 'Camera disconnected — tap the orange panel or press any key'; setSub();
}
function gestureReconnect() { if (camLost && running && !restarting && !camBusy) restartCamera('tap'); }
document.addEventListener('click', gestureReconnect, true);
document.addEventListener('keydown', () => { if (camLost && running && !restarting && !camBusy) restartCamera('key'); }, true);

// Watchdog: runs on its own timer, separate from the capture loop.
setInterval(() => {
  if (!running || restarting || camBusy || camLost || document.hidden) return;
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
  if (frozen) return; // picture frozen after a capture: no checking, nothing can trip a new read
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

async function runCapture(c) {
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
  if (S.freezeMode === 'answer') unfreezeView();
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
    entry.items = parsed.items.length;
    last = { q: parsed.q, a: parsed.a, items: parsed.items, text: res.text };
    if (S.voiceEngine === 'gemini') itemTexts(parsed.items).forEach((t) => geminiVoiceBuffer(t).catch(() => {})); // start making the voice now
  }
  logCapture(entry); // logged BEFORE speaking, so it is saved even if something interrupts the speech
  showLast(entry);

  if (next === 'retry') { noneRetries++; finish(false, true); } // try again with the next still window
  else if (next === 'stall') { if (!stalled) { await tone('failed'); await speak(S.stallLine); } finish(true); }
  else if (next === 'skip') finish(true);
  else {
    await speechChain; // let the stall line finish first
    await tone('answer');
    await speakItems(parsed.items);
    finish(true);
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
    const line = raw.trim(); if (!line) continue;
    let m;
    if ((m = line.match(/^\W*Q\s*\d*\s*:\s*(.*)$/i))) { cur = { q: unmark(m[1]), a: '' }; items.push(cur); field = 'q'; }
    else if ((m = line.match(/^\W*A\s*\d*\s*:\s*(.*)$/i))) {
      if (!cur || cur.a) { cur = { q: '', a: '' }; items.push(cur); }
      cur.a = unmark(m[1]); field = 'a';
    } else if (cur && field) cur[field] = (cur[field] ? cur[field] + ' ' : '') + unmark(line);
    else { cur = { q: '', a: line }; items.push(cur); field = 'a'; } // no labels at all: it's the answer
  }
  const good = items.filter((it) => it.a && !/^NONE\.?$/i.test(it.a));
  if (!good.length) return null;
  return { q: good.map((it) => it.q).filter(Boolean).join(' | '), a: displayItems(good), items: good };
}
function unmark(t) { return String(t).replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim(); } // drop **bold** marks etc.
function displayItems(items) {
  if (items.length === 1) return items[0].a;
  return items.map((it, i) => (i + 1) + '. ' + (it.q ? it.q + '\n→ ' : '') + it.a).join('\n\n');
}
function itemTexts(items) { // exactly what gets spoken, in order
  const many = items.length > 1, out = [];
  items.forEach((it, i) => {
    const lead = many ? 'Number ' + (i + 1) + '. ' : '';
    if (S.speakQuestion && it.q) { out.push(lead + it.q); out.push(it.a); } else out.push(lead + it.a);
  });
  return out;
}
function speakItems(items) { itemTexts(items).forEach((t) => speak(t)); return speechChain; }

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
      body: JSON.stringify({ image: dataUrl, prompt: S.prompt + (S.allItems ? '' : '\n\nOnly handle the FIRST item on the card, nearest the top.') + (S.style && S.style.trim() ? '\n\nExtra instructions from the performer: ' + S.style.trim() : ''), models, generationConfig, timeoutMs }),
    });
    const j = await r.json().catch(() => ({ error: 'Bad reply from Worker (HTTP ' + r.status + ')' }));
    return { ...j, ok: r.ok && !j.error };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Timed out' : 'Network error: ' + e.message };
  } finally { clearTimeout(timer); }
}

function repeatLast() {
  if (last.items && last.items.length) { tone('answer').then(() => speakItems(last.items)); }
  else if (last.a) { tone('answer').then(() => speak(last.a)); }
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
  if (speechNote) bits.push('⚠ ' + speechNote);
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
let lastFull = null, readerPx = 28;
function showLast(e) {
  const isAns = e.status === 'answer' || e.status === 'late-answer';
  const info = new Date(e.t).toLocaleTimeString() + ' · ' + (e.latencyMs / 1000).toFixed(1) + ' s · sharp ' + e.sharp +
    ' · ' + e.kb + ' KB · ' + (e.model || '');
  $('lastQ').textContent = last.q ? 'Card: ' + last.q : '';
  $('lastA').textContent = isAns ? last.a : '(' + e.status + ') ' + (e.error || e.reply || '');
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
  audioCtx(); unlockSpeech();
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
  if (S.voiceEngine === 'gemini') { prewarmVoice(); if (S.sayReady) speak('Ready'); }
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
$('btnTestVoice').onclick = () => {
  audioCtx(); setAudioSession(); speechNote = '';
  speak('This is how answers will sound in your earbud.').then(updateSpeechInfo); updateSpeechInfo();
};
// ---------------------------------------------------------------- audio check
// Plays a beep and four numbered voices; you tick which you heard and the app switches to what works.
let acReport = '';
async function runAudioCheck() {
  audioCtx(); setAudioSession(); // inside the tap, so iOS allows sound
  try { const u = new SpeechSynthesisUtterance('ready'); u.volume = 0; liveUtterances.add(u); u.onend = u.onerror = () => liveUtterances.delete(u); speechSynthesis.speak(u); } catch {}
  const out = $('acOut'), lines = [];
  const log = (t) => { lines.push(t); out.textContent = lines.join('\n'); acReport = lines.join('\n'); };
  const banner = (t) => { $('acBanner').textContent = t; };
  const desc = (r) => r.started ? 'started' + (r.error ? ', then error: ' + r.error : ' and finished') : 'did NOT start' + (r.error ? ' (' + r.error + ')' : '');
  $('acHeard').hidden = true; $('btnAudioCheck').disabled = true; $('acMsg').textContent = '';
  ['acH1', 'acH2', 'acH3', 'acH4', 'acH5'].forEach((id) => { $(id).checked = false; });
  log('App ' + APP_VERSION + ' · ' + (navigator.userAgent.match(/(iPhone|iPad)[^;)]*|OS [\d_]+|Version\/[\d.]+/g) || [navigator.userAgent.slice(0, 60)]).join(' · '));
  log('Audio mode: ' + (navigator.audioSession ? navigator.audioSession.type : 'not supported') + ' · Web Audio: ' + actx.state +
      ' · voices: ' + speechSynthesis.getVoices().length + ' · background sound: ' + (keepAlive && !keepAlive.paused ? 'playing' : 'off') +
      ' · camera: ' + (track && track.readyState === 'live' ? 'on' : 'off'));
  try { speechSynthesis.cancel(); } catch {}
  await wakeAudio();
  banner('1 of 5 — beep'); await beepNow('answer'); await sleep(600); log('1. Beep — played (Web Audio ' + actx.state + ')');
  banner('2 of 5 — iPhone voice'); let r = await speakDeviceNow('Two. iPhone voice.'); log('2. iPhone voice — ' + desc(r)); await sleep(400);
  banner('3 of 5 — iPhone voice, background sound paused');
  if (keepAlive && !keepAlive.paused) { loopPausedForSpeech = true; keepAlive.pause(); }
  r = await speakDeviceNow('Three. iPhone voice, background sound paused.'); log('3. iPhone voice, background paused — ' + desc(r));
  loopPausedForSpeech = false; playLoop(); await sleep(400);
  banner('4 of 5 — iPhone voice, normal audio mode');
  const hadSession = !!navigator.audioSession;
  try { if (hadSession) navigator.audioSession.type = 'auto'; } catch {}
  r = await speakDeviceNow('Four. iPhone voice, normal audio mode.');
  log('4. iPhone voice, normal audio mode — ' + desc(r) + (hadSession ? '' : ' (audio mode not supported: same as 2)'));
  setAudioSession(); await sleep(400);
  await wakeAudio();
  banner('5 of 5 — Gemini voice (needs the updated Worker)');
  try {
    const t0 = performance.now();
    const b = await geminiVoiceBuffer('Five. Gemini voice. ' + new Date().toLocaleTimeString());
    const ms = Math.round(performance.now() - t0);
    await playBuffer(b); log('5. Gemini voice — played (took ' + ms + ' ms to make)');
  } catch (e) { log('5. Gemini voice — FAILED: ' + e.message); }
  banner('Done — tick the numbers you heard'); $('acHeard').hidden = false; $('btnAudioCheck').disabled = false;
}
function syncInputs(keys) {
  for (const k of keys) { const el = document.querySelector('[data-k=' + k + ']'); if (!el) continue; if (el.type === 'checkbox') el.checked = !!S[k]; else el.value = S[k]; }
}
$('btnAudioCheck').onclick = () => { runAudioCheck().catch((e) => { $('acBanner').textContent = 'Audio check error: ' + e.message; $('btnAudioCheck').disabled = false; }); };
$('acApply').onclick = () => {
  const h = (i) => $('acH' + i).checked;
  let msg;
  if (h(2)) { S.voiceEngine = 'device'; S.pauseLoopForSpeech = true; S.audioSessionMode = 'playback'; msg = 'Set: iPhone voice.'; }
  else if (h(3)) { S.voiceEngine = 'device'; S.pauseLoopForSpeech = true; S.audioSessionMode = 'playback'; msg = 'Set: iPhone voice, with the background sound paused while it speaks.'; }
  else if (h(4)) { S.voiceEngine = 'device'; S.pauseLoopForSpeech = true; S.audioSessionMode = 'auto'; msg = 'Set: iPhone voice with the normal audio mode. (Beeps may now follow the silent switch.)'; }
  else if (h(5)) { S.voiceEngine = 'gemini'; msg = 'Set: Gemini voice. It starts about a second later than the iPhone voice; the stall line is prepared in advance.'; }
  else msg = 'Nothing worked yet. Check: the silent switch on the left side of the phone (orange = silent), the volume while something plays, and Control Center → the audio-output icon is set to your earbuds. Then run the check again.';
  if (!h(1)) msg += ' You also did not hear the beep — check the volume and that the earbuds are the audio output.';
  saveSettings(); syncInputs(['voiceEngine', 'pauseLoopForSpeech', 'audioSessionMode']); setAudioSession();
  geminiVoiceDown = false; voiceFails = 0; prewarmVoice();
  acReport += '\nHeard: ' + [1, 2, 3, 4, 5].filter(h).join(', ') + '\n' + msg;
  $('acMsg').textContent = msg;
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
const BIND_ACTIONS = [['toggle', 'Arm / disarm'], ['capture', 'Capture now'], ['repeat', 'Repeat last answer'],
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
  const a = boundAction(k) || PAD_DEFAULTS[k]; if (a) runBound(a);
}
setInterval(padPoll, 60);

// ---------------------------------------------------------------- lifecycle
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !running) return;
  if (!wakeLock) requestWakeLock();
  playLoop();
  setAudioSession();
  setTimeout(() => restartCamera('returned to app'), 600); // iOS usually freezes the camera while the app is away
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
