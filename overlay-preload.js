const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onBurst: (cb) => ipcRenderer.on('burst', (e, m, ms) => cb(m, ms)),
  onStop: (cb) => ipcRenderer.on('stop', () => cb()),
  onScope: (cb) => ipcRenderer.on('scope', (e, t) => cb(t)),
  onSnipe: (cb) => ipcRenderer.on('snipe', (e, m, t) => cb(m, t)),
  onTrack: (cb) => ipcRenderer.on('track', (e, t) => cb(t)),
  onFx: (cb) => ipcRenderer.on('fx', (e, p) => cb(p)),
  onGarden: (cb) => ipcRenderer.on('garden', (e, p) => cb(p)),
});
