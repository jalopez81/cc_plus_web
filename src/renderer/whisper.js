function float32ToInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

export class WhisperStream {
  constructor({ url, onTranscript, onStatus }) {
    this.url = url;
    this.onTranscript = onTranscript;
    this.onStatus = onStatus;
    this.ws = null;
    this.audioContext = null;
    this.processor = null;
    this.recording = false;
  }

  async start(audioStream) {
    this.recording = true;
    this.connect();
    await this.startAudioPipeline(audioStream);
  }

  connect() {
    if (!this.url) {
      this.onStatus('error', 'Add the transcription WebSocket URL in Settings.');
      return;
    }

    this.onStatus('connecting', 'Connecting to transcription server…');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.onStatus('live', 'Connected · listening');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data?.error) {
          this.onStatus('error', String(data.error));
          return;
        }
        if (data && typeof data.transcript === 'string') {
          this.onTranscript({
            text: data.transcript,
            language: data.language || 'en',
            translation: typeof data.translation === 'string' ? data.translation : '',
            translation_language: data.translation_language ?? null,
          });
        }
      } catch (err) {
        console.error('Could not parse transcription message:', err);
      }
    };

    ws.onerror = () => {
      this.onStatus('error', 'WebSocket error. Check the URL and server status.');
    };

    ws.onclose = () => {
      this.teardown();
      this.onStatus('disconnected', 'Disconnected · press Start to reconnect');
    };
  }

  async startAudioPipeline(audioStream) {
    const audioContext = new AudioContext({ sampleRate: 16000 });
    this.audioContext = audioContext;
    await audioContext.resume();
    const source = audioContext.createMediaStreamSource(audioStream);
    const gain = audioContext.createGain();
    gain.gain.value = 0;

    if (typeof AudioWorkletNode !== 'undefined') {
      try {
        const workletCode = `
          class PCMProcessor extends AudioWorkletProcessor {
            constructor() { super(); this.buf = new Int16Array(4096); this.n = 0; }
            process(inputs) {
              const channels = inputs[0];
              if (!channels?.length) return true;
              for (let i = 0; i < channels[0].length; i += 1) {
                let mixed = 0;
                for (let channel = 0; channel < channels.length; channel += 1) {
                  mixed += channels[channel][i];
                }
                const sample = Math.max(-1, Math.min(1, mixed / channels.length));
                this.buf[this.n++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
                if (this.n === this.buf.length) {
                  this.port.postMessage(this.buf.slice(0));
                  this.n = 0;
                }
              }
              return true;
            }
          }
          registerProcessor('pcm-processor', PCMProcessor);
        `;
        const moduleUrl = `data:application/javascript;charset=utf-8,${encodeURIComponent(workletCode)}`;
        await audioContext.audioWorklet.addModule(moduleUrl);
        const node = new AudioWorkletNode(audioContext, 'pcm-processor');
        node.port.onmessage = (event) => {
          this.sendFrame(event.data);
        };
        source.connect(node);
        node.connect(gain);
        gain.connect(audioContext.destination);
        this.processor = node;
        return;
      } catch (err) {
        console.warn('AudioWorklet setup failed, falling back to ScriptProcessor:', err);
      }
    }

    const processor = audioContext.createScriptProcessor(4096, 2, 1);
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer;
      const mono = new Float32Array(input.length);
      for (let channel = 0; channel < input.numberOfChannels; channel += 1) {
        const samples = input.getChannelData(channel);
        for (let i = 0; i < samples.length; i += 1) {
          mono[i] += samples[i] / input.numberOfChannels;
        }
      }
      this.sendFrame(float32ToInt16(mono));
    };
    source.connect(processor);
    processor.connect(gain);
    gain.connect(audioContext.destination);
    this.processor = processor;
  }

  sendFrame(frame) {
    if (!this.recording || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!frame || frame.length === 0) return;

    const view = new DataView(new ArrayBuffer(frame.byteLength));
    const int16 = frame instanceof Int16Array ? frame : new Int16Array(frame.buffer, frame.byteOffset, frame.length);
    for (let i = 0; i < int16.length; i += 1) {
      view.setInt16(i * 2, int16[i], true);
    }
    this.ws.send(view.buffer);
  }

  teardown() {
    this.recording = false;
    if (this.processor) {
      if (typeof this.processor.port !== 'undefined') {
        this.processor.port.onmessage = null;
      } else {
        this.processor.onaudioprocess = null;
      }
      if (typeof this.processor.disconnect === 'function') {
        this.processor.disconnect();
      }
      this.processor = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  stop() {
    this.teardown();
  }
}
