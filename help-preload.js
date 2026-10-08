const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helpApi', {
  getHelp: () => ipcRenderer.invoke('get-help'),
  navigate: (destination) => ipcRenderer.invoke('help:navigate', destination),
  openLights: () => ipcRenderer.invoke('open-lights'),
  onStatusChanged: (cb) => ipcRenderer.on('status-changed', () => cb()),
});
