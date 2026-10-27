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
  // R8-3b-2: only the Settings sheet's document is answered (settings:go-pane / settings:shown); inert on the Phone page
  goPane: pane => ipcRenderer.send('settings:go-pane', typeof pane === 'string' ? pane : ''),
  onShown: cb => ipcRenderer.on('settings:shown', () => cb()),
});
