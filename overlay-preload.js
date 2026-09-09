const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onBurst: (cb) => ipcRenderer.on('burst', (e, m, ms) => cb(m, ms)),
  onStop: (cb) => ipcRenderer.on('stop', () => cb()),
});
