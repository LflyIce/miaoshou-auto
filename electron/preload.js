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
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogin: (creds) => ipcRenderer.invoke('auth:login', creds),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  openDownloadUrl: () => ipcRenderer.invoke('update:open-download'),
  onLog: (handler) => {
    ipcRenderer.on('task:log', (_event, payload) => handler(payload));
  },
  onTaskState: (handler) => {
    ipcRenderer.on('task:state', (_event, payload) => handler(payload));
  },
  onUpdateAvailable: (handler) => {
    ipcRenderer.on('update:available', (_event, payload) => handler(payload));
  }
});
