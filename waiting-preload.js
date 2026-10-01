// "Waiting on you" page bridge: read the waiting inputs, answer one by
// option id (main rebuilds the answer from the request), jump to its
// terminal, and open the rules editor prefilled. Nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('waitingApi', {
  getInputs: () => ipcRenderer.invoke('get-inputs'),
  answerInput: (id, optionId, more) => ipcRenderer.invoke('answer-input', id, optionId, more),
  openInput: (id) => ipcRenderer.invoke('open-input', id),
  copyInputCommand: (id) => ipcRenderer.invoke('copy-input-command', id),
  openAutoRule: (from) => ipcRenderer.invoke('open-auto-rule', from),
  nudgeMute: (key) => ipcRenderer.invoke('nudge-mute', key),
  setSessionScope: (sessionId, mode) => ipcRenderer.invoke('set-session-scope', sessionId, mode),
  setRepoScope: (canonicalUrl, mode) => ipcRenderer.invoke('set-repo-scope', canonicalUrl, mode),
  onStatusChanged: (cb) => ipcRenderer.on('status-changed', () => cb()),
});
