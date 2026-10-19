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
  openSearch: () => ipcRenderer.invoke('search:open-page'),
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
  // Share the current saved filters with the team being shown; main resolves the team and board.
  shareView: request => {
    if (!closed(request, ['team', 'name', 'values']) || typeof request.team !== 'string' || !/^[0-9a-f]{32}$/.test(request.team) || typeof request.name !== 'string' || !request.name.trim() || request.name.length > 60) return denied();
    const values = request.values && typeof request.values === 'object' && !Array.isArray(request.values) ? Object.fromEntries(Object.entries(request.values).filter(([k, v]) => /^[a-z][a-z0-9_-]{0,23}$/i.test(k) && typeof v === 'string' && v && v.length <= 80).slice(0, 8)) : {};
    return Object.keys(values).length ? ipcRenderer.invoke('overview:share-view', { team: request.team, name: request.name.trim(), values }) : denied();
  },
  // Which shared session's details are open (null: none); the team's boards see it as card presence.
  viewing: request => closed(request, ['id']) && (request.id === null || typeof request.id === 'string' && /^[0-9a-f]{40}$/.test(request.id)) ? ipcRenderer.invoke('overview:viewing', { id: request.id }) : denied(),
  teamInspect: request => closed(request, ['id']) && typeof request.id === 'string' && /^[0-9a-f]{40}$/.test(request.id)
    ? ipcRenderer.invoke('overview:team-inspect', { id: request.id }) : denied(),
  followups: {
    list: () => ipcRenderer.invoke('overview:followup-list'),
    review: request => {
      if (!(closed(request, ['id','text']) || closed(request, ['id','text','when'])) || typeof request.id !== 'string' || !/^[0-9a-f]{40}$/.test(request.id)) return denied();
      const text = messageText(request.text);
      if (text === null) return denied();
      if (request.when === undefined) return ipcRenderer.invoke('overview:followup-review', { id: request.id, text });
      const w = request.when;
      if (!(closed(w, ['kind']) && ['ready', 'provider-reset'].includes(w.kind)
        || closed(w, ['kind', 'atMs']) && w.kind === 'at' && Number.isSafeInteger(w.atMs) && w.atMs >= 0
        || closed(w, ['kind', 'schedule']) && w.kind === 'next' && closed(w.schedule, ['kind', 'every']) && w.schedule.kind === 'hours' && [1,2,3,4,6,8,12].includes(w.schedule.every))) return denied();
      return ipcRenderer.invoke('overview:followup-review', { id: request.id, text, when: w });
    },
    enqueue: request => {
      if (!closed(request, ['selection', 'requestId', 'text']) || !uuid(request.selection) || !uuid(request.requestId)) return denied();
      const text = messageText(request.text);
      return text === null ? denied() : ipcRenderer.invoke('overview:followup-enqueue', { selection: request.selection, requestId: request.requestId, text });
    },
    cancel: request => closed(request, ['id']) && uuid(request.id) ? ipcRenderer.invoke('overview:followup-cancel', { id: request.id }) : denied(),
    discard: request => closed(request, ['id']) && uuid(request.id) ? ipcRenderer.invoke('overview:followup-discard', { id: request.id }) : denied(),
  },
  coordinator: {
    requestOwner: request => closed(request, ['proposal']) && uuid(request.proposal) ? ipcRenderer.invoke('overview:coordinator-request-owner', { ...request }) : denied(),
    remoteList: request => closed(request, ['id']) && typeof request.id === 'string' && /^[0-9a-f]{40}$/.test(request.id) ? ipcRenderer.invoke('overview:coordinator-remote-list', { ...request }) : denied(),
    remoteSend: request => closed(request, ['selection']) && uuid(request.selection) ? ipcRenderer.invoke('overview:coordinator-remote-send', { ...request }) : denied(),
    remoteReplace: request => closed(request, ['selection','text']) && uuid(request.selection) && messageText(request.text)!==null ? ipcRenderer.invoke('overview:coordinator-remote-replace', {selection:request.selection,text:messageText(request.text)}) : denied(),
    remoteCancel: request => closed(request, ['selection']) && uuid(request.selection) ? ipcRenderer.invoke('overview:coordinator-remote-cancel', { ...request }) : denied(),

    inventory: request => closed(request, ['team']) && (request.team === null || typeof request.team === 'string' && /^[0-9a-f]{32}$/.test(request.team)) ? ipcRenderer.invoke('overview:coordinator-inventory', { team: request.team }) : denied(),
    propose: request => {
      if (!closed(request, ['team', 'title', 'assignments']) || typeof request.team !== 'string' || !/^[0-9a-f]{32}$/.test(request.team) || typeof request.title !== 'string' || !request.title.trim() || request.title.length > 120 || !Array.isArray(request.assignments) || !request.assignments.length || request.assignments.length > 6) return denied();
      const assignments = request.assignments.map(a => closed(a, ['id', 'name', 'text']) && typeof a.id === 'string' && /^[0-9a-f]{40}$/.test(a.id) && typeof a.name === 'string' && !!a.name.trim() && a.name.length <= 80 && messageText(a.text) !== null ? { id: a.id, name: a.name, text: messageText(a.text) } : null);
      return assignments.includes(null) ? denied() : ipcRenderer.invoke('overview:coordinator-propose', { team: request.team, title: request.title, assignments });
    },
    confirm: request => {
      if (!closed(request, ['proposal', 'grants']) || !uuid(request.proposal) || !Array.isArray(request.grants) || !request.grants.length || request.grants.length > 6) return denied();
      const grants = request.grants.map(g => closed(g, ['assignment', 'operation']) && uuid(g.assignment) && g.operation === 'send' ? { assignment: g.assignment, operation: 'send' } : null);
      return grants.includes(null) ? denied() : ipcRenderer.invoke('overview:coordinator-confirm', { proposal: request.proposal, grants });
    },
    results: request => closed(request, ['proposal']) && uuid(request.proposal) ? ipcRenderer.invoke('overview:coordinator-results', { proposal: request.proposal }) : denied(),
    cancel: request => closed(request, ['proposal']) && uuid(request.proposal) ? ipcRenderer.invoke('overview:coordinator-cancel', { proposal: request.proposal }) : denied(),
  },
  teamAction: request => {
    if (!closed(request, ['selection', 'operation', 'text']) || !uuid(request.selection) || !['send', 'steer', 'interrupt'].includes(request.operation)) return denied();
    const text = request.operation === 'interrupt' ? request.text === '' ? '' : null : messageText(request.text);
    return text === null ? denied() : ipcRenderer.invoke('overview:team-action', { selection: request.selection, operation: request.operation, text });
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
    // Endpoints the person adds (main validates again; an API key goes to secure storage in main, never back here).
    localEndpoints: () => ipcRenderer.invoke('interaction:local-endpoints'),
    saveLocalEndpoint: request => {
      if (!closed(request, ['id', 'label', 'url', 'kind', 'apiKey', 'clearKey'])) return denied();
      const strOr = (v, max) => v === null || (typeof v === 'string' && v.length <= max);
      if (!strOr(request.id, 40) || !strOr(request.label, 60) || !strOr(request.url, 300) || !['openai', 'ollama'].includes(request.kind) || !strOr(request.apiKey, 400) || typeof request.clearKey !== 'boolean') return denied();
      return ipcRenderer.invoke('interaction:local-endpoint-save', { id: request.id, label: request.label, url: request.url, kind: request.kind, apiKey: request.apiKey, clearKey: request.clearKey });
    },
    removeLocalEndpoint: request => closed(request, ['id']) && typeof request.id === 'string' && request.id.length <= 40 ? ipcRenderer.invoke('interaction:local-endpoint-remove', { id: request.id }) : denied(),
    // An unavailable provider's next step: main opens that tool's AI tools row, if it lists one.
    openAiTools: id => typeof id === 'string' && /^[a-z]{2,12}$/.test(id) ? ipcRenderer.invoke('interaction:open-aitools', id) : Promise.resolve(false),
    // Ask all: one message to up to 6 distinct owned sessions; main sends each through the per-session guards.
    fanout: request => {
      if (!closed(request, ['sessions', 'text']) || !Array.isArray(request.sessions) || request.sessions.length < 1 || request.sessions.length > 6) return denied();
      const sessions = request.sessions.map(t => closed(t, ['session', 'generation']) && uuid(t.session) && generation(t.generation) ? { session: t.session, generation: t.generation } : null);
      const text = messageText(request.text);
      if (text === null || sessions.includes(null) || new Set(sessions.map(t => t.session)).size !== sessions.length) return denied();
      return ipcRenderer.invoke('interaction:fanout', { sessions, text });
    },
    // Team sharing of one of this page's sessions (watch, or interact = also send/steer/interrupt).
    proposalList: request => closed(request, ['share']) && uuid(request.share) ? ipcRenderer.invoke('interaction:proposal-list', { share: request.share }) : denied(),
    proposalApprove: request => closed(request, ['share','id','version','digest','expiresInS']) && uuid(request.share) && uuid(request.id) && Number.isSafeInteger(request.version) && request.version > 0 && typeof request.digest === 'string' && /^[a-f0-9]{64}$/.test(request.digest) && Number.isSafeInteger(request.expiresInS) && request.expiresInS >= 60 && request.expiresInS <= 3600 ? ipcRenderer.invoke('interaction:proposal-approve', { ...request }) : denied(),
    proposalRevoke: request => closed(request, ['share','id']) && uuid(request.share) && uuid(request.id) ? ipcRenderer.invoke('interaction:proposal-revoke', { ...request }) : denied(),
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
