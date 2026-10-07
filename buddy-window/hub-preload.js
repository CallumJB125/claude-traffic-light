'use strict';
// The board page's one read-only question to this app: the local handover for a card. The answer
// is decided in main (src/handover-share.js rowsForHub); the page can only ask, and gets text or null.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('plexiformDesktop', Object.freeze({
  localHandover: (cardId) => ipcRenderer.invoke('buddy:local-handover', String(cardId).slice(0, 100)),
}));
