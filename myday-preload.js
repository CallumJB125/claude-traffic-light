'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('myDayApi', {
  state: () => ipcRenderer.invoke('myday:state'),
  showMeetings: () => ipcRenderer.invoke('myday:show-meetings'),
  open: handle => ipcRenderer.invoke('myday:open', handle),
  changed: cb => ipcRenderer.on('myday:changed', () => cb()),
});
