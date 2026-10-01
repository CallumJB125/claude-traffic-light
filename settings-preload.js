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
  busyStatus: () => ipcRenderer.invoke('busy-status'),
  busyOpenPrivacy: () => ipcRenderer.invoke('busy-open-privacy'),
  busyReconnectCalendar: () => ipcRenderer.invoke('busy-reconnect-calendar'),
  voiceStatus: () => ipcRenderer.invoke('voice-status'),
  privacyText: () => ipcRenderer.invoke('get-privacy'),
  exportStats: (format, days) => ipcRenderer.invoke('export-stats', format, days),
  exportSetup: () => ipcRenderer.invoke('setup-export'),
  showDataFolder: () => ipcRenderer.invoke('show-data-folder'),
  remoteDevices: () => ipcRenderer.invoke('remote-devices'),
  remotePair: (name) => ipcRenderer.invoke('remote-pair', name),
  remoteRevoke: (id) => ipcRenderer.invoke('remote-revoke', id),
  remoteCopyCode: (code) => ipcRenderer.invoke('remote-copy-code', code),
  health: () => ipcRenderer.invoke('health-report'),
  healthFix: (id) => ipcRenderer.invoke('health-fix', id),
  copyDiagnostics: () => ipcRenderer.invoke('health-copy-diagnostics'),
  backupsList: () => ipcRenderer.invoke('backups-list'),
  backupsNow: () => ipcRenderer.invoke('backups-now'),
  backupsDiff: (id) => ipcRenderer.invoke('backups-diff', id),
  backupsRestore: (id, pick) => ipcRenderer.invoke('backups-restore', id, pick),
  backupsOpenFolder: () => ipcRenderer.invoke('backups-open-folder'),
  accountView: () => ipcRenderer.invoke('account-view'),
  accountOpen: (which) => ipcRenderer.invoke('account-open', which),
  onAccountChanged: (cb) => ipcRenderer.on('account-changed', () => cb()),
  onShowSection: (cb) => ipcRenderer.on('show-section', (e, id) => cb(id)),
});
