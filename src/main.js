const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  safeStorage,
  screen,
  session,
  shell,
} = require('electron');
// Windows installer: Setup.exe runs the app with --squirrel-* flags to create/remove shortcuts; quit right after.
if (require('electron-squirrel-startup')) app.quit();

const fs = require('node:fs');
const path = require('node:path');
const { translate } = require('./translate');
const { paraphrase } = require('./paraphrase');
const { getMicMuted, toggleMicMute, disposeMicMute } = require('./mic-mute');

const SECRET_KEYS = ['deeplKey', 'deepgramKey', 'accessCode', 'geminiKey'];
const DEFAULT_TRANSCRIPTION_URL = 'wss://whisper.life-caption-plus.bid/ws/transcribe';
// Control server (Cloudflare Worker in control-server/): checks access codes for Deepgram users.
const CONTROL_URL = process.env.CC_PLUS_CONTROL_URL || 'wss://control.life-caption-plus.bid/ws/session';
const DEFAULT_SETTINGS = {
  transcriptionEngine: 'whisper',
  transcriptionUrl: process.env.CC_PLUS_TRANSCRIPTION_URL || DEFAULT_TRANSCRIPTION_URL,
  accessCode: process.env.CC_PLUS_ACCESS_CODE || '',
  deepgramKey: '',
  translator: 'off',
  deeplKey: '',
  myMemoryEmail: '',
  geminiKey: '',
  fontSize: 26,
  bgColor: '#1c2740',
  showTranscription: true,
  showTranslation: true,
  sentenceLines: true,
  sideBySide: false,
  micMonitor: true,
  showDeepgram: false,
  uiZoom: 1.1,
};

// Whole-UI zoom (View menu / Ctrl +, -, 0). Defaults a bit above 100% so the compact chrome stays readable.
const ZOOM_DEFAULT = DEFAULT_SETTINGS.uiZoom;
const ZOOM_MIN = 0.8;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.1;

// Only these hosts may be opened in the system browser from the renderer.
const EXTERNAL_HOSTS = new Set(['www.deepl.com', 'deepl.com', 'aistudio.google.com', 'chat.whatsapp.com']);

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
  delete stored.groqKey; // Groq was dropped as a paraphrase provider
  delete stored.groqKeyEncrypted;
  // A blank URL (never set up) falls back to the default server instead of leaving the app unusable.
  if (!stored.transcriptionUrl) delete stored.transcriptionUrl;
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

const windowStatePath = () => path.join(app.getPath('userData'), 'window-state.json');

const intersects = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// Ignores saved bounds that would land off every connected display (e.g. an unplugged monitor).
function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    const { x, y, width, height } = state.bounds ?? {};
    if (![x, y, width, height].every(Number.isFinite)) return null;
    if (!screen.getAllDisplays().some((d) => intersects(d.workArea, state.bounds))) return null;
    return state;
  } catch {
    return null;
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const maximized = win.isMaximized();
  const bounds = maximized ? win.getNormalBounds() : win.getBounds();
  // Persist the expanded height so a collapsed window reopens at full size.
  if (expandedHeight !== null) bounds.height = expandedHeight;
  try {
    fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
    fs.writeFileSync(windowStatePath(), JSON.stringify({ bounds, maximized }, null, 2));
  } catch (err) {
    console.error('Could not save window state:', err);
  }
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(workArea.width, APP_WIDTH);
  const height = Math.min(workArea.height, APP_HEIGHT);
  const saved = loadWindowState();

  win = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + workArea.width - width),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    ...saved?.bounds,
    minWidth: Math.min(MIN_WIDTH, workArea.width),
    minHeight: Math.min(MIN_HEIGHT, workArea.height),
    transparent: false,
    frame: true,
    // Hidden rather than frameless keeps the native frame, so Aero Snap and edge resizing still work.
    titleBarStyle: 'hidden',
    resizable: true,
    alwaysOnTop: false,
    hasShadow: true,
    fullscreenable: false,
    skipTaskbar: false,
    acceptFirstMouse: true,
    backgroundColor: '#14161e',
    ...(process.platform === 'win32' && { icon: path.join(__dirname, '..', 'favicon.ico') }),
    // macOS keeps its native traffic lights with a hidden title bar; line them up with the toolbar row.
    ...(process.platform === 'darwin' && { trafficLightPosition: { x: 19, y: 22 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      zoomFactor: loadSettings().uiZoom,
    },
  });

  win.removeMenu();
  // Right-click Copy for selected caption text; editable fields also get the usual edit actions.
  win.webContents.on('context-menu', (_e, params) => {
    const template = params.isEditable
      ? [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' }]
      : params.selectionText.trim()
        ? [{ role: 'copy' }]
        : null;
    if (template) Menu.buildFromTemplate(template).popup({ window: win });
  });
  // A reload resets the zoom, so reapply the saved one; the hidden menu also means zoom keys need wiring.
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(loadSettings().uiZoom));
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const action = { '=': 'in', '+': 'in', '-': 'out', 0: 'reset' }[input.key];
    if (!action) return;
    event.preventDefault();
    if (action === 'reset') setZoom(ZOOM_DEFAULT);
    else zoomBy(action === 'in' ? ZOOM_STEP : -ZOOM_STEP);
  });
  if (saved?.maximized) win.maximize();
  let saveTimer;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 400);
  };
  win.on('move', scheduleSave);
  win.on('resize', scheduleSave);
  win.on('close', saveWindowState);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------- conversation log ----------

