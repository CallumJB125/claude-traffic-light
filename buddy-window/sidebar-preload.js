// Sidebar bridge: pick a page, a workspace or an account action, retry the
// board, sign out of an Access-fallback hub, read the page list, hear state;
// with the chat-first preview, read session rows and save collapsed groups.
// Nothing else crosses; main validates every id.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buddy', {
  pages: () => ipcRenderer.invoke('buddy:pages'),
  select: (id) => ipcRenderer.send('buddy:select', String(id)),
  retry: () => ipcRenderer.send('buddy:retry'),
  retryAccountStorage: () => ipcRenderer.send('buddy:account-storage-retry'),
  workspace: (id) => ipcRenderer.send('buddy:workspace', String(id)),
  optimiserSection: (id) => ipcRenderer.send('buddy:optimiser-section', String(id)),
  signOut: (id) => ipcRenderer.send('buddy:signout', String(id)),
  onState: (fn) => ipcRenderer.on('buddy:state', (_e, s) => fn(s)),
  // Chat-first preview only (main refuses both while it is off): the
  // read-only session rows, and which bucket groups are collapsed.
  sessions: () => ipcRenderer.invoke('overview:state'),
  setGroups: (ids) => ipcRenderer.send('buddy:sidebar-groups', Array.isArray(ids) ? ids.slice(0, 8).map(String) : []),
});
