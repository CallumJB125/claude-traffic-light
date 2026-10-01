// Hatch window bridge: describe a character (choices only), preview what comes
// back, save it by token. The page never sends art to be written: main keeps what
// it generated and saves that.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hatch', {
  options: () => ipcRenderer.invoke('hatch:options'),
  generate: (params) => ipcRenderer.invoke('hatch:generate', params),
  surprise: () => ipcRenderer.invoke('hatch:surprise'),
  save: (token) => ipcRenderer.invoke('hatch:save', token),
  close: () => ipcRenderer.invoke('hatch:close'),
});
