const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captioner', {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  isDev: () => ipcRenderer.invoke('app:is-dev'),
  getControlUrl: () => ipcRenderer.invoke('app:control-url'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  translate: (text, from, to) => ipcRenderer.invoke('translate', { text, from, to }),
  paraphrase: (text, lang) => ipcRenderer.invoke('paraphrase', { text, lang }),
  setCaptureMode: (mode) => ipcRenderer.invoke('capture:set-mode', mode),
  getMicMuted: () => ipcRenderer.invoke('mic:get-muted'),
  toggleMicMute: () => ipcRenderer.invoke('mic:toggle-mute'),
  close: () => ipcRenderer.send('window:close'),
  minimize: () => ipcRenderer.send('window:minimize'),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
  appendLog: (text) => ipcRenderer.send('log:append', text),
  logNewCall: () => ipcRenderer.invoke('log:new-call'),
  setCollapsed: (collapsed, contentHeight) => ipcRenderer.invoke('window:set-collapsed', collapsed, contentHeight),
  popupMenu: (name, x, y) => ipcRenderer.send('menu:popup', name, x, y),
  onMenuAction: (callback) => ipcRenderer.on('menu:action', (_e, action) => callback(action)),
});
