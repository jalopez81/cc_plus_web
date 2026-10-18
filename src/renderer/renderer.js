import { DeepgramStream } from './deepgram.js';

const MAX_BLOCKS = 200;
const SILENCE_WARNING_MS = 8000;
const HOLD_TIME_MS = 15 * 60 * 1000;
const HOLD_WARNING_MS = 2 * 60 * 1000;
const FONT_MIN = 16;
const FONT_MAX = 48;
const SPEAKER_LABELS = { en: 'Cliente · EN', es: 'LEP · ES' };
const SPEAKER_FLAGS = { en: '🇬🇧', es: '🇪🇸' };

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
let lastProvider = null;

// ---------- status & appearance ----------

function setStatus(state, text) {
  statusDot.className = `dot ${state === 'idle' ? '' : state}`;
  statusText.textContent = text;
  statusText.title = text;
}

function applyAppearance() {
  const root = document.documentElement.style;
  root.setProperty('--font-size', `${settings.fontSize}px`);
  root.setProperty('--bg-alpha', String(settings.bgOpacity));
  document.body.classList.toggle('hide-original', !settings.showOriginal);
  document.body.classList.toggle('no-translation', settings.translator === 'off');
}

// ---------- hold timer ----------

const holdTimerEl = $('holdTimer');
let holdDeadline = null;
let holdInterval = null;

function renderHoldTimer() {
  const remaining = holdDeadline === null ? HOLD_TIME_MS : Math.max(0, holdDeadline - Date.now());
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
    '<span class="time"></span><div class="src"><span class="flag"></span><span class="lang"></span><span class="text"></span></div><div class="tr"></div>';
  el.querySelector('.time').textContent = formatTime(new Date());
  el.querySelector('.flag').textContent = SPEAKER_FLAGS[baseLang(lang)] ?? '';
  el.querySelector('.lang').textContent = SPEAKER_LABELS[baseLang(lang)] ?? baseLang(lang).toUpperCase();
  captionsEl.appendChild(el);
  while (captionsEl.querySelectorAll('.cap').length > MAX_BLOCKS) {
    captionsEl.querySelector('.cap').remove();
  }
  scrollToBottom();
  return { el, lang: baseLang(lang), segments: [], interim: '' };
}

const formatTime = (date) =>
  date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

function scrollToBottom() {
  captionsEl.scrollTop = captionsEl.scrollHeight;
}

const SENTENCE_END = /(?<!\b(?:Mr|Mrs|Ms|Dr|Dra|Sr|Sra|Srta|Jr|St|Ud|Uds|vs))([.!?…])\s+/g;
const breakSentences = (text) => text.replace(SENTENCE_END, '$1\n');

function renderBlock(block) {
  const finalText = block.segments.map((s) => s.src).join(' ');
  block.el.querySelector('.text').textContent = breakSentences(
    [finalText, block.interim].filter(Boolean).join(' ')
  );

  const translated = [];
  for (const seg of block.segments) {
    if (seg.tr === undefined) {
      translated.push('…');
      break;
    }
    if (seg.tr) translated.push(seg.tr);
  }
  block.el.querySelector('.tr').textContent = breakSentences(translated.join(' '));
  scrollToBottom();
}

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
  if (text && currentBlock && currentBlock.segments.length > 0 && currentBlock.lang !== lang) {
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
    if (speechFinal) commitBlock();
  } else {
    currentBlock.interim = text;
    renderBlock(currentBlock);
  }
}

function handleUtteranceEnd() {
  if (currentBlock && !currentBlock.interim) commitBlock();
}

function clearCaptions() {
  currentBlock = null;
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

function watchForSilence(audioStream) {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(audioStream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const startedAt = Date.now();
  let heardAudio = false;

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    if (buf.some((v) => Math.abs(v) > 0.0005)) heardAudio = true;
    if (heardAudio) {
      clearInterval(timer);
    } else if (Date.now() - startedAt > SILENCE_WARNING_MS) {
      clearInterval(timer);
      setStatus(
        'connecting',
        'No audio yet. Play something, or allow audio capture in System Settings › Privacy & Security.'
      );
    }
  }, 250);

  return () => {
    clearInterval(timer);
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
    setStatus('error', 'No system audio track. macOS 13 or later is required.');
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

  session = { stream, deepgram, stopSilenceWatch: watchForSilence(audioStream) };
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

clickThroughBtn.addEventListener('click', () => window.captioner.setClickThrough(true));
window.captioner.onClickThrough((enabled) => {
  clickThroughBtn.classList.toggle('active', enabled);
  if (enabled) setStatus(session ? 'live' : 'idle', 'Click-through on · ⌘⇧L to unlock');
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

applyAppearance();
renderHoldTimer();
overlay.classList.add('idle');
