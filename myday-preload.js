'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('myDayApi', {
  state: () => ipcRenderer.invoke('myday:state'),
  open: handle => ipcRenderer.invoke('myday:open', handle),
  changed: cb => ipcRenderer.on('myday:changed', () => cb()),
});
