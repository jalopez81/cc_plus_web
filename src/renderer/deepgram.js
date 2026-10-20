const KEEPALIVE_MS = 8000;
const CHUNK_MS = 250;
const MAX_RECONNECTS = 3;

function dominantLanguage(alt, fallback) {
  if (alt.languages?.length) return alt.languages[0];
  const counts = {};
  for (const w of alt.words ?? []) {
    if (w.language) counts[w.language] = (counts[w.language] ?? 0) + 1;
  }
  const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return top ? top[0] : fallback;
}

/**
 * Streams an audio MediaStream to Deepgram's live transcription WebSocket.
 * Emits: onTranscript({ text, isFinal, speechFinal, language }), onUtteranceEnd(), onStatus(state, detail)
 */
export class DeepgramStream {
  constructor({ apiKey, sourceMode, onTranscript, onUtteranceEnd, onStatus }) {
    this.apiKey = apiKey;
    this.language = sourceMode === 'auto' ? 'multi' : sourceMode;
    this.fallbackLang = sourceMode === 'es' ? 'es' : 'en';
    this.onTranscript = onTranscript;
    this.onUtteranceEnd = onUtteranceEnd;
    this.onStatus = onStatus;
    this.reconnects = 0;
    this.stopped = false;
    this.audioActive = false;
  }

  start(audioStream) {
    this.audioStream = audioStream;
    this.connect();
  }

  setAudioActive(active) {
    if (this.audioActive === active) return;
    this.audioActive = active;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.onStatus(active ? 'live' : 'idle', active ? 'Listening' : 'Silent · waiting for audio');
    }
  }

  connect() {
    const params = new URLSearchParams({
      model: 'nova-3',
      language: this.language,
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      endpointing: '300',
      utterance_end_ms: '1000',
      vad_events: 'true',
    });
    this.onStatus('connecting', 'Connecting to Deepgram…');
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', this.apiKey]);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnects = 0;
      this.onStatus(
        this.audioActive ? 'live' : 'idle',
        this.audioActive ? 'Listening' : 'Silent · waiting for audio'
      );
      this.startRecorder();
      this.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }, KEEPALIVE_MS);
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'Results') {
        const alt = msg.channel?.alternatives?.[0];
        if (!alt) return;
        this.onTranscript({
          text: alt.transcript ?? '',
          isFinal: Boolean(msg.is_final),
          speechFinal: Boolean(msg.speech_final),
          language: dominantLanguage(alt, this.fallbackLang),
        });
      } else if (msg.type === 'UtteranceEnd') {
        this.onUtteranceEnd();
      }
    };

    ws.onerror = () => {};

    let opened = false;
    ws.addEventListener('open', () => (opened = true));

    ws.onclose = (event) => {
      this.teardownConnection();
      if (this.stopped) return;
      // Browsers surface a rejected handshake (bad key, no credit) only as 1006 before open.
      if (!opened && this.reconnects === 0) {
        this.onStatus('error', 'Could not connect to Deepgram. Check your API key and network.');
        return;
      }
      if (this.reconnects < MAX_RECONNECTS) {
        this.reconnects += 1;
        this.onStatus('connecting', `Reconnecting (${this.reconnects}/${MAX_RECONNECTS})…`);
        setTimeout(() => !this.stopped && this.connect(), 1000 * this.reconnects);
      } else {
        this.onStatus('error', `Connection lost (${event.code}).`);
      }
    };
  }

  startRecorder() {
    const mimeType = 'audio/webm;codecs=opus';
    this.recorder = new MediaRecorder(this.audioStream, { mimeType });
    this.recorder.ondataavailable = (e) => {
      if (this.audioActive && e.data.size > 0 && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(e.data);
      }
    };
    this.recorder.start(CHUNK_MS);
  }

  teardownConnection() {
    clearInterval(this.keepAlive);
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = null;
  }

  stop() {
    this.stopped = true;
    this.teardownConnection();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      this.ws.close(1000);
    }
    this.ws = null;
  }
}
