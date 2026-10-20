# Live Captioner

A resizable desktop window that captions whatever your computer is playing (a browser tab, Zoom, a livestream) in real time, with English ⇄ Spanish translation and built-in interpreter tools. No virtual audio driver required.

## Requirements

- Windows 10 or later, or macOS 13 or later
- Node.js 18+
- A [Deepgram](https://console.deepgram.com/signup) API key (new accounts include free credit)

## Getting started

```bash
npm install
npm start          # run in development
npm run make       # build a .zip for the current platform (plus a .dmg on macOS) into out/make
npm run make:mac   # macOS only: build a universal (Apple Silicon + Intel) .dmg and .zip
```

On first launch, open **⚙ Settings**, paste your Deepgram key, and press **Start**.

On macOS, the system asks for permission to capture system audio; allow it. If captions never appear and the status says "No audio yet", check **System Settings › Privacy & Security › Screen & System Audio Recording**. In development, the app requesting permission may be your terminal or editor rather than "Live Captioner". Windows needs no permission prompt.

## Interpreter tools

The app opens as a tall, right-aligned window occupying about one third of the primary display. Use the **Saludos**, **Intervenciones**, and **Solicitudes** buttons to open categorized soundbytes. Interpreter name/ID and a small call-notes field appear above the transcript. Soundbytes and notes can be customized and are saved locally. The hold timer remains in the transcription toolbar.

## Using it

Shortcuts use **Ctrl+Shift** on Windows and **⌘⇧** on macOS.

| Control | What it does |
| --- | --- |
| Source dropdown | **Auto** detects English/Spanish per sentence (Deepgram `multi`); or pin the source to English or Spanish for better accuracy |
| Start / Stop | Begin or end capturing system audio |
| Pin / Ctrl+Shift+L | Toggle click-through so the overlay ignores the mouse |
| Ctrl+Shift+K | Show / hide the window |
| Translator dropdown | Switch translation service on the fly (see below) |
| Background / Opacity (second toolbar row) | Pick the window color and transparency; text switches to dark on light colors |
| Native title bar | Move, minimize, maximize, close, and resize the window |

**Translation providers** (toolbar dropdown or Settings):
- **Auto**: tries DeepL (if a key is set), then Google, MyMemory, and Apertium, using the first that succeeds. A service that fails is skipped for 5 minutes, or 1 hour if it reports its quota is used up. The status bar shows which service is translating.
- **DeepL**: highest quality; free API keys (500,000 characters/month) and paid keys both work.
- **Google**: free, no key. Uses Google's unofficial web endpoint, which can rate-limit heavy use.
- **MyMemory**: free, no key. About 5,000 characters/day anonymously, or 50,000/day if you enter an email.
- **Apertium**: free, no key, open source. Slower and noticeably lower quality; best as a last resort.
- **Off**: transcription only.

API keys are stored encrypted with the OS credential store (`safeStorage`: Windows DPAPI or the macOS Keychain) in `settings.json`, under `%APPDATA%\Live Captioner\` on Windows or `~/Library/Application Support/Live Captioner/` on macOS. Settings from the old "Mac Live Captioner" folder are copied over on first launch; on macOS you may need to re-enter API keys.

## How it works

```
getDisplayMedia (system audio loopback: WASAPI on Windows, CoreAudio Tap on macOS)
  └─ MediaRecorder (webm/opus, 250 ms chunks)
       └─ Deepgram live WebSocket (nova-3, interim results)
            └─ final segments ─ IPC ─▶ main process ─▶ DeepL / Google / MyMemory / Apertium
```

- `src/main.js`: creates the overlay window, grants `getDisplayMedia` requests with `audio: 'loopback'`, stores settings, and handles IPC. The video track it grants is the overlay's own window, so Screen Recording permission is not needed. If that fails, it falls back to capturing the screen.
- `src/translate.js`: translation providers. These run in the main process to avoid CORS restrictions.
- `src/renderer/`: overlay UI, the Deepgram streaming client, and caption rendering.
- `scripts/patch-dev-plist.js` (macOS only; a no-op elsewhere): adds `NSAudioCaptureUsageDescription` to the dev `Electron.app`. Without this key, macOS 14.2+ silently returns a silent audio stream. Packaged builds get the key from `forge.config.js`.

## Deviations from the original spec

- **Electron 44 instead of 28.** Electron 28 can capture system audio only on Windows; macOS support arrived in Electron 39 (via the CoreAudio Tap API).
- **No Web Speech API engine.** `webkitSpeechRecognition` exists in Electron, but it produces no results: Electron does not ship Google's speech service keys, and on-device recognition reports `unavailable`. It also can only listen to the default microphone, not a captured stream. Deepgram is therefore the transcription engine. A fully offline/free option (e.g. whisper.cpp or Vosk) would be the natural next engine to add.
- **Captures all system audio, not one tab.** Electron cannot select a single Chrome tab, so mute other sources while captioning.
