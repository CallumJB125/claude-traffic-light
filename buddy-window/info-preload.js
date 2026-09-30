// Info page bridge: only "try again" for a board that failed to start.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buddyInfo', { retry: () => ipcRenderer.send('buddy:retry') });
