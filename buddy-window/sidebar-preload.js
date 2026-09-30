// Sidebar bridge: pick a page, retry the board, read the page list, hear state.
// Nothing else crosses; main validates every id.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buddy', {
  pages: () => ipcRenderer.invoke('buddy:pages'),
  select: (id) => ipcRenderer.send('buddy:select', String(id)),
  retry: () => ipcRenderer.send('buddy:retry'),
  onState: (fn) => ipcRenderer.on('buddy:state', (_e, s) => fn(s)),
});
