import { DeepgramStream } from './deepgram.js';
import { WhisperStream } from './whisper.js';
import { showToast } from './interpreter.js';

const MAX_BLOCKS = 200;
const HOLD_TIME_MS = 15 * 60 * 1000;
const HOLD_WARNING_MS = 2 * 60 * 1000;
const FONT_MIN = 16;
const FONT_MAX = 48;
const SPEAKER_LABELS = { en: 'Cliente · EN', es: 'LEP · ES' };
const SPEAKER_FLAGS = { en: 'flags/gb.svg', es: 'flags/es.svg' };

const $ = (id) => document.getElementById(id);
const overlay = $('overlay');
const captionsEl = $('captions');
const placeholder = $('placeholder');
const toggleBtn = $('toggleBtn');
const statusDot = $('statusDot');
const form = $('settingsForm');
const settingsBtn = $('settingsBtn');
const settingsSummary = $('settingsSummary');
const settingsContent = $('settingsContent');
const showTranscriptionToggle = $('showTranscriptionToggle');
const showTranslationToggle = $('showTranslationToggle');
const sentenceLinesToggle = $('sentenceLinesToggle');

document.body.classList.add(`platform-${window.captioner.platform}`);

let settings = await window.captioner.getSettings();
settings.transcriptionEngine ??= 'whisper';
settings.deepgramKey ??= '';
settings.accessCode ??= '';
settings.showTranscription = settings.showTranscription ?? settings.showOriginal ?? true;
settings.showTranslation = settings.showTranslation ?? true;
settings.sentenceLines ??= true;
let session = null;
let captureStarting = false;
let currentBlock = null;
let blockCounter = 0;
let lastProvider = null;

// ---------- status & appearance ----------

function setStatus(state, text) {
  statusDot.className = `dot ${state === 'idle' ? '' : state}`;
  statusDot.title = text;
  statusDot.setAttribute('aria-label', text);
  toggleBtn.title = text;
  if (state === 'error' || text.startsWith('Translation unavailable')) showToast(text);
}

const bgColorInput = $('bgColorInput');

const hexToRgb = (hex) => hex.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16));

function isLightBackground(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4;
}

