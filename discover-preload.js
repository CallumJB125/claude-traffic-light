// Discover page bridge: the community gallery (src/gallery.js). Main fetches
// and verifies the list; the page only ever names an entry id and the sha256
// it was shown, or a kind and local id to remove. Nothing else is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('galleryApi', {
  refresh: () => ipcRenderer.invoke('gallery:fetch'),
  cached: () => ipcRenderer.invoke('gallery:cached'),
  add: (id, sha) => ipcRenderer.invoke('gallery:add', String(id), String(sha)),
  addPack: (id, sha) => ipcRenderer.invoke('gallery:add-pack', String(id), String(sha)),
  installed: () => ipcRenderer.invoke('gallery:installed'),
  remove: (kind, id) => ipcRenderer.invoke('gallery:remove', String(kind), String(id)),
});
// The vibe-coder loop (src/build-log-main.js): session keys, item ids, review edits and digests only.
contextBridge.exposeInMainWorld('vibeApi', {
  catalog: (team) => ipcRenderer.invoke('vibe:catalog', team == null ? null : String(team)),
  install: (id, sha, kind) => ipcRenderer.invoke('vibe:install', String(id), String(sha), String(kind)),
  report: (id) => ipcRenderer.invoke('vibe:report', String(id)),
  sessions: () => ipcRenderer.invoke('vibe:sessions'),
  draft: (keys, opts) => ipcRenderer.invoke('vibe:draft', Array.isArray(keys) ? keys.map(String) : [], { kit: !!(opts && opts.kit) }),
  review: (r) => ipcRenderer.invoke('vibe:review', r),
  kitFromFolder: () => ipcRenderer.invoke('vibe:kit-from-folder'),
  exportHtml: (digest) => ipcRenderer.invoke('vibe:export', String(digest)),
  teams: () => ipcRenderer.invoke('vibe:teams'),
  publish: (digest, team) => ipcRenderer.invoke('vibe:publish', String(digest), String(team)),
  published: (team) => ipcRenderer.invoke('vibe:published', String(team)),
  unpublish: (team, id) => ipcRenderer.invoke('vibe:unpublish', String(team), String(id)),
  remixPreview: (link) => ipcRenderer.invoke('vibe:remix-preview', String(link)),
  remixInstall: () => ipcRenderer.invoke('vibe:remix-install'),
  reportLink: (link, reason) => ipcRenderer.invoke('vibe:report-link', String(link), String(reason || '')),
});
// Opens the Find agents page; takes nothing.
contextBridge.exposeInMainWorld('findAgentsApi', {
  open: () => ipcRenderer.invoke('discover:open-find-agents'),
});
contextBridge.exposeInMainWorld('demoApi', {
  state: () => ipcRenderer.invoke('demo:state'),
  exit: () => ipcRenderer.invoke('demo:exit'),
});
