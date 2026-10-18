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

const SECRET_KEYS = ['deepgramKey', 'deeplKey'];
const DEFAULT_SETTINGS = {
  deepgramKey: '8cc95dbd9338f31d9f2ed0d5361ef3d7940257d7',
  sourceMode: 'auto', // 'auto' (EN↔ES), 'en' (EN→ES), 'es' (ES→EN)
  translator: 'auto', // 'auto' | 'deepl' | 'google' | 'mymemory' | 'apertium' | 'off'
  deeplKey: '',
  myMemoryEmail: '',
  fontSize: 26,
  bgOpacity: 0.72,
  showOriginal: true,
};

const MIN_WIDTH = 420;
const MIN_HEIGHT = 140;
const COLLAPSED_HEIGHT = 56;

let win;
let clickThrough = false;
let expandedHeight = null;
let captureMode = 'window'; // 'window' grants our own window as the video track; 'screen' falls back to a display.

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

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
        stored[key] = '';
      }
    }
    delete stored[`${key}Encrypted`];
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}

function saveSettings(settings) {
  const out = { ...settings };
  if (safeStorage.isEncryptionAvailable()) {
    for (const key of SECRET_KEYS) {
      if (out[key]) {
        out[key] = safeStorage.encryptString(out[key]).toString('base64');
        out[`${key}Encrypted`] = true;
      }
    }
  }
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(out, null, 2));
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(960, workArea.width - 80);
  const height = 280;

  win = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - 40),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    skipTaskbar: true,
    acceptFirstMouse: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function setClickThrough(enabled) {
  clickThrough = enabled;
  win?.setIgnoreMouseEvents(enabled, { forward: true });
  win?.webContents.send('window:click-through', enabled);
}

function setCollapsed(collapsed) {
  if (!win) return;
  const [width, height] = win.getSize();
  if (collapsed && expandedHeight === null) {
    expandedHeight = height;
    win.setMinimumSize(MIN_WIDTH, COLLAPSED_HEIGHT);
    win.setSize(width, COLLAPSED_HEIGHT);
    win.setResizable(false);
  } else if (!collapsed && expandedHeight !== null) {
    win.setResizable(true);
    win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
    win.setSize(width, expandedHeight);
    expandedHeight = null;
  }
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
      console.error('Display media request failed:', err);
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
  ipcMain.on('window:collapse', (_e, collapsed) => setCollapsed(Boolean(collapsed)));
  ipcMain.on('window:click-through', (_e, enabled) => setClickThrough(Boolean(enabled)));
}

app.whenReady().then(() => {
  // getDisplayMedia arrives as 'media' with no mediaTypes; mic/camera requests list them. Only allow the former.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    cb(permission === 'media' && (details.mediaTypes ?? []).length === 0);
  });
  registerDisplayMediaHandler();
  registerIpc();
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+L', () => setClickThrough(!clickThrough));
  globalShortcut.register('CommandOrControl+Shift+K', () => {
    if (!win) return;
    win.isVisible() ? win.hide() : win.showInactive();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
