'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const denied = () => Promise.resolve({ ok: false, status: 'invalid', error: 'Request unavailable.' });
const generation = value => Number.isSafeInteger(value) && value >= 0;
const messageText = text => {
  if (typeof text !== 'string' || text.includes('\0')) return null;
  const trimmed = text.trim();
  return trimmed && trimmed.length <= 4000 && Buffer.byteLength(trimmed, 'utf8') <= 8192 ? trimmed : null;
};
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
  // Sessions Plexiform itself started. The board and the owning document are
  // decided in main; requests here carry only primitive, closed fields.
  interaction: {
    capabilities: () => ipcRenderer.invoke('interaction:capabilities'),
    list: () => ipcRenderer.invoke('interaction:list'),
    state: request => closed(request, ['session']) && uuid(request.session) ? ipcRenderer.invoke('interaction:state', { session: request.session }) : Promise.resolve(null),
    launch: request => closed(request, ['provider']) && request.provider === 'codex' ? ipcRenderer.invoke('interaction:launch', { provider: 'codex' }) : denied(),
    send: request => {
      const steer = closed(request, ['session', 'generation', 'text', 'expectedTurn']);
      if (!steer && !closed(request, ['session', 'generation', 'text'])) return denied();
      const text = messageText(request.text);
      if (!uuid(request.session) || !generation(request.generation) || text === null || steer && !uuid(request.expectedTurn)) return denied();
      return ipcRenderer.invoke('interaction:send', steer ? { session: request.session, generation: request.generation, text, expectedTurn: request.expectedTurn } : { session: request.session, generation: request.generation, text });
    },
    interrupt: request => closed(request, ['session', 'generation', 'turn']) && uuid(request.session) && generation(request.generation) && uuid(request.turn) ? ipcRenderer.invoke('interaction:interrupt', { session: request.session, generation: request.generation, turn: request.turn }) : denied(),
    close: request => closed(request, ['session', 'generation']) && uuid(request.session) && generation(request.generation) ? ipcRenderer.invoke('interaction:close', { session: request.session, generation: request.generation }) : denied(),
    // Team sharing of one of this page's sessions (watch, or interact = also send/steer/interrupt).
    shareList: () => ipcRenderer.invoke('interaction:share-list'),
    shareCreate: request => {
      if (!closed(request, ['session', 'team', 'scope', 'expiresInS']) || !uuid(request.session) || typeof request.team !== 'string' || !request.team || request.team.length > 100
        || !['watch', 'interact'].includes(request.scope) || (request.expiresInS !== null && !(Number.isSafeInteger(request.expiresInS) && request.expiresInS >= 60 && request.expiresInS <= 30 * 86400))) return denied();
      return ipcRenderer.invoke('interaction:share-create', { session: request.session, team: request.team, scope: request.scope, expiresInS: request.expiresInS });
    },
    shareStop: request => closed(request, ['share']) && typeof request.share === 'string' && request.share.length <= 100 ? ipcRenderer.invoke('interaction:share-stop', { share: request.share }) : denied(),
    onEvent: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, ...args) => { if (args.length === 1 && args[0] !== null && typeof args[0] === 'object') callback(args[0]); };
      ipcRenderer.on('interaction:event', listener);
      return () => ipcRenderer.removeListener('interaction:event', listener);
    },
  },
});
