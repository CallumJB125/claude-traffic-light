'use strict';
// Real team hub client for Overview "Team sessions" over the interaction hub's
// share endpoints. Every hub response is untrusted: rows are whitelisted,
// capped and stripped of control characters; failures map to a fixed reason
// table returned as both `error` and `reason`. The token is a function, re-read
// on every request, and never stored, logged or returned.
const crypto = require('node:crypto');
const { cleanReportText, REPORT_SOURCES, CHILD_STATES } = require('./session-interaction');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SHARED = 300, MAX_TEAMS = 64, MAX_PER_TEAM = 100, FANOUT = 6;
const MAX_TEXT = 4000, MAX_BYTES = 8192, MAX_BODY = 1_000_000;
const POLL_MS = 5000, TIMEOUT_MS = 15_000, DEADLINE_MS = 20_000, BACKOFF_MAX_MS = 60_000;
const DELIVERY_STATES = Object.freeze(['queued', 'sending', 'unconfirmed', 'delivered', 'acknowledged', 'recorded', 'responding', 'completed', 'interrupted', 'failed', 'replied', 'refused', 'expired', 'unknown']);
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

  async function accountTeams() {
    const r = await request(`${base}/api/account`, { method: 'GET' });
    if (r.status !== 200 || !object(r.body) || r.body.user?.id !== viewer()?.id || !Array.isArray(r.body.teams)) return [];
    const out = [], seen = new Set();
    for (const t of r.body.teams.slice(0, MAX_TEAMS)) if (object(t) && identifier(t.id) && !seen.has(t.id)) {
      seen.add(t.id); out.push({ id: t.id, name: str(t.name, 80) || 'Team' });
    }
    return out;
  }

  async function boardRows(teamId, deadline = 0) {
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
      boardRoutes.set(ref, route);
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
    while (boardRoutes.size > 500) boardRoutes.delete(boardRoutes.keys().next().value);
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

  async function sendBoard(teamId, ref, message, requestId) {
    const pinned = boardRoutes.get(ref);
    if (!pinned || pinned.team !== teamId || pinned.principal !== viewer()?.id) return failed('stale', CHANGED);
    let rows;
    try { rows = await boardRows(teamId); } catch { return failed('unavailable', REASONS.unavailable); }
    const fresh = rows.find(x => x.ref === ref), route = boardRoutes.get(ref);
    if (!fresh || !route || routePin(route) !== routePin(pinned)) return failed('stale', CHANGED);
    if (!route.canSend || !fresh.online || route.received + BOARD_TTL < atNow()) return failed('forbidden', 'This task inbox is read only or its runner is offline.');
    const rid = typeof requestId === 'string' && UUID.test(requestId) ? requestId : crypto.randomUUID();
    let r;
    try { r = await request(`${base}/api/cards/${encodeURIComponent(route.card)}/messages?board_id=${encodeURIComponent(route.board)}`, {
      method: 'POST', team: teamId, body: { request_id: rid, expected_fence: route.fence, kind: 'coordination', body: message, recipient_run_ids: [route.run] } }); }
    // A write may already be in the durable journal. Never invite automatic retry.
    catch { return failed('unconfirmed', 'No task-inbox receipt yet; the message may be queued. Do not resend automatically.'); }
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

  function applyState(entry, out, at) {
    const s = out.ok && object(out.result.state) ? out.result.state : null;
    if (!s) return;
    const pid = str(s.provider?.id, 40);
    entry.provider = { id: pid || 'unknown', label: str(s.provider?.label, 120) || 'AI', kind: /^local-/.test(pid) ? 'local' : 'integrated' };
    entry.state = s.status === 'working' || s.status === 'compacting' ? 'working' : s.status === 'ended' ? 'ended' : s.status === 'ready' ? 'idle' : 'Unknown';
    entry.capabilities = object(s.capabilities) ? { steer: s.capabilities.steer === true, interrupt: s.capabilities.interrupt === true } : {};
    entry.deliveries = (Array.isArray(s.deliveries) ? s.deliveries : []).slice(-10).map(deliveryOf).filter(Boolean);
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
          try {
            const got = hubResult(await sharedCall(rows[i].ref, crypto.randomUUID(), 'state', { session: rows[i].session }, deadline));
            if (settled) return;
            applyState(out[i], got, atNow());
          }
          catch { /* listed without state */ }
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

  async function send(viewerArg, teamId, ref, text, requestId) {
    const message = typeof text === 'string' ? text.trim() : '';
    if (!message || message.includes('\0') || message.length > MAX_TEXT || Buffer.byteLength(message) > MAX_BYTES) return failed('invalid', REASONS.invalid);
    if (typeof teamId !== 'string' || !teamId || teamId.length > 100) return failed('forbidden', REASONS.forbidden);
    if (boardDirectory && typeof ref === 'string' && ref.startsWith('board-run:')) return sendBoard(teamId, ref, message, requestId);
    let row = cache.find((r) => r.ref === ref) ?? null;
    if (!row) { try { cache = await listShared(); } catch { cache = []; } row = cache.find((r) => r.ref === ref) ?? null; }
    if (!row) return failed('stale', REASONS.stale);
    if (row.team.id !== teamId) return failed('forbidden', REASONS.forbidden);
    if (row.scope !== 'interact') return failed('forbidden', 'This session is shared with you to watch only.');
    let st;
    try { st = hubResult(await sharedCall(row.ref, crypto.randomUUID(), 'state', { session: row.session })); }
    catch { st = failed('unavailable', REASONS.unavailable); }
    if (!st.ok) return st;
    const generation = object(st.result.state) && Number.isSafeInteger(st.result.state.generation) ? st.result.state.generation : null;
    if (generation === null) return failed('unavailable', REASONS.unreadable);
    const rid = typeof requestId === 'string' && UUID.test(requestId) ? requestId : crypto.randomUUID();
    let out;
    try { out = hubResult(await sharedCall(row.ref, rid, 'send', { session: row.session, generation, text: message }), true); }
    catch { out = failed('unavailable', REASONS.unavailable); }
    if (!out.ok) return out;
    return { ok: true, status: 'queued', delivery: deliveryOf(out.result.delivery) };
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

  return Object.defineProperty({ teams, sessions, send, onChange, viewer }, 'origin', { value: new URL(base).origin, enumerable: true });
}

module.exports = { createTeamHubClient };
