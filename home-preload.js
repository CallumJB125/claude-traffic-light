'use strict';
// Home page bridge: one read, page navigation by id, and opening one of your
// cards by the opaque handle main gave out. Main decides what each means.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('homeApi', {
  state: () => ipcRenderer.invoke('home:state'),
  navigate: (destination) => (typeof destination === 'string' && /^[a-z]{2,12}(?::[a-z]{2,12})?$/.test(destination) ? ipcRenderer.invoke('home:navigate', destination) : Promise.resolve(false)),
  morningSeen: () => ipcRenderer.invoke('home:morning-seen'),
  openCard: (handle) => (typeof handle === 'string' && handle.length <= 100 ? ipcRenderer.invoke('home:open-card', handle) : Promise.resolve(false)),
});
