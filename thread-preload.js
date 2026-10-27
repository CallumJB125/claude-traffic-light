// Thread page bridge (chat-first preview, redesign R2a). The page reads the one
// row main opened it for and can ask for two navigation effects. Every call
// names that row; main refuses any other (src/thread-main.js guard T).
// R2b-1: a reply to the bound chat ({id, body}; main fixes the task and the
// action). R4-1a: thread:act, a choice on a request main showed this chat
// (approve once, deny, answer, choose, stop); main checks every key.
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
  // Reply to the bound chat. Only the two keys main accepts.
  message: (row, body) => ipcRenderer.invoke('thread:message', { id: id(row), body: typeof body === 'string' ? body : '' }),
  // A choice on a request in this chat. Only the keys main accepts, as strings or true; main refuses any other shape.
  act: (row, r) => {
    const o = r && typeof r === 'object' ? r : {}, out = { id: id(row) };
    for (const k of ['action', 'approvalId', 'scope', 'askId', 'answer', 'choiceId']) if (typeof o[k] === 'string') out[k] = o[k];
    if (o.confirmed === true) out.confirmed = true;
    return ipcRenderer.invoke('thread:act', out);
  },
  // Back to Board from an ended chat.
  board: () => ipcRenderer.send('thread:board'),
});
