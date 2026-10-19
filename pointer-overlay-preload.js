// Pointing overlay bridge: main only ever pushes one plan; the page sends nothing back.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pointer', {
  onPlay: (cb) => ipcRenderer.on('pointer:play', (e, plan) => cb(plan)),
});
