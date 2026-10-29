import { AccessSession } from './access.js';
import { DeepgramStream } from './deepgram.js';
import { WhisperStream } from './whisper.js';
import { showToast } from './interpreter.js';
import { endTour, startTour } from './tour.js';

const MAX_BLOCKS = 200;
const HOLD_TIME_MS = 15 * 60 * 1000;
const HOLD_WARNING_MS = 2 * 60 * 1000;
const MARK_WARNING_MS = 7 * 60 * 1000; // with a marked message, the first visual alert comes at the 7-minute mark
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
const sideBySideToggle = $('sideBySideToggle');

document.body.classList.add(`platform-${window.captioner.platform}`);

let settings = await window.captioner.getSettings();
void window.captioner.getVersion().then((version) => {
  $('appVersion').textContent = `v${version}`;
});
// npm start runs unpackaged; the badge tells it apart from the installed .exe.
void window.captioner.isDev().then((dev) => {
  $('devBadge').hidden = !dev;
});
// "Welcome <name>!" uses the name tied to the access code, sent by the server on connect.
// The last one is remembered so the greeting is there on launch, before the first Start.
const WELCOME_KEY = 'welcomeName';
function showWelcome(name, { toast = false } = {}) {
  const el = $('welcome');
  el.textContent = name ? `Welcome ${name}!` : '';
  el.title = el.textContent; // the header may truncate it in a narrow window
  el.hidden = !name;
  // Slides in from the right while fading in, on launch and again each time the server accepts the code.
  if (name && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.animate(
      [
        { opacity: 0, transform: 'translateX(28px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 550, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }
  try {
    if (name) localStorage.setItem(WELCOME_KEY, name);
    else localStorage.removeItem(WELCOME_KEY);
  } catch {}
  if (name && toast) showToast(`👋 Welcome ${name}!`);
}
try {
  showWelcome(localStorage.getItem(WELCOME_KEY) || '');
} catch {}

// Total time connected with the current access code. The server sends what was used before this
// session (`used_s`); the app keeps adding while connected and remembers the total for the next launch.
const USAGE_KEY = 'usedSeconds';
let usage = { base: 0, since: null, timer: null };
try {
  usage.base = Number(localStorage.getItem(USAGE_KEY)) || 0;
} catch {}

function formatUsage(seconds) {
  const totalMin = Math.floor(seconds / 60);
  const h = Math.floor(totalMin / 60);
  return h ? `${h} h ${totalMin % 60} min` : `${totalMin} min`;
}

function renderUsage() {
  const el = $('usage');
  const seconds = usage.base + (usage.since ? (Date.now() - usage.since) / 1000 : 0);
  el.textContent = `⏱ ${formatUsage(seconds)} usados`;
  el.hidden = $('welcome').hidden;
}

function startUsage(usedS) {
  stopUsage();
  usage = { base: usedS, since: Date.now(), timer: setInterval(renderUsage, 15000) };
  renderUsage();
}

function stopUsage() {
  clearInterval(usage.timer);
  if (usage.since) usage.base += (Date.now() - usage.since) / 1000;
  usage = { base: usage.base, since: null, timer: null };
  try {
    localStorage.setItem(USAGE_KEY, String(Math.round(usage.base)));
  } catch {}
  renderUsage();
}

// The server accepted the access code: greet its owner and start counting from their total.
function onAccepted({ name = '', usedS = null } = {}) {
  showWelcome(name, { toast: true });
  if (usedS !== null) startUsage(usedS);
}
renderUsage();

settings.transcriptionEngine ??= 'whisper';
settings.deepgramKey ??= '';
settings.accessCode ??= '';
settings.showTranscription = settings.showTranscription ?? settings.showOriginal ?? true;
settings.showTranslation = settings.showTranslation ?? true;
settings.sentenceLines ??= true;
settings.sideBySide ??= false;
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
  document.body.classList.toggle('side-by-side', settings.sideBySide);
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
  sideBySideToggle.checked = settings.sideBySide;
}

// ---------- hold timer ----------

const holdTimerEl = $('holdTimer');
let holdDeadline = null;
let holdInterval = null;
let holdAlarmPlayed = false;
let alarmCtx = null;
// The client's last message, pinned by the interpreter: { at, el, stage } — the 15 minutes count from `at`.
let holdMark = null;

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

const formatClock = (date) =>
  date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });

// Edge glow over the whole window plus a toast, so the alert is seen even while reading captions.
function flashHoldAlert(stage) {
  overlay.classList.remove('hold-flash-7', 'hold-flash-15');
  void overlay.offsetWidth; // restart the animation if the same class comes back
  overlay.classList.add(`hold-flash-${stage}`);
  showToast(stage === 7 ? '⏱ 7 minutos desde el mensaje marcado' : '⏱ 15 minutos: se acabó el tiempo de espera');
}

function renderHoldTimer() {
  if (holdMark) {
    const elapsed = Date.now() - holdMark.at;
    const stage = elapsed >= HOLD_TIME_MS ? 15 : elapsed >= MARK_WARNING_MS ? 7 : 0;
    if (stage > holdMark.stage) {
      holdMark.stage = stage;
      flashHoldAlert(stage);
    }
    const mins = Math.floor(elapsed / 60000);
    const secs = String(Math.floor(elapsed / 1000) % 60).padStart(2, '0');
    holdTimerEl.title = `Mensaje marcado: ${formatClock(new Date(holdMark.at))} · Ahora: ${formatClock(new Date())} · Pasaron ${mins}:${secs}. Clic para quitar la marca.`;
  } else {
    holdTimerEl.title = 'Hold time: resets on every new message. Mark a bubble with ⏱ to count from it.';
  }
  holdTimerEl.classList.toggle('marked', Boolean(holdMark));
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
  const warnFrom = holdMark ? HOLD_TIME_MS - MARK_WARNING_MS : HOLD_WARNING_MS;
  holdTimerEl.classList.toggle('warning', holdDeadline !== null && remaining > 0 && remaining <= warnFrom);
  holdTimerEl.classList.toggle('expired', holdDeadline !== null && remaining === 0);
}

function resetHoldTimer() {
  if (holdMark) return; // the marked message keeps driving the count
  startHoldCount(Date.now());
}

function startHoldCount(from) {
  holdDeadline = from + HOLD_TIME_MS;
  holdAlarmPlayed = Date.now() >= holdDeadline; // marking an old message shouldn't ring right away
  clearInterval(holdInterval);
  holdInterval = setInterval(renderHoldTimer, 250);
  renderHoldTimer();
}

// Time of the bubble's latest finished sentence: the moment the client stopped talking.
function lastMessageTime(block) {
  const last = block?.segments.at(-1);
  return last ? last.time.getTime() : Date.now();
}

function unmarkBubble() {
  holdMark.el.classList.remove('marked');
  holdMark.el.querySelector('.mark-btn').textContent = '⏱';
}

// Clicking ⏱ on the marked bubble again (or on the header timer) removes the mark.
function setHoldMark(el) {
  if (holdMark) unmarkBubble();
  if (!el || holdMark?.el === el) {
    holdMark = null;
    if (session) startHoldCount(Date.now());
    else stopHoldTimer();
    return;
  }
  const at = lastMessageTime(blocksByEl.get(el));
  const elapsed = Date.now() - at;
  // Stages already passed when marking don't flash again.
  holdMark = { at, el, stage: elapsed >= HOLD_TIME_MS ? 15 : elapsed >= MARK_WARNING_MS ? 7 : 0 };
  el.classList.add('marked');
  el.querySelector('.mark-btn').textContent = `⏱ ${formatClock(new Date(at))}`;
  startHoldCount(at);
}

holdTimerEl.addEventListener('click', () => {
  if (holdMark) setHoldMark(null);
});

function stopHoldTimer() {
  if (holdMark) {
    unmarkBubble();
    holdMark = null;
  }
  holdDeadline = null;
  clearInterval(holdInterval);
  renderHoldTimer();
}

// ---------- audio meters ----------

const METER_INTERVAL_MS = 100;
// Peak amplitude of system audio that counts as speech, whether sent or withheld by mute.
const SPEECH_LEVEL = 0.02;
const SPEECH_HOLD_MS = 400;

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

function renderMic(micMuted) {
  micIndicator.dataset.state = micMuted ? 'off' : 'on';
  micIndicator.setAttribute('aria-pressed', String(micMuted));
  micIndicator.setAttribute('aria-label', micMuted ? 'Unmute microphone' : 'Mute microphone');
  micIndicator.title = micMuted ? 'Microphone muted: click to unmute' : 'Microphone on: click to mute';
  micLabel.textContent = micMuted ? 'OFF' : 'ON';
}

function renderMicError(err) {
  micIndicator.dataset.state = 'unknown';
  micLabel.textContent = 'MIC';
  micIndicator.title = `Mic mute unavailable: ${err.message || err}`;
}

// The OS can change the mute (or the default mic) behind our back, so re-read it rather than tracking it.
async function refreshMic() {
  try {
    renderMic(await window.captioner.getMicMuted());
  } catch (err) {
    renderMicError(err);
  }
}

async function toggleMic() {
  micIndicator.disabled = true;
  try {
    renderMic(await window.captioner.toggleMicMute());
  } catch (err) {
    renderMicError(err);
  } finally {
    micIndicator.disabled = false;
  }
}

function pollMeters() {
  const now = Date.now();
  if (systemMeter && systemMeter.peak() > SPEECH_LEVEL) speechUntil = now + SPEECH_HOLD_MS;
  speakIndicator.classList.toggle('speaking', Boolean(systemMeter) && now < speechUntil);
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
    '<div class="cap-meta"><span class="time-col"><span class="time"></span><span class="latency" title="Tiempo que tardó el servidor en devolver la transcripción y su traducción"></span></span><button type="button" class="mark-btn" title="Marcar el último mensaje: los 15 minutos cuentan desde aquí">⏱</button></div><div class="src"><img class="flag" alt="" /><span class="lang"></span><span class="text"></span></div><div class="tr"></div>' +
    '<div class="paraphrase" hidden><button type="button" class="paraphrase-btn" title="Condense this message with Gemini">Paraphrase</button><div class="summary" hidden></div></div>' +
    '<div class="split-row" hidden><button type="button" class="split-btn" title="Lo próximo que se diga empieza en una burbuja nueva">✂ Split here</button></div>';
  el.querySelector('.time').textContent = formatTime(new Date());
  const flag = el.querySelector('.flag');
  const flagSrc = SPEAKER_FLAGS[baseLang(lang)];
  if (flagSrc) flag.src = flagSrc;
  else flag.hidden = true;
  el.querySelector('.lang').textContent = SPEAKER_LABELS[baseLang(lang)] ?? baseLang(lang).toUpperCase();
  captionsEl.appendChild(el);
  growObserver.observe(el);
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

// Bubbles grow smoothly instead of jumping, whatever makes them taller (a new segment, its translation, the
// paraphrase…). ResizeObserver runs after layout but before paint, so the jump is swapped for an animation from
// the previous height before it is ever seen. Small steps pass through, so the active bubble's own min-height
// transition isn't fought frame by frame; a change that lands mid-animation is animated once that one ends.
const GROW_MIN_PX = 6;
const bubbleHeights = new WeakMap();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const growObserver = new ResizeObserver((entries) => {
  for (const { target: el } of entries) {
    if (!el.isConnected) {
      growObserver.unobserve(el);
      continue;
    }
    if (el.dataset.growing) continue;
    const from = bubbleHeights.get(el);
    const to = el.offsetHeight;
    bubbleHeights.set(el, to);
    if (from === undefined || to - from < GROW_MIN_PX || reducedMotion.matches) continue;

    el.dataset.growing = '1';
    el.style.overflow = 'clip';
    const anim = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 280,
      easing: 'cubic-bezier(0.33, 1, 0.68, 1)',
    });
    // The newest bubble is kept in view as it grows; older ones (e.g. paraphrased later) don't pull the scroll.
    const follow = el === captionsEl.lastElementChild;
    const tick = () => {
      if (!el.dataset.growing) return;
      if (follow) scrollToBottom();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const done = () => {
      delete el.dataset.growing;
      el.style.overflow = '';
      if (follow) scrollToBottom();
    };
    anim.onfinish = done;
    anim.oncancel = done;
  }
});

// Server round trip per segment, under the bubble's time: ↑ while the server works on the audio it just cut,
// then how long the reply took. The arrow sits on the latest bubble, since the language (and so the bubble the
// reply lands in) is unknown until it arrives. Today's server replies before starting the next segment, but
// replies always come in order, so a queue keeps each reply (or drop) paired with its own start even if a
// server ever has several in flight.
const pending = []; // [{ since, block }]

const formatLatency = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

function showLatency(block, text, sending = false) {
  const span = block?.el.querySelector('.latency');
  if (!span) return;
  span.textContent = text;
  span.classList.toggle('sending', sending);
}

// With no live bubble, an empty "waiting" one opens as soon as the server starts on the audio, so the ↑ shows
// work is under way. The language is unknown until the reply, so it guesses the other side from the last
// bubble (in an interpreted call the other person usually speaks next); a reply in the other language
// replaces it, and a dropped segment removes it (commitBlock discards bubbles without segments).
function handleProcessing(started) {
  if (!started) {
    const dropped = pending.shift();
    if (dropped) showLatency(dropped.block, dropped.block?.latency ?? '');
    // A dropped segment takes its provisional text with it.
    if (currentBlock?.interim) {
      currentBlock.interim = '';
      renderBlock(currentBlock);
    }
    if (pending.length === 0 && currentBlock?.segments.length === 0) commitBlock();
    else if (pending.length) showLatency(pending[0].block, '↑', true);
    return;
  }
  if (!currentBlock) {
    const lastEl = [...captionsEl.querySelectorAll('.cap:not(.demo)')].at(-1);
    const lastLang = lastEl && blocksByEl.get(lastEl)?.lang;
    currentBlock = createBlock(lastLang ? targetFor(lastLang) : 'en');
    currentBlock.el.classList.add('waiting');
  }
  pending.push({ since: performance.now(), block: currentBlock });
  showLatency(currentBlock, '↑', true);
}

function settleLatency(block) {
  const done = pending.shift();
  if (!done) return;
  if (done.block !== block) showLatency(done.block, done.block?.latency ?? '');
  block.latency = formatLatency(performance.now() - done.since);
  showLatency(block, block.latency);
  // Another segment still in flight keeps the arrow on the bubble it was started on.
  if (pending.length) showLatency(pending[0].block, '↑', true);
}

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
  // The server marks doubtful words by their position in the whole segment; re-base them per sentence.
  const uncertain = new Set(seg.uncertain ?? []);
  let offset = 0;
  return {
    src: src.map((text, j) => {
      const count = text.split(/\s+/).filter(Boolean).length;
      const local = new Set();
      for (let i = 0; i < count; i += 1) if (uncertain.has(offset + i)) local.add(i);
      offset += count;
      return { text, pair: pairOf(j), uncertain: local };
    }),
    tr: tr.map((text, j) => ({ text, pair: pairOf(j) })),
  };
}

