// Info page bridge: "try again" for a board that failed, and the team hub
// connect form. Main validates everything.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buddyInfo', {
  retry: () => ipcRenderer.send('buddy:retry'),
  connect: (url, name) => ipcRenderer.invoke('buddy:connect', { url: String(url ?? ''), name: String(name ?? '') }),
});
