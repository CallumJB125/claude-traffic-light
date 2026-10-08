'use strict';
// The board page's one read-only question to this app (the local handover for a card, decided in
// main by src/handover-share.js rowsForHub: text or null), and one way to show the app's Team page.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('plexiformDesktop', Object.freeze({
  localHandover: (cardId) => ipcRenderer.invoke('buddy:local-handover', String(cardId).slice(0, 100)),
  openTeam: () => ipcRenderer.send('buddy:open-team'),
  continueIn: (cardId) => ipcRenderer.invoke('buddy:continue-in', String(cardId).slice(0, 100)),
}));
