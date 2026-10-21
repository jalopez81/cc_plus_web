const KEEPALIVE_MS = 8000;
const CHUNK_MS = 250;
const MAX_RECONNECTS = 3;

function dominantLanguage(alt, fallback = 'en') {
  if (alt.languages?.length) return alt.languages[0];
  const counts = {};
  for (const word of alt.words ?? []) {
    if (word.language) counts[word.language] = (counts[word.language] ?? 0) + 1;
  }
  const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return top ? top[0] : fallback;
}

export class DeepgramStream {
  constructor({ apiKey, onTranscript, onUtteranceEnd, onStatus }) {
    this.apiKey = apiKey;
    this.onTranscript = onTranscript;
    this.onUtteranceEnd = onUtteranceEnd;
    this.onStatus = onStatus;
    this.reconnects = 0;
    this.stopped = false;
  }

  start(audioStream) {
    this.audioStream = audioStream;
    if (!this.apiKey) {
      this.onStatus('error', 'Add a Deepgram API key in Engines settings.');
      return;
    }
    this.connect();
  }

  connect() {
    if (this.stopped) return;

    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'multi',
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      endpointing: '300',
      utterance_end_ms: '1000',
      vad_events: 'true',
    });
    this.onStatus('connecting', 'Connecting to Deepgram…');

    let ws;
    try {
      ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', this.apiKey]);
    } catch (error) {
      this.onStatus('error', `Could not connect to Deepgram: ${error.message}`);
      return;
    }
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.reconnects = 0;
      this.onStatus('live', 'Connected to Deepgram · listening');
      try {
        this.startRecorder();
      } catch (error) {
        this.onStatus('error', `Could not capture audio for Deepgram: ${error.message}`);
        this.stop();
        return;
      }
      this.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }, KEEPALIVE_MS);
    };

    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        console.error('Could not parse Deepgram message:', error);
        return;
      }
      if (message.type === 'Results') {
        const alternative = message.channel?.alternatives?.[0];
        if (!alternative) return;
        this.onTranscript({
          text: alternative.transcript ?? '',
          isFinal: Boolean(message.is_final),
          speechFinal: Boolean(message.speech_final),
          language: dominantLanguage(alternative),
        });
      } else if (message.type === 'UtteranceEnd') {
        this.onUtteranceEnd();
      }
    };

    ws.onerror = () => {};
    ws.onclose = (event) => {
      this.teardownConnection();
      if (this.stopped) return;
      if (!opened && this.reconnects === 0) {
        this.onStatus('error', 'Could not connect to Deepgram. Check the API key and network.');
        return;
      }
      if (this.reconnects < MAX_RECONNECTS) {
        this.reconnects += 1;
        this.onStatus('connecting', `Reconnecting to Deepgram (${this.reconnects}/${MAX_RECONNECTS})…`);
        this.reconnectTimer = setTimeout(() => this.connect(), 1000 * this.reconnects);
      } else {
        this.onStatus('error', `Deepgram connection lost (${event.code}).`);
      }
    };
  }

  startRecorder() {
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) =>
      MediaRecorder.isTypeSupported(type)
    );
    this.recorder = mimeType
      ? new MediaRecorder(this.audioStream, { mimeType })
      : new MediaRecorder(this.audioStream);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0 && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(event.data);
      }
    };
    this.recorder.onerror = (event) => {
      this.onStatus('error', `Deepgram audio recording failed: ${event.error?.message || 'unknown error'}`);
    };
    this.recorder.start(CHUNK_MS);
  }

  teardownConnection() {
    clearInterval(this.keepAlive);
    this.keepAlive = null;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = null;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardownConnection();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    }
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) this.ws.close(1000);
    this.ws = null;
  }
}