function applyAppearance() {
  const root = document.documentElement.style;
  const rgb = hexToRgb(settings.bgColor);
  root.setProperty('--font-size', `${settings.fontSize}px`);
  $('fontSizeValue').textContent = settings.fontSize;
  $('fontDownBtn').disabled = settings.fontSize <= FONT_MIN;
  $('fontUpBtn').disabled = settings.fontSize >= FONT_MAX;
  root.setProperty('--bg-alpha', '1');
  root.setProperty('--bg-rgb', rgb.join(', '));
  document.body.classList.toggle('light-bg', isLightBackground(rgb));
  document.body.classList.toggle('hide-transcription', !settings.showTranscription);
  document.body.classList.toggle('hide-translation', !settings.showTranslation);
  document.body.classList.toggle('translator-off', settings.translator === 'off');
  document.body.classList.toggle('paragraphs', !settings.sentenceLines);
  bgColorInput.value = settings.bgColor;
  const translatorNames = {
    auto: 'Auto',
    deepl: 'DeepL',
    google: 'Google',
    mymemory: 'MyMemory',
    apertium: 'Apertium',
    off: 'Off',
  };
  const transcriptionName = settings.transcriptionEngine === 'deepgram' ? 'Deepgram' : 'Whisper';
  settingsSummary.textContent = `${transcriptionName} · ${translatorNames[settings.translator] ?? 'Auto'}`;
  showTranscriptionToggle.checked = settings.showTranscription;
  showTranslationToggle.checked = settings.showTranslation;
  sentenceLinesToggle.checked = settings.sentenceLines;
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

// ---------- audio meters ----------

const METER_INTERVAL_MS = 100;
// Peak amplitude of system audio that counts as speech, whether sent or withheld by mute.
const SPEECH_LEVEL = 0.02;
const SPEECH_HOLD_MS = 400;
// Headsets muted in hardware deliver digital zeros; a live mic's noise floor sits above one 16-bit step.
const MIC_SILENCE_LEVEL = 1e-5;
const MIC_MUTE_AFTER_MS = 1200;
const MIC_SPEAKING_LEVEL = 0.05;

let meterCtx = null;

function createLevelMeter(stream) {
  meterCtx ??= new AudioContext();
  void meterCtx.resume();
  const source = meterCtx.createMediaStreamSource(stream);
  const analyser = meterCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  return {
    peak() {
      analyser.getFloatTimeDomainData(samples);
      let max = 0;
      for (const v of samples) max = Math.max(max, Math.abs(v));
      return max;
    },
    stop: () => source.disconnect(),
  };
}

// ---------- mute ----------

const speakIndicator = $('speakIndicator');
const speakLabel = $('speakLabel');
let muted = false;
let systemMeter = null;
let speechUntil = 0;

function setMuted(next) {
  muted = next;
  session?.transcription.setMuted(muted);
  speakIndicator.classList.toggle('muted', muted);
  speakIndicator.setAttribute('aria-pressed', String(muted));
  speakIndicator.title = muted
    ? 'Transcription muted: audio is not sent · click to resume'
    : 'Transcription on: click to mute';
  speakIndicator.setAttribute('aria-label', muted ? 'Unmute transcription' : 'Mute transcription');
  speakLabel.textContent = muted ? 'OFF' : 'ON';
}

// ---------- headset mic ----------

const micIndicator = $('micIndicator');
const micLabel = $('micLabel');
let micStream = null;
let micMeter = null;
let micLastSound = 0;
let micGeneration = 0;

function stopMicMonitor() {
  micGeneration += 1;
  micMeter?.stop();
  micStream?.getTracks().forEach((track) => track.stop());
  micMeter = null;
  micStream = null;
  micIndicator.dataset.state = 'unknown';
  micIndicator.classList.remove('speaking');
  micLabel.textContent = 'MIC';
  micIndicator.title = 'Headset mic';
}

async function startMicMonitor() {
  stopMicMonitor();
  const generation = micGeneration;
  try {
    if (!(await window.captioner.requestMicAccess())) throw new Error('microphone access denied');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (generation !== micGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    micStream = stream;
    micMeter = createLevelMeter(stream);
    micLastSound = Date.now();
    const [track] = stream.getAudioTracks();
    micIndicator.title = `Headset mic: ${track.label || 'default input'}`;
  } catch (err) {
    if (generation !== micGeneration) return;
    micIndicator.title = `Mic monitor unavailable: ${err.message || err.name}`;
  }
}

function renderMic(now) {
  const [track] = micStream.getAudioTracks();
  const peak = micMeter.peak();
  if (peak > MIC_SILENCE_LEVEL) micLastSound = now;
  const off = track.muted || track.readyState === 'ended' || now - micLastSound > MIC_MUTE_AFTER_MS;
  micIndicator.dataset.state = off ? 'off' : 'on';
  micIndicator.classList.toggle('speaking', !off && peak > MIC_SPEAKING_LEVEL);
  micLabel.textContent = off ? 'OFF' : 'ON';
}

function pollMeters() {
  const now = Date.now();
  if (systemMeter && systemMeter.peak() > SPEECH_LEVEL) speechUntil = now + SPEECH_HOLD_MS;
  speakIndicator.classList.toggle('speaking', Boolean(systemMeter) && now < speechUntil);
  if (micMeter) renderMic(now);
}

// ---------- captions ----------

const baseLang = (lang) => (lang || 'en').slice(0, 2).toLowerCase();
const targetFor = (lang) => (baseLang(lang) === 'es' ? 'en' : 'es');

function createBlock(lang) {
  placeholder.hidden = true;
  const el = document.createElement('div');
  el.className = 'cap interim active';
  el.dataset.lang = baseLang(lang);
  el.innerHTML =
    '<div class="cap-meta"><span class="time"></span><button type="button" class="split-btn" hidden title="Continue this language in a new bubble">Split</button></div><div class="src"><img class="flag" alt="" /><span class="lang"></span><span class="text"></span></div><div class="tr"></div>' +
    '<div class="paraphrase" hidden><button type="button" class="paraphrase-btn" title="Summarize this message (Gemini / Groq)">Paraphrase</button><div class="summary" hidden></div></div>';
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
  const block = { id: ++blockCounter, el, lang: baseLang(lang), segments: [], interim: '' };
  blocksByEl.set(el, block);
  return block;
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

// Translations arrive per transcription segment, so sentences pair 1:1 only when both sides split into
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
  block.el.querySelector('.paraphrase').hidden = block.segments.length === 0;
  updateSplitButton(block);
  scrollToBottom();
}

// Same-language speech stays in one bubble, so offer a manual split once it gets too tall to follow.
const SPLIT_THRESHOLD = 0.45; // fraction of the captions area's height

function updateSplitButton(block) {
  const tooTall = block === currentBlock && block.el.offsetHeight > captionsEl.clientHeight * SPLIT_THRESHOLD;
  block.el.querySelector('.split-btn').hidden = !tooTall;
}

// ---------- paraphrase ----------

const blocksByEl = new WeakMap();

// Summarizes the translation (what the interpreter reads out); without one, the original speech.
async function paraphraseBlock(el) {
  const block = blocksByEl.get(el);
  if (!block) return;
  const translated = block.segments.map((seg) => seg.tr).filter(Boolean);
  const [text, lang] = translated.length
    ? [translated.join(' '), targetFor(block.lang)]
    : [block.segments.map((seg) => seg.src).join(' '), block.lang];
  if (!text.trim()) return;

  const button = el.querySelector('.paraphrase-btn');
  const summary = el.querySelector('.summary');
  button.disabled = true;
  button.textContent = 'Paraphrasing…';
  try {
    const result = await window.captioner.paraphrase(text, lang);
    summary.classList.toggle('error', Boolean(result.error));
    summary.textContent =
      result.error === 'Paraphrase API key is not set'
        ? 'Add a Gemini or Groq API key in Engines to paraphrase.'
        : result.error || result.text;
  } catch (err) {
    summary.classList.add('error');
    summary.textContent = `Paraphrase: ${err.message || 'request failed'}`;
  }
  summary.hidden = false;
  button.disabled = false;
  button.textContent = 'Paraphrase again';
  if (el === captionsEl.lastElementChild) scrollToBottom();
}

function splitBlock(el) {
  if (currentBlock?.el !== el) return;
  // Speech still in progress moves to the new bubble on Deepgram's next interim update.
  commitBlock();
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
  const splitBtn = e.target.closest('.split-btn');
  if (splitBtn) {
    splitBlock(splitBtn.closest('.cap'));
    return;
  }
  const paraphraseBtn = e.target.closest('.paraphrase-btn');
  if (paraphraseBtn) {
    void paraphraseBlock(paraphraseBtn.closest('.cap'));
    return;
  }
  // A drag that selected text for copying also ends in a click; don't treat it as picking a sentence.
  if (!window.getSelection().isCollapsed) return;
  const pair = pairAt(e.target);
  if (!pair || pair === selectedPair) return;
  markPair(selectedPair, 'selected', false);
  selectedPair = pair;
  markPair(selectedPair, 'selected', true);
});

document.addEventListener('click', (e) => {
  if (!selectedPair || e.target.closest('.cap')) return;
  markPair(selectedPair, 'selected', false);
  selectedPair = null;
});

function commitBlock() {
  if (!currentBlock) return;
  currentBlock.interim = '';
  if (currentBlock.segments.length === 0) {
    currentBlock.el.remove();
  } else {
    currentBlock.el.classList.remove('interim', 'active');
    renderBlock(currentBlock);
  }
  currentBlock = null;
}

// Short fragments ("OK", "sí") are often misdetected, and a missing language says nothing,
// so only a longer fragment in another language opens a new bubble, unless the server is sure.
const MIN_SWITCH_WORDS = 3;

function resolveLang(language, transcript, confident = false) {
  const detected = language ? baseLang(language) : null;
  if (!currentBlock) return detected ?? 'en';
  if (!detected || detected === currentBlock.lang) return currentBlock.lang;
  if (confident) return detected;
  return transcript.split(/\s+/).length < MIN_SWITCH_WORDS ? currentBlock.lang : detected;
}

// ---------- conversation log ----------

const logTime = (date) => date.toLocaleTimeString('en-US', { hour12: true });

// Each segment is logged once, when final and translated, so Clear never loses the conversation.
function logSegment(block, seg) {
  const label = SPEAKER_LABELS[block.lang] ?? block.lang.toUpperCase();
  let line = `[${logTime(seg.time)}] ${label}: ${seg.src}
`;
  if (seg.tr) line += `    → ${seg.tr}
`;
  window.captioner.appendLog(line);
}

const logSession = (event) =>
  window.captioner.appendLog(`
=== Session ${event} · ${new Date().toLocaleString('en-US')} ===
`);

async function translateSegment(block, seg) {
  if (settings.translator === 'off') {
    seg.tr = '';
    renderBlock(block);
    logSegment(block, seg);
    return;
  }
  try {
    const result = await window.captioner.translate(seg.src, block.lang, targetFor(block.lang));
    seg.tr = result.text;
    if (result.error) {
      lastProvider = null;
      let message = result.error;
      if (message === 'DeepL API key is not set') {
        message = 'Add your DeepL API key in Settings to translate.';
      } else if (message.includes('HTTP 456')) {
        message = 'DeepL monthly character quota exceeded (HTTP 456); check your account.';
      } else if (message.includes('DeepL: HTTP 403')) {
        message = 'DeepL rejected the API key (HTTP 403); check it in Settings.';
      }
      setStatus('live', `Translation unavailable: ${message}`);
    } else if (result.provider && result.provider !== lastProvider) {
      lastProvider = result.provider;
      if (session) setStatus('live', `Listening · translating via ${result.provider}`);
    }
  } catch (err) {
    seg.tr = '';
    lastProvider = null;
    console.error('Translation request failed:', err);
    setStatus('live', `Translation unavailable: ${err.message || 'request failed'}`);
  }
  renderBlock(block);
  logSegment(block, seg);
}

function handleTranscript({ text, language, confident, translation }) {
  const transcript = String(text ?? '').trim();
  const translated = typeof translation === 'string' ? translation.trim() : '';
  if (!transcript) return;
  const lang = resolveLang(language, transcript, confident);

  if (text) resetHoldTimer();
  if (currentBlock && currentBlock.lang !== lang) {
    commitBlock();
  }
  if (!currentBlock) currentBlock = createBlock(lang);

  const seg = {
    src: transcript,
    tr: translated || (settings.translator === 'off' ? '' : undefined),
    time: new Date(),
  };
  currentBlock.segments.push(seg);
  renderBlock(currentBlock);
  if (seg.tr === undefined) void translateSegment(currentBlock, seg);
  else logSegment(currentBlock, seg);
}

function handleDeepgramTranscript({ text, language, isFinal, speechFinal }) {
  const transcript = String(text ?? '').trim();
  // End of a sentence no longer closes the bubble: same-language speech keeps growing the
  // current one, and only a language change (or Stop) commits it.
  if (!transcript) {
    if (speechFinal) handleUtteranceEnd();
    return;
  }
  resetHoldTimer();
  const lang = resolveLang(language, transcript);
  if (currentBlock && currentBlock.lang !== lang) commitBlock();
  if (!currentBlock) currentBlock = createBlock(lang);

  if (isFinal) {
    const seg = { src: transcript, tr: settings.translator === 'off' ? '' : undefined, time: new Date() };
    currentBlock.segments.push(seg);
    currentBlock.interim = '';
    renderBlock(currentBlock);
    if (seg.tr === undefined) void translateSegment(currentBlock, seg);
    else logSegment(currentBlock, seg);
    if (speechFinal) handleUtteranceEnd();
  } else {
    currentBlock.interim = transcript;
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
  const request = () =>
    navigator.mediaDevices.getDisplayMedia({ audio: true, video: { frameRate: 1 } });
  try {
    await window.captioner.setCaptureMode('window');
    return await request();
  } catch (err) {
    if (err.name === 'NotAllowedError') throw err;
    await window.captioner.setCaptureMode('screen');
    return request();
  }
}

const TOGGLE_LABELS = { idle: 'Start', starting: 'Starting…', live: 'Stop' };

// One place derives the Start/Stop button from capture state; CSS colors it per data-state.
function renderToggle() {
  const state = captureStarting ? 'starting' : session ? 'live' : 'idle';
  toggleBtn.dataset.state = state;
  toggleBtn.textContent = TOGGLE_LABELS[state];
  toggleBtn.disabled = captureStarting;
}

async function start() {
  if (session || captureStarting) return;
  captureStarting = true;
  renderToggle();

  // Pressing Start with unsaved engine choices should use them, not the last saved ones.
  if (formIsDirty()) {
    try {
      await saveForm();
    } catch (err) {
      setStatus('error', `Could not save settings: ${err.message || 'unknown error'}`);
      captureStarting = false;
      renderToggle();
      return;
    }
  }

  if (settings.transcriptionEngine === 'deepgram' && !settings.deepgramKey) {
    openSettings();
    form.deepgramKey.focus();
    setStatus('error', 'Add a Deepgram API key in Engines settings to start.');
    captureStarting = false;
    renderToggle();
    return;
  }

  if (settings.transcriptionEngine !== 'deepgram') {
    if (!settings.transcriptionUrl) {
      openSettings();
      form.transcriptionUrl.focus();
      setStatus('error', 'Add the Whisper WebSocket URL in Engines settings.');
      captureStarting = false;
      renderToggle();
      return;
    }
    if (!settings.transcriptionUrl.startsWith('wss://')) {
      setStatus('error', 'The Whisper transcription URL must start with wss://.');
      captureStarting = false;
      renderToggle();
      return;
    }
    if (!/^[0-9a-f]+$/i.test(settings.accessCode)) {
      openSettings();
      form.accessCode.focus();
      setStatus('error', 'Add your server access code in Engines settings.');
      captureStarting = false;
      renderToggle();
      return;
    }
  }

  setStatus('connecting', 'Requesting computer audio capture…');
  let stream;
  try {
    stream = await captureSystemAudio();
    const audioTracks = stream.getAudioTracks();
    stream.getVideoTracks().forEach((track) => track.stop());
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('No computer-audio track was provided by the system.');
    }

    const audioStream = new MediaStream(audioTracks);
    const onStatus = (state, text) => {
      if (state === 'disconnected') {
        if (session?.transcription === transcription) {
          stop({ keepStatus: true });
          setStatus('idle', text);
        }
        return;
      }
      setStatus(state, text);
      if (state === 'error') stop({ keepStatus: true });
    };
    const transcription =
      settings.transcriptionEngine === 'deepgram'
        ? new DeepgramStream({
            apiKey: settings.deepgramKey,
            onTranscript: handleDeepgramTranscript,
            onUtteranceEnd: handleUtteranceEnd,
            onStatus,
          })
        : new WhisperStream({
            url: settings.transcriptionUrl,
            accessCode: settings.accessCode,
            onTranscript: handleTranscript,
            onStatus,
          });

    transcription.setMuted(muted);
    systemMeter = createLevelMeter(audioStream);
    session = { stream, transcription };
    audioTracks[0].addEventListener('ended', () => stop());
    await transcription.start(audioStream);
    if (session?.transcription !== transcription) return;
    resetHoldTimer();
    logSession('started');

    renderToggle();
    overlay.classList.remove('idle');
  } catch (err) {
    if (session) stop({ keepStatus: true });
    else stream?.getTracks().forEach((track) => track.stop());
    systemMeter?.stop();
    systemMeter = null;
    setStatus('error', `Computer audio capture failed: ${err.message || err.name}`);
  } finally {
    captureStarting = false;
    renderToggle();
  }
}

function stop({ keepStatus = false } = {}) {
  if (!session) return;
  const { stream, transcription } = session;
  session = null;
  transcription.stop();
  stream.getTracks().forEach((t) => t.stop());
  systemMeter?.stop();
  systemMeter = null;
  stopHoldTimer();
  commitBlock();
  logSession('ended');
  renderToggle();
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
  for (const el of form.querySelectorAll('[data-engine-for]')) {
    el.hidden = !el.dataset.engineFor.split(' ').includes(form.transcriptionEngine.value);
  }
  if (form.translator.value !== 'deepl') setDeeplHelpOpen(false);
}

// ---------- DeepL help ----------

function setDeeplHelpOpen(open) {
  $('deeplHelp').hidden = !open;
  $('deeplHelpBtn').setAttribute('aria-expanded', String(open));
}

$('deeplHelpBtn').addEventListener('click', () => setDeeplHelpOpen($('deeplHelp').hidden));
$('closeDeeplHelp').addEventListener('click', () => setDeeplHelpOpen(false));
$('deeplHelp').addEventListener('click', (e) => {
  const link = e.target.closest('[data-href]');
  if (link) window.captioner.openExternal(link.dataset.href);
});

// ---------- hidden advanced settings ----------

// Typing this in the call notes reveals the advanced panel; typing it again hides it.
const SECRET_CODE = '#lcp-config';
const advancedPanel = $('advancedPanel');
const deepgramOption = $('deepgramOption');
const showDeepgramToggle = $('showDeepgramToggle');
const notesInput = $('callNotes');

function applyDeepgramVisibility() {
  const show = Boolean(settings.showDeepgram);
  deepgramOption.hidden = !show;
  deepgramOption.disabled = !show;
  showDeepgramToggle.checked = show;
}

notesInput.addEventListener('input', () => {
  if (!notesInput.value.includes(SECRET_CODE)) return;
  notesInput.value = notesInput.value.replace(SECRET_CODE, '');
  notesInput.dispatchEvent(new Event('input')); // lets the notes autosave drop the code too
  advancedPanel.hidden = !advancedPanel.hidden;
  if (!advancedPanel.hidden) openSettings();
  showToast(advancedPanel.hidden ? 'Configuración avanzada oculta' : 'Configuración avanzada activada');
});

showDeepgramToggle.addEventListener('change', async () => {
  const show = showDeepgramToggle.checked;
  // Hiding Deepgram while it is the engine falls back to Whisper so nothing points at a hidden option.
  const fallBack = !show && settings.transcriptionEngine === 'deepgram';
  try {
    settings = await window.captioner.setSettings({
      showDeepgram: show,
      ...(fallBack && { transcriptionEngine: 'whisper' }),
    });
  } catch (err) {
    setStatus('error', `Could not save settings: ${err.message || 'unknown error'}`);
    return;
  }
  if (!show && form.transcriptionEngine.value === 'deepgram') form.transcriptionEngine.value = 'whisper';
  applyDeepgramVisibility();
  syncTranslatorFields();
  applyAppearance();
  if (fallBack) await restartIfLive();
});

function fillForm() {
  form.transcriptionEngine.value = settings.transcriptionEngine;
  form.transcriptionUrl.value = settings.transcriptionUrl || '';
  form.accessCode.value = settings.accessCode || '';
  form.deepgramKey.value = settings.deepgramKey || '';
  form.translator.value = settings.translator;
  form.myMemoryEmail.value = settings.myMemoryEmail || '';
  form.deeplKey.value = settings.deeplKey || '';
  form.geminiKey.value = settings.geminiKey || '';
  form.groqKey.value = settings.groqKey || '';
  syncTranslatorFields();
}

// Opening and closing only toggle visibility, so unsaved edits survive a collapse.
function setSettingsOpen(open) {
  form.inert = !open;
  settingsContent.classList.toggle('expanded', open);
  settingsContent.setAttribute('aria-hidden', String(!open));
  settingsBtn.setAttribute('aria-expanded', String(open));
}

const openSettings = () => setSettingsOpen(true);
const closeSettings = () => setSettingsOpen(false);
const settingsOpen = () => settingsBtn.getAttribute('aria-expanded') === 'true';

function formIsDirty() {
  return Object.entries(readForm()).some(([key, value]) => value !== (settings[key] ?? ''));
}

async function saveForm() {
  const values = readForm();
  const restartRequired =
    values.transcriptionEngine !== settings.transcriptionEngine ||
    (values.transcriptionEngine === 'whisper' &&
      (values.transcriptionUrl !== settings.transcriptionUrl || values.accessCode !== settings.accessCode)) ||
    (values.transcriptionEngine === 'deepgram' && values.deepgramKey !== settings.deepgramKey);
  const translatorChanged = values.translator !== settings.translator || values.deeplKey !== settings.deeplKey;
  settings = await window.captioner.setSettings(values);
  if (translatorChanged) lastProvider = null;
  applyAppearance();
  return { restartRequired, translatorChanged };
}

function readForm() {
  return {
    transcriptionEngine: form.transcriptionEngine.value,
    transcriptionUrl: form.transcriptionUrl.value.trim(),
    accessCode: form.accessCode.value.trim(),
    deepgramKey: form.deepgramKey.value.trim(),
    translator: form.translator.value,
    myMemoryEmail: form.myMemoryEmail.value.trim(),
    deeplKey: form.deeplKey.value.trim(),
    geminiKey: form.geminiKey.value.trim(),
    groqKey: form.groqKey.value.trim(),
  };
}

form.addEventListener('input', () => {
  syncTranslatorFields();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { restartRequired, translatorChanged } = await saveForm();
    closeSettings();
    if (restartRequired) await restartIfLive();
    else if (!session) setStatus('idle', 'Idle');
    else if (translatorChanged) setStatus('live', 'Listening');
  } catch (err) {
    setStatus('error', `Could not save settings: ${err.message || 'unknown error'}`);
  }
});

