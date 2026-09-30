const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  // main answers a failed save with {error}; surface it as a rejection so no caller stores it as the config
  saveConfig: async (partial) => {
    const r = await ipcRenderer.invoke('save-config', partial);
    if (r && r.error) throw new Error(r.error);
    return r;
  },
  connectAgent: (which) => ipcRenderer.invoke('connect-agent', which),
  signalEndpoint: () => ipcRenderer.invoke('signal-endpoint'),
  mcpStatus: () => ipcRenderer.invoke('mcp-status'),
  mcpSetEnabled: (on) => ipcRenderer.invoke('mcp-set-enabled', on),
  gitStatus: () => ipcRenderer.invoke('git-status'),
  spend: () => ipcRenderer.invoke('get-spend'),
  voiceStatus: () => ipcRenderer.invoke('voice-status'),
});
