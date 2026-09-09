const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lightsApi', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (partial) => ipcRenderer.invoke('save-config', partial),
  resetRules: () => ipcRenderer.invoke('reset-rules'),
  getAggregateStatus: () => ipcRenderer.invoke('get-aggregate-status'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  previewSound: (name) => ipcRenderer.invoke('preview-sound', name),
  chooseSoundFile: () => ipcRenderer.invoke('choose-sound-file'),
  exportRules: (rules) => ipcRenderer.invoke('export-rules', rules),
  importRules: () => ipcRenderer.invoke('import-rules'),
  connectAgent: (which) => ipcRenderer.invoke('connect-agent', which),
  signalEndpoint: () => ipcRenderer.invoke('signal-endpoint'),
  previewOnWidget: (look, ms) => ipcRenderer.invoke('preview-on-widget', look, ms),
  openPreferences: () => ipcRenderer.invoke('open-preferences'),
  onStatusChanged: (callback) => ipcRenderer.on('status-changed', callback),
  onShowView: (cb) => ipcRenderer.on('show-view', (e, v) => cb(v)),
});
