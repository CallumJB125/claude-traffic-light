'use strict';
// The board page's one read-only question to this app (the local handover for a card, decided in
// main by src/handover-share.js rowsForHub: text or null), and ways to show the app's Team page and
// the local timeline of the session behind a card (main resolves the card the same way).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('plexiformDesktop', Object.freeze({
  localHandover: (cardId) => ipcRenderer.invoke('buddy:local-handover', String(cardId).slice(0, 100)),
  openTeam: () => ipcRenderer.send('buddy:open-team'),
  openTimeline: (cardId) => ipcRenderer.send('buddy:open-timeline', String(cardId).slice(0, 100)),
}));
