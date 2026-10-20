import { DeepgramStream } from './deepgram.js';
import './interpreter.js';

const MAX_BLOCKS = 200;
const SILENCE_WARNING_MS = 8000;
const AUDIO_ACTIVITY_THRESHOLD = 0.01;
const SILENCE_WINDOW_MS = 1800;
const AUDIO_CHECK_INTERVAL_MS = 100;
const HOLD_TIME_MS = 15 * 60 * 1000;
const HOLD_WARNING_MS = 2 * 60 * 1000;
const FONT_MIN = 16;
const FONT_MAX = 48;
const SPEAKER_LABELS = { en: 'Cliente · EN', es: 'LEP · ES' };
const SPEAKER_FLAGS = { en: 'flags/gb.svg', es: 'flags/es.svg' };
const SHORTCUT_MODIFIERS = /Mac/i.test(navigator.platform) ? '⌘⇧' : 'Ctrl+Shift+';

const $ = (id) => document.getElementById(id);
const overlay = $('overlay');
const captionsEl = $('captions');
const placeholder = $('placeholder');
const statusDot = $('statusDot');
const statusText = $('statusText');
const toggleBtn = $('toggleBtn');
const sourceModeEl = $('sourceMode');
const settingsPanel = $('settings');
const form = $('settingsForm');
const clickThroughBtn = $('clickThroughBtn');

let settings = await window.captioner.getSettings();
let session = null;
let currentBlock = null;
let blockCounter = 0;
let lastProvider = null;

// ---------- status & appearance ----------

function setStatus(state, text) {
  statusDot.className = `dot ${state === 'idle' ? '' : state}`;
  statusText.textContent = text;
  statusText.title = text;
}

const bgColorInput = $('bgColorInput');
const randomizeBgBtn = $('randomizeBgBtn');
const bgOpacityInput = $('bgOpacityInput');
const bgOpacityValue = $('bgOpacityValue');

const hexToRgb = (hex) => hex.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16));

// Below this opacity the desktop behind the window dominates, so keep light text with a shadow.
const LIGHT_TEXT_MAX_OPACITY = 0.4;

function isLightBackground(rgb, opacity) {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return opacity >= LIGHT_TEXT_MAX_OPACITY && 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4;
}

function applyAppearance() {
  const root = document.documentElement.style;
  const rgb = hexToRgb(settings.bgColor);
  root.setProperty('--font-size', `${settings.fontSize}px`);
  root.setProperty('--bg-alpha', String(settings.bgOpacity));
  root.setProperty('--bg-rgb', rgb.join(', '));
  document.body.classList.toggle('light-bg', isLightBackground(rgb, settings.bgOpacity));
  document.body.classList.toggle('hide-original', !settings.showOriginal);
  document.body.classList.toggle('no-translation', settings.translator === 'off');
  bgColorInput.value = settings.bgColor;
  bgOpacityInput.value = settings.bgOpacity;
  bgOpacityValue.textContent = `${Math.round(settings.bgOpacity * 100)}%`;
}

// ---------- hold timer ----------

const holdTimerEl = $('holdTimer');
let holdDeadline = null;
let holdInterval = null;
let holdAlarmPlayed = false;
let alarmCtx = null;

function playHoldAlarm() {
  alarmCtx ??= new AudioContext();
  const start = alarmCtx.currentTime + 0.05;
  for (let i = 0; i < 3; i++) {
    const t = start + i * 0.35;
    const osc = alarmCtx.createOscillator();
    const gain = alarmCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(gain).connect(alarmCtx.destination);
    osc.start(t);
    osc.stop(t + 0.26);
  }
}

function renderHoldTimer() {
  const remaining = holdDeadline === null ? HOLD_TIME_MS : Math.max(0, holdDeadline - Date.now());
  if (holdDeadline !== null && remaining === 0 && !holdAlarmPlayed) {
    holdAlarmPlayed = true;
    playHoldAlarm();
  }
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  holdTimerEl.textContent = `${minutes}:${seconds}`;
  holdTimerEl.classList.toggle('paused', holdDeadline === null);
  holdTimerEl.classList.toggle('warning', holdDeadline !== null && remaining > 0 && remaining <= HOLD_WARNING_MS);
  holdTimerEl.classList.toggle('expired', holdDeadline !== null && remaining === 0);
}

