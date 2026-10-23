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
});
