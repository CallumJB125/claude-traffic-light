'use strict';
// Home page bridge: one read, page navigation by id, and opening one of your
// cards by the opaque handle main gave out. Main decides what each means.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('homeApi', {
  state: () => ipcRenderer.invoke('home:state'),
  navigate: (destination) => (typeof destination === 'string' && /^[a-z]{2,12}(?::[a-z]{2,12})?$/.test(destination) ? ipcRenderer.invoke('home:navigate', destination) : Promise.resolve(false)),
  morningSeen: () => ipcRenderer.invoke('home:morning-seen'),
  openCard: (handle) => (typeof handle === 'string' && handle.length <= 100 ? ipcRenderer.invoke('home:open-card', handle) : Promise.resolve(false)),
  digest: {
    get: (period) => ipcRenderer.invoke('digest:get', period === 'week' ? 'week' : 'day'),
    copy: (period, as) => ipcRenderer.invoke('digest:copy', period === 'week' ? 'week' : 'day', as === 'markdown' ? 'markdown' : 'text'),
    save: (period) => ipcRenderer.invoke('digest:save', period === 'week' ? 'week' : 'day'),
    email: (period) => ipcRenderer.invoke('digest:email', period === 'week' ? 'week' : 'day'),
    saveWebhook: (url) => (typeof url === 'string' && url.length <= 400 ? ipcRenderer.invoke('digest:webhook-save', url) : Promise.resolve({ ok: false, error: 'Paste the Slack webhook link.' })),
    removeWebhook: () => ipcRenderer.invoke('digest:webhook-remove'),
    test: () => ipcRenderer.invoke('digest:test'),
    preview: () => ipcRenderer.invoke('digest:preview'),
    set: (patch) => ipcRenderer.invoke('digest:set', patch && typeof patch === 'object' ? { period: patch.period, time: patch.time, slack: patch.slack, notify: patch.notify } : {}),
  },
});
