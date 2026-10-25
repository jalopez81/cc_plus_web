const {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
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
  sentenceLines: true,
  micMonitor: true,
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
    },
  });

  win.removeMenu();
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
    win.setContentSize(width, Math.ceil(contentHeight));
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

function buildMenu(name) {
  const settings = loadSettings();
  const collapsed = expandedHeight !== null;
  const templates = {
    file: [
      { label: 'Start / Stop capture', click: () => sendMenuAction('toggle-capture') },
      { label: 'Mute / Unmute transcription', click: () => sendMenuAction('toggle-mute') },
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
      { label: 'Larger text', click: () => sendMenuAction('font-up') },
      { label: 'Smaller text', click: () => sendMenuAction('font-down') },
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
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = { ...loadSettings(), ...patch };
    saveSettings(next);
    return next;
  });
  ipcMain.handle('translate', (_e, { text, from, to }) => translate(text, from, to, loadSettings()));
  ipcMain.handle('capture:set-mode', (_e, mode) => {
    captureMode = mode === 'screen' ? 'screen' : 'window';
  });
  ipcMain.handle('mic:request-access', () =>
    process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true
  );
  ipcMain.on('window:close', () => app.quit());
  ipcMain.on('window:minimize', () => win?.minimize());
  ipcMain.handle('log:new-call', () => logNewCall());
  ipcMain.on('log:append', (_e, text) => {
    if (typeof text === 'string' && text) appendLog(text);
  });
  ipcMain.handle('window:set-collapsed', (_e, collapsed, contentHeight) =>
    setCollapsed(Boolean(collapsed), Number(contentHeight) || 0)
  );
  ipcMain.on('menu:popup', (_e, name, x, y) => {
    buildMenu(name)?.popup({ window: win, x: Math.round(x), y: Math.round(y) });
  });
}

app.whenReady().then(() => {
  migrateLegacySettings();
  // Packaged builds take the Dock icon from the bundle's .icns; `npm start` runs the stock Electron.app.
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    // Display capture arrives with no media types; the headset monitor asks for audio only, never video.
    cb(permission === 'media' && (details.mediaTypes ?? []).every((type) => type === 'audio'));
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
