const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // События от хуков
  onPttDown: (callback) => ipcRenderer.on('ptt-down', () => callback()),
  onPttUp:   (callback) => ipcRenderer.on('ptt-up',   () => callback()),
  onFreqShortcut: (callback) => ipcRenderer.on('freq-shortcut', (event, num) => callback(num)),

  // Управление глобальными хуками
  toggleHooks: (enable) => ipcRenderer.invoke('toggle-hooks', enable),

  // Запись новой комбинации
  startRecordingCombination: () => ipcRenderer.invoke('start-recording'),

  // Установка текущей комбинации
  registerPttCombination: (combo) => ipcRenderer.invoke('register-ptt-combination', combo)
});