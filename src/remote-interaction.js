'use strict';
// Remote interaction over the account hub (board/hub/interaction-relay.js).
//
// Host (the Mac): owns its own interaction hub (src/session-interaction.js,
// unchanged) whose sessions belong to the actor `account:<user id>`. Only
// sessions launched through this host are reachable remotely; Overview-owned
// sessions keep their per-document actor and are never exposed here. The
// host pins the signed-in user it was built for: a welcome or request naming
// any other user is refused, whatever the hub says. Every request is
// handled by the same contract as local IPC (closed schemas, session +
// generation + turn staleness, delivery states), so the remote side gets
// exactly the local DTOs. Provider targets never leave this process: every
// answer is checked for any live target before it is sent.
//
// Client (any other signed-in device): plain HTTPS to the hub with the
// device's own desktop token. Every call carries a fresh request_id; the hub
// refuses a replayed one.
//
// Hosting is opt-in per device: enable() sets this device's hub role to
// 'host' (PUT /api/interaction/v1/role) and keeps one connection up, with
// exponential backoff + jitter across network blips and hub restarts (4000).
// It stops for good, and ends every remote session, when the hub refuses the
// device (401/403, 4401/4403: revoked, signed out, account deleted) or the
// connection stays down longer than idleReapMs. A 4409 REPLACED close is shown
// (status().state 'replaced') and not fought over. A 409 at the upgrade means
// another connection holds this device's host slot without our resume nonce:
// one retry after heldProbeMs (past the hub's half-open probe, so our own dead
// socket is cleared), then a second 409 is 'held' (someone else has this
// device's sign-in) and is shown, never retried.
//
// Nothing here logs message text, responses or ids beyond the op name.
const crypto = require('node:crypto');
const { createInteractionHub } = require('./session-interaction');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPS = ['capabilities', 'list', 'state', 'launch', 'send', 'interrupt', 'close', 'watch'];
const MAX_FRAME = 64 * 1024, MAX_REPLY = 700 * 1024, MAX_SEEN = 2048, WATCH_MAX_MS = 20_000;
const MAX_HANDLING = 16, MAX_WATCHES = 8, MAX_TARGETS = 512;
const RESUME_HEADER = 'x-plexiform-resume';
const RETRY = { baseMs: 1000, maxMs: 60_000, idleReapMs: 15 * 60_000, heldProbeMs: 6000 };
const ROLE_RESET_MS = 5000;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => object(v) && Object.keys(v).every((k) => keys.includes(k));
const refuse = (status, error) => ({ ok: false, status, error });
const REFUSED = {
  invalid: refuse('invalid', 'Check the selected session and message.'),
  forbidden: refuse('forbidden', 'This device is signed in to a different account.'),
  replayed: refuse('stale', 'This request was already handled. Refresh and try again.'),
  tooLarge: refuse('unavailable', 'The session is too large to show remotely.'),
  unavailable: refuse('unavailable', 'The provider did not accept the message.'),
  busy: refuse('unavailable', 'This computer is busy with other requests. Try again shortly.'),
};

