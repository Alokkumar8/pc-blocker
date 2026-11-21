const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pcBlocker', {
  getInitialState: () => ipcRenderer.invoke('tasks:get-state'),
  commitTasks: (tasks) => ipcRenderer.invoke('tasks:commit', tasks),
  addTasks: (newTasks) => ipcRenderer.invoke('tasks:add', newTasks),
  exitTerminal: (pendingTasks) => ipcRenderer.invoke('terminal:exit', pendingTasks),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  runJevOcrCheck: () => ipcRenderer.invoke('overlay:run-jev-ocr'),
  runGeminiOcrCheck: () => ipcRenderer.invoke('overlay:run-gemini-ocr'),
  resizeOverlay: (height) => ipcRenderer.invoke('overlay:resize', height),
});
