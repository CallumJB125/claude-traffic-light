const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayRender', {
  onLook: (cb) => ipcRenderer.on('look', (e, look) => cb(look)),
});

// User characters: the list main has validated, and a nudge when it changes.
contextBridge.exposeInMainWorld('userCharacters', {
  list: () => ipcRenderer.invoke('characters:list'),
  onChange: (cb) => ipcRenderer.on('characters:changed', () => cb()),
});
