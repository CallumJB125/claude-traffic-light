const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trafficLight', {
  openClaude: () => ipcRenderer.invoke('open-claude'),
  goToNeedingSession: () => ipcRenderer.invoke('go-to-needing-session'),
  getAggregateStatus: () => ipcRenderer.invoke('get-aggregate-status'),
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  setWindowPosition: (x, y) => ipcRenderer.send('set-window-position', x, y),
  onStatusChanged: (callback) => ipcRenderer.on('status-changed', callback),
});