function resetHoldTimer() {
  holdDeadline = Date.now() + HOLD_TIME_MS;
  holdAlarmPlayed = false;
  clearInterval(holdInterval);
  holdInterval = setInterval(renderHoldTimer, 250);
  renderHoldTimer();
}

function stopHoldTimer() {
  holdDeadline = null;
  clearInterval(holdInterval);
  renderHoldTimer();
}

// ---------- captions ----------

const baseLang = (lang) => (lang || 'en').slice(0, 2).toLowerCase();
const targetFor = (lang) => (baseLang(lang) === 'es' ? 'en' : 'es');

function createBlock(lang) {
  placeholder.hidden = true;
  const el = document.createElement('div');
  el.className = 'cap interim';
  el.dataset.lang = baseLang(lang);
  el.innerHTML =
    '<span class="time"></span><div class="src"><img class="flag" alt="" /><span class="lang"></span><span class="text"></span></div><div class="tr"></div>';
  el.querySelector('.time').textContent = formatTime(new Date());
  const flag = el.querySelector('.flag');
  const flagSrc = SPEAKER_FLAGS[baseLang(lang)];
  if (flagSrc) flag.src = flagSrc;
  else flag.hidden = true;
  el.querySelector('.lang').textContent = SPEAKER_LABELS[baseLang(lang)] ?? baseLang(lang).toUpperCase();
  captionsEl.appendChild(el);
  while (captionsEl.querySelectorAll('.cap').length > MAX_BLOCKS) {
    captionsEl.querySelector('.cap').remove();
  }
  scrollToBottom();
  return { id: ++blockCounter, el, lang: baseLang(lang), segments: [], interim: '' };
}

const formatTime = (date) =>
  date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

function scrollToBottom() {
  captionsEl.scrollTop = captionsEl.scrollHeight;
}

