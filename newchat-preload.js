// New-chat page bridge (chat-first preview, redesign R2b-2). The same box as
// Home's: folder handles and fixed shapes only; main (src/newchat-main.js)
// resolves and checks everything. create is the only call that starts
// anything, and the page sends it only for Send or ⌘↩. No stop, no approve,
// deny or answer, and no task card: one push, newchat:changed.
const { contextBridge, ipcRenderer } = require('electron');

const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const RUN_KEYS = ['text', 'folder', 'ai', 'permissionLevel', 'expectAi', 'requestId', 'peersKey', 'overrideBudget'];

contextBridge.exposeInMainWorld('newChatApi', {
  info: () => ipcRenderer.invoke('newchat:info'),
  pickFolder: () => ipcRenderer.invoke('newchat:pick-folder'),
  route: (req) => { const r = plain(req); return ipcRenderer.invoke('newchat:route', { text: r.text, folder: r.folder, ai: r.ai, permissionLevel: r.permissionLevel }); },
  preflight: (folder) => ipcRenderer.invoke('newchat:preflight', { folder: typeof folder === 'string' ? folder : '' }),
  create: (draft) => { const d = plain(draft); const out = {}; for (const k of RUN_KEYS) if (d[k] !== undefined) out[k] = d[k]; return ipcRenderer.invoke('newchat:create', out); },
  openInTasks: (id) => ipcRenderer.invoke('newchat:open-in-tasks', String(id)),
  onChanged: (cb) => ipcRenderer.on('newchat:changed', () => cb()),
});
