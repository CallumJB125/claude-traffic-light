// Info page bridge: "try again" for a board that failed. Main validates it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buddyInfo', {
  retry: () => ipcRenderer.send('buddy:retry'),
});