const SENTENCE_END = /(?<!\b(?:Mr|Mrs|Ms|Dr|Dra|Sr|Sra|Srta|Jr|St|Ud|Uds|vs))([.!?…])\s+/g;
const ENDS_SENTENCE = /[.!?…]["'”)\]]*$/;
const splitSentences = (text) =>
  text
    .replace(SENTENCE_END, '$1\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

// Translations arrive per Deepgram segment, so sentences pair 1:1 only when both sides split into
// the same count; otherwise the whole segment is one pair rather than risk mismatched siblings.
function pairSegment(blockId, index, seg) {
  const src = splitSentences(seg.src);
  const tr = seg.tr ? splitSentences(seg.tr) : [];
  const base = `${blockId}:${index}`;
  const oneToOne = tr.length === 0 || src.length === tr.length;
  const pairOf = (j) => (oneToOne ? `${base}:${j}` : base);
  return {
    src: src.map((text, j) => ({ text, pair: pairOf(j) })),
    tr: tr.map((text, j) => ({ text, pair: pairOf(j) })),
  };
}

function fillSentences(container, items) {
  const nodes = [];
  items.forEach((item, k) => {
    if (k > 0) nodes.push(ENDS_SENTENCE.test(items[k - 1].text) ? '\n' : ' ');
    if (!item.pair) {
      nodes.push(item.text);
      return;
    }
    const span = document.createElement('span');
    span.className = 'sentence';
    span.dataset.pair = item.pair;
    span.textContent = item.text;
    span.classList.toggle('hovered', item.pair === hoveredPair);
    span.classList.toggle('selected', item.pair === selectedPair);
    nodes.push(span);
  });
  container.replaceChildren(...nodes);
}

function renderBlock(block) {
  const srcItems = [];
  const trItems = [];
  let trPending = false;
  block.segments.forEach((seg, i) => {
    const { src, tr } = pairSegment(block.id, i, seg);
    srcItems.push(...src);
    if (trPending) return;
    if (seg.tr === undefined) {
      trItems.push({ text: '…' });
      trPending = true;
    } else {
      trItems.push(...tr);
    }
  });
  if (block.interim) srcItems.push(...splitSentences(block.interim).map((text) => ({ text })));

  fillSentences(block.el.querySelector('.text'), srcItems);
  fillSentences(block.el.querySelector('.tr'), trItems);
  scrollToBottom();
}

// ---------- sentence highlighting ----------

let hoveredPair = null;
let selectedPair = null;

function markPair(pair, className, on) {
  if (!pair) return;
  for (const el of captionsEl.querySelectorAll(`.sentence[data-pair="${pair}"]`)) {
    el.classList.toggle(className, on);
  }
}

const pairAt = (target) => target.closest?.('.sentence')?.dataset.pair ?? null;

captionsEl.addEventListener('mouseover', (e) => {
  const pair = pairAt(e.target);
  if (pair === hoveredPair) return;
  markPair(hoveredPair, 'hovered', false);
  hoveredPair = pair;
  markPair(hoveredPair, 'hovered', true);
});

captionsEl.addEventListener('mouseleave', () => {
  markPair(hoveredPair, 'hovered', false);
  hoveredPair = null;
});

captionsEl.addEventListener('click', (e) => {
  const pair = pairAt(e.target);
  if (!pair || pair === selectedPair) return;
  markPair(selectedPair, 'selected', false);
  selectedPair = pair;
  markPair(selectedPair, 'selected', true);
});

function commitBlock() {
  if (!currentBlock) return;
  currentBlock.interim = '';
  if (currentBlock.segments.length === 0) {
    currentBlock.el.remove();
  } else {
    currentBlock.el.classList.remove('interim');
    renderBlock(currentBlock);
  }
  currentBlock = null;
}

async function translateSegment(block, seg) {
  if (settings.translator === 'off') {
    seg.tr = '';
    return;
  }
  const result = await window.captioner.translate(seg.src, block.lang, targetFor(block.lang));
  seg.tr = result.text;
  if (result.error) {
    lastProvider = null;
    setStatus('live', `Listening · translation error: ${result.error}`);
  } else if (result.provider && result.provider !== lastProvider) {
    lastProvider = result.provider;
    if (session) setStatus('live', `Listening · translating via ${result.provider}`);
  }
  renderBlock(block);
}

function handleTranscript({ text, isFinal, speechFinal, language }) {
  const lang = baseLang(language);
  if (text) resetHoldTimer();
  if (text && currentBlock && currentBlock.lang !== lang) {
    commitBlock();
  }
  if (text && !currentBlock) currentBlock = createBlock(lang);
  if (!currentBlock) return;

  if (isFinal) {
    currentBlock.interim = '';
    if (text) {
      const seg = { src: text, tr: undefined };
      currentBlock.segments.push(seg);
      translateSegment(currentBlock, seg);
    }
    renderBlock(currentBlock);
    if (speechFinal) currentBlock.el.classList.remove('interim');
  } else {
    currentBlock.interim = text;
    currentBlock.el.classList.add('interim');
    renderBlock(currentBlock);
  }
}

function handleUtteranceEnd() {
  if (currentBlock && !currentBlock.interim) currentBlock.el.classList.remove('interim');
}

function clearCaptions() {
  currentBlock = null;
  hoveredPair = null;
  selectedPair = null;
  captionsEl.querySelectorAll('.cap').forEach((el) => el.remove());
  placeholder.hidden = false;
}

// ---------- capture ----------

async function captureSystemAudio() {
  const request = () => navigator.mediaDevices.getDisplayMedia({ audio: true, video: { frameRate: 1 } });
  try {
    await window.captioner.setCaptureMode('window');
    return await request();
  } catch (err) {
    if (err.name === 'NotAllowedError') throw err;
    await window.captioner.setCaptureMode('screen');
    return await request();
  }
}

function watchForSilence(audioStream, deepgram) {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const source = ctx.createMediaStreamSource(audioStream);
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const startedAt = Date.now();
  let lastActivityAt = null;
  let audioActive = false;
  let hasHeardAudio = false;
  let warnedAboutMissingAudio = false;

  ctx.resume().catch((err) => console.error('Failed to resume audio activity detection:', err));

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sumSquares = 0;
    for (const sample of buf) sumSquares += sample * sample;
    const rms = Math.sqrt(sumSquares / buf.length);
    const now = Date.now();

    if (rms >= AUDIO_ACTIVITY_THRESHOLD) {
      lastActivityAt = now;
      hasHeardAudio = true;
      if (!audioActive) {
        audioActive = true;
        deepgram.setAudioActive(true);
      }
    } else if (audioActive && now - lastActivityAt >= SILENCE_WINDOW_MS) {
      audioActive = false;
      deepgram.setAudioActive(false);
    }

    if (!hasHeardAudio && !warnedAboutMissingAudio && now - startedAt >= SILENCE_WARNING_MS) {
      warnedAboutMissingAudio = true;
      setStatus(
        'connecting',
        'No audio yet. Play something, or check that this app is allowed to capture system audio.'
      );
    }
  }, AUDIO_CHECK_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    source.disconnect();
    analyser.disconnect();
    ctx.close();
  };
}

