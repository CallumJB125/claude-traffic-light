const { contextBridge, ipcRenderer } = require('electron');

// No network from the page: everything goes through main, which checks the sender.
contextBridge.exposeInMainWorld('feedbackApi', {
  info: () => ipcRenderer.invoke('feedback-info'),
  screenshot: (id) => ipcRenderer.invoke('feedback-screenshot', id),
  clearScreenshot: () => ipcRenderer.invoke('feedback-clear-screenshot'),
  preview: (draft) => ipcRenderer.invoke('feedback-preview', draft),
  save: (draft) => ipcRenderer.invoke('feedback-save', draft),
  showReport: () => ipcRenderer.invoke('feedback-show'),
  copyReport: () => ipcRenderer.invoke('feedback-copy'),
  openGithub: () => ipcRenderer.invoke('feedback-github'),
});