const logsDir = () => path.join(app.getPath('userData'), 'logs');
// sv-SE formats the local date as YYYY-MM-DD, giving one sortable file per day.
const logFile = () => path.join(logsDir(), `${new Date().toLocaleDateString('sv-SE')}.log`);
let logQueue = Promise.resolve();

// Appends are chained so lines never interleave, and async so captions never wait on the disk.
function appendLog(text) {
  logQueue = logQueue
    .then(() => fs.promises.mkdir(logsDir(), { recursive: true }))
    .then(() => fs.promises.appendFile(logFile(), text, 'utf8'))
    .catch((err) => console.error('Could not write conversation log:', err));
}

const CALL_HEADER = /^#+ Call #d+/gm;

// Numbers calls per day by counting headers already in today's file, so it survives restarts.
function logNewCall() {
  const done = logQueue.then(async () => {
    let existing = '';
    try {
      existing = await fs.promises.readFile(logFile(), 'utf8');
    } catch {}
    const number = (existing.match(CALL_HEADER)?.length ?? 0) + 1;
    const stamp = new Date().toLocaleString('en-US');
    await fs.promises.mkdir(logsDir(), { recursive: true });
    await fs.promises.appendFile(logFile(), `

########## Call #${number} · ${stamp} ##########
`, 'utf8');
    return number;
  });
  logQueue = done.catch((err) => console.error('Could not write conversation log:', err));
  return done;
}

async function openLogsFolder() {
  await fs.promises.mkdir(logsDir(), { recursive: true });
  await shell.openPath(logsDir());
}

// ---------- zoom ----------

function setZoom(factor) {
  const zoom = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, factor)) * 100) / 100;
  win.webContents.setZoomFactor(zoom);
  saveSettings({ ...loadSettings(), uiZoom: zoom });
}

const zoomBy = (delta) => setZoom(win.webContents.getZoomFactor() + delta);
// The renderer measures in CSS pixels; window sizes and menu positions are in device-independent pixels.
const toWindowPx = (cssPx) => cssPx * (win?.webContents.getZoomFactor() ?? 1);

// ---------- collapse ----------

let expandedHeight = null;

function setCollapsed(collapsed, contentHeight) {
  if (collapsed === (expandedHeight !== null)) return collapsed;
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  if (collapsed) {
    if (win.isMaximized()) win.unmaximize();
    expandedHeight = win.getBounds().height;
    const [width] = win.getContentSize();
    win.setMinimumSize(Math.min(MIN_WIDTH, workArea.width), 0);
    win.setContentSize(width, Math.ceil(toWindowPx(contentHeight)));
    win.setResizable(false);
  } else {
    const bounds = win.getBounds();
    win.setResizable(true);
    win.setMinimumSize(Math.min(MIN_WIDTH, workArea.width), Math.min(MIN_HEIGHT, workArea.height));
    win.setBounds({ ...bounds, height: expandedHeight });
    expandedHeight = null;
  }
  saveWindowState();
  return collapsed;
}

// ---------- in-app menus ----------

const sendMenuAction = (action) => win?.webContents.send('menu:action', action);
const FLUSH_SHORTCUT = 'CommandOrControl+Shift+Space';

