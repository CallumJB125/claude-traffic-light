const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trafficLight', {
  openClaude: () => ipcRenderer.invoke('open-claude'),
  goToNeedingSession: () => ipcRenderer.invoke('go-to-needing-session'),
  getAggregateStatus: () => ipcRenderer.invoke('get-aggregate-status'),
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  setWindowPosition: (x, y) => ipcRenderer.send('set-window-position', x, y),
  setClickThrough: (ignore) => ipcRenderer.send('set-click-through', ignore),
  resizeWindowBy: (factor) => ipcRenderer.send('resize-window-by', factor),
  onStatusChanged: (callback) => ipcRenderer.on('status-changed', callback),
  openLights: () => ipcRenderer.invoke('open-lights'),
  openHelp: () => ipcRenderer.invoke('open-help'),
  onBurst: (cb) => ipcRenderer.on('burst', (e, ms) => cb(ms)),
  onAim: (cb) => ipcRenderer.on('aim', (e, a) => cb(a)),
  onEvent: (cb) => ipcRenderer.on('event', (e, name) => cb(name)),
  onSoundFlash: (cb) => ipcRenderer.on('sound-flash', () => cb()),
  answerRequest: (id, decision) => ipcRenderer.invoke('answer-request', id, decision),
  adviceCopy: (sessionId) => ipcRenderer.invoke('router-switch-session', sessionId),
  adviceKeep: (sessionId) => ipcRenderer.invoke('advice-keep', sessionId),
  gesture: (g) => ipcRenderer.invoke('gesture', g),
});
