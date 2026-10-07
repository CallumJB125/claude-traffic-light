// Usage optimiser top bar and empty state. Main owns detection, consent and
// every command; this only draws the view model main pushes and asks for the
// few fixed things the page offers. The dashboard itself is a separate view.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('optimiserApi', {
  onState: (cb) => ipcRenderer.on('optimiser:state', (_e, s) => cb(s)),
  ready: () => ipcRenderer.send('optimiser:ready'),
  act: (kind) => ipcRenderer.invoke('optimiser:act', String(kind)),
  refresh: () => ipcRenderer.send('optimiser:refresh'),
  openBrowser: () => ipcRenderer.invoke('optimiser:open-browser'),
  openDocs: () => ipcRenderer.send('optimiser:docs'),
});
