'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aiToolsApi', {
  scan: () => ipcRenderer.invoke('aitools:scan'),
  focus: () => ipcRenderer.invoke('aitools:focus'),
  preview: (id) => ipcRenderer.invoke('aitools:preview', id),
  connect: (id) => ipcRenderer.invoke('aitools:connect', id),
  connectAll: () => ipcRenderer.invoke('aitools:connect-all'),
  disconnect: (id) => ipcRenderer.invoke('aitools:disconnect', id),
  undo: (id) => ipcRenderer.invoke('aitools:undo', id),
  addCustom: (name, command) => ipcRenderer.invoke('aitools:add-custom', name, command),
  removeCustom: (name) => ipcRenderer.invoke('aitools:remove-custom', name),
  fixRunner: () => ipcRenderer.invoke('aitools:fix-runner'),
  copy: (text) => ipcRenderer.invoke('aitools:copy', text),
  openInstall: (id) => ipcRenderer.invoke('aitools:open-install', id),
  mcpStatus: () => ipcRenderer.invoke('mcp-status'),
  mcpSetEnabled: (on) => ipcRenderer.invoke('mcp-set-enabled', on),
  burstCodex: () => ipcRenderer.invoke('burst:codex-routing'),
  burstAction: (id) => ipcRenderer.invoke('burst-action', id, {}),
  onChanged: (cb) => ipcRenderer.on('status-changed', () => cb()),
  // R8-3b-2: only the Settings sheet's document is answered (settings:go-pane / settings:shown); inert on the AI tools page
  goPane: (pane) => ipcRenderer.send('settings:go-pane', typeof pane === 'string' ? pane : ''),
  onShown: (cb) => ipcRenderer.on('settings:shown', () => cb()),
});
