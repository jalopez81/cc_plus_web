const {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  safeStorage,
  screen,
  session,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { translate } = require('./translate');

const SECRET_KEYS = ['deeplKey', 'deepgramKey'];
const DEFAULT_SETTINGS = {
  transcriptionEngine: 'whisper',
  transcriptionUrl: process.env.CC_PLUS_TRANSCRIPTION_URL || '',
  deepgramKey: '',
  translator: 'off',
  deeplKey: '',
  myMemoryEmail: '',
  fontSize: 26,
  bgColor: '#1c2740',
  showTranscription: true,
  showTranslation: true,
};

const MIN_WIDTH = 420;
const MIN_HEIGHT = 360;
const APP_WIDTH = 452;
const APP_HEIGHT = 720;

let win;
let captureMode = 'window'; // 'window' grants our own window as the video track; 'screen' falls back to a display.

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const LEGACY_APP_NAME = 'Mac Live Captioner';

function migrateLegacySettings() {
  const legacy = path.join(app.getPath('appData'), LEGACY_APP_NAME, 'settings.json');
  if (fs.existsSync(settingsPath()) || !fs.existsSync(legacy)) return;
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.copyFileSync(legacy, settingsPath());
}

function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {}
  for (const key of SECRET_KEYS) {
    if (stored[key] && stored[`${key}Encrypted`]) {
      try {
        stored[key] = safeStorage.decryptString(Buffer.from(stored[key], 'base64'));
      } catch {
        delete stored[key];
      }
    }
    delete stored[`${key}Encrypted`];
  }
  if (!Object.hasOwn(stored, 'showTranscription') && Object.hasOwn(stored, 'showOriginal')) {
    stored.showTranscription = stored.showOriginal;
  }
  delete stored.showOriginal;
  delete stored.sourceMode;
  return { ...DEFAULT_SETTINGS, ...stored };
}

function saveSettings(settings) {
  const out = { ...settings };
  const secretsToEncrypt = SECRET_KEYS.filter((key) => out[key]);
  if (secretsToEncrypt.length > 0 && !safeStorage.isEncryptionAvailable()) {
    throw new Error('Cannot save API keys because secure OS credential storage is unavailable.');
  }
  for (const key of secretsToEncrypt) {
    out[key] = safeStorage.encryptString(out[key]).toString('base64');
    out[`${key}Encrypted`] = true;
  }
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(out, null, 2));
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(workArea.width, APP_WIDTH);
  const height = Math.min(workArea.height, APP_HEIGHT);

  win = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + workArea.width - width),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    minWidth: Math.min(MIN_WIDTH, workArea.width),
    minHeight: Math.min(MIN_HEIGHT, workArea.height),
    transparent: false,
    frame: true,
    resizable: true,
    alwaysOnTop: false,
    hasShadow: true,
    fullscreenable: false,
    skipTaskbar: false,
    acceptFirstMouse: true,
    backgroundColor: '#14161e',
    ...(process.platform === 'win32' && { icon: path.join(__dirname, '..', 'favicon.ico') }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function registerDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (captureMode === 'window' && request.frame) {
        callback({ video: request.frame, audio: 'loopback' });
        return;
      }

      const [source] = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      callback(source ? { video: source, audio: 'loopback' } : null);
    } catch (err) {
      console.error('System audio capture request failed:', err);
      callback(null);
    }
  });
}

function registerIpc() {
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = { ...loadSettings(), ...patch };
    saveSettings(next);
    return next;
  });
  ipcMain.handle('translate', (_e, { text, from, to }) => translate(text, from, to, loadSettings()));
  ipcMain.handle('capture:set-mode', (_e, mode) => {
    captureMode = mode === 'screen' ? 'screen' : 'window';
  });
  ipcMain.on('window:close', () => app.quit());
}

app.whenReady().then(() => {
  migrateLegacySettings();
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    cb(permission === 'media' && (details.mediaTypes ?? []).length === 0);
  });
  registerDisplayMediaHandler();
  registerIpc();
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+K', () => {
    if (!win) return;
    win.isVisible() ? win.hide() : win.showInactive();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
