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
  // My sessions / Team sessions. Main filters team visibility; the team key is opaque.
  directory: request => {
    if (closed(request, ['view']) && request.view === 'mine') return ipcRenderer.invoke('overview:directory', { view: 'mine' });
    if (closed(request, ['view', 'team']) && request.view === 'team' && (request.team === null || typeof request.team === 'string' && /^[0-9a-f]{32}$/.test(request.team))) return ipcRenderer.invoke('overview:directory', { view: 'team', team: request.team });
    return Promise.resolve(null);
  },
  teamMessage: request => {
    if (!closed(request, ['id', 'text']) || typeof request.id !== 'string' || !/^[0-9a-f]{40}$/.test(request.id)) return denied();
    const text = messageText(request.text);
    return text === null ? denied() : ipcRenderer.invoke('overview:team-message', { id: request.id, text });
  },
  onDirectoryChanged: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, ...args) => { if (args.length === 0) callback(); };
    ipcRenderer.on('overview:directory-changed', listener);
    return () => ipcRenderer.removeListener('overview:directory-changed', listener);
  },
  // Sessions Plexiform itself started. The board and the owning document are
  // decided in main; requests here carry only primitive, closed fields.
  interaction: {
    capabilities: () => ipcRenderer.invoke('interaction:capabilities'),
    channelSetup: () => ipcRenderer.invoke('interaction:channel-setup'),
    list: () => ipcRenderer.invoke('interaction:list'),
    state: request => closed(request, ['session']) && uuid(request.session) ? ipcRenderer.invoke('interaction:state', { session: request.session }) : Promise.resolve(null),
    // Any listed provider id (codex, claude, gemini, local-<endpoint>-<hash>); main decides if it exists.
    launch: request => closed(request, ['provider']) && typeof request.provider === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(request.provider) ? ipcRenderer.invoke('interaction:launch', { provider: request.provider }) : denied(),
    // Existing sessions on an opt-in provider: a metadata list (opaque handles), then attach one by handle.
    discover: request => closed(request, ['provider']) && typeof request.provider === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(request.provider) ? ipcRenderer.invoke('interaction:discover', { provider: request.provider }) : denied(),
    attach: request => closed(request, ['provider', 'handle']) && typeof request.provider === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(request.provider) && uuid(request.handle) ? ipcRenderer.invoke('interaction:attach', { provider: request.provider, handle: request.handle }) : denied(),
    send: request => {
      const steer = closed(request, ['session', 'generation', 'text', 'expectedTurn']);
      if (!steer && !closed(request, ['session', 'generation', 'text'])) return denied();
      const text = messageText(request.text);
      if (!uuid(request.session) || !generation(request.generation) || text === null || steer && !uuid(request.expectedTurn)) return denied();
      return ipcRenderer.invoke('interaction:send', steer ? { session: request.session, generation: request.generation, text, expectedTurn: request.expectedTurn } : { session: request.session, generation: request.generation, text });
    },
    interrupt: request => closed(request, ['session', 'generation', 'turn']) && uuid(request.session) && generation(request.generation) && uuid(request.turn) ? ipcRenderer.invoke('interaction:interrupt', { session: request.session, generation: request.generation, turn: request.turn }) : denied(),
    close: request => closed(request, ['session', 'generation']) && uuid(request.session) && generation(request.generation) ? ipcRenderer.invoke('interaction:close', { session: request.session, generation: request.generation }) : denied(),
    localModels: () => ipcRenderer.invoke('interaction:local-models'),
    // Ask all: one message to up to 6 distinct owned sessions; main sends each through the per-session guards.
    fanout: request => {
      if (!closed(request, ['sessions', 'text']) || !Array.isArray(request.sessions) || request.sessions.length < 1 || request.sessions.length > 6) return denied();
      const sessions = request.sessions.map(t => closed(t, ['session', 'generation']) && uuid(t.session) && generation(t.generation) ? { session: t.session, generation: t.generation } : null);
      const text = messageText(request.text);
      if (text === null || sessions.includes(null) || new Set(sessions.map(t => t.session)).size !== sessions.length) return denied();
      return ipcRenderer.invoke('interaction:fanout', { sessions, text });
    },
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
