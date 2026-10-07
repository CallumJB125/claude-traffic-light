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
// Team sharing (board/hub/interaction-shares.js): the owner may share one
// session at a time with one team, scope 'watch' (state, watch) or
// 'interact' (also send, interrupt), with an optional expiry. The share is
// created here, through this device's own token, and kept here too: a
// relayed teammate call is served only when this Mac holds a live share with
// that id, team, session and scope, the expiry has not passed on this Mac's
// clock, and the caller is one of the members the hub listed for it (a
// member who joins later gets access at the next refresh). Otherwise it is
// refused whatever the hub says. Send and interrupt also need the member's
// team role to act (owner, admin, member): a 'viewer' only watches. A
// teammate sees only deliveries sent since this share was created, never
// earlier history. A teammate never lists, launches or closes, never sees the
// owner's other sessions, and their sends are labelled ("Sent by <name>") in
// the owner's transcript; a name another member of the share, or the owner,
// also uses gets a short stable suffix. Teammates get a bounded part of this
// Mac's capacity (each MAX_PER_TEAMMATE, all together MAX_SHARED_*), so the
// owner's own devices always keep the rest. Stopping a share drops it
// here first, then tells the hub. Sessions Overview started are reachable
// only once shared (main passes sharedTarget), never through 'list'.
//
// End-to-end (W2-A, src/e2e/relay-envelope.js, docs/relay-e2e-threat-model.md):
// with `e2e` set, a relayed call from a paired device arrives as an opaque
// `enc` envelope; it is opened here (pair keys exchanged at pairing, AAD bound
// to this desktop, the device, the session, the sequence number, the relay
// request id and the op; each (session, seq) accepted once) and the answer
// goes back sealed, so the hub sees routing metadata only. With e2e.required
// (the default once e2e is given) a plain own-device call is refused: a hub
// cannot read sessions by asking in plaintext. Teammate (shared) calls stay
// plain: they are not paired with this computer (see the threat model).
// Without `e2e` nothing changes (plain relay, as before).
//
// Nothing here logs message text, responses or ids beyond the op name.
const crypto = require('node:crypto');
const { createInteractionHub } = require('./session-interaction');
const Envelope = require('./e2e/relay-envelope.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPS = ['capabilities', 'list', 'state', 'launch', 'send', 'interrupt', 'close', 'watch'];
const MAX_FRAME = 64 * 1024, MAX_REPLY = 700 * 1024, MAX_SEEN = 2048, WATCH_MAX_MS = 20_000;
const MAX_HANDLING = 16, MAX_WATCHES = 8, MAX_TARGETS = 512, MAX_SHARES = 64, SHARED_POLL_MS = 200;
const MAX_SHARED_HANDLING = 8, MAX_SHARED_WATCHES = 4, MAX_PER_TEAMMATE = 2;
const SCOPE_OPS = { watch: ['state', 'watch'], interact: ['state', 'watch', 'send', 'interrupt'] };
const ACTING_ROLES = ['owner', 'admin', 'member'];
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
  notShared: refuse('forbidden', 'This session is not shared with you.'),
  gone: refuse('stale', 'This session is no longer shared.'),
};
// Plain refusals to a sealed call (made before it could be opened): fixed
// text and a code the device's channel maps to its own wording.
const e2eRefusal = (code) => ({ ok: false, status: 'e2e', error: code === 'required' ? 'This computer only accepts end-to-end encrypted requests. Pair this device with it first.' : 'This computer refused the end-to-end request.', e2e: code });
const E2E_OF = new Map([[REFUSED.invalid, 'malformed'], [REFUSED.forbidden, 'malformed'], [REFUSED.replayed, 'replayed'], [REFUSED.busy, 'busy']]);

