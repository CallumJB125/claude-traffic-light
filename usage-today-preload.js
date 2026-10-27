// Usage › Today's bridge (redesign R7-2, chat-first preview only). Reads, the person's own copy, save and email of the
// digest, and opening Team or Board. Main (src/usage-today-main.js, src/digest-main.js bindings) checks every call.
const { contextBridge, ipcRenderer } = require('electron');

const period = (p) => (p === 'week' ? 'week' : 'day');
contextBridge.exposeInMainWorld('todayApi', {
  state: () => ipcRenderer.invoke('usage-today:state'),
  open: (id) => ipcRenderer.invoke('usage-today:open', typeof id === 'string' ? id : ''),
  digest: {
    get: (p) => ipcRenderer.invoke('usage-today:digest-get', period(p)),
    copy: (p, as) => ipcRenderer.invoke('usage-today:digest-copy', period(p), as === 'markdown' ? 'markdown' : 'text'),
    save: (p) => ipcRenderer.invoke('usage-today:digest-save', period(p)),
    email: (p) => ipcRenderer.invoke('usage-today:digest-email', period(p)),
  },
});
