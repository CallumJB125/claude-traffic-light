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
contextBridge.exposeInMainWorld('recipesApi', {
  list: () => ipcRenderer.invoke('recipes:list'),
  run: (id, folder, when) => ipcRenderer.invoke('recipes:run', String(id), String(folder), when === 'tonight' ? 'tonight' : 'now'),
  saveMine: (id) => ipcRenderer.invoke('recipes:save-mine', String(id)),
  deleteMine: (id) => ipcRenderer.invoke('recipes:delete-mine', String(id)),
  exportMine: () => ipcRenderer.invoke('recipes:export'),
  importFile: () => ipcRenderer.invoke('recipes:import'),
  schedule: (id, schedule, folder) => ipcRenderer.invoke('recipes:schedule', String(id), schedule, folder == null ? null : String(folder)),
  keepAndSchedule: (draft, schedule, folder) => ipcRenderer.invoke('recipes:keep-and-schedule', draft, schedule, String(folder)),
  pauseSchedule: (id, on) => ipcRenderer.invoke('recipes:schedule-pause', String(id), on === true),
  skipNext: (id) => ipcRenderer.invoke('recipes:schedule-skip', String(id)),
  onSchedulesChanged: (fn) => { ipcRenderer.on('recipes:schedules-changed', () => fn()); },
  pickFolder: () => ipcRenderer.invoke('tasks:pick-folder'),
});
// The community gallery: main fetches and verifies; the page names an entry id and its sha256.
contextBridge.exposeInMainWorld('galleryApi', {
  refresh: () => ipcRenderer.invoke('gallery:fetch'),
  cached: () => ipcRenderer.invoke('gallery:cached'),
  add: (id, sha) => ipcRenderer.invoke('gallery:add', String(id), String(sha)),
});
contextBridge.exposeInMainWorld('demoApi', {
  state: () => ipcRenderer.invoke('demo:state'),
  exit: () => ipcRenderer.invoke('demo:exit'),
});