// ---------- toolbar ----------

toggleBtn.addEventListener('click', () => (session ? stop() : start()));
speakIndicator.addEventListener('click', () => setMuted(!muted));
// A plugged or unplugged headset changes the default input, so follow it (this also retries a failed start).
navigator.mediaDevices.addEventListener('devicechange', () => void startMicMonitor());
$('clearBtn').addEventListener('click', clearCaptions);

// Marks a call boundary in the log; the next speech starts a fresh bubble.
async function newCall() {
  commitBlock();
  try {
    const number = await window.captioner.logNewCall();
    if (session) resetHoldTimer();
    showToast(`Llamada #${number} iniciada en el registro`);
  } catch (err) {
    showToast('No se pudo escribir en el registro');
    console.error('New call log failed:', err);
  }
}

$('newCallBtn').addEventListener('click', newCall);

async function changeFontSize(delta) {
  const fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, settings.fontSize + delta));
  settings = await window.captioner.setSettings({ fontSize });
  applyAppearance();
}
$('fontDownBtn').addEventListener('click', () => changeFontSize(-2));
$('fontUpBtn').addEventListener('click', () => changeFontSize(2));
settingsBtn.addEventListener('click', () => setSettingsOpen(!settingsOpen()));

// Translator choice needs no restart, so apply it immediately; otherwise a stale saved
// translator (e.g. DeepL without a key) keeps erroring until Done is pressed.
form.translator.addEventListener('change', async () => {
  syncTranslatorFields();
  lastProvider = null;
  try {
    settings = await window.captioner.setSettings({ translator: form.translator.value });
    applyAppearance();
    if (session) setStatus('live', 'Listening');
  } catch (err) {
    setStatus('error', `Could not save settings: ${err.message || 'unknown error'}`);
  }
});

