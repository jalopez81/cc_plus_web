# Live Captioner

A resizable desktop window that captions computer audio (such as YouTube, a browser call, or a livestream) in real time, with English ⇄ Spanish translation and built-in interpreter tools. It captures system loopback audio, not your microphone.

## Requirements

- Windows 10 or later, or macOS 13 or later
- Node.js 18+
- A live transcription backend exposing a `wss://.../ws/transcribe` endpoint
- Optional: `CC_PLUS_TRANSCRIPTION_URL` environment variable for the default WebSocket URL

## Getting started

```bash
npm install
npm start          # run in development
npm run make       # build a .zip for the current platform (plus a .dmg on macOS) into out/make
npm run make:mac   # macOS only: build a universal (Apple Silicon + Intel) .dmg and .zip
```

On first launch, expand **Engines**, choose a transcription engine, configure its endpoint or API key, and press **Done**. **Whisper** uses a self-hosted WebSocket URL (for example `wss://your-pod-id-8000.proxy.runpod.net/ws/transcribe`); you can set `CC_PLUS_TRANSCRIPTION_URL` before launch to prefill it. **Deepgram** connects directly to its live transcription WebSocket and requires your own Deepgram API key.

To test, play a YouTube video on your computer and press **Start**. The app captures computer/system audio through Electron's loopback capture; it does not listen to your microphone. On macOS, allow the system-audio recording permission prompt. If no captions appear, check **System Settings › Privacy & Security › Screen & System Audio Recording**. In development, the app requesting permission may be your terminal or editor rather than "Live Captioner".

## Interpreter tools

The app opens as a compact, right-aligned 452 × 720 window (limited to the available display size). Use the **Saludos**, **Intervenciones**, and **Solicitudes** buttons to open categorized soundbytes. Interpreter name/ID are saved in the quick-phrases popup, and a compact call-notes field appears above the transcript. Use the bottom checkmarks to show/hide transcription and translation. English and Spanish are always detected automatically. Soundbytes and notes can be customized and are saved locally. The hold timer remains in the transcription toolbar.

## Using it

Shortcuts use **Ctrl+Shift** on Windows and **⌘⇧** on macOS.

| Control | What it does |
| --- | --- |
| Engines row | Expand or collapse the transcription endpoint and translation provider settings |
| Transcription engine | Select self-hosted Whisper or Deepgram Nova-3 (automatic English/Spanish detection) |
| Start / Stop | Begin or end capturing computer/system audio (not microphone audio) |
| Bottom controls | Toggle transcription/translation visibility, adjust text size/background, or clear captions |
| Ctrl+Shift+K | Show or hide the window |
| Native title bar | Move, minimize, maximize, close, and resize the window |

**Translation providers** (Engines settings) translate each transcript segment as it arrives:
- **Auto**: tries DeepL (if a key is set), then Google, MyMemory, and Apertium, using the first that succeeds. A service that fails is skipped for 5 minutes, or 1 hour if it reports its quota is used up. The status bar shows which service is translating.
- **DeepL**: highest quality; free API keys (500,000 characters/month) and paid keys both work.
- **Google**: free, no key. Uses Google's unofficial web endpoint, which can rate-limit heavy use.
- **MyMemory**: free, no key. About 5,000 characters/day anonymously, or 50,000/day if you enter an email.
- **Apertium**: free, no key, open source. Slower and noticeably lower quality; best as a last resort.
- **Off**: transcription only.

DeepL keys are sent to DeepL for translation; Deepgram keys authenticate the direct Deepgram WebSocket and are visible to the Electron renderer while in use. Both keys are stored encrypted with the OS credential store (`safeStorage`: Windows DPAPI or the macOS Keychain) in `settings.json`, under `%APPDATA%\Live Captioner\` on Windows or `~/Library/Application Support/Live Captioner/` on macOS. The app refuses to save a key if secure OS credential storage is unavailable. Settings from the old "Mac Live Captioner" folder are copied over on first launch; on macOS you may need to re-enter API keys.

## How it works

```
getDisplayMedia (Electron system-audio loopback)
  ├─ Whisper: AudioWorklet / ScriptProcessor (16 kHz mono PCM Int16)
  │    └─ self-hosted transcription WebSocket
  └─ Deepgram: MediaRecorder (WebM/Opus chunks)
       └─ Deepgram live transcription WebSocket
            └─ transcript ─▶ translation ─▶ captions
```

- `src/main.js`: creates the overlay window, grants `getDisplayMedia` requests with `audio: 'loopback'`, stores settings, and handles IPC. A video track is requested to activate Electron's display-media capture API; only the audio track is sent to the selected transcription service.
- `src/renderer/whisper.js` and `src/renderer/deepgram.js`: provide the self-hosted Whisper and direct Deepgram streaming clients, respectively.
- `src/translate.js`: translation providers. These run in the main process to avoid CORS restrictions.
- `src/renderer/`: overlay UI, the transcription WebSocket client, PCM audio capture, and caption rendering.
- `scripts/patch-dev-plist.js` (macOS only; a no-op elsewhere): adds `NSAudioCaptureUsageDescription` to the dev `Electron.app`, which is required for macOS system-audio capture.

## Deviations from the original spec

- **Captures computer audio, not a single browser tab.** Other system audio may be included along with YouTube or a browser call.
