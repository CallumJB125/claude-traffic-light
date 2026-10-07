'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sessionsApi', {
  state: () => ipcRenderer.invoke('sessions:state'),
  settings: () => ipcRenderer.invoke('sessions:settings'),
  handover: (action, key) => ipcRenderer.invoke('sessions:handover', action, key),
  setup: () => ipcRenderer.invoke('sessions:setup'),
  pickFolder: () => ipcRenderer.invoke('sessions:pick-folder'),
  linkRepo: (folder, board) => ipcRenderer.invoke('sessions:link-repo', { folder, board }),
  linkFromSession: (handle) => ipcRenderer.invoke('sessions:link-from-session', handle),
  start: (folder, ai, prompt) => ipcRenderer.invoke('sessions:start', { folder, ai, prompt }),
  makeCard: (handle, board) => ipcRenderer.invoke('sessions:make-card', handle, board),
  searchCards: (query) => ipcRenderer.invoke('sessions:search-cards', query),
  attach: (handle, ref) => ipcRenderer.invoke('sessions:attach', handle, ref),
  share: (handle, on) => ipcRenderer.invoke('sessions:share', handle, on),
  connect: () => ipcRenderer.invoke('sessions:connect'),
  burstShare: (repo, on) => ipcRenderer.invoke('burst:handover-share', repo, on),
  burstView: (name, args) => ipcRenderer.invoke('burst:view', name, args),
  burstAction: (id, args) => ipcRenderer.invoke('burst-action', id, args),
  contextBreakdown: (session) => ipcRenderer.invoke('burst:context-breakdown', session),
  messageOwned: (session, text) => ipcRenderer.invoke('sessions:message', session, text),
});