// boardCurrent: remote sessions are not board-bound unless main says so.
function createRemoteInteractionHost({ userId, adapters, workspace, boardCurrent = (b) => b === null, now, log = () => {}, retry = {}, random = Math.random }) {
  if (typeof userId !== 'string' || !userId) throw new Error('a remote host needs the signed-in user id');
  const actor = `account:${userId}`;
  const versions = new Map(); // session -> change counter
  const watchers = new Set();
  const seen = new Map();     // relay id / (from, rid) -> true, bounded
  const targets = new Set();  // every provider target seen here, current or replaced, bounded
  const R = { ...RETRY, ...retry };
  let handling = 0, watching = 0;
  const hub = createInteractionHub({
    adapters, workspace, boardCurrent, now,
    onEvent(a, state) {
      if (a !== actor) return;
      remember(state.session);
      bump(state.session);
    },
  });
  function remember(session) {
    const t = hub.targetOf(session);
    if (!t || targets.has(t)) return;
    targets.add(t);
    while (targets.size > MAX_TARGETS) targets.delete(targets.values().next().value);
  }
  function bump(session) {
    versions.set(session, (versions.get(session) ?? 0) + 1);
    for (const w of [...watchers]) w();
  }
  let socket = null;

  function once(key) {
    if (seen.has(key)) return false;
    seen.set(key, true);
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
    return true;
  }

  function watch(args) {
    if (!closed(args, ['session', 'after']) || typeof args.session !== 'string' || !UUID.test(args.session) || !Number.isSafeInteger(args.after) || args.after < 0) return REFUSED.invalid;
    const read = () => {
      const state = hub.state({ session: args.session }, actor);
      return state ? { ok: true, version: versions.get(args.session) ?? 0, state } : refuse('stale', 'This session changed. Refresh and select it again.');
    };
    const first = read();
    if (!first.ok || first.version > args.after) return first;
    if (watching >= MAX_WATCHES) return REFUSED.busy;
    watching++;
    return new Promise((resolve) => {
      const done = () => { watchers.delete(check); clearTimeout(timer); watching--; resolve(read()); };
      const check = () => { const v = versions.get(args.session) ?? 0; if (v > args.after || !hub.state({ session: args.session }, actor)) done(); };
      const timer = setTimeout(done, WATCH_MAX_MS);
      timer.unref?.();
      watchers.add(check);
    });
  }

  async function run(op, args) {
    if ((op === 'capabilities' || op === 'list') && Object.keys(args).length) return REFUSED.invalid;
    if (op === 'capabilities') return { ok: true, providers: hub.capabilities() };
    if (op === 'list') return { ok: true, sessions: hub.list(actor) };
    if (op === 'state') { const state = hub.state(args, actor); return state ? { ok: true, state } : refuse('stale', 'This session changed. Refresh and select it again.'); }
    if (op === 'watch') return watch(args);
    const result = await hub[op](args, actor);
    // A closed session emits nothing; its watchers learn it here.
    if (op === 'close' && result.ok) bump(args.session);
    return result;
  }

  // A provider target (thread id) in an answer means a bug upstream: refuse
  // rather than put it on the wire. Replaced targets count too.
  function leaksTarget(text) {
    for (const s of hub.list(actor)) remember(s.session);
    for (const t of targets) if (text.includes(t)) return true;
    return false;
  }

  /** One relay.request frame (already parsed) → the result object for its relay.reply. */
  async function handle(frame) {
    if (!closed(frame, ['type', 'id', 'rid', 'user', 'from', 'op', 'args']) || frame.type !== 'relay.request'
      || typeof frame.id !== 'string' || !UUID.test(frame.id) || typeof frame.rid !== 'string' || !UUID.test(frame.rid)
      || typeof frame.from !== 'string' || !frame.from || frame.from.length > 100 || !OPS.includes(frame.op) || !object(frame.args)) return REFUSED.invalid;
    if (frame.user !== userId) return REFUSED.forbidden;
    if (handling >= MAX_HANDLING) return REFUSED.busy;
    if (!once(`id:${frame.id}`) || !once(`rid:${frame.from}:${frame.rid}`)) return REFUSED.replayed;
    for (const x of hub.list(actor)) remember(x.session);
    let result;
    handling++;
    try { result = await run(frame.op, frame.args); } catch { result = REFUSED.unavailable; } finally { handling--; }
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text) > MAX_REPLY) return REFUSED.tooLarge;
    if (leaksTarget(text)) { log(`[remote-interaction] ${frame.op}: answer withheld (provider id)`); return REFUSED.unavailable; }
    return result;
  }

  let state = 'off', notice = null, resume = null, retryTimer = null, idleTimer = null, attempts = 0, conflicts = 0, running = null;
  const reapRemote = () => hub.reap(() => false).catch(() => {});
  function idleFrom() {
    if (idleTimer || !running) return;
    idleTimer = setTimeout(() => { idleTimer = null; reapRemote(); }, R.idleReapMs);
    idleTimer.unref?.();
  }
  function stopRunning(next) {
    running = null; state = next;
    clearTimeout(retryTimer); retryTimer = null;
    clearTimeout(idleTimer); idleTimer = null;
  }

  /**
   * One connection over the hub's /ws/interaction-host with this device's
   * desktop token. `WebSocket` is the `ws` constructor (headers are needed).
   * Resolves once the hub's welcome names this host's own user; rejects
   * otherwise (err.status: the hub's HTTP refusal, err.code: its close code).
   */
  function connect({ url, token, WebSocket }) {
    disconnect();
    return new Promise((resolve, reject) => {
      const headers = { authorization: `Bearer ${typeof token === 'function' ? token() : token}` };
      if (resume) headers[RESUME_HEADER] = resume;
      const ws = new WebSocket(url, { headers, maxPayload: MAX_FRAME }); // privacy-flow: remote-interaction
      socket = ws;
      let welcomed = false;
      const fail = (msg, extra) => reject(Object.assign(new Error(msg), extra));
      ws.on('message', async (data, isBinary) => {
        let f;
        try { if (isBinary) throw new Error('binary'); f = JSON.parse(String(data)); } catch { ws.close(1008, 'bad frame'); return; }
        if (!welcomed) {
          if (!closed(f, ['type', 'user', 'device', 'resume']) || f.type !== 'relay.welcome' || f.user !== userId || typeof f.resume !== 'string') { ws.close(1008, 'wrong account'); fail('The hub named a different account.', { wrongAccount: true }); return; }
          welcomed = true; resume = f.resume; resolve({ device: f.device }); return;
        }
        if (closed(f, ['type', 'kind']) && f.type === 'relay.notice') {
          if (f.kind === 'replace-refused') { notice = 'Another connection tried to use this computer\'s sign-in and was refused.'; log('[remote-interaction] a second connection for this device was refused'); }
          return;
        }
        const id = object(f) && typeof f.id === 'string' && UUID.test(f.id) ? f.id : null;
        if (!id) { ws.close(1008, 'bad frame'); return; }
        const result = await handle(f);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'relay.reply', id, result }));
      });
      ws.on('unexpected-response', (req, res) => { fail(`The hub refused this device (${res.statusCode}).`, { status: res.statusCode }); req.destroy?.(); });
      ws.on('close', (code) => {
        if (socket !== ws) return;
        socket = null;
        if (!welcomed) fail(`The hub closed the connection (${code}).`, { code });
        // Signed out, revoked or account deleted: remote sessions end with it.
        if (code === 4401 || code === 4403) { reapRemote(); if (running) stopRunning('signed-out'); return; }
        if (code === 4409) { if (running) { stopRunning('replaced'); log('[remote-interaction] replaced by another connection of this device; not reconnecting'); } return; }
        if (running) { state = 'retrying'; idleFrom(); schedule(); }
      });
      ws.on('error', () => {});
    });
  }

  function schedule(atLeast = 0) {
    if (!running || retryTimer) return;
    const cap = Math.min(R.maxMs, R.baseMs * 2 ** Math.min(attempts, 16));
    const wait = Math.max(atLeast, Math.round(cap / 2 + random() * cap / 2));
    attempts++;
    retryTimer = setTimeout(() => { retryTimer = null; attempt(running); }, wait);
    retryTimer.unref?.();
  }

  async function attempt(run) {
    if (!run || run !== running) return;
    state = attempts ? 'retrying' : 'connecting';
    try {
      await connect(run);
      if (run !== running) return;
      attempts = 0; conflicts = 0; state = 'connected';
      clearTimeout(idleTimer); idleTimer = null;
    } catch (e) {
      if (run !== running) return;
      if (e.status === 401 || e.status === 403 || e.wrongAccount) { reapRemote(); stopRunning(e.wrongAccount ? 'refused' : 'signed-out'); return; }
      if (e.status === 409) {
        if (++conflicts >= 2) { reapRemote(); stopRunning('held'); log('[remote-interaction] another connection holds this device; not reconnecting'); return; }
        state = 'retrying'; idleFrom(); schedule(R.heldProbeMs); return;
      }
      conflicts = 0;
      state = 'retrying'; idleFrom(); schedule();
    }
  }

  /**
   * Opt in and keep hosting: set this device's hub role to 'host', then stay
   * connected. `token` may be a function (read per attempt, never kept).
   */
  async function enable({ baseUrl, url = `${baseUrl.replace(/^http/, 'ws')}/ws/interaction-host`, token, WebSocket, fetch = globalThis.fetch }) { // privacy-flow: remote-interaction
    stopRunning('connecting');
    const tok = typeof token === 'function' ? token() : token;
    let res;
    try { res = await fetch(`${baseUrl}/api/interaction/v1/role`, { method: 'PUT', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ role: 'host' }) }); } // privacy-flow: remote-interaction
    catch { res = null; }
    if (res && (res.status === 401 || res.status === 403)) { reapRemote(); state = 'signed-out'; return status(); }
    attempts = 0; conflicts = 0; resume = null; notice = null;
    running = { url, token, WebSocket };
    if (!res || !res.ok) { state = 'retrying'; idleFrom(); schedule(); return status(); }
    await attempt(running);
    return status();
  }

  /**
   * Opt out: drop the connection, end remote sessions, and set the role back
   * to 'client' on the hub (bounded by timeoutMs). → true when the hub has no
   * host role for this sign-in any more (200, or 401/403: the token is gone),
   * false when it could not be told (the caller retries: resetRole).
   */
  async function disable({ baseUrl, token, fetch = globalThis.fetch, timeoutMs = ROLE_RESET_MS } = {}) { // privacy-flow: remote-interaction
    stopRunning('off');
    disconnect();
    resume = null;
    await reapRemote();
    if (!baseUrl || !token) return false;
    return resetRole({ baseUrl, token, fetch, timeoutMs });
  }

  function status() { return { state, notice, connected: socket?.readyState === 1 }; }

  function disconnect() { const ws = socket; socket = null; try { ws?.close(1000, 'bye'); } catch { /* gone */ } }
  function close() { stopRunning('off'); disconnect(); for (const w of [...watchers]) w(); hub.stopAll(); }

  // `hub` is a main-only seam (tests and proof logs), never exposed remotely.
  return { handle, connect, enable, disable, status, disconnect, close, hub, actor, connected: () => socket?.readyState === 1 };
}