// Words Whisper wasn't sure about get their own span, so the interpreter knows which ones to double-check.
function appendMarkedWords(parent, text, uncertain) {
  let index = 0;
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      parent.append(part);
      continue;
    }
    if (uncertain.has(index)) {
      const word = document.createElement('span');
      word.className = 'uncertain';
      word.title = 'Whisper no está seguro de esta palabra';
      word.textContent = part;
      parent.append(word);
    } else {
      parent.append(part);
    }
    index += 1;
  }
}

function fillSentences(container, items) {
  const nodes = [];
  items.forEach((item, k) => {
    if (k > 0) nodes.push(ENDS_SENTENCE.test(items[k - 1].text) ? '\n' : ' ');
    if (item.provisional) {
      const span = document.createElement('span');
      span.className = 'provisional';
      span.textContent = item.text;
      nodes.push(span);
      return;
    }
    if (!item.pair) {
      nodes.push(item.text);
      return;
    }
    const span = document.createElement('span');
    span.className = 'sentence';
    span.dataset.pair = item.pair;
    if (item.uncertain?.size) appendMarkedWords(span, item.text, item.uncertain);
    else span.textContent = item.text;
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
  // Provisional text goes with its provisional translation: clearing one (the final reply arrived) clears both.
  if (!block.interim) {
    block.interimShown = '';
    block.interimTr = '';
    block.interimTrShown = '';
  }
  if (block.interimShown) {
    srcItems.push(...splitSentences(block.interimShown).map((text) => ({ text, provisional: true })));
  }
  if (block.interimTrShown && !trPending) {
    trItems.push(...splitSentences(block.interimTrShown).map((text) => ({ text, provisional: true })));
  }

  fillSentences(block.el.querySelector('.text'), srcItems);
  fillSentences(block.el.querySelector('.tr'), trItems);
  block.el.classList.toggle('waiting', srcItems.length === 0);
  block.el.querySelector('.paraphrase').hidden = block.segments.length === 0;
  updateSplitButton(block);
  scrollToBottom();
}

// Same-language speech keeps growing one bubble; the live one offers "Split here" at its foot
// so the next words start a new bubble.
function updateSplitButton(block) {
  block.el.querySelector('.split-row').hidden = block !== currentBlock || block.segments.length === 0;
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
      result.error === 'Gemini API key is not set'
        ? 'Add your free Gemini API key in Engines to paraphrase (press ? next to the field for how).'
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

// Ctrl+click (Cmd+click on macOS) removes a bubble, e.g. noise or a misheard fragment.
function removeBubble(el) {
  if (holdMark?.el === el) setHoldMark(null);
  if (currentBlock?.el === el) currentBlock = null;
  el.remove();
  if (!captionsEl.querySelector('.cap')) placeholder.hidden = false;
  showToast('Burbuja eliminada');
}

// While Ctrl/Cmd is held, the bubble under the pointer shows it would be removed.
const setCtrlHeld = (held) => document.body.classList.toggle('ctrl-held', held);
window.addEventListener('keydown', (e) => setCtrlHeld(e.ctrlKey || e.metaKey));
window.addEventListener('keyup', (e) => setCtrlHeld(e.ctrlKey || e.metaKey));
window.addEventListener('blur', () => setCtrlHeld(false));

captionsEl.addEventListener('click', (e) => {
  const bubble = e.target.closest('.cap');
  if (bubble && (e.ctrlKey || e.metaKey)) {
    removeBubble(bubble);
    return;
  }
  const markBtn = e.target.closest('.mark-btn');
  if (markBtn) {
    setHoldMark(markBtn.closest('.cap'));
    return;
  }
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

// Tutorial bubbles: rendered like real ones, but never translated, logged or kept after the tour.
function addDemoBlock(lang, segments) {
  commitBlock();
  const block = createBlock(lang);
  block.el.classList.add('demo');
  block.el.classList.remove('interim', 'active');
  block.segments = segments.map((seg) => ({ ...seg, uncertain: seg.uncertain ?? [], time: new Date() }));
  renderBlock(block);
  return block.el;
}

function clearDemo() {
  captionsEl.querySelectorAll('.cap.demo').forEach((el) => el.remove());
  if (!captionsEl.querySelector('.cap')) placeholder.hidden = false;
}

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
  // An empty waiting bubble only guessed its language, so it doesn't hold short replies to it.
  if (!currentBlock || currentBlock.el.classList.contains('waiting')) return detected ?? currentBlock?.lang ?? 'en';
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
        message = 'DeepL character quota used up (HTTP 456); switch to Auto or check your DeepL plan.';
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

// Highest segment the server has given a final reply for; provisional text for it or earlier is stale.
let lastFinalSeg = 0;

// Provisional text from the Whisper server while someone is still speaking: shown greyed in the bubble (the
// same slot Deepgram's interim results use) until the segment's final transcript and translation replace it.
function handlePartial({ text, language, translation, translation_language, seg }) {
  const transcript = String(text ?? '').trim();
  if (!transcript || (seg !== null && seg <= lastFinalSeg)) return;
  resetHoldTimer();
  const lang = resolveLang(language, transcript);
  if (currentBlock && currentBlock.lang !== lang) commitBlock();
  if (!currentBlock) currentBlock = createBlock(lang);
  // Same check as the final text: a translation made from the other language's guess points the wrong way.
  const serverTarget = translation_language ? baseLang(translation_language) : targetFor(lang);
  currentBlock.interim = transcript;
  currentBlock.interimTr = serverTarget === targetFor(lang) ? String(translation ?? '').trim() : '';
  typeField(currentBlock, 'interim');
  typeField(currentBlock, 'interimTr');
  if (pending.length) showLatency(currentBlock, '↑', true);
}

// The server sends provisional text (and its translation) every ~1.5 s; new words are typed out one by one
// across most of that gap, so both columns keep flowing instead of jumping. Words already on screen that still
// match stay put; a corrected word swaps in at once and only what follows it is typed. The final text still
// lands at once.
const TYPE_SPREAD_MS = 1200;
const TYPE_MAX_STEP_MS = 150;

// `key` is 'interim' (original) or 'interimTr' (translation); what is on screen so far lives in `${key}Shown`.
function typeField(block, key) {
  const shownKey = `${key}Shown`;
  const timerKey = `${key}Timer`;
  clearTimeout(block[timerKey]);
  const text = block[key] || '';
  const target = text.split(/\s+/).filter(Boolean);
  const shown = (block[shownKey] || '').split(/\s+/).filter(Boolean);
  let n = 0;
  while (n < shown.length && n < target.length && shown[n] === target[n]) n++;
  if (reducedMotion.matches) n = target.length;
  const step = Math.min(TYPE_MAX_STEP_MS, TYPE_SPREAD_MS / Math.max(1, target.length - n));
  const tick = () => {
    if ((block[key] || '') !== text) return; // replaced by newer text, or cleared by the final one
    block[shownKey] = target.slice(0, n).join(' ');
    renderBlock(block);
    if (n++ < target.length) block[timerKey] = setTimeout(tick, step);
  };
  tick();
}

function handleTranscript({ text, language, confident, uncertain, translation, translation_language, seg: segNo }) {
  if (Number.isInteger(segNo)) lastFinalSeg = Math.max(lastFinalSeg, segNo);
  const transcript = String(text ?? '').trim();
  if (!transcript) return;
  const lang = resolveLang(language, transcript, confident);
  // The server translates from its own language guess; if resolveLang kept the segment in the other block,
  // that translation points the wrong way, so it is dropped.
  const serverTarget = translation_language ? baseLang(translation_language) : targetFor(lang);
  const translated = typeof translation === 'string' && serverTarget === targetFor(lang) ? translation.trim() : '';

  if (text) resetHoldTimer();
  if (currentBlock && currentBlock.lang !== lang) {
    commitBlock();
  }
  if (!currentBlock) currentBlock = createBlock(lang);

  const seg = {
    src: transcript,
    tr: translated || (settings.translator === 'off' ? '' : undefined),
    time: new Date(),
    uncertain: uncertain ?? [],
  };
  currentBlock.segments.push(seg);
  currentBlock.interim = ''; // the final text replaces the provisional one
  renderBlock(currentBlock);
  settleLatency(currentBlock);
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
    // Deepgram's interim results come several times a second, already word by word: shown as they are.
    currentBlock.interim = transcript;
    currentBlock.interimShown = transcript;
    renderBlock(currentBlock);
  }
}

function handleUtteranceEnd() {
  if (currentBlock && !currentBlock.interim) currentBlock.el.classList.remove('interim');
}

function clearCaptions() {
  if (holdMark) setHoldMark(null);
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
const flushBtn = $('flushBtn');

// Cuts the current utterance short: the server transcribes what it has buffered without waiting for a pause.
function flushAudio() {
  if (!session) return;
  if (!session.transcription.flush()) showToast('Este servidor no admite el envío manual');
}

function renderToggle() {
  const state = captureStarting ? 'starting' : session ? 'live' : 'idle';
  toggleBtn.dataset.state = state;
  toggleBtn.textContent = TOGGLE_LABELS[state];
  toggleBtn.disabled = captureStarting;
  flushBtn.disabled = !session;
  // Once Start is pressed, the empty caption area says it's listening instead of asking to press Start.
  placeholder.classList.toggle('listening', state !== 'idle');
}

async function start() {
  if (session || captureStarting) return;
  endTour(); // real captions shouldn't mix with the demo ones
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
  }
  // Both engines need a code: Whisper checks it on the GPU server, Deepgram on the control server.
  if (!/^[0-9a-f]+$/i.test(settings.accessCode)) {
    openSettings();
    setHelpOpen('accessHelp', true);
    form.accessCode.focus();
    setStatus('error', 'Add your access code in Engines. To get one, ask in the LCP_LIVE_CAPTION_PLUS WhatsApp group.');
    captureStarting = false;
    renderToggle();
    return;
  }

  let access = null;
  if (settings.transcriptionEngine === 'deepgram') {
    setStatus('connecting', 'Checking access code…');
    access = new AccessSession({
      url: await window.captioner.getControlUrl(),
      accessCode: settings.accessCode,
      onLost: (message) => {
        if (session?.access !== access) return;
        stop({ keepStatus: true });
        setStatus('error', message);
      },
    });
    try {
      onAccepted(await access.open());
    } catch (err) {
      access.close();
      setStatus('error', err.message);
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
    pending.length = 0; // segments left in flight by the last session never get a reply
    lastFinalSeg = 0; // a new connection numbers its segments from 1 again
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
            onWelcome: onAccepted,
            onProcessing: handleProcessing,
            onPartial: handlePartial,
          });

    transcription.setMuted(muted);
    systemMeter = createLevelMeter(audioStream);
    session = { stream, transcription, access };
    audioTracks[0].addEventListener('ended', () => stop());
    await transcription.start(audioStream);
    if (session?.transcription !== transcription) return;
    resetHoldTimer();
    logSession('started');

    renderToggle();
    overlay.classList.remove('idle');
  } catch (err) {
    if (session) stop({ keepStatus: true });
    else {
      stream?.getTracks().forEach((track) => track.stop());
      access?.close();
    }
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
  const { stream, transcription, access } = session;
  session = null;
  transcription.stop();
  access?.close();
  stream.getTracks().forEach((t) => t.stop());
  systemMeter?.stop();
  systemMeter = null;
  stopHoldTimer();
  stopUsage();
  handleProcessing(false);
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
  // A help panel whose "?" button just got hidden, itself or with its row (e.g. DeepL deselected), closes with it.
  for (const button of form.querySelectorAll('.help-btn[aria-controls]')) {
    if (button.closest('[hidden]')) setHelpOpen(button.getAttribute('aria-controls'), false);
  }
}

// ---------- help panels (access code, DeepL, Gemini) ----------

// One panel at a time, so the settings area doesn't grow into a wall of instructions.
function setHelpOpen(id, open) {
  for (const button of form.querySelectorAll('.help-btn[aria-controls]')) {
    const panelId = button.getAttribute('aria-controls');
    if (panelId !== id && !open) continue; // closing one panel leaves the others alone
    const show = open && panelId === id;
    $(panelId).hidden = !show;
    button.setAttribute('aria-expanded', String(show));
  }
}

for (const button of form.querySelectorAll('.help-btn[aria-controls]')) {
  const id = button.getAttribute('aria-controls');
  button.addEventListener('click', () => setHelpOpen(id, $(id).hidden));
}
for (const panel of form.querySelectorAll('.help-panel')) {
  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-help]')) setHelpOpen(panel.id, false);
    const link = e.target.closest('[data-href]');
    if (link) window.captioner.openExternal(link.dataset.href);
  });
}

// ---------- hidden advanced settings ----------

// Typing this in the call notes reveals the advanced panel; typing it again hides it.
const SECRET_CODE = '#lcp-config';
const advancedPanel = $('advancedPanel');
const engineToggleRow = $('engineToggleRow');
const deepgramKeyRow = $('deepgramKeyRow');
const showDeepgramToggle = $('showDeepgramToggle');
const notesInput = $('callNotes');

// With Deepgram hidden, Whisper is the only engine, so there is nothing to toggle.
function applyDeepgramVisibility() {
  const show = Boolean(settings.showDeepgram);
  engineToggleRow.hidden = !show;
  deepgramKeyRow.hidden = !show;
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
  syncTranslatorFields();
}

// Opening and closing only toggle visibility, so unsaved edits survive a collapse.
// ---------- show/hide keys ----------

const EYE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /></svg>';
const EYE_OFF_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /><path d="M2.5 13.5l11-11" /></svg>';

function setRevealed(button, input, revealed) {
  input.type = revealed ? 'text' : 'password';
  button.innerHTML = revealed ? EYE_OFF_ICON : EYE_ICON;
  button.setAttribute('aria-pressed', String(revealed));
  button.title = revealed ? 'Ocultar' : 'Mostrar';
  button.setAttribute('aria-label', revealed ? 'Ocultar' : 'Mostrar');
}

// Every key field (access code, DeepL, Deepgram, Gemini) gets an eye button inside it.
const revealButtons = [...form.querySelectorAll('input[type="password"]')].map((input) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reveal-btn';
  setRevealed(button, input, false);
  button.addEventListener('click', () => setRevealed(button, input, input.type === 'password'));
  input.closest('label').classList.add('has-reveal');
  input.after(button);
  return { button, input };
});