async function saveVisibilitySettings() {
  try {
    settings = await window.captioner.setSettings({
      showTranscription: showTranscriptionToggle.checked,
      showTranslation: showTranslationToggle.checked,
      sentenceLines: sentenceLinesToggle.checked,
    });
    applyAppearance();
  } catch (err) {
    setStatus('error', `Could not save display options: ${err.message || 'unknown error'}`);
  }
}

showTranscriptionToggle.addEventListener('change', saveVisibilitySettings);
showTranslationToggle.addEventListener('change', saveVisibilitySettings);
sentenceLinesToggle.addEventListener('change', saveVisibilitySettings);

function previewBackground() {
  settings = { ...settings, bgColor: bgColorInput.value };
  applyAppearance();
}

async function saveBackground() {
  previewBackground();
  settings = await window.captioner.setSettings({ bgColor: settings.bgColor });
}

bgColorInput.addEventListener('input', previewBackground);
bgColorInput.addEventListener('change', saveBackground);

// ---------- window controls & menus ----------

const collapseBtn = $('winCollapse');

async function toggleCollapse() {
  const collapsing = !overlay.classList.contains('collapsed');
  overlay.classList.toggle('collapsed', collapsing);
  // The 6px overlay inset plus its 1px border sit below the stripe once everything else is hidden.
  const contentHeight = document.querySelector('.accent-stripe').getBoundingClientRect().bottom + 7;
  const collapsed = await window.captioner.setCollapsed(collapsing, contentHeight);
  overlay.classList.toggle('collapsed', collapsed);
  collapseBtn.setAttribute('aria-pressed', String(collapsed));
  collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
  collapseBtn.setAttribute('aria-label', collapseBtn.title);
}

