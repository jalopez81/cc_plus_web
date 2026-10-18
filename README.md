# Mac Live Captioner

A transparent, always-on-top macOS overlay that captions whatever your Mac is playing (a browser tab, Zoom, a livestream) in real time, with English ⇄ Spanish translation. No virtual audio driver required.

## Requirements

- macOS 13 Ventura or later (system-audio capture is not possible on macOS 12 without a driver such as BlackHole)
- Node.js 18+
- A [Deepgram](https://console.deepgram.com/signup) API key (new accounts include free credit)

## Getting started

```bash
npm install
npm start          # run in development
npm run make       # build a universal (Apple Silicon + Intel) .dmg and .zip into out/make
```

On first launch, open **⚙ Settings**, paste your Deepgram key, and press **Start**. macOS will ask for permission to capture system audio; allow it. If captions never appear and the status says "No audio yet", check **System Settings › Privacy & Security › Screen & System Audio Recording**. In development, the app requesting permission may be your terminal or editor rather than "Mac Live Captioner".

## Using it

| Control | What it does |
| --- | --- |
| Source dropdown | **Auto** detects English/Spanish per sentence (Deepgram `multi`); or pin the source to English or Spanish for better accuracy |
| Start / Stop | Begin or end capturing system audio |
| Pin / ⌘⇧L | Toggle click-through so the overlay ignores the mouse |
| ⌘⇧K | Show / hide the overlay |
| Translator dropdown | Switch translation service on the fly (see below) |
| Drag the toolbar | Move the window; resize from the edges |

The toolbar fades out while captioning and reappears on hover.

**Translation providers** (toolbar dropdown or Settings):
- **Auto**: tries DeepL (if a key is set), then Google, MyMemory, and Apertium, using the first that succeeds. A service that fails is skipped for 5 minutes, or 1 hour if it reports its quota is used up. The status bar shows which service is translating.
- **DeepL**: highest quality; free API keys (500,000 characters/month) and paid keys both work.
- **Google**: free, no key. Uses Google's unofficial web endpoint, which can rate-limit heavy use.
- **MyMemory**: free, no key. About 5,000 characters/day anonymously, or 50,000/day if you enter an email.
- **Apertium**: free, no key, open source. Slower and noticeably lower quality; best as a last resort.
- **Off**: transcription only.

API keys are stored encrypted with the macOS Keychain (`safeStorage`) in `~/Library/Application Support/Mac Live Captioner/settings.json`.

## How it works

```
getDisplayMedia (system audio loopback via CoreAudio Tap)
  └─ MediaRecorder (webm/opus, 250 ms chunks)
       └─ Deepgram live WebSocket (nova-3, interim results)
            └─ final segments ─ IPC ─▶ main process ─▶ DeepL / Google / MyMemory / Apertium
```

- `src/main.js`: creates the overlay window, grants `getDisplayMedia` requests with `audio: 'loopback'`, stores settings, and handles IPC. The video track it grants is the overlay's own window, so Screen Recording permission is not needed. If that fails, it falls back to capturing the screen.
- `src/translate.js`: translation providers. These run in the main process to avoid CORS restrictions.
- `src/renderer/`: overlay UI, the Deepgram streaming client, and caption rendering.
- `scripts/patch-dev-plist.js`: adds `NSAudioCaptureUsageDescription` to the dev `Electron.app`. Without this key, macOS 14.2+ silently returns a silent audio stream. Packaged builds get the key from `forge.config.js`.

## Deviations from the original spec

- **Electron 44 instead of 28.** Loopback capture of macOS system audio only became the default in Electron 39 (via the CoreAudio Tap API). On Electron 28 it is Windows-only.
- **No Web Speech API engine.** `webkitSpeechRecognition` exists in Electron, but it produces no results: Electron does not ship Google's speech service keys, and on-device recognition reports `unavailable`. It also can only listen to the default microphone, not a captured stream. Deepgram is therefore the transcription engine. A fully offline/free option (e.g. whisper.cpp or Vosk) would be the natural next engine to add.
- **Captures all system audio, not one tab.** Electron cannot select a single Chrome tab, so mute other sources while captioning.
