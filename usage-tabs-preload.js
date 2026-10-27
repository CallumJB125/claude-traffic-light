// The Usage tab strip's bridge (redesign R7-2, chat-first preview only). Navigation only: name one tab, hear which is
// showing. Main (buddy-window/index.js) accepts only its five ids, from this document, while it is showing.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usageTabs', {
  select: (id) => ipcRenderer.send('usage-tabs:select', typeof id === 'string' ? id : ''),
  onState: (cb) => ipcRenderer.on('usage-tabs:state', (_e, s) => cb({ selected: typeof s?.selected === 'string' ? s.selected : null })),
});
