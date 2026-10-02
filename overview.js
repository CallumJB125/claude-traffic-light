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
  // ── Sessions Plexiform started (owned). Cards, provider rows, Ask-all
  // targets and local endpoints are keyed and updated in place so typing,
  // focus and IME composition survive pushes and automatic checks. Provider
  // and model text is only ever set through textContent.
  const ix = obj(api.interaction) ? api.interaction : null;
  const router = obj(window.PlexiformRouter) && typeof window.PlexiformRouter.suggest === 'function' ? window.PlexiformRouter : null;
  const owned = new Map(), providers = new Map(), askTargets = new Map(), askChecked = new Set(), endpoints = new Map();
  let ixRead = 0, launching = false, selectedProvider = null, askRound = null, askBusy = false, clock = 0;
  const MAX_ASK = 6;
  const BOARD_STALE = /belongs to another board/;
  const set = (el, value) => { if (el.textContent !== value) el.textContent = value; };
  // A control disabled while its request runs drops focus to <body>; put it back.
  function restoreFocus(previous, fallback) {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && !active.disabled) return;
    const usable = el => el && el.isConnected && !el.disabled && !el.hidden;
    (usable(previous) ? previous : usable(fallback) ? fallback : null)?.focus();
  }
  // Board keys are opaque; a stale-board refusal or a success tells us which sessions share a board.
  function markBoard(board, off) { for (const e of owned.values()) if (e.state && e.state.board === board && !!e.offBoard !== off) { e.offBoard = off; updateCard(e.state.session); } }
  const STATUSES = ['ready', 'working', 'ended'];
  const DELIVERY = { sending: 'Sending…', acknowledged: 'Acknowledged by %', recorded: 'Recorded by %', responding: 'Responding…', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted', refused: 'Refused' };
  const REFUSAL = { invalid: 'Refused: the request was not valid', forbidden: 'Refused: not allowed from this page right now', stale: 'Refused: stale', busy: 'Refused: busy', unavailable: 'Unavailable' };
  const text = (value, max) => typeof value === 'string' && value.length <= max;
  const stamp = value => Number.isFinite(value) && value >= 0;
  const turnRef = value => value === null || uuid(value);
  const providerId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value);
  const validDelivery = d => obj(d) && uuid(d.id) && text(d.text, 4000) && ['new-turn', 'steer'].includes(d.mode) && Object.hasOwn(DELIVERY, d.state) && typeof d.recorded === 'boolean' && turnRef(d.turn) && text(d.response, 16000) && (d.error === null || text(d.error, 1000)) && Array.isArray(d.notices) && d.notices.length <= 5 && d.notices.every(n => text(n, 300)) && stamp(d.sentAt) && (d.finishedAt === null || stamp(d.finishedAt));
  const validProvider = p => obj(p) && text(p.id, 80) && text(p.label, 120);
  const validState = s => obj(s) && uuid(s.session) && Number.isSafeInteger(s.generation) && s.generation >= 0 && validProvider(s.provider) && s.ownership === 'plexiform-owned' && text(s.label, 200) && STATUSES.includes(s.status) && turnRef(s.activeTurn) && obj(s.capabilities) && Array.isArray(s.deliveries) && s.deliveries.length <= 20 && s.deliveries.every(validDelivery);
  const validCap = c => obj(c) && providerId(c.provider) && text(c.label, 120) && typeof c.available === 'boolean' && text(c.reason, 600) && obj(c.capabilities);
  const ownedStatus = message => { $('owned-status').textContent = message; };
  const statusLabel = status => status === 'working' ? 'Working' : status === 'ended' ? 'Ended' : 'Ready';
  const deliveryLabel = (state, label) => DELIVERY[state].replace('%', label);
  const nameOf = entry => entry.state.provider.label;
  // One view per delivery, updated field by field so streaming tokens do not
  // rebuild the list (text selection survives) and nothing re-announces.
  function deliveryView(withHead) {
    const el = node(withHead ? 'li' : 'div', '', withHead ? 'delivery' : 'delivery-body'), head = node('div', '', 'delivery-head');
    const who = node('strong'), tag = node('span'), said = node('p', '', 'delivery-text'), response = node('p', '', 'delivery-response'), wait = node('p', '', 'muted'), details = node('div');
    head.append(who, tag);
    el.append(...(withHead ? [head, said] : []), response, wait, details);
    return { el, who, tag, said, response, wait, details, sig: null };
  }
  function updateDelivery(v, d, label, tagText) {
    set(v.who, d.mode === 'steer' ? 'You (steer)' : 'You'); set(v.said, d.text);
    set(v.tag, tagText ?? deliveryLabel(d.state, label)); v.tag.className = `tag ${d.state}`;
    set(v.response, d.response); v.response.hidden = !d.response; v.response.setAttribute('aria-label', `${label} response`);
    const waiting = !d.response && ['acknowledged', 'recorded', 'responding'].includes(d.state);
    set(v.wait, waiting ? `Waiting for ${label} to answer…` : ''); v.wait.hidden = !waiting;
    const lines = [];
    if (d.state === 'acknowledged' && !d.recorded) lines.push(`${label} accepted this turn. It has not yet echoed your exact text.`);
    if (d.error) lines.push(`${label} reported: ${d.error}`);
    lines.push(...d.notices);
    if (d.state === 'refused') lines.push(`Plexiform could not confirm ${label} accepted this message.`);
    const sig = JSON.stringify(lines);
    if (v.sig !== sig) { v.sig = sig; v.details.replaceChildren(...lines.map(t => node('p', t, 'reason'))); }
  }
  function syncDeliveries(entry, label) {
    const c = entry.composer, list = entry.state.deliveries, keep = new Set(list.map(d => d.id));
    for (const [id, v] of c.views) if (!keep.has(id)) { v.el.remove(); c.views.delete(id); }
    if (list.length) c.none.remove(); else if (!c.none.isConnected) c.list.append(c.none);
    let previous = null;
    for (const d of list) {
      let v = c.views.get(d.id);
      if (!v) { v = deliveryView(true); c.views.set(d.id, v); }
      updateDelivery(v, d, label);
      const want = previous ? previous.nextSibling : c.list.firstChild;
      if (want !== v.el) c.list.insertBefore(v.el, want);
      previous = v.el;
    }
  }
  function ownedCard(id) {
    const entry = owned.get(id), el = node('article', '', 'session owned-session'); el.dataset.session = id;
    const heading = node('div', '', 'row-heading'), title = node('h3'), tag = node('span', '', 'tag');
    heading.append(title, tag);
    const meta = node('p', '', 'row-meta'), body = node('div'), notice = node('p', '', 'reason'); notice.setAttribute('role', 'status');
    el.append(heading, meta, body, notice);
    entry.el = el; entry.parts = { title, tag, meta, body, notice };
    return el;
  }
  // The composer is built once per session and never detached while live.
  function composerParts(id) {
    const entry = owned.get(id), box = node('div', '', 'composer'), label = node('label', `Message this ${nameOf(entry)} session`);
    const input = node('textarea'); input.id = `owned-${id}`; label.htmlFor = input.id; input.placeholder = `Type a message for ${nameOf(entry)}…`;
    input.value = entry.draft; input.addEventListener('input', () => { entry.draft = input.value; });
    const note = node('p', '', 'reason'), buttons = node('div', '', 'actions');
    const send = button('Send', () => void effect(id, 'send')), steer = button('Steer current turn', () => void effect(id, 'steer'));
    const stop = button('Interrupt', () => void effect(id, 'interrupt')), close = button('Close session', () => void effect(id, 'close'));
    const recheck = button('Check again', () => { markBoard(entry.state.board, false); entry.notice = ''; updateCard(id); renderAsk(); input.focus(); void refreshOwned(); });
    recheck.hidden = true;
    buttons.append(send, steer, stop, recheck, close); box.append(label, input, note, buttons);
    const list = node('ol', '', 'deliveries');
    list.setAttribute('aria-label', 'Messages and responses');
    entry.composer = { box, input, note, send, steer, stop, recheck, close, list, views: new Map(), none: node('li', 'No messages yet.', 'muted') };
    entry.parts.body.replaceChildren(list, box);
  }
  function updateCard(id) {
    const entry = owned.get(id); if (!entry) return;
    if (!entry.el) $('owned').append(ownedCard(id));
    const { title, tag, meta, notice } = entry.parts, s = entry.state, label = nameOf(entry);
    set(title, `${label} session`);
    set(meta, `${s.label} · private read-only workspace`);
    set(notice, entry.notice);
    if (entry.missing) {
      // Kept visible (never silently removed); its last known messages stay readable.
      tag.textContent = 'Ended'; tag.className = 'tag stale';
      if (entry.composer) {
        for (const control of [entry.composer.input, entry.composer.send, entry.composer.steer, entry.composer.stop, entry.composer.recheck, entry.composer.close]) control.disabled = true;
        entry.composer.recheck.hidden = true;
        entry.composer.note.textContent = 'Plexiform no longer holds this session (closed, provider exited or Plexiform restarted). Nothing more can be sent to it.';
        if (!entry.dismiss) { entry.dismiss = button('Dismiss', () => { owned.delete(id); entry.el.remove(); renderOwnedEmpty(); renderAsk(); }); entry.composer.box.append(entry.dismiss); }
      }
      return;
    }
    // Another board: never shown as Ready with Send enabled. Interrupt and Close stay available.
    const off = !!entry.offBoard && s.status !== 'ended';
    set(tag, off ? 'On another board — switch back to use it' : statusLabel(s.status));
    tag.className = `tag ${off || s.status === 'ended' ? 'stale' : s.status === 'working' ? 'working' : ''}`;
    if (!entry.composer) composerParts(id);
    const c = entry.composer, working = s.status === 'working' && !!s.activeTurn;
    const canSteer = s.capabilities.steer === true, canInterrupt = s.capabilities.interrupt === true;
    syncDeliveries(entry, label);
    // Controls the provider does not support are not offered at all.
    c.steer.hidden = !canSteer; c.stop.hidden = !canInterrupt; c.recheck.hidden = !off;
    c.input.disabled = !!entry.busy || s.status === 'ended';
    c.send.disabled = !!entry.busy || off || s.status !== 'ready';
    c.steer.disabled = !!entry.busy || off || !working || !canSteer;
    c.stop.disabled = !!entry.busy || !working || !canInterrupt;
    c.recheck.disabled = !!entry.busy;
    c.close.disabled = !!entry.busy;
    set(c.send, entry.busy === 'send' ? 'Sending…' : 'Send');
    set(c.note, s.status === 'ended' ? 'This session has ended. Close it to remove it.' : off ? 'This session belongs to another board. Switch back to the board it started on, then choose Check again.' : working ? `A turn is running. ${canSteer ? 'Steer adds your text to it; ' : ''}Send is available when it finishes.` : 'Sends your exact text to this session only. Maximum 4,000 characters.');
  }
  // Pushes, launches and effect results are newer than any list read that
  // started before them: `touched` orders them against list snapshots.
  function applyState(state, asOf = null) {
    const entry = owned.get(state.session) ?? { draft: '', notice: '', busy: false, touched: 0 };
    if (entry.missing || asOf !== null && entry.touched > asOf) return;
    entry.state = state;
    if (asOf === null) entry.touched = ++clock;
    owned.set(state.session, entry); updateCard(state.session); renderAsk();
  }
  function renderOwnedEmpty() {
    const placeholder = $('owned').querySelector('.empty');
    if (!owned.size && !placeholder) $('owned').append(empty('No Plexiform sessions', 'Choose an AI above and start a session to message it from here. It runs read-only in a private Plexiform folder.'));
    else if (owned.size) placeholder?.remove();
  }
  // ── Provider picker: every provider main lists, available or not, with the
  // honest reason. A provider that disappears stays listed as no longer found.
  const features = c => [c.capabilities.steer === true ? 'can steer a running turn' : '', c.capabilities.interrupt === true ? 'can interrupt' : ''].filter(Boolean).join(' · ');
  function providerRow(id) {
    const row = node('label', '', 'provider-option'), input = node('input'), name = node('span', '', 'provider-name'), tag = node('span', '', 'tag'), reason = node('span', '', 'reason');
    input.type = 'radio'; input.name = 'owned-provider'; input.value = id;
    input.addEventListener('change', () => { if (input.checked) { selectedProvider = id; startButton(); } });
    row.append(input, name, tag, reason); $('provider-list').append(row);
    return { row, input, name, tag, reason };
  }
  function renderProviders(caps) {
    const seen = new Set();
    for (const cap of caps) {
      if (!validCap(cap) || seen.has(cap.provider)) continue;
      seen.add(cap.provider);
      const p = providers.get(cap.provider) ?? { parts: providerRow(cap.provider) };
      p.cap = cap; p.missing = false; providers.set(cap.provider, p);
    }
    for (const [id, p] of providers) {
      if (!seen.has(id)) p.missing = true;
      const available = p.cap.available === true && !p.missing;
      p.parts.name.textContent = p.cap.label;
      p.parts.tag.textContent = p.missing ? 'Not listed' : available ? 'Available' : 'Unavailable';
      p.parts.tag.className = `tag ${available ? 'completed' : 'stale'}`;
      p.parts.reason.textContent = p.missing ? 'No longer listed on the last check.' : available ? features(p.cap) : p.cap.reason || 'Unavailable.';
      p.parts.input.disabled = !available;
      if (!available && selectedProvider === id) { selectedProvider = null; p.parts.input.checked = false; }
    }
    if (!selectedProvider) {
      const first = providers.get('codex')?.parts.input.disabled === false ? 'codex' : [...providers].find(([, p]) => !p.parts.input.disabled)?.[0];
      if (first) { selectedProvider = first; providers.get(first).parts.input.checked = true; }
    }
    if (!providers.size) $('provider-list').replaceChildren(node('p', 'No AI providers are listed.', 'muted'));
    else $('provider-list').querySelector(':scope > p.muted')?.remove();
    startButton(); renderHint();
  }
  const usableProvider = id => { const p = id ? providers.get(id) : null; return p && !p.missing && p.cap.available === true ? p : null; };
  function startButton() {
    const b = $('start-session'), p = usableProvider(selectedProvider);
    b.disabled = launching || !p;
    b.textContent = launching ? 'Starting…' : p ? `Start ${p.cap.label} session` : 'Start session';
    b.title = p ? '' : 'Choose an available AI first.';
    renderHint();
  }
  // Advisory only: the user clicks to start a session with the suggestion.
  function renderHint() {
    const hint = $('router-hint'), use = $('router-use'), message = $('router-text').value.trim();
    const pick = router && message ? router.suggest(message, [...providers.values()].filter(p => !p.missing).map(p => ({ provider: p.cap.provider, label: p.cap.label, available: p.cap.available }))) : null;
    if (!pick || !usableProvider(pick.provider)) {
      hint.textContent = router ? (message ? 'No available AI to suggest.' : 'Type what you want to ask for a cheapest-capable suggestion.') : '';
      use.hidden = true; use.dataset.provider = ''; return;
    }
    hint.textContent = `Suggested: ${pick.label} (${pick.cheaper ? 'cheaper' : pick.tier}). ${pick.reason}`;
    use.hidden = false; use.disabled = launching; use.dataset.provider = pick.provider; use.textContent = `Start with ${pick.label}`;
  }
  async function launch(id, draft = '') {
    const p = usableProvider(id);
    if (!ix || launching || !p) return;
    const label = p.cap.label, focused = document.activeElement;
    launching = true; startButton(); ownedStatus(`Starting a ${label} session…`);
    let result;
    try { result = await ix.launch({ provider: id }); } catch { result = null; }
    launching = false; startButton();
    if (result?.ok === true && validState(result.state)) {
      ownedStatus(`${label} session started. Type a message below.`);
      applyState(result.state); renderOwnedEmpty(); markBoard(result.state.board, false);
      const entry = owned.get(result.state.session);
      if (draft && entry?.composer) { entry.draft = draft; entry.composer.input.value = draft; }
      entry?.composer?.input.focus();
    } else { ownedStatus(`Could not start ${label}. ${REFUSAL[result?.status] ?? REFUSAL.unavailable}${text(result?.error, 600) ? `: ${result.error}` : '.'}`); restoreFocus(focused, $('start-session')); }
  }
  // ── Ask all: one message to several owned sessions, answers side by side.
  const liveEntries = () => [...owned].filter(([, e]) => !e.missing && e.state.status !== 'ended');
  function renderAsk() {
    if (!ix || typeof ix.fanout !== 'function') return;
    const live = liveEntries();
    $('ask-all').hidden = live.length < 2 && !askRound;
    const liveIds = new Set(live.map(([id]) => id));
    for (const [id, t] of askTargets) if (!liveIds.has(id)) { t.row.remove(); askTargets.delete(id); askChecked.delete(id); }
    for (const [id, entry] of live) {
      let t = askTargets.get(id);
      if (!t) {
        const row = node('label', '', 'ask-target'), input = node('input'), name = node('span');
        input.type = 'checkbox'; input.value = id;
        input.addEventListener('change', () => { if (input.checked) askChecked.add(id); else askChecked.delete(id); renderAsk(); });
        row.append(input, name); $('ask-targets').append(row);
        t = { row, input, name }; askTargets.set(id, t);
      }
      const ready = entry.state.status === 'ready' && !entry.busy && !entry.offBoard;
      set(t.name, `${nameOf(entry)}${entry.offBoard ? ' (on another board)' : ready ? '' : ' (busy)'}`);
      t.input.checked = askChecked.has(id);
      t.input.disabled = askBusy || !ready || (!t.input.checked && askChecked.size >= MAX_ASK);
    }
    const chosen = [...askChecked].filter(id => askTargets.get(id) && !askTargets.get(id).input.disabled);
    $('ask-send').disabled = askBusy || !chosen.length;
    $('ask-send').textContent = askBusy ? 'Asking…' : chosen.length ? `Ask ${chosen.length} selected` : 'Ask selected';
    const results = $('ask-results');
    if (!askRound) { results.replaceChildren(); return; }
    if (!askRound.built) { askRound.built = true; results.replaceChildren(...askRound.items.map(item => { item.view = deliveryView(false); item.head = node('strong'); const col = node('article', '', 'ask-answer'), head = node('div', '', 'delivery-head'); head.append(item.head, item.view.tag); col.append(head, item.view.el); return col; })); }
    for (const item of askRound.items) {
      const entry = owned.get(item.session), label = entry ? nameOf(entry) : item.label;
      const d = item.delivery && entry && !entry.missing ? entry.state.deliveries.find(x => x.id === item.delivery) : null;
      set(item.head, label);
      if (d) { updateDelivery(item.view, d, label, d.state === 'completed' && d.response ? `Answered by ${label}` : null); continue; }
      const why = !item.ok ? `${REFUSAL[item.status] ?? REFUSAL.unavailable}. ${item.error || 'Nothing was sent to this session.'}` : 'This session is no longer held; its answer is not available.';
      updateDelivery(item.view, { mode: 'new-turn', text: '', state: item.ok ? 'acknowledged' : 'refused', recorded: true, response: '', error: null, notices: [] }, label, item.ok ? 'No longer held' : 'Refused');
      item.view.wait.hidden = true; set(item.view.details, ''); item.view.sig = null; item.view.details.append(node('p', why, 'reason'));
    }
  }
  async function askAll() {
    const value = $('ask-text').value.trim();
    const chosen = [...askChecked].map(id => owned.get(id)).filter(e => e && !e.missing && e.state.status === 'ready').slice(0, MAX_ASK);
    if (askBusy || !chosen.length) return;
    if (!value || value.length > 4000 || value.includes('\0') || new Blob([value]).size > 8192) { $('ask-status').textContent = 'Write a message of at most 4,000 characters and 8 KB.'; return; }
    const focused = document.activeElement;
    askBusy = true; $('ask-status').textContent = `Asking ${chosen.length} sessions…`; renderAsk();
    let result;
    try { result = await ix.fanout({ sessions: chosen.map(e => ({ session: e.state.session, generation: e.state.generation })), text: value }); } catch { result = null; }
    askBusy = false;
    if (result?.status !== 'fanned-out' || !Array.isArray(result.results)) {
      $('ask-status').textContent = `${REFUSAL[result?.status] ?? REFUSAL.unavailable}. ${text(result?.error, 300) ? result.error : 'Nothing was sent.'}`;
      renderAsk(); restoreFocus(focused, $('ask-text')); return;
    }
    const items = [];
    for (const r of result.results) {
      if (!obj(r) || !uuid(r.session)) continue;
      const entry = owned.get(r.session);
      items.push({ session: r.session, label: entry ? nameOf(entry) : 'Session', ok: r.ok === true, status: r.status, error: text(r.error, 600) ? r.error : '', delivery: r.ok === true && obj(r.delivery) && uuid(r.delivery.id) ? r.delivery.id : null });
      if (entry && validState(r.state)) applyState(r.state);
      if (entry && r.ok === true) markBoard(entry.state.board, false);
      else if (entry && r.status === 'stale' && text(r.error, 600) && BOARD_STALE.test(r.error)) markBoard(entry.state.board, true);
    }
    const sent = items.filter(i => i.ok).length;
    askRound = { items };
    if (sent) $('ask-text').value = '';
    $('ask-status').textContent = sent === items.length ? `Sent to ${sent} sessions.` : `Sent to ${sent} of ${items.length} sessions. The others show why.`;
    renderAsk(); restoreFocus(focused, $('ask-text'));
  }
  // ── Integrated local models: what main found, read-only.
  const validEndpoint = e => obj(e) && text(e.id, 40) && text(e.label, 80) && ['openai', 'ollama'].includes(e.kind) && text(e.host, 300) && typeof e.reachable === 'boolean' && (e.error === null || text(e.error, 300)) && ['configured', 'discovered'].includes(e.source);
  const validModel = m => obj(m) && providerId(m.provider) && text(m.model, 200) && text(m.endpoint, 40) && (m.lastUsed === null || stamp(m.lastUsed));
  function renderLocal(data) {
    if (!obj(data) || !Array.isArray(data.endpoints) || !Array.isArray(data.models) || data.endpoints.length > 64 || data.models.length > 500) {
      $('local-status').textContent = 'Local model status is unavailable right now. Showing the last known state.'; return;
    }
    const models = data.models.filter(validModel), seen = new Set();
    for (const e of data.endpoints) {
      if (!validEndpoint(e) || seen.has(e.id)) continue;
      seen.add(e.id);
      let row = endpoints.get(e.id);
      if (!row) {
        const el = node('article', '', 'session endpoint'), heading = node('div', '', 'row-heading'), title = node('h3'), tag = node('span', '', 'tag');
        heading.append(title, tag);
        const meta = node('p', '', 'row-meta'), error = node('p', '', 'reason'), list = node('ul', '', 'model-list');
        el.append(heading, meta, error, list); $('local-endpoints').append(el);
        row = { el, title, tag, meta, error, list }; endpoints.set(e.id, row);
      }
      row.missing = false;
      row.title.textContent = e.label;
      row.tag.textContent = e.reachable ? 'Reachable' : 'Not reachable'; row.tag.className = `tag ${e.reachable ? 'completed' : 'stale'}`;
      row.meta.textContent = `${e.host} · ${e.kind === 'ollama' ? 'Ollama' : 'OpenAI-compatible'} · ${e.source === 'configured' ? 'from local-models.json' : 'found on this computer'}`;
      row.error.textContent = e.reachable ? '' : e.error || 'Not reachable.';
      const mine = models.filter(m => m.endpoint === e.id);
      row.list.replaceChildren(...(mine.length ? mine.map(m => node('li', `${m.model} · ${m.lastUsed ? `last used ${ageText(Math.max(0, Date.now() - m.lastUsed))}` : 'not used yet'}`)) : [node('li', 'No models listed.', 'muted')]));
    }
    for (const [id, row] of endpoints) if (!seen.has(id) && !row.missing) {
      row.missing = true; row.tag.textContent = 'Not found'; row.tag.className = 'tag stale';
      row.error.textContent = 'Not found on the last check. Its models are not offered until it is back.';
    }
    $('local-status').textContent = endpoints.size ? `Checked just now. ${models.length} model${models.length === 1 ? '' : 's'} available to start a session with.` : 'No local model endpoints found. Plexiform looks for Ollama (:11434), LM Studio (:1234) and OpenAI-compatible servers on :8000 and :8888 on this computer.';
  }
  async function refreshOwned() {
    if (!ix || document.hidden) return;
    const request = ++ixRead, asOf = clock;
    try {
      // Local models register as providers when found, so read them before capabilities.
      const [local, items] = await Promise.all([typeof ix.localModels === 'function' ? ix.localModels().catch(() => null) : null, ix.list()]);
      const caps = await ix.capabilities();
      if (request !== ixRead || document.hidden) return;
      if (typeof ix.localModels === 'function') renderLocal(local);
      if (Array.isArray(caps)) renderProviders(caps);
      if (!Array.isArray(items)) { ownedStatus('Plexiform session state is unavailable right now. Showing the last known state.'); return; }
      const seen = new Set();
      for (const item of items) {
        if (validState(item)) { seen.add(item.session); applyState(item, asOf); }
      }
      // A list read that started before a push or launch cannot declare that session gone.
      for (const [id, entry] of owned) if (!seen.has(id) && !entry.missing && !entry.busy && entry.touched <= asOf) { entry.missing = true; updateCard(id); }
      renderOwnedEmpty(); renderAsk();
    } catch { if (request === ixRead) ownedStatus('Plexiform session state is unavailable right now. Showing the last known state.'); }
  }
  async function effect(id, kind) {
    const entry = owned.get(id); if (!entry || entry.busy || entry.missing) return;
    const s = entry.state, base = { session: s.session, generation: s.generation }, label = nameOf(entry);
    let request;
    if (kind === 'send' || kind === 'steer') {
      const value = entry.draft.trim();
      if (!value || value.length > 4000 || value.includes('\0') || new Blob([value]).size > 8192) { entry.notice = 'Write a message of at most 4,000 characters and 8 KB.'; updateCard(id); return; }
      request = kind === 'steer' ? { ...base, text: value, expectedTurn: s.activeTurn } : { ...base, text: value };
    } else request = kind === 'interrupt' ? { ...base, turn: s.activeTurn } : base;
    const focused = document.activeElement;
    entry.busy = kind; entry.notice = ''; updateCard(id); renderAsk();
    let result;
    try { result = await ix[kind === 'steer' ? 'send' : kind](request); } catch { result = null; }
    entry.busy = false;
    if (owned.get(id) !== entry) return;
    if (result?.ok === true) {
      if (kind === 'close') { owned.delete(id); entry.el?.remove(); renderOwnedEmpty(); renderAsk(); ownedStatus('Session closed.'); restoreFocus(null, $('start-session')); return; }
      if (kind !== 'interrupt') { entry.draft = ''; if (entry.composer) entry.composer.input.value = ''; }
      entry.notice = kind === 'interrupt' ? `Interrupt requested. ${label} will confirm when the turn stops.` : `Delivered: ${label} acknowledged this message.`;
      if (validState(result.state)) applyState(result.state); else updateCard(id);
      if (kind !== 'interrupt') markBoard(entry.state.board, false);
      restoreFocus(focused, entry.composer?.input);
      return;
    }
    entry.notice = `${REFUSAL[result?.status] ?? REFUSAL.unavailable}. ${text(result?.error, 300) ? result.error : 'Nothing was sent.'}`;
    if (result?.status === 'stale' && text(result?.error, 300) && BOARD_STALE.test(result.error)) markBoard(entry.state.board, true);
    updateCard(id); renderAsk(); restoreFocus(focused, entry.composer?.input);
    if (['stale', 'busy', 'forbidden'].includes(result?.status)) void refreshOwned();
  }
  if (ix) {
    $('owned-section').hidden = false;
    if (typeof ix.localModels === 'function') $('local-section').hidden = false;
    $('start-session').addEventListener('click', () => void launch(selectedProvider));
    $('router-text').addEventListener('input', renderHint);
    $('router-use').addEventListener('click', () => void launch($('router-use').dataset.provider, $('router-text').value.trim()));
    // Built only when owned sessions exist, so the reported-work composer stays the page's first textarea.
    const ask = node('textarea'); ask.id = 'ask-text'; ask.maxLength = 4000; $('ask-send').closest('.actions').before(ask);
    $('ask-send').addEventListener('click', () => void askAll());
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