// boardCurrent: remote sessions are not board-bound unless main says so.
// sharedTarget(session) → {hub, actor} | null: another interaction hub's
// session (Overview) that may be shared; this host's own sessions always may.
// e2e: {did, privateKey, peer(dev) → ECDH public (base64url) | null, required = true}
// (see createDesktopChannel in src/e2e/relay-envelope.js).
function createRemoteInteractionHost({ userId, adapters, workspace, boardCurrent = (b) => b === null, now, log = () => {}, retry = {}, random = Math.random, sharedTarget = () => null, e2e = null }) {
  if (typeof userId !== 'string' || !userId) throw new Error('a remote host needs the signed-in user id');
  const channel = e2e ? Envelope.createDesktopChannel({ did: e2e.did, privateKey: e2e.privateKey, peer: e2e.peer, now: now ?? Date.now }) : null;
  const e2eRequired = !!e2e && e2e.required !== false;
  const actor = `account:${userId}`;
  const versions = new Map(); // session -> change counter
  const watchers = new Set();
  const seen = new Map();     // relay id / (from, rid) -> true, bounded
  const targets = new Set();  // every provider target seen here, current or replaced, bounded
  const R = { ...RETRY, ...retry };
  let handling = 0, watching = 0, sharedHandling = 0, sharedWatching = 0;
  const byTeammate = new Map(); // teammate user id -> calls in flight
  const clock = now ?? Date.now;
  const shares = new Map();   // share id -> {id, session, team, teamName, scope, createdAt, expiresAt, ownerName, users: Map(user id -> {name, act})}
  const prints = new Map();   // share id -> {text, version}
  const sharedWaits = new Set(); // exact share watches; revocation releases capacity immediately
  const hub = createInteractionHub({
    adapters, workspace, boardCurrent, now,
    onEvent(a, state) {
      if (a !== actor) return;
      remember(state.session);
      bump(state.session);
    },
  });
  function remember(session, from = hub) {
    const t = from.targetOf(session);
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

  // ── Team sharing ────────────────────────────────────────────────────────
  function targetFor(session) {
    if (hub.state({ session }, actor)) return { hub, actor };
    let t = null;
    try { t = sharedTarget(session); } catch { t = null; }
    return t && t.hub && typeof t.actor === 'string' && t.hub.state({ session }, t.actor) ? t : null;
  }
  // A teammate sees the session's messages and responses sent since the share
  // was created (never earlier history), never the owner's board key. A steer
  // into a turn that began before the share shows no response: it holds pre-share output.
  function project(state, sh) {
    const { board, reporting, task_title, input_needed, ...rest } = state;
    const after = rest.deliveries.filter((d) => d.sentAt >= sh.createdAt);
    const fresh = new Set(after.filter((d) => d.mode === 'new-turn' && d.turn != null).map((d) => d.turn));
    // A fresh host receipt or a repeated old hook report cannot expose metadata
    // from before the share. Child creation is independently gated as well:
    // an old child's later status must not reveal its private name/task.
    const at = clock();
    const visible = (r) => object(r) && Number.isSafeInteger(r.observed_at) && r.observed_at > sh.createdAt && r.observed_at <= at;
    const task = visible(reporting?.task) ? reporting.task : null;
    const input = visible(reporting?.input) ? reporting.input : null;
    const children = (Array.isArray(reporting?.children) ? reporting.children : []).filter((c) => visible(c) && Number.isSafeInteger(c.created_at) && c.created_at > sh.createdAt).slice(0, 20);
    return { ...rest, task_title: task?.title ?? null, input_needed: input_needed === true && input?.needed === true && input.observed_at >= 0 && at - input.observed_at <= 90_000, reporting: { task, input, children }, deliveries: after.map((d) => (d.mode === 'new-turn' || fresh.has(d.turn) ? d : { ...d, response: '' })) };
  }
  function sharedRead(t, sh) {
    const st = t.hub.state({ session: sh.session }, t.actor);
    if (!st) return null;
    const out = project(st, sh), text = JSON.stringify(out);
    let p = prints.get(sh.id);
    if (!p) { p = { text, version: 1 }; prints.set(sh.id, p); while (prints.size > MAX_SHARES) prints.delete(prints.keys().next().value); }
    else if (p.text !== text) { p.text = text; p.version++; }
    // Receipt time proves the owner's host answered this authorized state read;
    // it does not claim new provider activity or refresh child report times.
    return { ok: true, version: p.version, state: { ...out, observed_at: clock() } };
  }
  const liveShare = (sh) => !!sh && shares.get(sh.id) === sh && (sh.expiresAt === null || clock() < sh.expiresAt);

  // A relayed teammate call: served only against this Mac's own copy of the share.
  async function runShared(frame) {
    const s = frame.share, args = frame.args;
    if (!closed(s, ['id', 'team', 'user', 'name', 'scope']) || typeof s.id !== 'string' || typeof s.team !== 'string' || typeof s.user !== 'string' || typeof args.session !== 'string') return REFUSED.invalid;
    const sh = shares.get(s.id);
    const member = sh?.users.get(s.user);
    if (!sh || s.user === userId || sh.team !== s.team || !member || sh.session !== args.session || !SCOPE_OPS[member.act ? sh.scope : 'watch'].includes(frame.op)) return REFUSED.notShared;
    if (!liveShare(sh)) { dropShare(sh.id); return REFUSED.gone; }
    const t = targetFor(sh.session);
    if (!t) { dropShare(sh.id); return REFUSED.gone; }
    remember(sh.session, t.hub);
    if (frame.op === 'state') {
      if (!closed(args, ['session'])) return REFUSED.invalid;
      return sharedRead(t, sh) ?? REFUSED.gone;
    }
    if (frame.op === 'watch') return sharedWatch(sh, t, args);
    if (frame.op === 'send') {
      if (!closed(args, ['session', 'generation', 'text', 'expectedTurn'])) return REFUSED.invalid;
      const st = t.hub.state({ session: sh.session }, t.actor);
      const req = { session: sh.session, generation: args.generation, board: st.board, text: args.text };
      if (args.expectedTurn !== undefined) req.expectedTurn = args.expectedTurn;
      const result = await t.hub.send(req, t.actor, { by: member.name });
      return result.state ? { ...result, state: project(result.state, sh) } : result;
    }
    if (!closed(args, ['session', 'generation', 'turn'])) return REFUSED.invalid;
    const result = await t.hub.interrupt(args, t.actor);
    return result.state ? { ...result, state: project(result.state, sh) } : result;
  }

  function sharedWatch(sh, t, args) {
    if (!closed(args, ['session', 'after']) || !Number.isSafeInteger(args.after) || args.after < 0) return REFUSED.invalid;
    const read = () => (liveShare(sh) ? sharedRead(t, sh) ?? REFUSED.gone : REFUSED.gone);
    const first = read();
    if (!first.ok || first.version > args.after) return first;
    if (watching >= MAX_WATCHES || sharedWatching >= MAX_SHARED_WATCHES) return REFUSED.busy;
    watching++; sharedWatching++;
    return new Promise((resolve) => {
      let waited = 0, done = false, tick = null;
      const wait = { share: sh.id, finish(result) {
        if (done) return;
        done = true; clearInterval(tick); sharedWaits.delete(wait);
        watching--; sharedWatching--; resolve(result);
      } };
      sharedWaits.add(wait);
      tick = setInterval(() => {
        const r = read();
        waited += SHARED_POLL_MS;
        if (!r.ok || r.version > args.after || waited >= WATCH_MAX_MS) wait.finish(r);
      }, SHARED_POLL_MS);
      tick.unref?.();
    });
  }

  function dropShare(id, { tellHub = true } = {}) {
    const sh = shares.get(id);
    if (!sh) return;
    shares.delete(id);
    prints.delete(id);
    for (const wait of [...sharedWaits]) if (wait.share === id) wait.finish(REFUSED.gone);
    if (tellHub) hubCall('DELETE', `/api/interaction/v1/shares/${encodeURIComponent(id)}`, {}).catch(() => {});
  }

  function hubCall(method, path, body) { // privacy-flow: remote-interaction
    const r = running;
    if (!r?.baseUrl) return Promise.resolve({ status: 0, body: null });
    const tok = typeof r.token === 'function' ? r.token() : r.token;
    const headers = { authorization: `Bearer ${tok}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return r.fetch(`${r.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }) // privacy-flow: remote-interaction
      .then(async (res) => { let json = null; try { json = await res.json(); } catch { json = null; } return { status: res.status, body: json }; });
  }

  // "Sent by" labels: the hub's display name, unless another member of this
  // share or the owner goes by the same name; then a short suffix stable for
  // that member tells them apart (display names are free text).
  const fold = (n) => n.normalize('NFKC').trim().toLowerCase();
  const tag = (id) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 6);
  function usersOf(members, ownerName) {
    const list = (Array.isArray(members) ? members : []).filter((m) => object(m) && typeof m.id === 'string' && m.id !== userId)
      .map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name.trim() ? m.name.slice(0, 80) : 'Teammate', act: ACTING_ROLES.includes(m.role) }));
    const seen = new Map();
    for (const m of list) seen.set(fold(m.name), (seen.get(fold(m.name)) ?? 0) + 1);
    const owner = typeof ownerName === 'string' && ownerName.trim() ? fold(ownerName) : null;
    return new Map(list.map((m) => [m.id, { name: seen.get(fold(m.name)) > 1 || fold(m.name) === owner ? `${m.name.slice(0, 70)} #${tag(m.id)}` : m.name, act: m.act }]));
  }
  const shareView = (sh) => ({ id: sh.id, session: sh.session, team: { id: sh.team, name: sh.teamName }, scope: sh.scope, expiresAt: sh.expiresAt,
    members: [...sh.users].map(([id, u]) => ({ id, name: u.name, canSend: sh.scope === 'interact' && u.act })) });
  const hubError = (r, fallback) => refuse('unavailable', (typeof r?.body?.error?.message === 'string' ? r.body.error.message : '') || fallback);

  /** Owner: share one of this Mac's sessions with one team. */
  async function shareSession({ session, team, scope, expiresInS = null } = {}) {
    if (typeof session !== 'string' || !UUID.test(session) || typeof team !== 'string' || !team || team.length > 100 || !Object.hasOwn(SCOPE_OPS, scope)
      || (expiresInS !== null && (!Number.isSafeInteger(expiresInS) || expiresInS < 60 || expiresInS > 30 * 86_400))) return REFUSED.invalid;
    const t = targetFor(session);
    if (!t || t.hub.state({ session }, t.actor).status === 'ended') return refuse('stale', 'This session has ended and cannot be shared.');
    if (state !== 'connected') return refuse('unavailable', 'This Mac is not connected to your team hub.');
    if (shares.size >= MAX_SHARES) return refuse('unavailable', 'Stop sharing another session first.');
    // Taken before the hub creates its row, so this Mac never shows a teammate anything older than the hub would.
    const createdAt = clock();
    let r;
    try { r = await hubCall('POST', '/api/interaction/v1/shares', { session, team, scope, ...(expiresInS === null ? {} : { expires_in_s: expiresInS }) }); } catch { r = null; }
    const s = r?.body?.share;
    if (r?.status !== 200 || !object(s) || typeof s.id !== 'string' || s.session !== session || s.scope !== scope || s.team?.id !== team) return hubError(r, 'The hub did not accept the share.');
    // The session may have ended while the hub answered.
    if (!targetFor(session)) { dropShare(s.id); return refuse('stale', 'This session has ended and cannot be shared.'); }
    for (const x of [...shares.values()]) if (x.session === session && x.team === team) dropShare(x.id, { tellHub: false });
    const sh = { id: s.id, session, team, teamName: typeof s.team.name === 'string' ? s.team.name.slice(0, 120) : 'Team', scope, createdAt, expiresAt: expiresInS === null ? null : clock() + expiresInS * 1000, ownerName: s.owner?.name, users: usersOf(s.members, s.owner?.name) };
    shares.set(sh.id, sh);
    return { ok: true, share: shareView(sh) };
  }

  /** Owner: the hub's view of this Mac's shares, reconciled with this Mac's own; and the teams it may share with. */
  async function listShares() {
    if (!running?.baseUrl) return refuse('unavailable', 'This Mac is not connected to your team hub.');
    let r;
    try { r = await hubCall('GET', '/api/interaction/v1/shares'); } catch { r = null; }
    if (r?.status !== 200 || !Array.isArray(r.body?.shares)) return hubError(r, 'The hub did not answer.');
    const onHub = new Map(r.body.shares.filter((x) => object(x) && typeof x.id === 'string').map((x) => [x.id, x]));
    for (const [id, x] of onHub) {
      const sh = shares.get(id);
      // Unknown here (a restart) or for a session that is gone: ended at the hub too.
      if (!sh || !liveShare(sh) || !targetFor(sh.session)) { if (sh) dropShare(id); else hubCall('DELETE', `/api/interaction/v1/shares/${encodeURIComponent(id)}`, {}).catch(() => {}); continue; }
      if (typeof x.owner?.name === 'string') sh.ownerName = x.owner.name;
      sh.users = usersOf(x.members, sh.ownerName);
    }
    // Revoked by a team admin, expired or deleted at the hub: gone here too.
    for (const id of [...shares.keys()]) if (!onHub.has(id)) dropShare(id, { tellHub: false });
    const teams = (Array.isArray(r.body.teams) ? r.body.teams : []).filter((x) => object(x) && typeof x.id === 'string').map((x) => ({ id: x.id, name: typeof x.name === 'string' ? x.name.slice(0, 120) : 'Team' }));
    return { ok: true, teams, shares: [...shares.values()].map(shareView) };
  }

  /** Owner: stop sharing now (this Mac refuses at once; the hub is told). */
  function stopSharing(id) {
    if (!shares.has(id)) return refuse('stale', 'That share has already stopped.');
    dropShare(id);
    return { ok: true };
  }

  /** One relay.request frame (already parsed) → the result object for its relay.reply. */
  async function handle(frame) {
    const sealed = object(frame) && frame.enc !== undefined;
    const r = await handlePlain(frame, sealed);
    return sealed && !object(r?.enc) && r?.ok === false && !r.e2e ? e2eRefusal(E2E_OF.get(r) ?? 'malformed') : r;
  }

  async function handlePlain(frame, sealed) {
    if (!closed(frame, ['type', 'id', 'rid', 'user', 'from', 'op', 'args', 'enc', 'share']) || frame.type !== 'relay.request'
      || typeof frame.id !== 'string' || !UUID.test(frame.id) || typeof frame.rid !== 'string' || !UUID.test(frame.rid)
      || typeof frame.from !== 'string' || !frame.from || frame.from.length > 100 || !(OPS.includes(frame.op) || (sealed && frame.op === 'hello'))
      || (sealed ? frame.args !== undefined : !object(frame.args))) return REFUSED.invalid;
    if (frame.user !== userId) return REFUSED.forbidden;
    const shared = frame.share !== undefined;
    const by = shared ? frame.share?.user : null;
    if (shared && (typeof by !== 'string' || sealed)) return REFUSED.invalid;
    // A plain own-device call when end-to-end is required: refused, whatever the hub says.
    if (!shared && !sealed && e2eRequired) return e2eRefusal('required');
    if (sealed && !channel) return e2eRefusal('unsupported');
    if (handling >= MAX_HANDLING || (shared && (sharedHandling >= MAX_SHARED_HANDLING || (byTeammate.get(by) ?? 0) >= MAX_PER_TEAMMATE))) return REFUSED.busy;
    if (!once(`id:${frame.id}`) || !once(`rid:${frame.from}:${frame.rid}`)) return REFUSED.replayed;
    let result, opened = null;
    handling++;
    if (shared) { sharedHandling++; byTeammate.set(by, (byTeammate.get(by) ?? 0) + 1); }
    try {
      if (sealed) {
        opened = await channel.open({ rid: frame.rid, op: frame.op, enc: frame.enc });
        if (!opened.ok) return e2eRefusal(opened.code);
        if (opened.hello) return { enc: opened.reply };
        if (!object(opened.args)) return await sealedAnswer(opened, REFUSED.invalid);
      }
      for (const x of hub.list(actor)) remember(x.session);
      try { result = await (shared ? runShared(frame) : run(frame.op, sealed ? opened.args : frame.args)); } catch { result = REFUSED.unavailable; }
    } finally {
      handling--;
      if (shared) { sharedHandling--; const n = byTeammate.get(by) - 1; if (n) byTeammate.set(by, n); else byTeammate.delete(by); }
    }
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text) > MAX_REPLY) result = REFUSED.tooLarge;
    else if (leaksTarget(text)) { log(`[remote-interaction] ${frame.op}: answer withheld (provider id)`); result = REFUSED.unavailable; }
    return sealed ? sealedAnswer(opened, result) : result;
  }

  // The answer to an opened call, sealed for that device and request only.
  async function sealedAnswer(opened, result) {
    let enc = await opened.seal(result);
    if (Buffer.byteLength(JSON.stringify(enc)) > MAX_REPLY) enc = await opened.seal(REFUSED.tooLarge);
    return { enc };
  }

  let state = 'off', notice = null, resume = null, retryTimer = null, idleTimer = null, attempts = 0, conflicts = 0, running = null;
  // Told when hosting connects or stops (session messaging follows it).
  const stateListeners = new Set();
  function tell() { for (const fn of [...stateListeners]) { try { fn(state); } catch (e) { log(`[remote-interaction] ${e.message}`); } } }
  const reapRemote = () => hub.reap(() => false).catch(() => {});
  function idleFrom() {
    if (idleTimer || !running) return;
    idleTimer = setTimeout(() => { idleTimer = null; reapRemote(); }, R.idleReapMs);
    idleTimer.unref?.();
  }
  // Not hosting any more: every share ends here (the hub drops them with the device or on the next list).
  function stopRunning(next) {
    running = null; state = next;
    shares.clear(); prints.clear();
    for (const wait of [...sharedWaits]) wait.finish(REFUSED.gone);
    clearTimeout(retryTimer); retryTimer = null;
    clearTimeout(idleTimer); idleTimer = null;
    tell();
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
      tell();
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
    running = { url, token, WebSocket, baseUrl, fetch };
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
  function close() { stopRunning('off'); disconnect(); for (const w of [...watchers]) w(); channel?.close(); hub.stopAll(); }

  // `hub` is a main-only seam (tests and proof logs), never exposed remotely.
  const onState = (fn) => { stateListeners.add(fn); return () => stateListeners.delete(fn); };
  // forgetDevice(dev): drop a revoked device's end-to-end sessions now (its peer() should already return null).
  return { handle, connect, enable, disable, status, disconnect, close, onState, hub, actor, connected: () => socket?.readyState === 1, shareSession, listShares, stopSharing, shared: () => [...shares.values()].map(shareView), forgetDevice: (dev) => channel?.forget(dev) };
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

/**
 * The other device's side: list hosts, then call ops on one. `e2e`: a device
 * channel (Envelope.createDeviceChannel) for a host this device is paired
 * with; calls then go sealed and answers are opened (see relay-envelope.js).
 */
function createRemoteInteractionClient({ baseUrl, token, fetch = globalThis.fetch, e2e = null }) { // privacy-flow: remote-interaction
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
  const call = (host, op, args = {}, requestId = crypto.randomUUID()) => {
    const path = `/api/interaction/v1/hosts/${encodeURIComponent(host)}/call`;
    if (!e2e) return request('POST', path, { request_id: requestId, op, args });
    return e2e.call(op, args, (rid, name, enc) => request('POST', path, { request_id: rid, op: name, enc }), () => crypto.randomUUID());
  };
  return { hosts, call, request };
}

module.exports = { createRemoteInteractionHost, createRemoteInteractionClient, resetRole, OPS };
