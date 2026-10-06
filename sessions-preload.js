'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sessionsApi', {
  state: () => ipcRenderer.invoke('sessions:state'),
  settings: () => ipcRenderer.invoke('sessions:settings'),
  burstShare: (repo, on) => ipcRenderer.invoke('burst:handover-share', repo, on),
});