function setSettingsOpen(open) {
  // Closing the settings hides any key left visible.
  if (!open) for (const { button, input } of revealButtons) setRevealed(button, input, false);
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
    values.transcriptionUrl !== settings.transcriptionUrl ||
    values.accessCode !== settings.accessCode ||
    (values.transcriptionEngine === 'deepgram' && values.deepgramKey !== settings.deepgramKey);
  const translatorChanged = values.translator !== settings.translator || values.deeplKey !== settings.deeplKey;
  // A new code may belong to someone else: greet again only after the server names its owner.
  if (values.accessCode !== settings.accessCode) {
    showWelcome('');
    usage.base = 0;
    stopUsage();
  }
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
  };
}

// ---------- copy the whole configuration ----------

// Plain "Label: value" lines, so the copy is readable (and editable) wherever the user keeps it.
const CONFIG_HEADER = 'Live Caption Plus · configuración';
const CONFIG_FIELDS = [
  ['transcriptionEngine', 'Engine'],
  ['transcriptionUrl', 'Server URL'],
  ['accessCode', 'Access code'],
  ['deepgramKey', 'Deepgram key'],
  ['translator', 'Translator'],
  ['deeplKey', 'DeepL key'],
  ['myMemoryEmail', 'MyMemory email'],
  ['geminiKey', 'Gemini key'],
];

