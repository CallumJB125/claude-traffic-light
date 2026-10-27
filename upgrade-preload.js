// Upgrade page bridge: the entitlement IPC contract and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('plan', {
  state: () => ipcRenderer.invoke('entitlement:state'),
  refresh: () => ipcRenderer.invoke('entitlement:refresh'),
  upgrade: (interval) => ipcRenderer.invoke('entitlement:open', 'checkout', interval === 'year' ? 'year' : 'month'),
  manage: () => ipcRenderer.invoke('entitlement:open', 'portal'),
  signIn: () => ipcRenderer.invoke('entitlement:sign-in'),
  // R8-3c-1: only the Settings sheet's document is answered (settings:go-pane / settings:shown); inert on the Plan & billing page
  goPane: (pane) => ipcRenderer.send('settings:go-pane', typeof pane === 'string' ? pane : ''),
  onShown: (cb) => ipcRenderer.on('settings:shown', () => cb()),
});
