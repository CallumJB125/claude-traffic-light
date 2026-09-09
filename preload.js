const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trafficLight', {
  openClaude: () => ipcRenderer.invoke('open-claude'),
  goToNeedingSession: () => ipcRenderer.invoke('go-to-needing-session'),
  getAggregateStatus: () => ipcRenderer.invoke('get-aggregate-status'),
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  setWindowPosition: (x, y) => ipcRenderer.send('set-window-position', x, y),
  resizeWindowBy: (factor) => ipcRenderer.send('resize-window-by', factor),
  onStatusChanged: (callback) => ipcRenderer.on('status-changed', callback),
  openLights: () => ipcRenderer.invoke('open-lights'),
  onBurst: (cb) => ipcRenderer.on('burst', (e, ms) => cb(ms)),
  onAim: (cb) => ipcRenderer.on('aim', (e, a) => cb(a)),
  onEvent: (cb) => ipcRenderer.on('event', (e, name) => cb(name)),
  onSoundFlash: (cb) => ipcRenderer.on('sound-flash', () => cb()),
  answerRequest: (id, decision) => ipcRenderer.invoke('answer-request', id, decision),
  gesture: (g) => ipcRenderer.invoke('gesture', g),
});
