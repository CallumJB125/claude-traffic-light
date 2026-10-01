// About & Updates bridge: the updater's IPC contract and nothing else. The
// page never sees ipcRenderer, only these named calls.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updates', {
  getState: () => ipcRenderer.invoke('updater:get-state'),
  onState: (cb) => ipcRenderer.on('updater:state', (_e, state) => cb(state)),
  check: () => ipcRenderer.invoke('updater:check'),
  download: () => ipcRenderer.invoke('updater:download'),
  install: (opts) => ipcRenderer.invoke('updater:install', { when: opts && opts.when === 'idle' ? 'idle' : 'now', ...(opts && opts.force ? { force: true } : {}) }),
  setChannel: (ch) => ipcRenderer.invoke('updater:set-channel', ch === 'beta' ? 'beta' : 'stable'),
  setAutoDownload: (on) => ipcRenderer.invoke('updater:set-auto-download', !!on),
  revert: () => ipcRenderer.invoke('updater:revert'),
});
