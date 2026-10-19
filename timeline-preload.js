'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('timelineApi', {
  list: () => ipcRenderer.invoke('timeline:list'),
  load: key => ipcRenderer.invoke('timeline:load', key),
  preview: (key, includePrompts) => ipcRenderer.invoke('timeline:preview', key, includePrompts),
  save: (key, includePrompts) => ipcRenderer.invoke('timeline:export', key, includePrompts),
  share: (key) => ipcRenderer.invoke('timeline:share-summary', key),
  canShare: () => ipcRenderer.invoke('timeline:share-available'),
  changed: cb => ipcRenderer.on('timeline:changed', () => cb()),
});
