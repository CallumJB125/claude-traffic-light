'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const api = window.overviewApi;
  const filters = ['device', 'board', 'provider', 'status'];
  const defaults = { device: 'All devices', board: 'All boards', provider: 'All providers', status: 'All statuses' };
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const str = value => typeof value === 'string' && value.length <= 1000;
  const ageValid = value => value === null || Number.isFinite(value) && value >= 0;
  const taskValid = task => obj(task) && ['tracked', 'unknown'].includes(task.status) && str(task.title) && (task.key === null || str(task.key));
  const capValid = cap => obj(cap) && typeof cap.enabled === 'boolean' && str(cap.label) && str(cap.reason);
  const reportingValid = value => value === undefined || obj(value) && Object.keys(value).length === 2 && value.source === 'self-reported' && Number.isSafeInteger(value.observed_at) && value.observed_at >= 0;
  const validWork = row => obj(row) && str(row.id) && str(row.label) && str(row.status) && ['recent', 'stale', 'unknown'].includes(row.freshness) && ageValid(row.age_ms) && reportingValid(row.reporting) && taskValid(row.task) && obj(row.capabilities) && capValid(row.capabilities.open) && capValid(row.capabilities.message);
  function validSnapshot(value) {
    if (!obj(value) || value.schema !== 1 || !['complete', 'partial', 'unavailable'].includes(value.status) || !Number.isFinite(value.observed_at) || value.observed_at < 0 || !Number.isSafeInteger(value.omitted) || value.omitted < 0 || !Array.isArray(value.sessions) || value.sessions.length > 500) return false;
    const ids = new Set();
    for (const row of value.sessions) {
      if (!validWork(row) || !uuid(row.handle) || !obj(row.provider) || !str(row.provider.id) || !str(row.provider.label) || !['integrated', 'local'].includes(row.provider.kind) || !obj(row.device) || !str(row.device.label) || typeof row.device.local !== 'boolean' || !obj(row.board) || !str(row.board.label) || !['personal', 'team', 'unknown'].includes(row.board.kind) || !str(row.project) || !Array.isArray(row.children) || row.children.length > 64) return false;
      if (ids.has(row.id)) return false;
      ids.add(row.id);
      for (const child of row.children) {
        if (!validWork(child) || !(child.handle === null || uuid(child.handle)) || ids.has(child.id)) return false;
        ids.add(child.id);
      }
    }
    return true;
  }
  let snapshot = null, readGeneration = 0, viewGeneration = 0;
  let ready = typeof api.onReady !== 'function';
  const expanded = new Map(), composers = new Map(), busy = new Set(), notices = new Map();
  let rows = new Map();
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const ageText = value => value === null ? 'Report time unknown' : value < 60_000 ? `${Math.floor(value / 1000)}s ago` : value < 3_600_000 ? `${Math.floor(value / 60_000)}m ago` : `${Math.floor(value / 3_600_000)}h ago`;
  const ageNow = row => row.age_ms === null ? null : row.age_ms + Math.max(0, Date.now() - snapshot.observed_at);
  const freshness = row => row.freshness === 'recent' && (ageNow(row) === null || ageNow(row) > 90_000) ? 'stale' : row.freshness;
  const identity = (row, parent) => JSON.stringify([row.id, row.task.key, row.task.title, parent.provider.id, parent.device.label, parent.board.kind, parent.board.label]);
  const byId = id => rows.get(id);
  function capability(row, action) {
    if (document.hidden || !snapshot || snapshot.status === 'unavailable') return { enabled: false, reason: 'Current activity is unavailable.' };
    // A connection that can never do this keeps its own exact reason, even when stale.
    if (row.capabilities[action].enabled !== true) return row.capabilities[action];
    if (freshness(row) !== 'recent') return { enabled: false, reason: freshness(row) === 'stale' ? 'This report is stale. Refresh before acting.' : 'Current activity has not been reported.' };
    if (row.capabilities[action].enabled !== true) return row.capabilities[action];
    if (!uuid(row.handle)) return { enabled: false, reason: 'This agent has no supported action connection.' };
    return row.capabilities[action];
  }
  function button(label, callback, focus) {
    const el = node('button', label); el.type = 'button';
    if (focus) el.dataset.focus = focus;
    el.addEventListener('click', callback); return el;
  }
  // An already dispatched action stays fenced until its promise settles,
  // even when the page/filter invalidates the presentation of its result.
  function clearInteractions() { viewGeneration++; composers.clear(); notices.clear(); }
  function clearPage(message) {
    snapshot = null; rows.clear(); clearInteractions();
    $('content').replaceChildren(); $('summary').replaceChildren(); $('connections').replaceChildren();
    $('result-count').textContent = ''; $('status').textContent = message; $('content').setAttribute('aria-busy', 'false');
  }
  function empty(title, text) { const el = node('div', '', 'empty'); el.append(node('h3', title), node('p', text)); return el; }
  const keyFor = (row, filter) => filter === 'provider' ? row.provider.id : filter === 'status' ? row.status : row[filter].label;
  function updateFilters() {
    for (const filter of filters) {
      const select = $(`${filter}-filter`), previous = select.value;
      const values = new Map();
      for (const row of snapshot.sessions) values.set(keyFor(row, filter), filter === 'provider' ? `${row.provider.label}${row.provider.kind === 'local' ? ' · local model' : ''}` : keyFor(row, filter));
      select.replaceChildren(Object.assign(node('option', defaults[filter]), { value: '' }));
      for (const [value, label] of [...values].sort((a, b) => a[1].localeCompare(b[1]))) select.append(Object.assign(node('option', label), { value }));
      if (previous && !values.has(previous)) select.append(Object.assign(node('option', `${previous} · no reports`), { value: previous }));
      select.value = previous;
    }
  }
  function matches(row) { return filters.every(filter => !$(`${filter}-filter`).value || keyFor(row, filter) === $(`${filter}-filter`).value); }
  function renderSummary() {
    const all = snapshot.sessions, children = all.flatMap(row => row.children);
    const recent = row => freshness(row) === 'recent';
    const metrics = [[all.length, 'Reported sessions'], [all.filter(row => recent(row) && row.status === 'Working').length, 'Working now'], [[...all, ...children].filter(row => recent(row) && row.status === 'Waiting on you').length, 'Waiting on you'], [children.length, 'Reported child agents']];
    $('summary').replaceChildren(...metrics.map(([value, label]) => { const el = node('div', '', 'metric'); el.append(node('strong', String(value)), node('span', label)); return el; }));
  }
  function renderConnections() {
    const byProvider = new Map();
    for (const row of snapshot.sessions) {
      let entry = byProvider.get(row.provider.id);
      if (!entry) { entry = { provider: row.provider, recent: 0, stale: 0, unknown: 0 }; byProvider.set(row.provider.id, entry); }
      entry[freshness(row)]++;
    }
    $('connections').replaceChildren(...[...byProvider.values()].map(entry => {
      const el = node('div', '', 'connection');
      el.append(node('strong', `${entry.provider.label}${entry.provider.kind === 'local' ? ' · local model' : ''}`), node('p', `${entry.recent} recent · ${entry.stale} stale · ${entry.unknown} unknown`, 'muted'));
      return el;
    }));
    if (!byProvider.size) $('connections').append(node('p', 'No provider or local-model activity has been reported yet.', 'muted'));
  }
  function actions(row, parent) {
    const wrap = node('div', '', 'row-footer'), buttons = node('div', '', 'actions');
    for (const kind of ['open', 'message']) {
      const cap = capability(row, kind), action = node('div', '', 'action');
      const label = row.capabilities[kind].label || (kind === 'open' ? 'Open' : 'Message');
      const b = button(label, () => kind === 'open' ? void act(row.id, 'open') : compose(row.id), `${row.id}:${kind}`);
      b.disabled = cap.enabled !== true || busy.has(row.id);
      b.setAttribute('aria-label', `${label}: ${row.label}`);
      action.append(b);
      if (cap.enabled !== true) { const why = node('p', cap.reason || 'This connection does not support this action.', 'reason'); action.append(why); b.title = why.textContent; }
      buttons.append(action);
    }
    wrap.append(buttons);
    if (notices.has(row.id)) { const notice = node('p', notices.get(row.id).text, 'reason'); notice.setAttribute('role', 'status'); wrap.append(notice); }
    return wrap;
  }
  function compose(id) {
    const entry = byId(id); if (!entry || capability(entry.row, 'message').enabled !== true || busy.has(id)) return;
    composers.set(id, { identity: entry.identity, text: '', error: '' });
    renderWork(`${id}:text`);
  }
  function composer(row) {
    const draft = composers.get(row.id); if (!draft) return null;
    const box = node('div', '', 'composer'), label = node('label', `Message ${row.label}`);
    const input = node('textarea'); input.id = `message-${row.id}`; label.htmlFor = input.id;
    input.dataset.focus = `${row.id}:text`; input.value = draft.text; input.disabled = busy.has(row.id);
    input.placeholder = 'Write a message to this task…';
    input.addEventListener('input', () => { draft.text = input.value; draft.error = ''; });
    const note = node('p', draft.error || 'Sends through this task’s supported connection. Maximum 4,000 characters and 8 KB.', 'reason'); note.setAttribute('role', 'status');
    const buttons = node('div', '', 'actions');
    const send = button(busy.has(row.id) ? 'Sending…' : 'Send message', () => void act(row.id, 'message'), `${row.id}:send`);
    send.disabled = busy.has(row.id) || capability(row, 'message').enabled !== true;
    const cancel = button('Cancel', () => { composers.delete(row.id); renderWork(`${row.id}:message`); }, `${row.id}:cancel`); cancel.disabled = busy.has(row.id);
    buttons.append(send, cancel); box.append(label, input, note, buttons); return box;
  }
  function workRow(row, parent, child = false) {
    const el = node(child ? 'li' : 'article', '', child ? 'agent' : 'session'); el.dataset.id = row.id;
    const heading = node('div', '', 'row-heading'), title = node('div');
    title.append(node('h3', row.task.status === 'tracked' ? row.task.title : row.label));
    if (row.task.status === 'unknown') title.append(node('p', 'Task not reported', 'muted'));
    else if (row.label !== row.task.title) title.append(node('p', row.label, 'muted'));
    const fresh = freshness(row), tone = fresh !== 'recent' ? fresh : row.status === 'Waiting on you' ? 'waiting' : row.status === 'Working' ? 'working' : '';
    heading.append(title, node('span', fresh === 'recent' ? row.status : `${row.status} · ${fresh === 'stale' ? 'Stale' : 'Freshness unknown'}`, `tag ${tone}`));
    el.append(heading);
    if (!child) el.append(node('p', `${parent.provider.label}${parent.provider.kind === 'local' ? ' · local model' : ''} · ${parent.project} · ${parent.device.label}${parent.device.local ? ' (this device)' : ''} · ${parent.board.label}${parent.board.kind === 'unknown' ? ' (board unknown)' : ''}`, 'row-meta'));
    el.append(node('p', `${ageText(ageNow(row))} · ${row.reporting?.source === 'self-reported' ? 'Self-reported activity' : 'Reported activity'}`, 'muted'), actions(row, parent));
    const comp = composer(row); if (comp) el.append(comp);
    if (!child && row.children.length) {
      const details = node('details', '', 'children'); details.dataset.focus = `${row.id}:agents`;
      details.open = expanded.get(row.id) ?? true;
      const summary = node('summary', `${row.children.length} child ${row.children.length === 1 ? 'agent' : 'agents'}`); summary.dataset.focus = `${row.id}:agents`;
      details.addEventListener('toggle', () => { if (details.isConnected) expanded.set(row.id, details.open); });
      const list = node('ul', '', 'agent-list'); list.setAttribute('aria-label', `Child agents of ${row.label}`);
      for (const entry of row.children) list.append(workRow(entry, parent, true));
      details.append(summary, list); el.append(details);
    }
    return el;
  }
  function renderWork(focus = null) {
    const active = document.activeElement, focusKey = focus || active?.dataset?.focus;
    const selection = active?.tagName === 'TEXTAREA' ? [active.selectionStart, active.selectionEnd] : null;
    const selected = snapshot.sessions.filter(matches);
    $('content').replaceChildren(...selected.map(row => workRow(row, row)));
    $('result-count').textContent = `${selected.length} of ${snapshot.sessions.length} sessions`;
    if (!selected.length) $('content').append(snapshot.sessions.length ? empty('No work matches these filters', 'Try another device, board, provider or status, or clear the filters.') : empty('No activity reported yet', 'Start work in a connected tool or local model. Supported reports will appear here.'));
    $('content').setAttribute('aria-busy', 'false');
    if (focusKey) {
      const target = [...$('content').querySelectorAll('[data-focus]')].find(el => el.dataset.focus === focusKey && el.tagName !== 'DETAILS');
      target?.focus(); if (selection && target?.tagName === 'TEXTAREA') target.setSelectionRange(...selection);
    }
  }
  function render(value) {
    snapshot = value; rows = new Map();
    for (const parent of snapshot.sessions) for (const row of [parent, ...parent.children]) rows.set(row.id, { row, parent, identity: identity(row, parent) });
    for (const [id, draft] of composers) if (!rows.has(id) || rows.get(id).identity !== draft.identity || capability(rows.get(id).row, 'message').enabled !== true) composers.delete(id);
    for (const [id, notice] of notices) if (!rows.has(id) || rows.get(id).identity !== notice.identity) notices.delete(id);
    updateFilters(); renderSummary(); renderConnections(); renderWork();
    const time = new Date(value.observed_at).toLocaleTimeString();
    $('status').textContent = `Checked ${time}. Refreshes every 5 seconds while visible.${value.status === 'partial' ? ' Some activity is unavailable.' : ''}${value.omitted ? ` ${value.omitted} additional reports exceed the display limit.` : ''}`;
  }
  const resultText = { opened: 'Opened this task.', queued: 'Message queued by the supported connection. Delivery is not yet verified.', unavailable: 'This action is unavailable. Check the connection and try Refresh.', invalid: 'This request is unavailable. Try Refresh.', stale: 'This task changed before the action completed. Refresh and try again.' };
  async function act(id, kind) {
    const entry = byId(id); if (!entry || busy.has(id) || capability(entry.row, kind).enabled !== true) return;
    const generation = viewGeneration, captured = entry.identity, request = { handle: entry.row.handle };
    if (kind === 'message') {
      const draft = composers.get(id); if (!draft || draft.identity !== captured) return;
      const text = draft.text.trim();
      if (!text || text.length > 4000 || text.includes('\0') || new Blob([text]).size > 8192) { draft.error = 'Write a message of at most 4,000 characters and 8 KB with no NUL characters.'; renderWork(`${id}:text`); return; }
      request.text = text;
    }
    busy.add(id); notices.delete(id); renderWork();
    try {
      const result = await api[kind](request);
      if (document.hidden || generation !== viewGeneration || byId(id)?.identity !== captured) return;
      if (result?.ok === true && result.status === (kind === 'open' ? 'opened' : 'queued')) {
        notices.set(id, { identity: captured, text: resultText[result.status] }); if (kind === 'message') composers.delete(id);
      } else notices.set(id, { identity: captured, text: resultText[result?.status] || resultText.unavailable });
    } catch {
      if (!document.hidden && generation === viewGeneration && byId(id)?.identity === captured) notices.set(id, { identity: captured, text: resultText.unavailable });
    } finally {
      busy.delete(id); if (snapshot && !document.hidden) renderWork();
    }
  }
  async function refresh() {
    const request = ++readGeneration;
    try {
      const value = await api.state();
      if (request !== readGeneration || document.hidden) return;
      if (!validSnapshot(value) || value.status === 'unavailable') throw new Error('unavailable');
      render(value);
    } catch {
      if (request === readGeneration && !document.hidden) {
        clearPage('Reported activity is unavailable. Try Refresh.');
        $('content').append(empty('Activity unavailable', 'Current reports could not be read. Refresh to try again.'));
      }
    }
  }
  // ── Sessions Plexiform started (owned). Cards are keyed by session and
  // updated in place so typing, focus and IME composition survive pushes and
  // automatic checks. Provider text is only ever set through textContent.
  const ix = obj(api.interaction) ? api.interaction : null;
  const owned = new Map();
  let ixRead = 0, codexCap = null, launching = false;
  const STATUSES = ['ready', 'working', 'ended'];
  const DELIVERY = { sending: 'Sending…', acknowledged: 'Acknowledged by Codex', recorded: 'Recorded by Codex', responding: 'Responding…', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted', refused: 'Refused' };
  const REFUSAL = { invalid: 'Refused: the request was not valid', forbidden: 'Refused: not allowed from this page right now', stale: 'Refused: stale', busy: 'Refused: busy', unavailable: 'Unavailable' };
  const text = (value, max) => typeof value === 'string' && value.length <= max;
  const stamp = value => Number.isFinite(value) && value >= 0;
  const turnRef = value => value === null || uuid(value);
  const validDelivery = d => obj(d) && uuid(d.id) && text(d.text, 4000) && ['new-turn', 'steer'].includes(d.mode) && Object.hasOwn(DELIVERY, d.state) && typeof d.recorded === 'boolean' && turnRef(d.turn) && text(d.response, 16000) && (d.error === null || text(d.error, 1000)) && Array.isArray(d.notices) && d.notices.length <= 5 && d.notices.every(n => text(n, 300)) && stamp(d.sentAt) && (d.finishedAt === null || stamp(d.finishedAt));
  const validProvider = p => obj(p) && text(p.id, 40) && text(p.label, 80);
  const validState = s => obj(s) && uuid(s.session) && Number.isSafeInteger(s.generation) && s.generation >= 0 && validProvider(s.provider) && s.ownership === 'plexiform-owned' && text(s.label, 200) && STATUSES.includes(s.status) && turnRef(s.activeTurn) && obj(s.capabilities) && Array.isArray(s.deliveries) && s.deliveries.length <= 20 && s.deliveries.every(validDelivery);
  const ownedStatus = message => { $('owned-status').textContent = message; };
  const statusLabel = status => status === 'working' ? 'Working' : status === 'ended' ? 'Ended' : 'Ready';
  function deliveryItem(d) {
    const li = node('li', '', 'delivery'), head = node('div', '', 'delivery-head');
    head.append(node('strong', `${text(d.by, 80) && d.by ? `Sent by ${d.by}` : 'You'}${d.mode === 'steer' ? ' (steer)' : ''}`), node('span', DELIVERY[d.state], `tag ${d.state}`));
    li.append(head, node('p', d.text, 'delivery-text'));
    if (d.response) { const reply = node('p', d.response, 'delivery-response'); reply.setAttribute('aria-label', 'Codex response'); li.append(reply); }
    else if (['acknowledged', 'recorded', 'responding'].includes(d.state)) li.append(node('p', 'Waiting for Codex to answer…', 'muted'));
    if (d.state === 'acknowledged' && !d.recorded) li.append(node('p', 'Codex accepted this turn. It has not yet echoed your exact text.', 'reason'));
    if (d.error) li.append(node('p', `Codex reported: ${d.error}`, 'reason'));
    for (const n of d.notices) li.append(node('p', n, 'reason'));
    if (d.state === 'refused') li.append(node('p', 'Plexiform could not confirm Codex accepted this message.', 'reason'));
    return li;
  }
  function ownedCard(id) {
    const entry = owned.get(id), el = node('article', '', 'session owned-session'); el.dataset.session = id;
    const heading = node('div', '', 'row-heading'), title = node('h3'), tag = node('span', '', 'tag');
    heading.append(title, tag);
    const meta = node('p', '', 'row-meta'), body = node('div'), notice = node('p', '', 'reason'); notice.setAttribute('role', 'status');
    el.append(heading, meta, body, notice);
    globalThis.OverviewShare?.mount(el, id);
    entry.el = el; entry.parts = { title, tag, meta, body, notice };
    return el;
  }
  // The composer is built once per session and never detached while live.
  function composerParts(id) {
    const entry = owned.get(id), box = node('div', '', 'composer'), label = node('label', 'Message this Codex session');
    const input = node('textarea'); input.id = `owned-${id}`; label.htmlFor = input.id; input.placeholder = 'Type a message for Codex…';
    input.value = entry.draft; input.addEventListener('input', () => { entry.draft = input.value; });
    const note = node('p', '', 'reason'), buttons = node('div', '', 'actions');
    const send = button('Send', () => void effect(id, 'send')), steer = button('Steer current turn', () => void effect(id, 'steer'));
    const stop = button('Interrupt', () => void effect(id, 'interrupt')), close = button('Close session', () => void effect(id, 'close'));
    buttons.append(send, steer, stop, close); box.append(label, input, note, buttons);
    const list = node('ol', '', 'deliveries');
    list.setAttribute('aria-label', 'Messages and responses');
    entry.composer = { box, input, note, send, steer, stop, close, list };
    entry.parts.body.replaceChildren(list, box);
  }
  function updateCard(id) {
    const entry = owned.get(id); if (!entry) return;
    if (!entry.el) $('owned').append(ownedCard(id));
    const { title, tag, meta, body, notice } = entry.parts, s = entry.state;
    title.textContent = `${s.provider.label} session`;
    meta.textContent = `${s.label} · private read-only workspace`;
    notice.textContent = entry.notice;
    if (entry.missing) {
      // Kept visible (never silently removed); its last known messages stay readable.
      tag.textContent = 'Ended'; tag.className = 'tag stale';
      if (entry.composer) {
        for (const control of [entry.composer.input, entry.composer.send, entry.composer.steer, entry.composer.stop, entry.composer.close]) control.disabled = true;
        entry.composer.note.textContent = 'Plexiform no longer holds this session (closed, provider exited or Plexiform restarted). Nothing more can be sent to it.';
        if (!entry.dismiss) { entry.dismiss = button('Dismiss', () => { owned.delete(id); entry.el.remove(); renderOwnedEmpty(); }); entry.composer.box.append(entry.dismiss); }
      }
      return;
    }
    tag.textContent = statusLabel(s.status);
    tag.className = `tag ${s.status === 'working' ? 'working' : s.status === 'ended' ? 'stale' : ''}`;
    if (!entry.composer) composerParts(id);
    const c = entry.composer, working = s.status === 'working' && !!s.activeTurn;
    c.list.replaceChildren(...(s.deliveries.length ? s.deliveries.map(deliveryItem) : [node('li', 'No messages yet.', 'muted')]));
    c.input.disabled = !!entry.busy || s.status === 'ended';
    c.send.disabled = !!entry.busy || s.status !== 'ready';
    c.steer.disabled = !!entry.busy || !working || s.capabilities.steer !== true;
    c.stop.disabled = !!entry.busy || !working || s.capabilities.interrupt !== true;
    c.close.disabled = !!entry.busy;
    c.send.textContent = entry.busy === 'send' ? 'Sending…' : 'Send';
    c.note.textContent = s.status === 'ended' ? 'This session has ended. Close it to remove it.' : working ? 'A turn is running. Steer adds your text to it; Send is available when it finishes.' : 'Sends your exact text to this session only. Maximum 4,000 characters.';
  }
  function applyState(state) {
    const entry = owned.get(state.session) ?? { draft: '', notice: '', busy: false };
    if (entry.missing) return;
    entry.state = state;
    owned.set(state.session, entry); updateCard(state.session);
  }
  function renderOwnedEmpty() {
    const placeholder = $('owned').querySelector('.empty');
    if (!owned.size && !placeholder) $('owned').append(empty('No Plexiform sessions', 'Start a Codex session to message it from here. It runs read-only in a private Plexiform folder.'));
    else if (owned.size) placeholder?.remove();
  }
  function startButton() {
    const b = $('start-codex');
    b.disabled = launching || !codexCap || codexCap.available !== true;
    b.textContent = launching ? 'Starting…' : 'Start Codex session';
    b.title = codexCap && codexCap.available !== true ? codexCap.reason : '';
  }
  async function refreshOwned() {
    if (!ix || document.hidden) return;
    const request = ++ixRead;
    try {
      const [caps, items] = await Promise.all([ix.capabilities(), ix.list()]);
      if (request !== ixRead || document.hidden) return;
      if (Array.isArray(caps)) {
        codexCap = caps.find(c => obj(c) && c.provider === 'codex') ?? { available: false, reason: 'Codex is not available.' };
        startButton();
        if (codexCap.available !== true) ownedStatus(`Codex unavailable: ${text(codexCap.reason, 300) ? codexCap.reason : 'not installed'}.`);
      }
      if (!Array.isArray(items)) { ownedStatus('Plexiform session state is unavailable right now. Showing the last known state.'); return; }
      const seen = new Set();
      for (const item of items) {
        if (validState(item)) { seen.add(item.session); applyState(item); }
      }
      for (const [id, entry] of owned) if (!seen.has(id) && !entry.missing && !entry.busy) { entry.missing = true; updateCard(id); }
      renderOwnedEmpty();
    } catch { if (request === ixRead) ownedStatus('Plexiform session state is unavailable right now. Showing the last known state.'); }
  }
  async function launchCodex() {
    if (!ix || launching || codexCap?.available !== true) return;
    launching = true; startButton(); ownedStatus('Starting a Codex session…');
    let result;
    try { result = await ix.launch({ provider: 'codex' }); } catch { result = null; }
    launching = false; startButton();
    if (result?.ok === true && validState(result.state)) {
      ownedStatus('Codex session started. Type a message below.');
      applyState(result.state); renderOwnedEmpty(); owned.get(result.state.session).composer?.input.focus();
    } else ownedStatus(`Could not start Codex. ${REFUSAL[result?.status] ?? REFUSAL.unavailable}${text(result?.error, 300) ? `: ${result.error}` : '.'}`);
  }
  async function effect(id, kind) {
    const entry = owned.get(id); if (!entry || entry.busy || entry.missing) return;
    const s = entry.state, base = { session: s.session, generation: s.generation };
    let request;
    if (kind === 'send' || kind === 'steer') {
      const value = entry.draft.trim();
      if (!value || value.length > 4000 || value.includes('\0') || new Blob([value]).size > 8192) { entry.notice = 'Write a message of at most 4,000 characters and 8 KB.'; updateCard(id); return; }
      request = kind === 'steer' ? { ...base, text: value, expectedTurn: s.activeTurn } : { ...base, text: value };
    } else request = kind === 'interrupt' ? { ...base, turn: s.activeTurn } : base;
    entry.busy = kind; entry.notice = ''; updateCard(id);
    let result;
    try { result = await ix[kind === 'steer' ? 'send' : kind](request); } catch { result = null; }
    entry.busy = false;
    if (owned.get(id) !== entry) return;
    if (result?.ok === true) {
      if (kind === 'close') { owned.delete(id); entry.el?.remove(); renderOwnedEmpty(); ownedStatus('Session closed.'); return; }
      if (kind !== 'interrupt') { entry.draft = ''; if (entry.composer) entry.composer.input.value = ''; }
      entry.notice = kind === 'interrupt' ? 'Interrupt requested. Codex will confirm when the turn stops.' : 'Delivered: Codex acknowledged this message.';
      if (validState(result.state)) applyState(result.state); else updateCard(id);
      return;
    }
    entry.notice = `${REFUSAL[result?.status] ?? REFUSAL.unavailable}. ${text(result?.error, 300) ? result.error : 'Nothing was sent.'}`;
    updateCard(id);
    if (['stale', 'busy', 'forbidden'].includes(result?.status)) void refreshOwned();
  }
  if (ix) {
    $('owned-section').hidden = false;
    $('start-codex').addEventListener('click', () => void launchCodex());
    if (typeof ix.onEvent === 'function') ix.onEvent(state => { if (validState(state) && owned.has(state.session)) applyState(state); });
  }
  if (typeof api.onReady === 'function') api.onReady(() => {
    ready = true;
    if (!document.hidden) { void refresh(); void refreshOwned(); }
  });
  $('refresh').addEventListener('click', () => void refresh());
  for (const filter of filters) $(`${filter}-filter`).addEventListener('change', () => { clearInteractions(); if (snapshot) renderWork(); });
  $('clear-filters').addEventListener('click', () => { filters.forEach(filter => { $(`${filter}-filter`).value = ''; }); clearInteractions(); if (snapshot) renderWork(); });
  document.addEventListener('visibilitychange', () => { ++readGeneration; expanded.clear(); clearPage('Checking reported activity…'); if (!document.hidden && ready) { void refresh(); void refreshOwned(); } });
  setInterval(() => { if (!document.hidden && ready) { if (snapshot) { renderSummary(); renderConnections(); renderWork(); } void refresh(); void refreshOwned(); } }, 5000);
  if (!document.hidden && ready) { void refresh(); void refreshOwned(); }
})();