async function start() {
  if (!settings.deepgramKey) {
    openSettings();
    form.deepgramKey.focus();
    setStatus('error', 'Add a Deepgram API key to start.');
    return;
  }

  setStatus('connecting', 'Requesting system audio…');
  let stream;
  try {
    stream = await captureSystemAudio();
  } catch (err) {
    setStatus('error', `Audio capture failed: ${err.message || err.name}`);
    return;
  }

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    setStatus('error', 'No system audio track. This system does not support system-audio capture.');
    return;
  }

  const audioStream = new MediaStream(audioTracks);
  const deepgram = new DeepgramStream({
    apiKey: settings.deepgramKey,
    sourceMode: settings.sourceMode,
    onTranscript: handleTranscript,
    onUtteranceEnd: handleUtteranceEnd,
    onStatus: (state, text) => {
      setStatus(state, text);
      if (state === 'error') stop({ keepStatus: true });
    },
  });

  session = { stream, deepgram, stopSilenceWatch: watchForSilence(audioStream, deepgram) };
  audioTracks[0].addEventListener('ended', () => stop());
  deepgram.start(audioStream);
  resetHoldTimer();

  toggleBtn.textContent = 'Stop';
  overlay.classList.remove('idle');
}

function stop({ keepStatus = false } = {}) {
  if (!session) return;
  const { stream, deepgram, stopSilenceWatch } = session;
  session = null;
  deepgram.stop();
  stopSilenceWatch();
  stream.getTracks().forEach((t) => t.stop());
  stopHoldTimer();
  commitBlock();
  toggleBtn.textContent = 'Start';
  overlay.classList.add('idle');
  if (!keepStatus) setStatus('idle', 'Idle');
}

async function restartIfLive() {
  if (!session) return;
  stop();
  await start();
}

// ---------- settings ----------

function syncTranslatorFields() {
  for (const el of form.querySelectorAll('[data-for]')) {
    el.hidden = !el.dataset.for.split(' ').includes(form.translator.value);
  }
}

function openSettings() {
  form.deepgramKey.value = settings.deepgramKey;
  form.translator.value = settings.translator;
  form.myMemoryEmail.value = settings.myMemoryEmail;
  form.deeplKey.value = settings.deeplKey;
  form.fontSize.value = settings.fontSize;
  form.bgOpacity.value = settings.bgOpacity;
  form.bgColor.value = settings.bgColor;
  form.showOriginal.checked = settings.showOriginal;
  syncTranslatorFields();
  settingsPanel.hidden = false;
  overlay.classList.add('settings-open');
}

function readForm() {
  return {
    deepgramKey: form.deepgramKey.value.trim(),
    translator: form.translator.value,
    myMemoryEmail: form.myMemoryEmail.value.trim(),
    deeplKey: form.deeplKey.value.trim(),
    fontSize: Number(form.fontSize.value),
    bgOpacity: Number(form.bgOpacity.value),
    bgColor: form.bgColor.value,
    showOriginal: form.showOriginal.checked,
  };
}

