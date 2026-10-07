// Upgrade page bridge: the entitlement IPC contract and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('plan', {
  state: () => ipcRenderer.invoke('entitlement:state'),
  refresh: () => ipcRenderer.invoke('entitlement:refresh'),
  upgrade: (interval) => ipcRenderer.invoke('entitlement:open', 'checkout', interval === 'year' ? 'year' : 'month'),
  manage: () => ipcRenderer.invoke('entitlement:open', 'portal'),
});
