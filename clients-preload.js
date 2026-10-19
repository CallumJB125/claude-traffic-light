'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('clientsApi', {
  state: () => ipcRenderer.invoke('clients:state'),
  save: (store) => ipcRenderer.invoke('clients:save', store),
  folders: () => ipcRenderer.invoke('clients:folders'),
  pickFolder: () => ipcRenderer.invoke('clients:pick-folder'),
  preview: (req) => ipcRenderer.invoke('clients:preview', req),
  export: (req, format) => ipcRenderer.invoke('clients:export', req, format),
});
