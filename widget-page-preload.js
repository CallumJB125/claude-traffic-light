// Widget page: fixed channels only. Main checks every value and owns the widget's window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetPageApi', {
  state: () => ipcRenderer.invoke('widget-page:state'),
  preview: () => ipcRenderer.invoke('widget-page:preview'),
  set: (patch) => ipcRenderer.invoke('widget-page:set', patch && typeof patch === 'object' ? patch : {}),
  size: (width) => ipcRenderer.invoke('widget-page:size', Number(width)),
  move: (corner) => ipcRenderer.invoke('widget-page:move', String(corner)),
  open: (id) => ipcRenderer.invoke('widget-page:open', String(id)),
});
