// Usage pop-out bridge: read the summary, hear about refreshes, open the full
// view, close. Nothing else reaches the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usagePop', {
  get: () => ipcRenderer.invoke('usage-pop:get'),
  onUpdate: (cb) => ipcRenderer.on('usage-pop:update', (_e, s) => cb(s)),
  openFull: () => ipcRenderer.invoke('usage-pop:open-full'),
  close: () => ipcRenderer.invoke('usage-pop:close'),
});