$('copyConfigBtn').addEventListener('click', async () => {
  const values = readForm();
  const lines = [CONFIG_HEADER, ...CONFIG_FIELDS.filter(([key]) => values[key]).map(([key, label]) => `${label}: ${values[key]}`)];
  try {
    await window.captioner.writeClipboard(lines.join('\n'));
    showToast('Configuración copiada. Incluye tus claves: guárdala en un lugar privado.');
  } catch (err) {
    showToast(`No se pudo copiar: ${err.message || 'error'}`);
  }
});

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
flushBtn.addEventListener('click', flushAudio);
micIndicator.addEventListener('click', () => void toggleMic());
// A plugged or unplugged headset changes the default input, which has its own mute state.
navigator.mediaDevices.addEventListener('devicechange', () => void refreshMic());
window.addEventListener('focus', () => void refreshMic());
$('clearBtn').addEventListener('click', clearCaptions);

// Marks a call boundary in the log; the next speech starts a fresh bubble.
// A random dark background (any hue, muted, low lightness) so each call looks visibly different
// while light caption text stays readable; the hue always moves at least 60° from the current one.
function randomDarkColor(current) {
  const hueOf = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (!d) return null;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const currentHue = /^#[0-9a-f]{6}$/i.test(current ?? '') ? hueOf(current) : null;
  let hue;
  do hue = Math.random() * 360;
  while (currentHue !== null && Math.abs(((hue - currentHue + 540) % 360) - 180) < 60);
  const s = 0.3 + Math.random() * 0.25;
  const l = 0.12 + Math.random() * 0.08;
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const value = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

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
  // The previous call is already in the log, so the screen can start fresh.
  clearCaptions();
  settings = await window.captioner.setSettings({ bgColor: randomDarkColor(settings.bgColor) });
  applyAppearance();
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
      sideBySide: sideBySideToggle.checked,
    });
    applyAppearance();
  } catch (err) {
    setStatus('error', `Could not save display options: ${err.message || 'unknown error'}`);
  }
}

showTranscriptionToggle.addEventListener('change', saveVisibilitySettings);
showTranslationToggle.addEventListener('change', saveVisibilitySettings);
sentenceLinesToggle.addEventListener('change', saveVisibilitySettings);
sideBySideToggle.addEventListener('change', saveVisibilitySettings);

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

const runTour = () =>
  startTour({
    isLive: () => Boolean(session || captureStarting),
    toast: showToast,
    expand: async () => {
      if (overlay.classList.contains('collapsed')) await toggleCollapse();
    },
    settingsOpen,
    closeSettings,
    addDemoBlock,
    clearDemo,
  });
$('tourBtn').addEventListener('click', runTour);

const MENU_ACTIONS = {
  'start-tour': runTour,
  'toggle-capture': () => (session ? stop() : start()),
  'toggle-mute': () => setMuted(!muted),
  'flush-audio': flushAudio,
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
  'toggle-side-by-side': () => toggleVisibility(sideBySideToggle),
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
void refreshMic();
