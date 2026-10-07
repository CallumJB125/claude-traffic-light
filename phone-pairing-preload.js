'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('phonePairing', {
  state: () => ipcRenderer.invoke('phone:state'),
  set: patch => ipcRenderer.invoke('phone:set', patch),
  start: () => ipcRenderer.invoke('phone:pair-start'),
  confirm: (pid, code) => ipcRenderer.invoke('phone:pair-confirm', pid, code),
  cancel: () => ipcRenderer.invoke('phone:pair-cancel'),
  revoke: deviceId => ipcRenderer.invoke('phone:revoke', deviceId),
  upgrade: () => ipcRenderer.invoke('phone:upgrade'),
  changed: cb => ipcRenderer.on('phone:changed', () => cb()),
});
