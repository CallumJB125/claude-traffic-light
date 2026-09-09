const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayRender', {
  onLook: (cb) => ipcRenderer.on('look', (e, look) => cb(look)),
});
