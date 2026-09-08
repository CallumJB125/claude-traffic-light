const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trafficLight', {
  openClaude: () => ipcRenderer.invoke('open-claude'),
  getAggregateStatus: () => ipcRenderer.invoke('get-aggregate-status'),
  onStatusChanged: (callback) => ipcRenderer.on('status-changed', callback),
});
