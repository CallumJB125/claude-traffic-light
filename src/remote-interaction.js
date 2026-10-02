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
// Nothing here logs message text, responses or ids beyond the op name.
const crypto = require('node:crypto');
const { createInteractionHub } = require('./session-interaction');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPS = ['capabilities', 'list', 'state', 'launch', 'send', 'interrupt', 'close', 'watch'];
const MAX_FRAME = 64 * 1024, MAX_REPLY = 700 * 1024, MAX_SEEN = 2048, WATCH_MAX_MS = 20_000;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => object(v) && Object.keys(v).every((k) => keys.includes(k));
const refuse = (status, error) => ({ ok: false, status, error });
const REFUSED = {
  invalid: refuse('invalid', 'Check the selected session and message.'),
  forbidden: refuse('forbidden', 'This device is signed in to a different account.'),
  replayed: refuse('stale', 'This request was already handled. Refresh and try again.'),
  tooLarge: refuse('unavailable', 'The session is too large to show remotely.'),
  unavailable: refuse('unavailable', 'The provider did not accept the message.'),
};

// boardCurrent: remote sessions are not board-bound unless main says so.
function createRemoteInteractionHost({ userId, adapters, workspace, boardCurrent = (b) => b === null, now, log = () => {} }) {
  if (typeof userId !== 'string' || !userId) throw new Error('a remote host needs the signed-in user id');
  const actor = `account:${userId}`;
  const versions = new Map(); // session -> change counter
  const watchers = new Set();
  const seen = new Map();     // relay id / (from, rid) -> true, bounded
  const hub = createInteractionHub({
    adapters, workspace, boardCurrent, now,
    onEvent(a, state) {
      if (a !== actor) return;
      bump(state.session);
    },
  });
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
    return new Promise((resolve) => {
      const done = () => { watchers.delete(check); clearTimeout(timer); resolve(read()); };
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
  // rather than put it on the wire.
  function leaksTarget(text) {
    for (const s of hub.list(actor)) { const t = hub.targetOf(s.session); if (t && text.includes(t)) return true; }
    return false;
  }

  /** One relay.request frame (already parsed) → the result object for its relay.reply. */
  async function handle(frame) {
    if (!closed(frame, ['type', 'id', 'rid', 'user', 'from', 'op', 'args']) || frame.type !== 'relay.request'
      || typeof frame.id !== 'string' || !UUID.test(frame.id) || typeof frame.rid !== 'string' || !UUID.test(frame.rid)
      || typeof frame.from !== 'string' || !frame.from || frame.from.length > 100 || !OPS.includes(frame.op) || !object(frame.args)) return REFUSED.invalid;
    if (frame.user !== userId) return REFUSED.forbidden;
    if (!once(`id:${frame.id}`) || !once(`rid:${frame.from}:${frame.rid}`)) return REFUSED.replayed;
    let result;
    try { result = await run(frame.op, frame.args); } catch { result = REFUSED.unavailable; }
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text) > MAX_REPLY) return REFUSED.tooLarge;
    if (leaksTarget(text)) { log(`[remote-interaction] ${frame.op}: answer withheld (provider id)`); return REFUSED.unavailable; }
    return result;
  }

  /**
   * Hosts over the hub's /ws/interaction-host with this device's desktop
   * token. `WebSocket` is the `ws` constructor (headers are needed). Resolves
   * once the hub's welcome names this host's own user; rejects otherwise.
   */
  function connect({ url, token, WebSocket }) {
    disconnect();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, maxPayload: MAX_FRAME }); // privacy-flow: remote-interaction
      socket = ws;
      let welcomed = false;
      ws.on('message', async (data, isBinary) => {
        let f;
        try { if (isBinary) throw new Error('binary'); f = JSON.parse(String(data)); } catch { ws.close(1008, 'bad frame'); return; }
        if (!welcomed) {
          if (!closed(f, ['type', 'user', 'device']) || f.type !== 'relay.welcome' || f.user !== userId) { ws.close(1008, 'wrong account'); reject(new Error('The hub named a different account.')); return; }
          welcomed = true; resolve({ device: f.device }); return;
        }
        const id = object(f) && typeof f.id === 'string' && UUID.test(f.id) ? f.id : null;
        if (!id) { ws.close(1008, 'bad frame'); return; }
        const result = await handle(f);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'relay.reply', id, result }));
      });
      ws.on('unexpected-response', (_req, res) => reject(new Error(`The hub refused this device (${res.statusCode}).`)));
      ws.on('close', (code) => {
        if (socket === ws) socket = null;
        if (!welcomed) reject(new Error(`The hub closed the connection (${code}).`));
        // Signed out, revoked or account deleted: remote sessions end with it.
        if (code === 4401 || code === 4403) hub.reap(() => false).catch(() => {});
      });
      ws.on('error', () => {});
    });
  }
  function disconnect() { const ws = socket; socket = null; try { ws?.close(1000, 'bye'); } catch { /* gone */ } }
  function close() { disconnect(); for (const w of [...watchers]) w(); hub.stopAll(); }

  // `hub` is a main-only seam (tests and proof logs), never exposed remotely.
  return { handle, connect, disconnect, close, hub, actor, connected: () => socket?.readyState === 1 };
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

module.exports = { createRemoteInteractionHost, createRemoteInteractionClient, OPS };
