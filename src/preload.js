const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captioner', {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  translate: (text, from, to) => ipcRenderer.invoke('translate', { text, from, to }),
  setCaptureMode: (mode) => ipcRenderer.invoke('capture:set-mode', mode),
  requestMicAccess: () => ipcRenderer.invoke('mic:request-access'),
  close: () => ipcRenderer.send('window:close'),
  minimize: () => ipcRenderer.send('window:minimize'),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
  appendLog: (text) => ipcRenderer.send('log:append', text),
  logNewCall: () => ipcRenderer.invoke('log:new-call'),
  setCollapsed: (collapsed, contentHeight) => ipcRenderer.invoke('window:set-collapsed', collapsed, contentHeight),
  popupMenu: (name, x, y) => ipcRenderer.send('menu:popup', name, x, y),
  onMenuAction: (callback) => ipcRenderer.on('menu:action', (_e, action) => callback(action)),
});
