'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('checkpointsApi', {
  state: () => ipcRenderer.invoke('checkpoints:state'),
  set: patch => ipcRenderer.invoke('checkpoints:set', patch),
  turns: id => ipcRenderer.invoke('checkpoints:turns', id),
  diff: (id, turn, file) => ipcRenderer.invoke('checkpoints:diff', id, turn, file),
  restore: (id, target) => ipcRenderer.invoke('checkpoints:restore', id, target),
  previewUndo: (id, turn) => ipcRenderer.invoke('checkpoints:undo-preview', id, turn),
  undo: (id, token) => ipcRenderer.invoke('checkpoints:undo', id, token),
  cancelUndo: (id, token) => ipcRenderer.invoke('checkpoints:undo-cancel', id, token),
  changed: cb => ipcRenderer.on('checkpoints:changed', () => cb()),
});
