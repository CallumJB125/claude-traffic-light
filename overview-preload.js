'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const denied = () => Promise.resolve({ ok: false, status: 'invalid', error: 'Request unavailable.' });
contextBridge.exposeInMainWorld('overviewApi', {
  state: () => ipcRenderer.invoke('overview:state'),
  onReady: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, ...args) => { if (args.length === 0) callback(); };
    ipcRenderer.on('overview:ready', listener);
    return () => ipcRenderer.removeListener('overview:ready', listener);
  },
  open: request => closed(request, ['handle']) && uuid(request.handle) ? ipcRenderer.invoke('overview:open', { handle: request.handle }) : denied(),
  message: request => {
    if (!closed(request, ['handle', 'text']) || !uuid(request.handle) || typeof request.text !== 'string' || request.text.includes('\0')) return denied();
    const text = request.text.trim();
    return text && text.length <= 4000 && Buffer.byteLength(text, 'utf8') <= 8192 ? ipcRenderer.invoke('overview:message', { handle: request.handle, text }) : denied();
  },
});
