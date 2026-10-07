'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sessionsApi', {
  state: () => ipcRenderer.invoke('sessions:state'),
  settings: () => ipcRenderer.invoke('sessions:settings'),
  handover: (action, key) => ipcRenderer.invoke('sessions:handover', action, key),
  burstShare: (repo, on) => ipcRenderer.invoke('burst:handover-share', repo, on),
});
