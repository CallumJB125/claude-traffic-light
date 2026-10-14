'use strict';
// Main resolves every card id under the current local/team sharing scope.
// The page can read a handover, request explicit local copy/save/refresh actions,
// or show the exact session's controls and timeline. Paths and provider commands
// never come from the hub page.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('plexiformDesktop', Object.freeze({
  localHandover: (cardId) => ipcRenderer.invoke('buddy:local-handover', String(cardId).slice(0, 100)),
  openTeam: () => ipcRenderer.send('buddy:open-team'),
  openTimeline: (cardId) => ipcRenderer.send('buddy:open-timeline', String(cardId).slice(0, 100)),
  continueIn: (cardId) => ipcRenderer.invoke('buddy:continue-in', String(cardId).slice(0, 100)),
  handoverAction: (cardId, action) => ['refresh', 'copy', 'save'].includes(action) ? ipcRenderer.invoke('buddy:card-session-action', action, String(cardId).slice(0, 100)) : Promise.resolve({ ok: false }),
  openSession: (cardId) => ipcRenderer.invoke('buddy:card-session-action', 'open', String(cardId).slice(0, 100)),
}));
