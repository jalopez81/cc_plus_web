const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captioner', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  translate: (text, from, to) => ipcRenderer.invoke('translate', { text, from, to }),
  setCaptureMode: (mode) => ipcRenderer.invoke('capture:set-mode', mode),
  close: () => ipcRenderer.send('window:close'),
});
