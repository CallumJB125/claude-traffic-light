// Tasks page bridge. The page asks main for sanitised tasks and sends small
// validated requests back; it never sees the supervisor's socket or token, and
// a folder is only ever an opaque handle main gave it. Nothing else is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tasksApi', {
  state: () => ipcRenderer.invoke('tasks:state'),
  retry: () => ipcRenderer.invoke('tasks:retry'),
  open: (id) => ipcRenderer.invoke('tasks:open', id),
  close: () => ipcRenderer.invoke('tasks:close'),
  act: (req) => ipcRenderer.invoke('tasks:act', req),
  saveCheckpoint: (req) => ipcRenderer.invoke('tasks:checkpoint', req),
  create: (draft) => ipcRenderer.invoke('tasks:create', draft),
  composer: () => ipcRenderer.invoke('tasks:composer'),
  pickFolder: () => ipcRenderer.invoke('tasks:pick-folder'),
  copyTakeover: (id) => ipcRenderer.invoke('tasks:copy-takeover', id),
  onChanged: (cb) => ipcRenderer.on('tasks:changed', (_e, snap) => cb(snap)),
  onEvent: (cb) => ipcRenderer.on('tasks:event', (_e, m) => cb(m)),
});