$('winClose').addEventListener('click', () => window.captioner.close());
$('winMinimize').addEventListener('click', () => window.captioner.minimize());
collapseBtn.addEventListener('click', toggleCollapse);

for (const button of document.querySelectorAll('.app-menu [data-menu]')) {
  button.addEventListener('click', () => {
    const rect = button.getBoundingClientRect();
    window.captioner.popupMenu(button.dataset.menu, rect.left, rect.bottom + 2);
  });
}

async function copyTranscript() {
  const lines = [...captionsEl.querySelectorAll('.cap')].map((cap) => {
    const time = cap.querySelector('.time').textContent;
    const label = cap.querySelector('.lang').textContent;
    const src = cap.querySelector('.text').textContent.trim();
    const tr = cap.querySelector('.tr').textContent.trim();
    return [`[${time}] ${label}: ${src}`, tr && `    → ${tr}`].filter(Boolean).join('\n');
  });
  if (lines.length === 0) {
    showToast('No hay transcripción para copiar');
    return;
  }
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    showToast('Transcripción copiada');
  } catch {
    showToast('No se pudo copiar la transcripción');
  }
}

function toggleVisibility(checkbox) {
  checkbox.checked = !checkbox.checked;
  void saveVisibilitySettings();
}

const MENU_ACTIONS = {
  'toggle-capture': () => (session ? stop() : start()),
  'toggle-mute': () => setMuted(!muted),
  'clear-captions': clearCaptions,
  'new-call': newCall,
  'copy-transcript': copyTranscript,
  'copy-notes': () => $('copyNotes').click(),
  'clear-notes': () => $('clearNotes').click(),
  'toggle-settings': () => {
    if (overlay.classList.contains('collapsed')) void toggleCollapse();
    setSettingsOpen(!settingsOpen());
  },
  'toggle-collapse': toggleCollapse,
  'toggle-transcription': () => toggleVisibility(showTranscriptionToggle),
  'toggle-translation': () => toggleVisibility(showTranslationToggle),
  'toggle-sentence-lines': () => toggleVisibility(sentenceLinesToggle),
  'font-up': () => changeFontSize(2),
  'font-down': () => changeFontSize(-2),
};

window.captioner.onMenuAction((action) => MENU_ACTIONS[action]?.());

// A saved Deepgram engine can't stay selected while its option is hidden.
if (!settings.showDeepgram && settings.transcriptionEngine === 'deepgram') {
  settings = await window.captioner.setSettings({ transcriptionEngine: 'whisper' });
}
applyDeepgramVisibility();
fillForm();
closeSettings();
applyAppearance();
renderHoldTimer();
overlay.classList.add('idle');
setInterval(pollMeters, METER_INTERVAL_MS);
// Indicator only: monitoring always runs, since there is no longer a click to turn it on.
void startMicMonitor();
