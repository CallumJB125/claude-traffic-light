'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, value) => ipcRenderer.invoke(`terminal:${name}`, value);
const subscribe = (name, callback) => {
  if (typeof callback !== 'function') throw new TypeError('A callback is required');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(`terminal:${name}`, listener);
  return () => ipcRenderer.removeListener(`terminal:${name}`, listener);
};
contextBridge.exposeInMainWorld('terminal', Object.freeze({
  ready: () => invoke('ready'),
  spawn: value => invoke('spawn', value),
  select: sessionId => invoke('select', sessionId),
  write: value => invoke('write', value),
  resize: value => invoke('resize', value),
  detach: sessionId => invoke('detach', { sessionId }),
  stop: sessionId => invoke('stop', { sessionId }),
  reconnect: () => invoke('reconnect'),
  onData: callback => subscribe('data', callback),
  onState: callback => subscribe('state', callback),
  onNotice: callback => subscribe('notice', callback),
}));
