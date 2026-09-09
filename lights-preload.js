const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lightsApi', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (partial) => ipcRenderer.invoke('save-config', partial),
  resetRules: () => ipcRenderer.invoke('reset-rules'),
  getAggregateStatus: () => ipcRenderer.invoke('get-aggregate-status'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  previewSound: (name) => ipcRenderer.invoke('preview-sound', name),
  chooseSoundFile: () => ipcRenderer.invoke('choose-sound-file'),
  previewOnWidget: (look, ms) => ipcRenderer.invoke('preview-on-widget', look, ms),
  openPreferences: () => ipcRenderer.invoke('open-preferences'),
  onStatusChanged: (callback) => ipcRenderer.on('status-changed', callback),
});
