// Thread page bridge (chat-first preview, redesign R2a). Read-only: the page
// reads the one row main opened it for and can ask for two navigation effects.
// Every call names that row; main refuses any other (src/thread-main.js guard T).
// Nothing that acts on a chat (approve, answer, send, stop) is here.
const { contextBridge, ipcRenderer } = require('electron');

const ROW_ID = /^[0-9a-f]{64}$/;
const id = (v) => (typeof v === 'string' && ROW_ID.test(v) ? v : '');

contextBridge.exposeInMainWorld('threadApi', {
  open: (row) => ipcRenderer.invoke('thread:open', id(row)),
  state: (row) => ipcRenderer.invoke('thread:state', id(row)),
  close: (row) => ipcRenderer.invoke('thread:close', id(row)),
  openInTasks: (row) => ipcRenderer.invoke('thread:open-in-tasks', id(row)),
  goToTerminal: (row) => ipcRenderer.invoke('thread:go-to-terminal', id(row)),
  // Main's own pushes. The row id arrives with readiness; listeners only.
  onReady: (cb) => ipcRenderer.on('thread:ready', (_e, m) => cb(id(m?.id))),
  onEvent: (cb) => ipcRenderer.on('thread:event', (_e, m) => cb(m && typeof m === 'object' ? { id: id(m.id), event: m.event } : null)),
  // Copy link (provisional deep-link form, awaiting Callum): plexiform://thread/<id>.
  copyLink: (row) => ipcRenderer.invoke('thread:copy-link', id(row)),
  // Back to Board from an ended chat.
  board: () => ipcRenderer.send('thread:board'),
});
