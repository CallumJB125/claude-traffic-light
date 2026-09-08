const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');

contextBridge.exposeInMainWorld('trafficLight', {
  openClaude: () => ipcRenderer.invoke('open-claude'),
  getStatusPath: () => ipcRenderer.invoke('get-status-path'),
  onStatusChanged: (callback) => ipcRenderer.on('status-changed', callback),
  readStatusFile: (filePath) => {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  },
});
