'use strict';
// Real team hub client for Overview "Team sessions" over the interaction hub's
// share endpoints. Every hub response is untrusted: rows are whitelisted,
// capped and stripped of control characters; failures map to a fixed reason
// table returned as both `error` and `reason`. The token is a function, re-read
// on every request, and never stored, logged or returned.
const crypto = require('node:crypto');
const { cleanReportText, REPORT_SOURCES, CHILD_STATES } = require('./session-interaction');
const { redactSecrets } = require('./secret-patterns');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SHARED = 300, MAX_TEAMS = 64, MAX_PER_TEAM = 100, FANOUT = 6;
const MAX_TEXT = 4000, MAX_BYTES = 8192, MAX_BODY = 1_000_000;
const POLL_MS = 5000, TIMEOUT_MS = 15_000, DEADLINE_MS = 20_000, BACKOFF_MAX_MS = 60_000;
const DIRECTORY_STATE_MS = 45_000;
// T1: the sidebar's passive teammate read (passiveSessions).
const PASSIVE_TEAMS = 4, PASSIVE_ROWS = 200, PASSIVE_REFRESH = 24, PASSIVE_SPAN_MS = 2500;
const DELIVERY_STATES = Object.freeze(['queued', 'sending', 'unconfirmed', 'delivered', 'acknowledged', 'recorded', 'responding', 'completed', 'interrupted', 'failed', 'replied', 'refused', 'expired', 'unknown']);
const ACTIVITY_LABELS = Object.freeze(['Thinking', 'Running a command', 'Editing files', 'Reading files', 'Searching', 'Using a tool', 'Coordinating agents']);
const REASONS = Object.freeze({
  stale: 'This session is no longer shared with you.',
  forbidden: 'This session is not shared with you to send.',
  unavailable: 'The team hub did not accept the request just now.',
  unreadable: 'The team hub sent an unreadable answer.',
  invalid: 'Check the message and try again.',
});
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u2028\u2029\u2060-\u2064\u{e0000}-\u{e007f}]/gu;
const LOOSE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u2028\u2029\u2060-\u2064\u{e0000}-\u{e007f}]/gu;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? [...v.replace(HIDDEN, '')].slice(0, max).join('') : '');
const prose = (v, max) => (typeof v === 'string' ? [...v.replace(LOOSE, '')].slice(0, max).join('').replace(/\n{3,}/g, '\n\n') : '');
const failed = (status, reason) => ({ ok: false, status, reason, error: reason });
const bounded = (v, dflt) => (Number.isSafeInteger(v) && v > 0 ? v : dflt);

function parseBase(raw) {
  if (typeof raw !== 'string' || !raw) throw new Error('a team hub client needs an http(s) baseUrl');
  let u;
  try { u = new URL(raw); } catch { throw new Error('the team hub baseUrl is not a valid URL'); }
  const host = u.hostname.toLowerCase();
  const loop = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) throw new Error('the team hub baseUrl must use https (http only for a loopback address)');
  if (u.username || u.password || u.search || u.hash) throw new Error('the team hub baseUrl must not carry credentials, a query or a fragment');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

function shareRow(x) {
  if (!object(x)) return null;
  const id = str(x.id, 100), session = str(x.session, 100);
  const scope = x.scope === 'interact' || x.scope === 'watch' ? x.scope : '';
  const team = object(x.team) ? { id: str(x.team.id, 100), name: str(x.team.name, 80) || 'Team' } : null;
  const ownerId = object(x.owner) && typeof x.owner.id === 'string' ? x.owner.id.replace(HIDDEN, "").trim() : '';
  if (!UUID.test(id) || !UUID.test(session) || !scope || !team || !team.id || !ownerId || ownerId.length > 100) return null;
  return {
    ref: id, session, scope, team,
    expiresAt: typeof x.expires_at === 'string' && x.expires_at.length <= 60 ? x.expires_at : null,
    owner: { id: ownerId, name: str(x.owner.name, 80) || 'Teammate' },
    online: x.online === true,
  };
}

