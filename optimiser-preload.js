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
  view: (name, args) => ipcRenderer.invoke('burst:view', String(name), args && typeof args === 'object' ? args : {}),
  burstAction: (id) => ipcRenderer.invoke('burst-action', String(id), {}),
  openDocs: () => ipcRenderer.send('optimiser:docs'),
  tools: () => ipcRenderer.invoke('burst:tools'),
  waste: () => ipcRenderer.invoke('cost-guard:report'),
  setCompaction: (req) => ipcRenderer.invoke('burst:set-compaction', { enabled: !!(req && req.enabled), confirmed: !!(req && req.confirmed === true) }),
  openLink: (id) => ipcRenderer.send('optimiser:link', String(id)),
  openPage: (id) => ipcRenderer.send('optimiser:open-page', String(id)),
});