form.addEventListener('input', () => {
  syncTranslatorFields();
  settings = { ...settings, ...readForm() };
  applyAppearance();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const keyChanged = form.deepgramKey.value.trim() !== (await window.captioner.getSettings()).deepgramKey;
  settings = await window.captioner.setSettings(readForm());
  applyAppearance();
  translatorSelect.value = settings.translator;
  settingsPanel.hidden = true;
  overlay.classList.remove('settings-open');
  if (keyChanged) await restartIfLive();
  else if (!session) setStatus('idle', 'Idle');
});

// ---------- toolbar ----------

toggleBtn.addEventListener('click', () => (session ? stop() : start()));
$('clearBtn').addEventListener('click', clearCaptions);
$('closeBtn').addEventListener('click', () => window.captioner.close());

const collapseBtn = $('collapseBtn');
collapseBtn.addEventListener('click', () => {
  const collapsed = overlay.classList.toggle('collapsed');
  collapseBtn.textContent = collapsed ? '▲' : '▼';
  collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
  window.captioner.setCollapsed(collapsed);
});

async function changeFontSize(delta) {
  const fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, settings.fontSize + delta));
  settings = await window.captioner.setSettings({ fontSize });
  applyAppearance();
}
$('fontDownBtn').addEventListener('click', () => changeFontSize(-2));
$('fontUpBtn').addEventListener('click', () => changeFontSize(2));
$('settingsBtn').addEventListener('click', () => {
  if (settingsPanel.hidden) openSettings();
  else form.requestSubmit();
});

clickThroughBtn.title = `Click-through (${SHORTCUT_MODIFIERS}L)`;
clickThroughBtn.addEventListener('click', () => window.captioner.setClickThrough(true));
window.captioner.onClickThrough((enabled) => {
  clickThroughBtn.classList.toggle('active', enabled);
  if (enabled) setStatus(session ? 'live' : 'idle', `Click-through on · ${SHORTCUT_MODIFIERS}L to unlock`);
  else setStatus(session ? 'live' : 'idle', session ? 'Listening' : 'Idle');
});

sourceModeEl.value = settings.sourceMode;
sourceModeEl.addEventListener('change', async () => {
  settings = await window.captioner.setSettings({ sourceMode: sourceModeEl.value });
  await restartIfLive();
});

const translatorSelect = $('translatorSelect');
translatorSelect.value = settings.translator;
translatorSelect.addEventListener('change', async () => {
  settings = await window.captioner.setSettings({ translator: translatorSelect.value });
  lastProvider = null;
  applyAppearance();
  if (!settingsPanel.hidden) {
    form.translator.value = settings.translator;
    syncTranslatorFields();
  }
});

function previewBackground() {
  settings = { ...settings, bgColor: bgColorInput.value, bgOpacity: Number(bgOpacityInput.value) };
  applyAppearance();
  if (!settingsPanel.hidden) {
    form.bgColor.value = settings.bgColor;
    form.bgOpacity.value = settings.bgOpacity;
  }
}

async function saveBackground() {
  previewBackground();
  settings = await window.captioner.setSettings({ bgColor: settings.bgColor, bgOpacity: settings.bgOpacity });
}

function randomDarkColor() {
  const channel = () => Math.floor(Math.random() * 72 + 24).toString(16).padStart(2, '0');
  return `#${channel()}${channel()}${channel()}`;
}

async function randomizeBackground() {
  settings = { ...settings, bgColor: randomDarkColor() };
  applyAppearance();
  if (!settingsPanel.hidden) form.bgColor.value = settings.bgColor;
  settings = await window.captioner.setSettings({ bgColor: settings.bgColor });
}

let backgroundChangePromise = Promise.resolve();
randomizeBgBtn.addEventListener('click', () => {
  backgroundChangePromise = randomizeBackground();
});

for (const input of [bgColorInput, bgOpacityInput]) {
  input.addEventListener('input', previewBackground);
  input.addEventListener('change', saveBackground);
}

randomizeBgBtn.click();
await backgroundChangePromise;
renderHoldTimer();
overlay.classList.add('idle');