function createTeamHubClient({ baseUrl, token, fetch = globalThis.fetch, viewer: viewerOpt = null, viewerId = null, boardDirectory = false } = {}, { pollMs, timeoutMs, deadlineMs, now = Date.now } = {}) { // privacy-flow: team-hub-directory
  const base = parseBase(baseUrl);
  if (typeof token !== 'function') throw new Error('a team hub client needs token as a function');
  if (typeof fetch !== 'function') throw new Error('a team hub client needs a fetch function');
  if (typeof now !== 'function') throw new Error('a team hub client needs now as a function');
  const every = bounded(pollMs, POLL_MS), timeout = bounded(timeoutMs, TIMEOUT_MS), span = bounded(deadlineMs, DEADLINE_MS);
  let cache = [];
  const stateCache = new Map();
  // Run/card/repo/member/fence bindings remain in main. The renderer sees only
  // the directory's hash of this opaque client ref, never these routing IDs.
  const boardRoutes = new Map(), watchedTeams = new Set(), sentBoardRefs = new Set(), receiptCache = new Map();
  let journalCursor = 0;
  const partialRows = () => Object.assign([], { partial: true });
  const BOARD_TTL = 45_000;
  const TASK_INBOX_NOTICE = 'Task inbox: the agent reads messages with board_list_messages. Queued is not received or acknowledged. Sending does not resume a session.';
  const identifier = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(v);
  const routePin = (r) => JSON.stringify([r.team, r.principal, r.member, r.run, r.board, r.card, r.repo, r.fence, r.owner, r.ownerMember, r.provider]);
  const routeRef = (r) => `board-run:${crypto.createHash('sha256').update(routePin(r)).digest('hex')}`;

  const atNow = () => { try { return now(); } catch { return Date.now(); } };
  const viewer = () => {
    if (object(viewerOpt) && typeof viewerOpt.id === 'string' && viewerOpt.id) return { id: viewerOpt.id.slice(0, 100), name: str(viewerOpt.name, 80) || 'You' };
    if (typeof viewerId === 'string' && viewerId) return { id: viewerId.slice(0, 100), name: 'You' };
    return null;
  };
  const json = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
  const bearer = () => {
    const tok = token();
    if (typeof tok !== 'string' || !tok) throw new Error('no team hub token is current');
    return tok;
  };

  async function request(url, { method, body = undefined, deadline = 0, team = null }) {
    const ms = deadline ? Math.min(timeout, deadline - Date.now()) : timeout;
    if (!(ms > 0)) throw new Error('the team hub deadline passed');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    // Active requests retain their deadline; finally releases it on settlement.
    try {
      const res = await fetch(url, { // privacy-flow: team-hub-directory
        method, redirect: 'error', signal: ctl.signal,
        headers: { authorization: `Bearer ${bearer()}`, accept: 'application/json', ...(team === null ? {} : { 'X-Board-Team': team }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const len = Number(res.headers?.get?.('content-length'));
      if (Number.isSafeInteger(len) && len > MAX_BODY) return { status: res.status, body: null };
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader(), parts = [];
        let bytes = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value?.byteLength ?? 0;
          if (bytes > MAX_BODY) { ctl.abort(); Promise.resolve(reader.cancel?.()).catch(() => {}); return { status: res.status, body: null }; }
          parts.push(chunk.value);
        }
        return { status: res.status, body: json(Buffer.concat(parts).toString('utf8')) };
      }
      const raw = await res.text();
      return { status: res.status, body: Buffer.byteLength(raw) <= MAX_BODY ? json(raw) : null };
    } finally { clearTimeout(timer); }
  }

  async function listShared() {
    const r = await request(`${base}/api/interaction/v1/shared`, { method: 'GET' });
    if (r.status !== 200 || !object(r.body) || !Array.isArray(r.body.shared)) throw new Error('the team hub shared list is unreadable');
    const out = [], seen = new Set();
    for (const x of r.body.shared.slice(0, MAX_SHARED)) {
      const row = shareRow(x);
      if (row && !seen.has(row.ref)) { seen.add(row.ref); out.push(row); }
    }
    for (const ref of stateCache.keys()) if (!seen.has(ref)) stateCache.delete(ref);
    return out;
  }

  const sharedCall = (shareId, requestId, op, args, deadline = 0) =>
    request(`${base}/api/interaction/v1/shared/${encodeURIComponent(shareId)}/call`, { method: 'POST', body: { request_id: requestId, op, args }, deadline });

  const mapStatus = (code) => (code === 404 || code === 410 ? 'stale' : code === 401 || code === 403 ? 'forbidden' : 'unavailable');
  const reasonFor = (status) => REASONS[status] ?? REASONS.unavailable;
  const CHANGED = 'The session changed; try again.';
  // send() only: a generation race or any other named refusal means the session moved on, which is retryable.
  const movedOn = (res) => res.status === 'stale' || /generation[_ -]?(mismatch|race|changed|stale)/i.test(`${res.status ?? ''} ${res.error ?? ''} ${res.code ?? ''}`);
  function hubResult(r, send = false) {
    if (!object(r) || typeof r.status !== 'number') return failed('unavailable', REASONS.unavailable);
    if (r.status !== 200) return failed(mapStatus(r.status), reasonFor(mapStatus(r.status)));
    const res = object(r.body) && object(r.body.result) ? r.body.result : null;
    if (!res) return failed('unavailable', REASONS.unreadable);
    if (res.ok !== true) {
      if (res.status === 'unconfirmed') return failed('unconfirmed', 'No receipt yet; Claude may still act. Do not resend automatically.');
      if (send && res.status !== 'forbidden' && movedOn(res)) return failed('stale', CHANGED);
      const status = res.status === 'stale' ? 'stale' : res.status === 'forbidden' ? 'forbidden' : 'unavailable';
      return failed(status, reasonFor(status));
    }
    return { ok: true, result: res };
  }

  const deliveryOf = (d) => object(d) && typeof d.id === 'string' && d.id ? {
    id: str(d.id, 80), text: prose(d.text, 4000), by: typeof d.by === 'string' && d.by ? str(d.by, 80) : null,
    state: DELIVERY_STATES.includes(d.state) ? d.state : 'unknown', response: prose(d.response, 4000),
  } : null;

  // This is a main-process contract, separate from the smaller directory
  // projection. Generation and turn are Plexiform handles, never native
  // provider IDs. Main binds them to a one-use preview before rendering.
  const safeProse = (v, max) => typeof v === 'string' ? prose(redactSecrets(v, { docExamples: false }), max) : '';
  const safeTime = (v, at) => Number.isSafeInteger(v) && v >= 0 && v <= at ? v : null;
  const activityOf = (v, at) => object(v) && ACTIVITY_LABELS.includes(v.label) && ['working', 'completed'].includes(v.phase)
    && safeTime(v.observed_at, at) !== null && UUID.test(v.turn ?? '')
    ? { label: v.label, phase: v.phase, observed_at: v.observed_at, turn: v.turn } : null;
  function interactionDelivery(d, at) {
    if (!object(d) || typeof d.id !== 'string' || !d.id || d.id.length > 80 || str(d.id, 80) !== d.id) return null;
    return {
      id: d.id, text: safeProse(d.text, MAX_TEXT), by: str(d.by, 80) || null,
      mode: d.mode === 'steer' ? 'steer' : d.mode === 'new-turn' ? 'new-turn' : null,
      state: DELIVERY_STATES.includes(d.state) ? d.state : 'unknown', recorded: d.recorded === true,
      turn: typeof d.turn === 'string' && UUID.test(d.turn) ? d.turn : null,
      response: safeProse(d.response, 16_000), error: safeProse(d.error, 1000) || null,
      notices: (Array.isArray(d.notices) ? d.notices : []).slice(0, 5).map(x => safeProse(x, 1000)).filter(Boolean),
      sentAt: safeTime(d.sentAt, at), finishedAt: safeTime(d.finishedAt, at),
    };
  }
  function interactionState(s, row) {
    if (!object(s) || s.session !== row.session || !Number.isSafeInteger(s.generation) || s.generation < 1
      || !['ready', 'working', 'compacting', 'ended'].includes(s.status)
      || (s.activeTurn != null && (typeof s.activeTurn !== 'string' || !UUID.test(s.activeTurn)))) return null;
    const at = atNow(), entry = baseEntry(row);
    applyState(entry, { ok: true, result: { state: s } }, at, row.session);
    const acts = row.scope === 'interact' && s.status !== 'ended', caps = object(s.capabilities) ? s.capabilities : {};
    return {
      generation: s.generation, activeTurn: s.activeTurn ?? null, status: s.status, observed_at: entry.observed_at,
      provider: { id: entry.provider.id, label: entry.provider.label },
      capabilities: Object.fromEntries(['newTurn', 'steer', 'interrupt', 'ack', 'echo', 'stream'].map(k => [k, caps[k] === true && (!['newTurn', 'steer', 'interrupt'].includes(k) || acts)])),
      reporting: {
        task: entry.task_source ? { title: entry.task_title, source: entry.task_source, observed_at: entry.task_observed_at, received_at: entry.task_received_at } : null,
        input: entry.input_source ? { needed: entry.input_reported_needed, source: entry.input_source, observed_at: entry.input_observed_at, received_at: entry.input_received_at } : null,
        children: entry.children,
      },
      task_title: entry.task_title, input_needed: entry.input_needed,
      activity: activityOf(s.activity, at),
      deliveries: (Array.isArray(s.deliveries) ? s.deliveries : []).slice(-20).map(d => interactionDelivery(d, at)).filter(Boolean),
    };
  }

  const uncertain = () => failed('unconfirmed', 'No receipt yet; the session may still act. Do not resend automatically.');
  const actionReasons = {
    busy: 'A turn is running or a request is in flight. Refresh the session before acting.',
    invalid: REASONS.invalid,
    unsupported: 'This provider does not support that action.',
    refused: 'The provider refused that action.',
    unconfirmed: 'No receipt yet; the session may still act. Do not resend automatically.',
  };
  function interactionResult(r, row, { mutating = false } = {}) {
    if (!object(r) || typeof r.status !== 'number') return mutating ? uncertain() : failed('unavailable', REASONS.unavailable);
    if (r.status !== 200) {
      if (mutating && (r.status >= 500 || r.status <= 0)) return uncertain();
      const status = r.status === 409 ? 'stale' : mapStatus(r.status);
      return failed(status, status === 'stale' ? CHANGED : reasonFor(status));
    }
    const res = object(r.body) && object(r.body.result) ? r.body.result : null;
    if (!res) return mutating ? uncertain() : failed('unavailable', REASONS.unreadable);
    const state = object(res.state) ? interactionState(res.state, row) : null;
    // Do not associate even a valid-looking receipt with a different target.
    if (object(res.state) && !state) return failed('stale', CHANGED);
    // Older hosts/hubs filtered state deliveries but could leave a steer
    // receipt's top-level response unfiltered. Use its id only to locate the
    // already projected state delivery; never trust that parallel payload.
    const delivery = object(res.delivery) && typeof res.delivery.id === 'string'
      ? state?.deliveries.find(d => d.id === res.delivery.id) ?? null : null;
    if (res.ok !== true) {
      const status = movedOn(res) || res.status === 'gone' ? 'stale'
        : ['forbidden', 'unavailable', ...Object.keys(actionReasons)].includes(res.status) ? res.status : 'unavailable';
      return { ...failed(status, status === 'stale' ? CHANGED : actionReasons[status] ?? reasonFor(status)), ...(state ? { state } : {}), ...(delivery ? { delivery } : {}) };
    }
    if (!mutating) return state ? { ok: true, status: 'ok', state } : failed('unavailable', REASONS.unreadable);
    const status = [...DELIVERY_STATES, 'interrupt-requested'].includes(res.status) ? res.status : delivery?.state;
    // A generic success is not evidence of queuing, provider receipt or stop.
    if (!status || status === 'unknown') return uncertain();
    return { ok: true, status, ...(state ? { state } : {}), ...(delivery ? { delivery } : {}) };
  }

  function sameViewer(viewerArg) {
    return object(viewerArg) && typeof viewerArg.id === 'string' && !!viewerArg.id && (!viewer() || viewerArg.id === viewer().id);
  }
  async function sharedTarget(viewerArg, teamId, ref) {
    if (!sameViewer(viewerArg) || typeof teamId !== 'string' || !teamId || teamId.length > 100 || typeof ref !== 'string' || !UUID.test(ref)) return { error: failed('forbidden', REASONS.forbidden) };
    const pinned = cache.find(r => r.ref === ref);
    if (pinned && pinned.team.id !== teamId) return { error: failed('forbidden', REASONS.forbidden) };
    let all;
    try { all = await listShared(); } catch { return { error: failed('unavailable', REASONS.unavailable) }; }
    cache = all;
    const row = all.find(r => r.ref === ref);
    if (!row) return { error: failed('stale', REASONS.stale) };
    if (row.team.id !== teamId || row.owner.id === viewerArg.id) return { error: failed('forbidden', REASONS.forbidden) };
    if (pinned && (pinned.session !== row.session || pinned.owner.id !== row.owner.id)) return { error: failed('stale', CHANGED) };
    if (row.expiresAt !== null && (!Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= atNow())) return { error: failed('stale', REASONS.stale) };
    return { row };
  }
  async function readShared(row, viewerArg) {
    try {
      const r = await sharedCall(row.ref, crypto.randomUUID(), 'state', { session: row.session });
      const out = interactionResult(r, row);
      if (out.ok) rememberState(row, viewerArg, r.body.result.state);
      return out;
    }
    catch { return failed('unavailable', REASONS.unavailable); }
  }
  async function inspect(viewerArg, teamId, ref) {
    const who = viewerArg?.id;
    const target = await sharedTarget(viewerArg, teamId, ref);
    if (target.error) return target.error;
    const out = await readShared(target.row, viewerArg);
    if (!(viewerArg?.id === who && sameViewer(viewerArg))) return failed('forbidden', REASONS.forbidden);
    // T2: the share's current terms ride with a good read, so a thread never shows a cached scope.
    return out.ok ? { ...out, share: { scope: target.row.scope, expiresAt: target.row.expiresAt } } : out;
  }
  async function act(viewerArg, teamId, ref, action, requestId, fresh = () => true) {
    const who = viewerArg?.id;
    const current = () => { try { return viewerArg?.id === who && sameViewer(viewerArg) && fresh() === true; } catch { return false; } };
    if (!object(action) || Object.keys(action).some(k => !['operation', 'generation', 'turn', 'text'].includes(k))
      || !['send', 'steer', 'interrupt'].includes(action.operation) || !Number.isSafeInteger(action.generation) || action.generation < 1
      || (action.operation === 'send' ? action.turn !== null : typeof action.turn !== 'string' || !UUID.test(action.turn))
      || typeof fresh !== 'function' || (requestId !== undefined && (typeof requestId !== 'string' || !UUID.test(requestId)))) return failed('invalid', REASONS.invalid);
    const message = typeof action.text === 'string' ? action.text.trim() : '';
    if (action.operation === 'interrupt' ? action.text !== undefined : !message || message.includes('\0') || message.length > MAX_TEXT || Buffer.byteLength(message) > MAX_BYTES) return failed('invalid', REASONS.invalid);
    const target = await sharedTarget(viewerArg, teamId, ref);
    if (target.error) return target.error;
    if (!current()) return failed('forbidden', REASONS.forbidden);
    const row = target.row;
    if (row.scope !== 'interact') return failed('forbidden', 'This session is shared with you to watch only.');
    const before = await readShared(row, viewerArg);
    if (!current()) return failed('forbidden', REASONS.forbidden);
    if (!before.ok) return before;
    const state = before.state;
    if (state.generation !== action.generation || state.status === 'ended'
      || (action.operation === 'send' ? state.activeTurn !== null : state.activeTurn !== action.turn)) return failed('stale', CHANGED);
    if (action.operation === 'send' && state.status === 'working') return failed('busy', actionReasons.busy);
    if (action.operation !== 'send' && !state.capabilities[action.operation]) return failed('unsupported', actionReasons.unsupported);
    const args = { session: row.session, generation: action.generation };
    if (action.operation === 'interrupt') args.turn = action.turn;
    else { args.text = message; if (action.operation === 'steer') args.expectedTurn = action.turn; }
    try {
      if (!current()) return failed('forbidden', REASONS.forbidden);
      const result = await sharedCall(row.ref, requestId ?? crypto.randomUUID(), action.operation === 'interrupt' ? 'interrupt' : 'send', args);
      return current() ? interactionResult(result, row, { mutating: true }) : uncertain();
    }
    catch { return uncertain(); }
  }

  async function proposals(viewerArg, teamId, ref, operation, input = null, fresh = () => true) {
    const who = viewerArg?.id, current = () => sameViewer(viewerArg) && viewerArg?.id === who && fresh() === true;
    if (!['list','request','send','cancel'].includes(operation) || !current()) return failed('forbidden', REASONS.forbidden);
    const target = await sharedTarget(viewerArg, teamId, ref);
    if (target.error) return target.error;
    if (!current()) return failed('forbidden', REASONS.forbidden);
    const row = target.row;
    if (row.scope !== 'interact') return failed('forbidden', 'Owner-reviewed requests require an existing Watch and send share.');
    let endpoint = `${base}/api/interaction/v1/shared/${encodeURIComponent(ref)}/proposals`, method = operation === 'list' ? 'GET' : operation === 'cancel' ? 'DELETE' : 'POST', body;
    if (operation === 'request') {
      if (!object(input) || !UUID.test(input.id) || !UUID.test(input.decision) || !Number.isSafeInteger(input.version) || !Number.isSafeInteger(input.generation) || typeof input.title !== 'string' || typeof input.text !== 'string') return failed('invalid', REASONS.invalid);
      body = { id: input.id, decision: input.decision, version: input.version, generation: input.generation, title: input.title, text: input.text };
    } else if (operation === 'send' || operation === 'cancel') {
      if (!object(input) || !UUID.test(input.id) || !Number.isSafeInteger(input.version) || typeof input.digest !== 'string') return failed('invalid', REASONS.invalid);
      endpoint += `/${encodeURIComponent(input.id)}${operation === 'send' ? '/send' : ''}`;
      if (operation === 'send') {
        const before = await readShared(row, viewerArg);
        if (!current()) return failed('forbidden', REASONS.forbidden);
        if (!before.ok || before.state.generation !== input.generation || before.state.status !== 'ready' || before.state.activeTurn !== null) return failed('stale', 'The reviewed session is busy, ended or changed.');
        body = { version: input.version, digest: input.digest, request_id: crypto.randomUUID() };
      }
    }
    try {
      if (!current()) return failed('forbidden', REASONS.forbidden);
      const r = await request(endpoint, { method, ...(body ? { body } : {}) }); // privacy-flow: interaction-proposals
      if (!current()) return operation === 'send' ? uncertain() : failed('stale', CHANGED);
      if (r.status !== 200 || r.body?.ok !== true) return failed(r.status === 403 ? 'forbidden' : r.status === 409 || r.status === 404 ? 'stale' : 'unavailable', 'The hub did not accept this proposal action. Refresh its current state.');
      const valid = p => object(p) && UUID.test(p.id) && p.share === row.ref && object(p.requester) && p.requester.id === who && typeof p.requester.name === 'string'
        && UUID.test(p.decision) && Number.isSafeInteger(p.version) && p.version > 0 && Number.isSafeInteger(p.generation) && typeof p.digest === 'string' && /^[a-f0-9]{64}$/.test(p.digest)
        && typeof p.title === 'string' && p.title.length <= 120 && typeof p.text === 'string' && p.text.length <= 4000 && typeof p.status === 'string' && p.action === 'send' && p.budget === 1;
      const clean = p => ({ id:p.id, decision:p.decision, version:p.version, generation:p.generation, title:p.title, text:p.text, digest:p.digest, status:p.status,
        acknowledgedAt: typeof p.acknowledgedAt === 'string' ? p.acknowledgedAt : null, expiresAt: typeof p.expiresAt === 'string' ? p.expiresAt : null,
        receipt: object(p.receipt) && typeof p.receipt.id === 'string' ? { id:p.receipt.id.slice(0,100),state:String(p.receipt.state).slice(0,80) } : null });
      if (operation === 'list') return Array.isArray(r.body.proposals) && r.body.proposals.length <= 64 && r.body.proposals.every(valid) ? { ok:true, proposals:r.body.proposals.map(clean) } : failed('unavailable', REASONS.unavailable);
      return valid(r.body.proposal) ? { ok:true, proposal:clean(r.body.proposal) } : failed('unavailable', REASONS.unavailable);
    } catch { return operation === 'send' ? uncertain() : failed('unavailable', REASONS.unavailable); }
  }

  async function accountTeams() {
    const r = await request(`${base}/api/account`, { method: 'GET' });
    if (r.status !== 200 || !object(r.body) || r.body.user?.id !== viewer()?.id || !Array.isArray(r.body.teams)) return [];
    const out = [], seen = new Set();
    for (const t of r.body.teams.slice(0, MAX_TEAMS)) if (object(t) && identifier(t.id) && !seen.has(t.id)) {
      seen.add(t.id); out.push({ id: t.id, name: str(t.name, 80) || 'Team' });
    }
    return out;
  }

  // T1: the parse half is pure (no route is recorded), so a passive sidebar
  // read can list board runs without evicting Overview's message routes.
  async function boardRows(teamId, deadline = 0) {
    const routes = [], out = await parseBoardRows(teamId, deadline, routes);
    for (const [ref, route] of routes) boardRoutes.set(ref, route);
    while (boardRoutes.size > 500) boardRoutes.delete(boardRoutes.keys().next().value);
    return out;
  }
  async function parseBoardRows(teamId, deadline, routes) {
    const r = await request(`${base}/api/team-session-directory`, { method: 'GET', team: teamId, deadline });
    const at = atNow(), b = r.body, me = viewer();
    if (r.status !== 200 || !object(b) || b.schema !== 1 || !['complete', 'partial'].includes(b.status)
      || b.message_contract !== 'task-inbox' || b.team?.id !== teamId || !me || b.principal?.user_id !== me.id
      || !identifier(b.principal?.member_id) || !['owner', 'admin', 'member', 'viewer'].includes(b.principal.role)
      || !Number.isSafeInteger(b.observed_at) || b.observed_at < 0 || b.observed_at > at || !Array.isArray(b.sessions)) return partialRows();
    const out = [], seen = new Set();
    for (const x of b.sessions.slice(0, 200)) {
      if (!object(x) || !UUID.test(x.ref ?? '') || seen.has(x.ref) || !identifier(x.owner?.id) || !identifier(x.owner?.user_id)
        || !identifier(x.board?.id) || !identifier(x.card?.id) || !identifier(x.card?.repo_id)
        || !Number.isSafeInteger(x.card.fence) || x.card.fence < 0 || !['claude', 'codex'].includes(x.provider?.id)
        || !['claimed', 'running', 'quiet', 'blocked', 'suspended', 'reconnecting', 'unresponsive', 'orphaned', 'handing_over'].includes(x.state)) continue;
      seen.add(x.ref);
      const heartbeat = Number.isSafeInteger(x.hb_age_ms) && x.hb_age_ms >= 0 ? x.hb_age_ms : null;
      const age = heartbeat === null ? null : heartbeat + at - b.observed_at;
      const online = x.online === true && age !== null && age <= BOARD_TTL;
      const writer = b.principal.role !== 'viewer';
      const route = { team: teamId, principal: me.id, member: b.principal.member_id, run: x.ref, board: x.board.id,
        card: x.card.id, repo: x.card.repo_id, fence: x.card.fence, owner: x.owner.user_id, ownerMember: x.owner.id, provider: x.provider.id,
        canSend: writer && online && x.canSend === true, received: at };
      const ref = routeRef(route);
      routes.push([ref, route]);
      const input = online && x.input_needed === true;
      out.push({ ref, boardRunId: route.run, kind: 'board-run', messageContract: 'task-inbox', notice: TASK_INBOX_NOTICE,
        team: { id: teamId, name: str(b.team.name, 80) || 'Team' },
        owner: { id: x.owner.user_id, name: str(x.owner.name, 80) || 'Teammate', self: x.owner.user_id === me.id },
        // Team-board participation is the explicit sharing boundary for this
        // execution; private provider sessions still require a separate share.
        share: { explicit: true, scope: writer && x.canSend === true ? 'interact' : 'watch', revoked: false, expiresAt: null },
        board: { name: str(x.board.name, 80) || 'Board' }, card: { key: str(x.card.key, 80), title: cleanReportText(x.card.title, 200) || 'Untitled task' },
        provider: { id: x.provider.id, label: x.provider.id === 'claude' ? 'Claude Code' : 'Codex', kind: 'integrated' },
        device: { label: 'Team runner', local: false }, task_title: null,
        state: input ? 'input' : x.state === 'running' ? 'working' : x.state === 'quiet' ? 'idle' : x.state === 'blocked' ? 'waiting' : 'Unknown',
        input_needed: input, input_reported_needed: false, observed_at: age === null ? null : Math.max(0, at - age), online,
        self_reported: null, capabilities: { steer: false, interrupt: false }, handoffs: [], children: [], deliveries: [] });
    }
    if (b.status === 'partial' || b.sessions.length > 200 || out.length < b.sessions.length) out.partial = true;
    return out;
  }

  function boardDelivery(message, route, messages = []) {
    if (!object(message) || !UUID.test(message.id ?? '') || !UUID.test(message.thread_id ?? '') || message.card_id !== route.card || message.repo_id !== route.repo
      || message.fence !== route.fence || message.for_agent !== false || message.auto_resume !== false || message.grants_execution !== false) return null;
    const d = (Array.isArray(message.deliveries) ? message.deliveries : []).find(x => object(x) && x.recipient_run_id === route.run
      && x.recipient_card_id === route.card && x.recipient_member_id === route.ownerMember && x.fence === route.fence);
    if (!d) return null;
    const current = d.current_recipient === true, receipt = current && d.receipt_connection_current === true;
    let state = !current ? 'expired' : receipt && d.state === 'acknowledged' && d.acknowledgement_source === 'agent_reported' && typeof d.acknowledged_at === 'string' ? 'acknowledged'
      : receipt && ['received', 'acknowledged'].includes(d.state) && typeof d.received_at === 'string' ? 'recorded' : 'queued';
    const reply = messages.find(x => object(x) && UUID.test(x.id ?? '') && x.reply_to === message.id && x.thread_id === message.thread_id
      && x.card_id === route.card && x.repo_id === route.repo && x.fence === route.fence && x.author?.kind === 'run'
      && x.author.run_id === route.run && x.author.member_id === route.ownerMember && x.author.account_id === route.owner
      && x.author.identity_source === 'hub_run' && x.author.provider === route.provider && x.for_agent === false && x.auto_resume === false && x.grants_execution === false);
    if (current && reply) state = 'replied';
    return { id: crypto.createHash('sha256').update(`${routeRef(route)}:${message.id}`).digest('hex'), text: prose(message.body, 4000),
      by: str(message.author?.name, 80) || null, state, response: reply ? prose(reply.body, 4000) : '' };
  }

  async function boardMessages(route, deadline = 0) {
    const r = await request(`${base}/api/cards/${encodeURIComponent(route.card)}/messages?board_id=${encodeURIComponent(route.board)}`, { method: 'GET', team: route.team, deadline });
    return r.status === 200 && object(r.body) && r.body.auto_resume === false && Array.isArray(r.body.messages) ? r.body.messages.slice(0, 50) : [];
  }

  async function sendBoard(teamId, ref, message, requestId, fresh = () => true) {
    const principal = viewer()?.id;
    const current = () => { try { return !!principal && viewer()?.id === principal && fresh() === true; } catch { return false; } };
    if (!current()) return failed('forbidden', REASONS.forbidden);
    const pinned = boardRoutes.get(ref);
    if (!pinned || pinned.team !== teamId || pinned.principal !== viewer()?.id) return failed('stale', CHANGED);
    let rows;
    try { rows = await boardRows(teamId); } catch { return failed('unavailable', REASONS.unavailable); }
    if (!current()) return failed('forbidden', REASONS.forbidden);
    const freshRow = rows.find(x => x.ref === ref), route = boardRoutes.get(ref);
    if (!freshRow || !route || routePin(route) !== routePin(pinned)) return failed('stale', CHANGED);
    if (!route.canSend || !freshRow.online || route.received + BOARD_TTL < atNow()) return failed('forbidden', 'This task inbox is read only or its runner is offline.');
    const rid = typeof requestId === 'string' && UUID.test(requestId) ? requestId : crypto.randomUUID();
    let r;
    try {
      if (!current()) return failed('forbidden', REASONS.forbidden);
      r = await request(`${base}/api/cards/${encodeURIComponent(route.card)}/messages?board_id=${encodeURIComponent(route.board)}`, {
      method: 'POST', team: teamId, body: { request_id: rid, expected_fence: route.fence, kind: 'coordination', body: message, recipient_run_ids: [route.run] } }); }
    // A write may already be in the durable journal. Never invite automatic retry.
    catch { return failed('unconfirmed', 'No task-inbox receipt yet; the message may be queued. Do not resend automatically.'); }
    if (!current()) return failed('unconfirmed', 'The view changed while sending. The task inbox may have queued the message; do not resend automatically.');
    if (r.status >= 500 || r.status <= 0) return failed('unconfirmed', 'No task-inbox receipt yet; the message may be queued. Do not resend automatically.');
    if (r.status !== 200) return failed(r.status === 409 ? 'stale' : mapStatus(r.status), r.status === 409 ? CHANGED : reasonFor(mapStatus(r.status)));
    sentBoardRefs.add(ref); while (sentBoardRefs.size > 50) sentBoardRefs.delete(sentBoardRefs.values().next().value);
    const m = r.body?.message;
    const delivery = object(m) && m.request_id === rid && m.body === message && m.kind === 'coordination'
      && m.author?.kind === 'member' && m.author.member_id === route.member && m.author.account_id === route.principal
      && m.author.identity_source === 'staff_credential' ? boardDelivery(m, route) : null;
    return delivery ? { ok: true, status: 'queued', delivery, messageContract: 'task-inbox', notice: TASK_INBOX_NOTICE }
      : failed('unconfirmed', 'The task inbox answered without a matching receipt. Do not resend automatically.');
  }

  async function teams() {
    let rows;
    try { rows = await listShared(); } catch (e) { if (!boardDirectory) throw e; rows = []; }
    cache = rows;
    return teamsOf(rows);
  }
  async function teamsOf(rows) {
    const out = boardDirectory ? await accountTeams().catch(() => []) : [], seen = new Set(out.map(t => t.id));
    for (const row of rows) if (!seen.has(row.team.id) && out.length < MAX_TEAMS) { seen.add(row.team.id); out.push({ id: row.team.id, name: row.team.name }); }
    return out;
  }

  const baseEntry = (row) => ({
    ref: row.ref, team: { ...row.team }, owner: { ...row.owner },
    share: { explicit: true, scope: row.scope, expiresAt: row.expiresAt, revoked: false },
    provider: null, device: null, card: null, task_title: null, state: 'Unknown', input_needed: false, input_reported_needed: false,
    observed_at: null, self_reported: null, online: row.online, capabilities: {}, handoffs: [], children: [], deliveries: [],
  });

  // Passive directory rows are refreshed less often than the selected live
  // conversation. The cached projection has no routing/native IDs, and keeps
  // its original clocks: a cache hit is never fresh provider activity.
  const statePin = (row, viewerArg) => JSON.stringify([viewer()?.id ?? viewerArg?.id ?? null, row.ref, row.session, row.team.id, row.owner.id, row.scope, row.expiresAt]);
  const stateKeys = ['provider', 'state', 'capabilities', 'deliveries', 'activity', 'observed_at', 'task_title', 'task_source', 'task_observed_at', 'task_received_at', 'input_needed', 'input_reported_needed', 'input_source', 'input_observed_at', 'input_received_at', 'children'];
  const clone = v => structuredClone(v);
  function stateSlot(row, viewerArg) {
    const pin = statePin(row, viewerArg), old = stateCache.get(row.ref);
    if (old?.pin === pin) return old;
    const slot = { pin, readAt: null, pending: false, data: null, version: 0 };
    stateCache.delete(row.ref); stateCache.set(row.ref, slot);
    while (stateCache.size > MAX_SHARED) stateCache.delete(stateCache.keys().next().value);
    return slot;
  }
  function projectState(row, state, at) {
    if (!object(state) || state.session !== row.session) return null;
    const entry = baseEntry(row);
    applyState(entry, { ok: true, result: { state } }, at, row.session);
    return Object.fromEntries(stateKeys.filter(k => Object.hasOwn(entry, k)).map(k => [k, entry[k]]));
  }
  function rememberState(row, viewerArg, state) {
    const at = atNow(), data = projectState(row, state, at);
    if (!data) return;
    const slot = stateSlot(row, viewerArg);
    slot.version++; slot.readAt = at; slot.data = data;
  }
  function applyCached(entry, slot) {
    if (!slot.data) return;
    Object.assign(entry, clone(slot.data));
    if (entry.input_needed && (!Number.isSafeInteger(entry.input_observed_at) || atNow() - entry.input_observed_at > 90_000)) entry.input_needed = false;
  }

  function applyState(entry, out, at, expectedSession) {
    const s = out.ok && object(out.result.state) ? out.result.state : null;
    if (!s || s.session !== expectedSession) return;
    const pid = str(s.provider?.id, 40);
    entry.provider = { id: pid || 'unknown', label: str(s.provider?.label, 120) || 'AI', kind: /^local-/.test(pid) ? 'local' : 'integrated' };
    entry.state = s.status === 'working' || s.status === 'compacting' ? 'working' : s.status === 'ended' ? 'ended' : s.status === 'ready' ? 'idle' : 'Unknown';
    entry.capabilities = object(s.capabilities) ? { steer: s.capabilities.steer === true, interrupt: s.capabilities.interrupt === true } : {};
    entry.deliveries = (Array.isArray(s.deliveries) ? s.deliveries : []).slice(-10).map(deliveryOf).filter(Boolean);
    entry.activity = activityOf(s.activity, at);
    const t = typeof s.observed_at === 'number' ? s.observed_at : typeof s.updated_at === 'number' ? s.updated_at : NaN;
    entry.observed_at = Number.isFinite(t) && t >= 0 ? Math.min(Math.floor(t), at) : null;
    // Report clocks are independent of the owner's state-read receipt. Treat
    // hub metadata as untrusted and repeat the whitelist/redaction boundary.
    const validTime = (v) => Number.isSafeInteger(v) && v >= 0 && v <= at;
    const validReport = (v) => object(v) && REPORT_SOURCES.includes(v.source) && validTime(v.observed_at) && validTime(v.received_at) && v.observed_at <= v.received_at;
    const task = s.reporting?.task, input = s.reporting?.input;
    if (validReport(task) && typeof task.title === 'string') { entry.task_title = cleanReportText(task.title); entry.task_source = task.source; entry.task_observed_at = task.observed_at; entry.task_received_at = task.received_at; }
    if (validReport(input) && typeof input.needed === 'boolean') { entry.input_reported_needed = input.needed; entry.input_needed = input.needed && s.input_needed === true && at - input.observed_at <= 90_000; entry.input_source = input.source; entry.input_observed_at = input.observed_at; entry.input_received_at = input.received_at; if (entry.input_needed) entry.state = 'input'; }
    const seen = new Set();
    entry.children = (Array.isArray(s.reporting?.children) ? s.reporting.children : []).slice(0, 20).filter((c) => {
      if (!validReport(c) || !UUID.test(c.ref ?? '') || seen.has(c.ref) || !CHILD_STATES.includes(c.state) || !validTime(c.created_at) || c.created_at > c.observed_at) return false;
      seen.add(c.ref); return true;
    }).map((c) => ({ ref: c.ref, name: cleanReportText(c.name, 80) || 'Agent', task_title: cleanReportText(c.task_title), state: c.state, source: c.source, observed_at: c.observed_at, received_at: c.received_at, created_at: c.created_at }));
  }

  async function sessions(viewerArg, teamId) {
    if (typeof teamId !== 'string' || !teamId || teamId.length > 100) return [];
    let all, partial = false;
    try { all = await listShared(); } catch (e) { if (!boardDirectory) throw e; all = []; partial = true; }
    cache = all;
    if (boardDirectory) { watchedTeams.clear(); watchedTeams.add(teamId); }
    const rows = all.filter((r) => r.team.id === teamId).slice(0, MAX_PER_TEAM);
    const deadline = Date.now() + span, out = rows.map(baseEntry);
    const boardPending = boardDirectory ? boardRows(teamId, deadline).catch(partialRows) : Promise.resolve([]);
    let next = 0, settled = false;
    let cutTimer;
    const cut = new Promise((done) => { cutTimer = setTimeout(done, Math.max(deadline - Date.now(), 0)); });
    try {
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (settled || i >= rows.length || Date.now() >= deadline) return;
          const row = rows[i], slot = stateSlot(row, viewerArg), at = atNow();
          if (slot.pending || slot.readAt !== null && at >= slot.readAt && at - slot.readAt < DIRECTORY_STATE_MS) { applyCached(out[i], slot); continue; }
          slot.pending = true; slot.readAt = at; const version = ++slot.version;
          // Preserve the last report if this refresh is unavailable. Its
          // provider/report timestamps still age normally in the directory.
          applyCached(out[i], slot);
          try {
            const got = hubResult(await sharedCall(row.ref, crypto.randomUUID(), 'state', { session: row.session }, deadline));
            if (got.ok && stateCache.get(row.ref) === slot && slot.version === version) {
              const data = projectState(row, got.result.state, atNow());
              if (data) slot.data = data;
            }
            if (settled) return;
            applyCached(out[i], slot);
          }
          catch { /* listed without state */ }
          finally { slot.pending = false; }
        }
      };
      await Promise.race([Promise.all(Array.from({ length: Math.min(FANOUT, rows.length) }, worker)), cut]);
      settled = true;
      if (!boardDirectory) return out;
      const boards = await Promise.race([boardPending, cut.then(partialRows)]);
      // At most six bounded reads; a stalled journal cannot hide the directory.
      for (const e of boards) e.deliveries = receiptCache.get(e.ref) ?? [];
      const candidates = boards.filter(e => sentBoardRefs.has(e.ref));
      // Directory + one rotating journal per five-second cycle stays below the
      // shared 60/minute member-read budget; retain historical receipts meanwhile.
      const tracked = candidates.length ? [candidates[journalCursor++ % candidates.length]] : [];
      let cursor = 0, receiptsClosed = false;
      await Promise.race([Promise.all(Array.from({ length: Math.min(FANOUT, tracked.length) }, async () => {
        while (cursor < tracked.length && Date.now() < deadline) {
          const entry = tracked[cursor++], route = boardRoutes.get(entry.ref);
          try { const msgs = await boardMessages(route, deadline); if (!receiptsClosed) { entry.deliveries = msgs.map(m => boardDelivery(m, route, msgs)).filter(Boolean).slice(0, 10); receiptCache.set(entry.ref, entry.deliveries); while (receiptCache.size > 50) receiptCache.delete(receiptCache.keys().next().value); } } catch { /* no receipt evidence */ }
        }
      })), cut]);
      receiptsClosed = true;
      const combined = out.concat(boards).slice(0, MAX_SHARED);
      if (partial || boards.partial === true || out.length + boards.length > MAX_SHARED || all.length >= MAX_SHARED || rows.length >= MAX_PER_TEAM) combined.partial = true;
      return combined;
    } finally { clearTimeout(cutTimer); }
  }

  // T1: the chat-first sidebar's teammate rows. Read-only and side-effect free
  // for Overview: one shared list for every team, the same 45 s state cache
  // (so it adds no relay call inside a window Overview already filled), at most
  // PASSIVE_REFRESH expired slots refreshed per pass, a shorter deadline. It
  // never writes cache, watchedTeams or boardRoutes, never schedules poll(), and
  // a slot it refreshes calls no listener (poll()'s fingerprint never reads slots).
  // → { teamsTotal, teams: [{ id, name, entries }] (the first PASSIVE_TEAMS of teams()'s order), partial }.
  async function passiveSessions(viewerArg) {
    const result = { teamsTotal: 0, teams: [], partial: false };
    if (!sameViewer(viewerArg)) return result;
    let all;
    try { all = await listShared(); } catch (e) { if (!boardDirectory) throw e; all = []; result.partial = true; }
    const listed = await teamsOf(all);
    result.teamsTotal = listed.length;
    const picked = listed.slice(0, PASSIVE_TEAMS), ids = picked.map((t) => t.id);
    const deadline = Date.now() + Math.min(span, PASSIVE_SPAN_MS);
    let room = PASSIVE_ROWS;
    const rows = [];
    for (const id of ids) {
      const mine = all.filter((r) => r.team.id === id).slice(0, Math.min(MAX_PER_TEAM, Math.max(room, 0)));
      room -= mine.length;
      if (all.filter((r) => r.team.id === id).length > mine.length) result.partial = true;
      const entries = mine.map(baseEntry);
      result.teams.push({ id, name: picked.find((t) => t.id === id).name, entries });
      mine.forEach((row, i) => rows.push({ row, entry: entries[i] }));
    }
    const at = atNow(), due = [];
    for (const x of rows) {
      const slot = stateSlot(x.row, viewerArg);
      applyCached(x.entry, slot);
      if (!slot.pending && !(slot.readAt !== null && at >= slot.readAt && at - slot.readAt < DIRECTORY_STATE_MS)) due.push({ ...x, slot });
    }
    // Never-read slots first, then the oldest; the rest keep their cached report.
    due.sort((a, b) => (a.slot.readAt ?? -1) - (b.slot.readAt ?? -1));
    if (due.length > PASSIVE_REFRESH) result.partial = true;
    const refresh = due.slice(0, PASSIVE_REFRESH);
    const boardPending = boardDirectory ? Promise.all(ids.map((id) => parseBoardRows(id, deadline, []).catch(partialRows))) : Promise.resolve([]);
    let next = 0, settled = false, cutTimer;
    const cut = new Promise((done) => { cutTimer = setTimeout(() => { result.partial = true; done(); }, Math.max(deadline - Date.now(), 0)); });
    try {
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (settled || i >= refresh.length || Date.now() >= deadline) return;
          const { row, entry, slot } = refresh[i];
          if (slot.pending) continue;
          slot.pending = true; slot.readAt = atNow(); const version = ++slot.version;
          try {
            const got = hubResult(await sharedCall(row.ref, crypto.randomUUID(), 'state', { session: row.session }, deadline));
            if (got.ok && stateCache.get(row.ref) === slot && slot.version === version) {
              const data = projectState(row, got.result.state, atNow());
              if (data) slot.data = data;
            }
            if (!settled) applyCached(entry, slot);
          } catch { /* listed with its cached state */ } finally { slot.pending = false; }
        }
      };
      await Promise.race([Promise.all(Array.from({ length: Math.min(FANOUT, refresh.length) }, worker)), cut]);
      settled = true;
      if (next < refresh.length) result.partial = true;
      const boards = await Promise.race([boardPending, cut.then(() => null)]);
      if (!boards) { if (boardDirectory) result.partial = true; return result; }
      boards.forEach((list, i) => {
        if (list.partial === true) result.partial = true;
        const t = result.teams[i];
        t.entries = t.entries.concat(list.slice(0, MAX_PER_TEAM));
      });
      return result;
    } finally { clearTimeout(cutTimer); }
  }

  // T2: the shared list alone, as passiveSessions' rows, with no state read and no board read. A thread binds
  // from this: one relay call (listShared), the same entries a sidebar row id is derived from.
  async function sharedEntries(viewerArg) {
    const result = { teams: [] };
    if (!sameViewer(viewerArg)) return result;
    const all = await listShared();
    const ids = [];
    for (const r of all) if (!ids.includes(r.team.id) && ids.length < PASSIVE_TEAMS) ids.push(r.team.id);
    for (const id of ids) {
      const mine = all.filter((r) => r.team.id === id).slice(0, MAX_PER_TEAM);
      result.teams.push({ id, name: mine[0].team.name, entries: mine.map(baseEntry) });
    }
    return result;
  }

  async function send(viewerArg, teamId, ref, text, requestId, fresh = () => true) {
    const message = typeof text === 'string' ? text.trim() : '';
    if (!message || message.includes('\0') || message.length > MAX_TEXT || Buffer.byteLength(message) > MAX_BYTES) return failed('invalid', REASONS.invalid);
    if (typeof teamId !== 'string' || !teamId || teamId.length > 100) return failed('forbidden', REASONS.forbidden);
    const principal = viewerArg?.id;
    const current = () => { try { return viewerArg?.id === principal && sameViewer(viewerArg) && fresh() === true; } catch { return false; } };
    if (typeof fresh !== 'function' || !current()) return failed('forbidden', REASONS.forbidden);
    if (boardDirectory && typeof ref === 'string' && ref.startsWith('board-run:')) return sendBoard(teamId, ref, message, requestId, current);
    let row = cache.find((r) => r.ref === ref) ?? null;
    if (!row) { try { cache = await listShared(); } catch { cache = []; } row = cache.find((r) => r.ref === ref) ?? null; }
    if (!current()) return failed('forbidden', REASONS.forbidden);
    if (!row) return failed('stale', REASONS.stale);
    if (row.team.id !== teamId) return failed('forbidden', REASONS.forbidden);
    if (row.scope !== 'interact') return failed('forbidden', 'This session is shared with you to watch only.');
    let st;
    try { st = hubResult(await sharedCall(row.ref, crypto.randomUUID(), 'state', { session: row.session })); }
    catch { st = failed('unavailable', REASONS.unavailable); }
    if (!current()) return failed('forbidden', REASONS.forbidden);
    if (!st.ok) return st;
    const generation = object(st.result.state) && st.result.state.session === row.session && Number.isSafeInteger(st.result.state.generation) ? st.result.state.generation : null;
    if (generation === null) return failed('unavailable', REASONS.unreadable);
    const rid = typeof requestId === 'string' && UUID.test(requestId) ? requestId : crypto.randomUUID();
    let out;
    try {
      if (!current()) return failed('forbidden', REASONS.forbidden);
      const result = await sharedCall(row.ref, rid, 'send', { session: row.session, generation, text: message });
      if (!current()) return uncertain();
      out = result.status >= 500 || result.status <= 0 ? uncertain() : hubResult(result, true);
    }
    catch { out = uncertain(); }
    if (!out.ok) return out;
    const returnedState = out.result.state;
    const matched = object(returnedState) && returnedState.session === row.session && Array.isArray(returnedState.deliveries) && object(out.result.delivery)
      ? returnedState.deliveries.find(d => object(d) && d.id === out.result.delivery.id) : null;
    const delivery = deliveryOf(matched);
    const status = DELIVERY_STATES.includes(out.result.status) ? out.result.status : delivery?.state;
    return status && status !== 'unknown' ? { ok: true, status, ...(delivery ? { delivery } : {}) } : uncertain();
  }

  const listeners = new Set();
  let scheduled = null, running = false, last = '', failures = 0;
  const fingerprint = (rows) => JSON.stringify(rows.map((r) => [r.ref, r.session, r.scope, r.expiresAt, r.team, r.owner.id, r.owner.name, r.online]));
  async function poll() {
    running = true;
    try {
      let rows;
      try { rows = await listShared(); } catch (e) { if (!boardDirectory) throw e; rows = []; }
      cache = rows;
      failures = 0;
      const boardState = [], deadline = Date.now() + span;
      if (boardDirectory) for (const team of watchedTeams) {
        if (Date.now() >= deadline) break;
        try {
          const entries = await boardRows(team, deadline), candidates = entries.filter(e => sentBoardRefs.has(e.ref));
          const tracked = candidates.length ? [candidates[journalCursor++ % candidates.length]] : [];
          let cursor = 0;
          await Promise.all(Array.from({ length: Math.min(FANOUT, tracked.length) }, async () => {
            while (cursor < tracked.length && Date.now() < deadline) {
              const index = cursor++, e = tracked[index], route = boardRoutes.get(e.ref);
              try { const msgs = await boardMessages(route, deadline); receiptCache.set(e.ref, msgs.map(m => boardDelivery(m, route, msgs)).filter(Boolean).slice(0, 10)); while (receiptCache.size > 50) receiptCache.delete(receiptCache.keys().next().value); }
              catch { /* preserve historical receipt, never fabricate a new one */ }
            }
          }));
          boardState.push([team, entries.map(e => [e.ref, e.online, e.state, e.share.scope, e.input_needed]), entries.map(e => [e.ref, receiptCache.get(e.ref) ?? []])]);
        } catch { boardState.push([team, []]); }
      }
      const fp = fingerprint(rows) + JSON.stringify(boardState);
      if (fp !== last) {
        last = fp;
        for (const l of [...listeners]) { try { l(); } catch { /* a listener must never break the loop */ } }
      }
    } catch { failures++; }
    running = false;
    if (listeners.size && !scheduled) scheduleNext();
  }
  const arm = (ms) => { const t = setTimeout(() => { scheduled = null; poll(); }, ms); t.unref?.(); return t; };
  const scheduleNext = () => { scheduled = arm(failures ? Math.min(BACKOFF_MAX_MS, every * 2 ** Math.min(failures, 20)) : every); };
  const kick = () => { if (!scheduled && !running) scheduled = arm(0); };
  function onChange(fn) {
    if (typeof fn !== 'function') throw new Error('onChange needs a function');
    listeners.add(fn);
    kick();
    return () => {
      listeners.delete(fn);
      if (!listeners.size && scheduled) { clearTimeout(scheduled); scheduled = null; }
    };
  }

  return Object.defineProperty({ teams, sessions, passiveSessions, sharedEntries, inspect, act, send, proposals, onChange, viewer }, 'origin', { value: new URL(base).origin, enumerable: true });
}

module.exports = { createTeamHubClient, parseBase };
