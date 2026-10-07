'use strict';
// Search page bridge: the memory IPC contract and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const key = (k) => ({ tool: String(k && k.tool), sid: String(k && k.sid) });
contextBridge.exposeInMainWorld('memoryApi', {
  status: () => ipcRenderer.invoke('memory:status'),
  search: (req) => ipcRenderer.invoke('memory:search', { q: String(req.q ?? ''), tool: req.tool || null, repo: req.repo || null, from: Number.isFinite(req.from) ? req.from : null }),
  facets: () => ipcRenderer.invoke('memory:facets'),
  reindex: () => ipcRenderer.invoke('memory:reindex'),
  clear: () => ipcRenderer.invoke('memory:clear'),
  setExperimental: (on) => ipcRenderer.invoke('memory:settings', { experimental: on === true }),
  openHandover: (k) => ipcRenderer.invoke('memory:handover', 'open', key(k)),
  copyHandover: (k) => ipcRenderer.invoke('memory:handover', 'copy', key(k)),
  hand: (k, to) => ipcRenderer.invoke('memory:hand', key(k), to === 'claude' ? 'claude' : 'codex'),
  reply: (id, text) => ipcRenderer.invoke('memory:reply', String(id), String(text)),
  end: (id) => ipcRenderer.invoke('memory:end', String(id)),
  onHandoff: (cb) => ipcRenderer.on('memory:handoff-event', (_e, ev) => cb(ev)),
});
