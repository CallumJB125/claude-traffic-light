'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('checkpointsApi', {
  state: () => ipcRenderer.invoke('checkpoints:state'),
  set: patch => ipcRenderer.invoke('checkpoints:set', patch),
  turns: id => ipcRenderer.invoke('checkpoints:turns', id),
  diff: (id, turn, file) => ipcRenderer.invoke('checkpoints:diff', id, turn, file),
  restore: (id, target) => ipcRenderer.invoke('checkpoints:restore', id, target),
  changed: cb => ipcRenderer.on('checkpoints:changed', () => cb()),
});