/** PUT role=client with this token, bounded. → true once the hub has no host role for it. */
async function resetRole({ baseUrl, token, fetch = globalThis.fetch, timeoutMs = ROLE_RESET_MS }) { // privacy-flow: remote-interaction
  const tok = typeof token === 'function' ? token() : token;
  if (!tok) return false;
  try {
    const res = await fetch(`${baseUrl}/api/interaction/v1/role`, { method: 'PUT', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ role: 'client' }), signal: AbortSignal.timeout(timeoutMs) }); // privacy-flow: remote-interaction
    return res.ok || res.status === 401 || res.status === 403;
  } catch { return false; }
}

/** The other device's side: list hosts, then call ops on one. */
function createRemoteInteractionClient({ baseUrl, token, fetch = globalThis.fetch }) { // privacy-flow: remote-interaction
  async function request(method, path, body) {
    const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); // privacy-flow: remote-interaction
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, body: json };
  }
  const hosts = () => request('GET', '/api/interaction/v1/hosts');
  // → {status, body:{host, result}} or {status, body:{error}}. requestId only for replay tests.
  const call = (host, op, args = {}, requestId = crypto.randomUUID()) =>
    request('POST', `/api/interaction/v1/hosts/${encodeURIComponent(host)}/call`, { request_id: requestId, op, args });
  return { hosts, call, request };
}

module.exports = { createRemoteInteractionHost, createRemoteInteractionClient, resetRole, OPS };
