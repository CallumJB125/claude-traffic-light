// Discover page bridge: the community gallery (src/gallery.js). Main fetches
// and verifies the list; the page only ever names an entry id and the sha256
// it was shown, or a kind and local id to remove. Nothing else is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('galleryApi', {
  refresh: () => ipcRenderer.invoke('gallery:fetch'),
  cached: () => ipcRenderer.invoke('gallery:cached'),
  add: (id, sha) => ipcRenderer.invoke('gallery:add', String(id), String(sha)),
  addPack: (id, sha) => ipcRenderer.invoke('gallery:add-pack', String(id), String(sha)),
  installed: () => ipcRenderer.invoke('gallery:installed'),
  remove: (kind, id) => ipcRenderer.invoke('gallery:remove', String(kind), String(id)),
});
contextBridge.exposeInMainWorld('demoApi', {
  state: () => ipcRenderer.invoke('demo:state'),
  exit: () => ipcRenderer.invoke('demo:exit'),
});