function buildMenu(name) {
  const settings = loadSettings();
  const collapsed = expandedHeight !== null;
  const templates = {
    file: [
      { label: 'Start / Stop capture', click: () => sendMenuAction('toggle-capture') },
      { label: 'Mute / Unmute transcription', click: () => sendMenuAction('toggle-mute') },
      {
        label: 'Send pending audio now',
        accelerator: FLUSH_SHORTCUT,
        registerAccelerator: false,
        click: () => sendMenuAction('flush-audio'),
      },
      { label: 'New call', click: () => sendMenuAction('new-call') },
      { label: 'Clear captions', click: () => sendMenuAction('clear-captions') },
      { label: 'Copy transcript', click: () => sendMenuAction('copy-transcript') },
      { label: 'Open conversation logs', click: () => void openLogsFolder() },
      { type: 'separator' },
      { label: 'Minimize', click: () => win.minimize() },
      { label: 'Quit', click: () => app.quit() },
    ],
    edit: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Copy call notes', click: () => sendMenuAction('copy-notes') },
      { label: 'Clear call notes', click: () => sendMenuAction('clear-notes') },
    ],
    view: [
      { label: 'Engine settings', click: () => sendMenuAction('toggle-settings') },
      { label: 'Tutorial', click: () => sendMenuAction('start-tour') },
      { label: collapsed ? 'Expand window' : 'Collapse window', click: () => sendMenuAction('toggle-collapse') },
      { type: 'separator' },
      {
        label: 'Show transcription',
        type: 'checkbox',
        checked: settings.showTranscription,
        click: () => sendMenuAction('toggle-transcription'),
      },
      {
        label: 'Show translation',
        type: 'checkbox',
        checked: settings.showTranslation,
        click: () => sendMenuAction('toggle-translation'),
      },
      {
        label: 'One sentence per line',
        type: 'checkbox',
        checked: settings.sentenceLines,
        click: () => sendMenuAction('toggle-sentence-lines'),
      },
      {
        label: 'Original and translation side by side',
        type: 'checkbox',
        checked: settings.sideBySide,
        click: () => sendMenuAction('toggle-side-by-side'),
      },
      { label: 'Larger text', click: () => sendMenuAction('font-up') },
      { label: 'Smaller text', click: () => sendMenuAction('font-down') },
      { type: 'separator' },
      // registerAccelerator: false — the keys are handled in before-input-event; these only show the hint.
      { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', registerAccelerator: false, click: () => zoomBy(ZOOM_STEP) },
      { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: () => zoomBy(-ZOOM_STEP) },
      {
        label: `Actual size (${Math.round(ZOOM_DEFAULT * 100)}%) · now ${Math.round(win.webContents.getZoomFactor() * 100)}%`,
        accelerator: 'CmdOrCtrl+0',
        registerAccelerator: false,
        click: () => setZoom(ZOOM_DEFAULT),
      },
      { type: 'separator' },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: win.isAlwaysOnTop(),
        click: (item) => win.setAlwaysOnTop(item.checked),
      },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
    ],
  };
  return templates[name] && Menu.buildFromTemplate(templates[name]);
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
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:is-dev', () => !app.isPackaged);
  ipcMain.handle('app:control-url', () => CONTROL_URL);
  // The renderer may only use media permissions, so copying the configuration goes through here.
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = { ...loadSettings(), ...patch };
    saveSettings(next);
    return next;
  });
  ipcMain.handle('translate', (_e, { text, from, to }) => translate(text, from, to, loadSettings()));
  ipcMain.handle('paraphrase', (_e, { text, lang }) => paraphrase(text, lang, loadSettings()));
  ipcMain.handle('capture:set-mode', (_e, mode) => {
    captureMode = mode === 'screen' ? 'screen' : 'window';
  });
  ipcMain.handle('mic:get-muted', () => getMicMuted());
  ipcMain.handle('mic:toggle-mute', () => toggleMicMute());
  ipcMain.on('window:close', () => app.quit());
  ipcMain.on('window:minimize', () => win?.minimize());
  ipcMain.on('app:open-external', (_e, url) => {
    try {
      const { protocol, hostname } = new URL(url);
      if (protocol === 'https:' && EXTERNAL_HOSTS.has(hostname)) void shell.openExternal(url);
    } catch {}
  });
  ipcMain.handle('log:new-call', () => logNewCall());
  ipcMain.on('log:append', (_e, text) => {
    if (typeof text === 'string' && text) appendLog(text);
  });
  ipcMain.handle('window:set-collapsed', (_e, collapsed, contentHeight) =>
    setCollapsed(Boolean(collapsed), Number(contentHeight) || 0)
  );
  ipcMain.on('menu:popup', (_e, name, x, y) => {
    buildMenu(name)?.popup({ window: win, x: Math.round(toWindowPx(x)), y: Math.round(toWindowPx(y)) });
  });
}

app.whenReady().then(() => {
  migrateLegacySettings();
  // Packaged builds take the Dock icon from the bundle's .icns; `npm start` runs the stock Electron.app.
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    // Display capture arrives with no media types; anything else may ask for audio only, never video.
    cb(permission === 'media' && (details.mediaTypes ?? []).every((type) => type === 'audio'));
  });
  registerDisplayMediaHandler();
  registerIpc();
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+K', () => {
    if (!win) return;
    win.isVisible() ? win.hide() : win.showInactive();
  });
  // Global so it works while the call app has focus; register() returns false if another app owns the combo.
  if (!globalShortcut.register(FLUSH_SHORTCUT, () => sendMenuAction('flush-audio'))) {
    console.warn(`Could not register ${FLUSH_SHORTCUT}: already in use by another app`);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  disposeMicMute();
});
app.on('window-all-closed', () => app.quit());
