// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onPttPress: (callback) => ipcRenderer.on('ptt-press', () => callback()),
  onFreqShortcut: (callback) => ipcRenderer.on('freq-shortcut', (event, num) => callback(num)),
  registerPttKey: (keyStr) => ipcRenderer.invoke('register-ptt-key', keyStr),
  toggleShortcuts: (enable) => ipcRenderer.invoke('toggle-shortcuts', enable) // <-- Добавили эту строчку
});