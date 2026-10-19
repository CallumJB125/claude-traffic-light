'use strict';
// Home page bridge: one read, page navigation by id, and opening one of your
// cards by the opaque handle main gave out. Main decides what each means.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('homeApi', {
  state: () => ipcRenderer.invoke('home:state'),
  navigate: (destination) => (typeof destination === 'string' && /^[a-z]{2,12}(?::[a-z]{2,12})?$/.test(destination) ? ipcRenderer.invoke('home:navigate', destination) : Promise.resolve(false)),
  morningSeen: () => ipcRenderer.invoke('home:morning-seen'),
  resumeCap: () => ipcRenderer.invoke('home:resume-cap'),
  alerts: () => ipcRenderer.invoke('home:alerts'),
  alertAct: (kind, action, handle) => (['stuck', 'limit', 'mail', 'waiting', 'burst'].includes(kind) && ['open', 'handoff', 'dismiss', 'resume', 'act'].includes(action) && typeof handle === 'string' && handle.length <= 100 ? ipcRenderer.invoke('home:alert', kind, action, handle) : Promise.resolve({ ok: false })),
  deploys: () => ipcRenderer.invoke('home:deploys'),
  deployAct: (action, handle) => (['copy-prompt', 'open'].includes(action) && typeof handle === 'string' && handle.length <= 200 ? ipcRenderer.invoke('home:deploy-act', action, handle) : Promise.resolve({ ok: false })),
  teamToday: () => ipcRenderer.invoke('home:team-today'),
  teamTodaySeen: () => ipcRenderer.invoke('home:team-today-seen'),
  teamTodayRefresh: () => ipcRenderer.invoke('home:team-today-refresh'),
  starter: () => ipcRenderer.invoke('home:starter'),
  starterAct: (action) => (['look', 'add', 'run', 'dismiss'].includes(action) ? ipcRenderer.invoke('home:starter-act', action) : Promise.resolve({ ok: false })),
  teamInbox: () => ipcRenderer.invoke('home:team-inbox'),
  inboxRead: (keys) => (Array.isArray(keys) && keys.length <= 50 && keys.every((k) => typeof k === 'string' && k.length <= 300) ? ipcRenderer.invoke('home:inbox-read', keys) : Promise.resolve({ ok: false, error: 'invalid' })),
  answerInput: (id, optionId) => (typeof id === 'string' && id.length <= 100 && typeof optionId === 'string' && optionId.length <= 100 ? ipcRenderer.invoke('home:answer-input', id, optionId) : Promise.resolve({ ok: false, error: 'invalid' })),
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
contextBridge.exposeInMainWorld('demoApi', {
  state: () => ipcRenderer.invoke('demo:state'),
  start: () => ipcRenderer.invoke('demo:start'),
  exit: () => ipcRenderer.invoke('demo:exit'),
});

// First-run tour (src/first-run-tour-main.js): main pushes the step; the page answers Next / Skip / missing.
contextBridge.exposeInMainWorld('tourApi', { onStep: (cb) => ipcRenderer.on('tour:step', (e, step) => cb(step)), action: (kind, id) => ipcRenderer.invoke('tour:action', String(kind), String(id)) });
