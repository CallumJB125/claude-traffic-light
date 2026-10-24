'use strict';
// Find agents page bridge (src/agents-find-main.js). The page names only an
// agent id, the catalogue sha it was shown, platform ids and an undo id. Each
// platform item is rebuilt here, never passed through as the page's object.
const { contextBridge, ipcRenderer } = require('electron');

const id = (x) => String(x ?? '').slice(0, 200);
const platform = (x) => (x && typeof x === 'object' ? { platform: String(x.platform).slice(0, 40), alt: x.alt === true } : String(x).slice(0, 40));

contextBridge.exposeInMainWorld('agentsApi', {
  list: () => ipcRenderer.invoke('agents:list'),
  detail: (agentId) => ipcRenderer.invoke('agents:detail', id(agentId)),
  targets: (agentId) => ipcRenderer.invoke('agents:targets', id(agentId)),
  status: () => ipcRenderer.invoke('agents:status'),
  add: (agentId, catalogSha, platforms) => ipcRenderer.invoke('agents:add', id(agentId), String(catalogSha ?? '').slice(0, 64), Array.isArray(platforms) ? platforms.slice(0, 16).map(platform) : []),
  undo: (opId) => ipcRenderer.invoke('agents:undo', String(opId ?? '').slice(0, 36)),
  addToProject: (agentId, catalogSha) => ipcRenderer.invoke('agents:add-to-project', id(agentId), String(catalogSha ?? '').slice(0, 64)),
  undoProject: (opId) => ipcRenderer.invoke('agents:undo-project', String(opId ?? '').slice(0, 36)),
  openTools: () => ipcRenderer.invoke('agents:open-tools'),
  // PR 4: manage what's added. The page names only file names, agent ids,
  // undo ids and backup ids; main works out every path and asks first.
  mine: () => ipcRenderer.invoke('agents:mine'),
  adoptable: () => ipcRenderer.invoke('agents:adoptable'),
  adopt: (names) => ipcRenderer.invoke('agents:adopt', Array.isArray(names) ? names.slice(0, 400).map((n) => String(n ?? '').slice(0, 128)) : []),
  stopManaging: () => ipcRenderer.invoke('agents:stop-managing'),
  update: (agentId, catalogSha) => ipcRenderer.invoke('agents:update', id(agentId), String(catalogSha ?? '').slice(0, 64)),
  remove: (agentId) => ipcRenderer.invoke('agents:remove', id(agentId)),
  undoOp: (opId) => ipcRenderer.invoke('agents:undo-op', String(opId ?? '').slice(0, 36)),
  undoProjectOp: (opId) => ipcRenderer.invoke('agents:undo-project-op', String(opId ?? '').slice(0, 36)),
  showBackup: (backupId) => ipcRenderer.invoke('agents:show-backup', String(backupId ?? '').slice(0, 64)),
  backupPlan: (backupId) => ipcRenderer.invoke('agents:backup-plan', String(backupId ?? '').slice(0, 64)),
  // Health's "Review on Find agents": only the literal 'mine' gets through.
  onShow: (fn) => { if (typeof fn === 'function') ipcRenderer.on('agents:show', (_e, v) => { if (v === 'mine') fn('mine'); }); },
});
