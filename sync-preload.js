// Sync page bridge: the sync IPC contract (src/sync/index.js) and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sync', {
  state: () => ipcRenderer.invoke('sync:state'),
  enable: () => ipcRenderer.invoke('sync:enable'),
  disable: () => ipcRenderer.invoke('sync:disable'),
  recover: (code) => ipcRenderer.invoke('sync:recover', String(code ?? '')),
  approve: (id) => ipcRenderer.invoke('sync:approve', String(id ?? '')),
  revoke: (id) => ipcRenderer.invoke('sync:revoke', String(id ?? '')),
  newCode: () => ipcRenderer.invoke('sync:new-code'),
  now: () => ipcRenderer.invoke('sync:now'),
});
