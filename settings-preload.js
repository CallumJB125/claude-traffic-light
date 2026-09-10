const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (partial) => ipcRenderer.invoke('save-config', partial),
  connectAgent: (which) => ipcRenderer.invoke('connect-agent', which),
  signalEndpoint: () => ipcRenderer.invoke('signal-endpoint'),
  mcpStatus: () => ipcRenderer.invoke('mcp-status'),
  mcpSetEnabled: (on) => ipcRenderer.invoke('mcp-set-enabled', on),
});
