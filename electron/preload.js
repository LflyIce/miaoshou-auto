const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miaoshouApp', {
  loadSettings: () => ipcRenderer.invoke('app:load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('app:save-settings', settings),
  startTask: (taskName) => ipcRenderer.invoke('task:start', taskName),
  continueTask: () => ipcRenderer.invoke('task:continue'),
  stopTask: () => ipcRenderer.invoke('task:stop'),
  openPath: (target) => ipcRenderer.invoke('path:open', target),
  listFillHistory: () => ipcRenderer.invoke('history:list'),
  openFillHistory: (fileName) => ipcRenderer.invoke('history:open', fileName),
  searchFillHistory: (query) => ipcRenderer.invoke('history:search', query),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogin: (creds) => ipcRenderer.invoke('auth:login', creds),
  onLog: (handler) => {
    ipcRenderer.on('task:log', (_event, payload) => handler(payload));
  },
  onTaskState: (handler) => {
    ipcRenderer.on('task:state', (_event, payload) => handler(payload));
  }
});
