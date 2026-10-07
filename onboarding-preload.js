'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('onboardingApi', {
  state: () => ipcRenderer.invoke('onboarding:state'),
  preview: (id) => ipcRenderer.invoke('onboarding:preview', id),
  connect: (ids) => ipcRenderer.invoke('onboarding:connect', ids),
  undo: (id) => ipcRenderer.invoke('onboarding:undo', id),
  setLoginItem: (on) => ipcRenderer.invoke('onboarding:login-item', on),
  setDailyBudget: (dollars) => ipcRenderer.invoke('onboarding:budget', dollars),
  navigate: (destination) => ipcRenderer.invoke('onboarding:navigate', destination),
  onStatusChanged: (cb) => ipcRenderer.on('status-changed', () => cb()),
});
