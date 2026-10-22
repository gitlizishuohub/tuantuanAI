const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  request: (method, route, body) => ipcRenderer.invoke('api', { method, route, body }),
  importPdf: (projectId) => ipcRenderer.invoke('import-pdf', projectId),
  exportReport: (projectId, sessionId) => ipcRenderer.invoke('export-report', { projectId, sessionId }),
  settings: () => ipcRenderer.invoke('settings-get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings-save', settings),
  testConnection: () => ipcRenderer.invoke('model-test'),
  openDataDirectory: () => ipcRenderer.invoke('open-data'),
  backup: () => ipcRenderer.invoke('backup'),
  restore: () => ipcRenderer.invoke('restore'),
}));
