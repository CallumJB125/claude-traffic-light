// Hatch window bridge: describe a character (choices only), preview what comes
// back, save it by token. The page never sends art to be written: main keeps what
// it generated and saves that.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('userCharacters', { list: () => ipcRenderer.invoke('characters:list') });
contextBridge.exposeInMainWorld('hatch', {
  options: () => ipcRenderer.invoke('hatch:options'),
  generate: (params) => ipcRenderer.invoke('hatch:generate', params),
  describe: (params) => ipcRenderer.invoke('hatch:describe', params),
  surprise: () => ipcRenderer.invoke('hatch:surprise'),
  save: (token) => ipcRenderer.invoke('hatch:save', token),
  close: () => ipcRenderer.invoke('hatch:close'),
});
// "Share to gallery…" (src/gallery-publish.js): main builds and checks the item; the page names a kind, a ref and a draft token.
contextBridge.exposeInMainWorld('galleryPublishApi', {
  begin: (kind, ref) => ipcRenderer.invoke('gallery-publish:begin', String(kind), ref),
  draft: (kind, ref, meta) => ipcRenderer.invoke('gallery-publish:draft', String(kind), ref, meta),
  open: (token) => ipcRenderer.invoke('gallery-publish:open', String(token)),
  copy: (token) => ipcRenderer.invoke('gallery-publish:copy', String(token)),
});
