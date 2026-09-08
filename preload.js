const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trafficLight', {
  openClaude: () => ipcRenderer.invoke('open-claude'),
  goToNeedingSession: () => ipcRenderer.invoke('go-to-needing-session'),
  getAggregateStatus: () => ipcRenderer.invoke('get-aggregate-status'),
  onStatusChanged: (callback) => ipcRenderer.on('status-changed', callback),
});
