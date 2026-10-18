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
  preflight: (req) => ipcRenderer.invoke('tasks:preflight', req),
  composer: () => ipcRenderer.invoke('tasks:composer'),
  pickFolder: () => ipcRenderer.invoke('tasks:pick-folder'),
  copyTakeover: (id) => ipcRenderer.invoke('tasks:copy-takeover', id),
  openTerminal: (id) => ipcRenderer.invoke('tasks:open-terminal', id),
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
  // A gallery recipe was added or removed on the Discover page.
  onChanged: (cb) => ipcRenderer.on('recipes:changed', () => cb()),
});
// The community gallery lives on the Discover page; this only opens it.
contextBridge.exposeInMainWorld('galleryApi', {
  openDiscover: () => ipcRenderer.invoke('gallery:open-discover'),
});
// "Share to gallery…" (src/gallery-publish.js): main builds and checks the item; the page names a kind, a ref and a draft token.
contextBridge.exposeInMainWorld('galleryPublishApi', {
  begin: (kind, ref) => ipcRenderer.invoke('gallery-publish:begin', String(kind), ref),
  draft: (kind, ref, meta) => ipcRenderer.invoke('gallery-publish:draft', String(kind), ref, meta),
  open: (token) => ipcRenderer.invoke('gallery-publish:open', String(token)),
  copy: (token) => ipcRenderer.invoke('gallery-publish:copy', String(token)),
});
contextBridge.exposeInMainWorld('demoApi', {
  state: () => ipcRenderer.invoke('demo:state'),
  exit: () => ipcRenderer.invoke('demo:exit'),
});
