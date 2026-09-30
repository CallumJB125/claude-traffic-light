// Sidebar bridge: pick a page, a workspace or an account action, retry the
// board, sign out of an Access-fallback hub, read the page list, hear state.
// Nothing else crosses; main validates every id.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buddy', {
  pages: () => ipcRenderer.invoke('buddy:pages'),
  select: (id) => ipcRenderer.send('buddy:select', String(id)),
  retry: () => ipcRenderer.send('buddy:retry'),
  workspace: (id) => ipcRenderer.send('buddy:workspace', String(id)),
  signOut: (id) => ipcRenderer.send('buddy:signout', String(id)),
  onState: (fn) => ipcRenderer.on('buddy:state', (_e, s) => fn(s)),
});
