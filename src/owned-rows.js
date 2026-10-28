'use strict';
// T4a (plan-t4a §2.2–2.4, Rev 1 M1): my own Plexiform-held sessions (the Overview document's
// interaction-hub sessions) as chat-first sidebar rows and `owned` threads. Main-only: the routes
// name an actor and a session and never leave this file; a renderer gets the row id only.
//
// - One row per Codex session, sticky per epoch: the first pass that sees a Codex session decides it.
//   Exactly one reported twin then → folded: that reported row is its one row, for the whole epoch,
//   even while the twin's hook row is missing. Otherwise → its own owned row for the epoch, and a twin
//   that turns up later is hidden, so one session never has two rows and never flips between them.
// - Tombstones come from here, with a reason, and only for an epoch move ('overview') or the session
//   ending or closing in the same epoch ('ended'). Anything else (another account, the cap) is silent.
// - Row ids carry the epoch, so a row of an earlier Overview document never resolves again.
const { sessionRow } = require('./session-row');
const OwnedThread = require('./owned-thread-view');

const MAX_ROWS = 20;
const ENDED_MS = 10 * 60_000;
const ENDED_MAX = 50;
const REASONS = Object.freeze(['overview', 'ended']); // tombstones; 'account' is a read's reason only, never a tombstone

const bucketOf = (s) => (s.input_needed === true ? 'needs' : s.status === 'working' || s.status === 'compacting' ? 'working' : 'idle');

function createOwnedRows({ stable, now = Date.now }) {
  let epoch = null, account;
  const folds = new Map(); // row id → true (folded into its reported twin) | false (its own row), this epoch only
  const routes = new Map(); // row id → { epoch, actor, session, vm }
  const ended = new Map(); // row id → { reason, at }
  // T4 (Rev 3, the T4a review nit): rows that left with an account switch. No tombstone, in the sidebar or the
  // thread: they were never this person's. Kept only so an open thread can say so instead of "ended".
  const left = new Map(); // row id → at
  function leave(id, t) {
    left.delete(id); left.set(id, t);
    while (left.size > ENDED_MAX) left.delete(left.keys().next().value);
  }
  const idOf = (at, session) => stable(['owned', at, session]);
  function end(id, reason, t) {
    ended.delete(id);
    ended.set(id, { reason, at: t });
    while (ended.size > ENDED_MAX) ended.delete(ended.keys().next().value);
  }
  const endedList = () => [...ended].map(([id, e]) => ({ id, reason: e.reason }));
  // The reported rows (the build's refs) that are this owned Codex session: same native session id, this computer's own.
  function twinsOf(o, refs) {
    if (o.state?.provider?.id !== 'codex' || typeof o.nativeSessionId !== 'string' || !o.nativeSessionId) return [];
    const out = [];
    for (const [rowId, v] of refs instanceof Map ? refs : []) if (v?.ref && v.ref.provider === 'codex' && v.ref.origin !== 'chat' && v.ref.origin !== 'owned' && v.ref.sessionId === o.nativeSessionId) out.push(rowId);
    return out;
  }
  function rowOf(id, o, t) {
    const s = o.state, channel = s.provider?.id === 'claude-channel', title = channel ? OwnedThread.CHANNEL_TITLE : typeof s.task_title === 'string' ? s.task_title : '';
    const at = s.activity?.observed_at;
    const dto = {
      id, provider: { id: s.provider?.id }, task: title.trim() ? { status: 'tracked', title } : { status: 'unknown' },
      project: typeof o.leaf === 'string' ? o.leaf : '', bucket: bucketOf(s),
      age_ms: Number.isSafeInteger(at) && at >= 0 && at <= t ? t - at : null, board: { kind: 'personal' },
    };
    let vm = null;
    try { vm = sessionRow(dto, { ref: { provider: s.provider?.id, sessionId: o.session, origin: 'owned', driver: 'owned' } }); } catch { vm = null; }
    return vm ? { dto, vm } : null;
  }

  /** view: interactionMain.ownedView(); refs: the build's reported refs. → { rows: [{dto, vm}], hide: Set<rowId>, ended } */
  function pass(view, refs) {
    const t = now(), rows = [], hide = new Set();
    for (const [id, e] of ended) if (t - e.at > ENDED_MS) ended.delete(id);
    for (const [id, at] of left) if (t - at > ENDED_MS) left.delete(id);
    if (!view || typeof view !== 'object' || !Number.isSafeInteger(view.epoch) || !Array.isArray(view.sessions)) return { rows, hide, ended: endedList() };
    if (view.epoch !== epoch) {
      // The Overview document changed: every row it held ends with it (plan-t4a §2.4).
      if (epoch !== null) for (const id of routes.keys()) end(id, 'overview', t);
      routes.clear(); folds.clear(); epoch = view.epoch; account = view.account;
    } else if (view.account !== account) {
      // Another account: its rows were never this person's, so they leave without a tombstone.
      for (const id of routes.keys()) leave(id, t);
      routes.clear(); folds.clear(); account = view.account;
    }
    const sessions = view.sessions.filter((o) => o && typeof o.session === 'string' && o.state && typeof o.state === 'object');
    const present = new Set(sessions.map((o) => idOf(epoch, o.session)));
    for (const id of [...routes.keys()]) if (!present.has(id)) { routes.delete(id); end(id, 'ended', t); }
    for (const o of sessions) {
      const id = idOf(epoch, o.session);
      if (o.state.status === 'ended') { if (routes.delete(id)) end(id, 'ended', t); continue; }
      const twins = twinsOf(o, refs);
      if (!folds.has(id)) folds.set(id, twins.length === 1);
      if (folds.get(id) === true) continue;
      if (twins.length === 1) hide.add(twins[0]);
      const row = rows.length < MAX_ROWS ? rowOf(id, o, t) : null;
      if (!row) { routes.delete(id); continue; }
      ended.delete(id); left.delete(id);
      routes.set(id, { epoch, account, actor: o.actor, session: o.session, vm: row.vm });
      rows.push(row);
    }
    while (folds.size > 200) folds.delete(folds.keys().next().value);
    return { rows, hide, ended: endedList() };
  }

  // A thread's target: an owned row this pass listed, or one that ended (its thread then shows why).
  function target(rowId) {
    const r = routes.get(rowId);
    if (r) return { kind: 'owned', vm: r.vm };
    return ended.has(rowId) || left.has(rowId) ? { kind: 'owned', vm: null } : null;
  }

  /** The bound row's state read. state(epoch, actor, session), currentEpoch() and currentAccount() are interaction-main's. */
  function read(rowId, { state, currentEpoch, currentAccount = () => account }) {
    const r = routes.get(rowId);
    if (!r) return left.has(rowId) ? { gone: true, reason: 'account' } : { gone: true, reason: ended.get(rowId)?.reason ?? 'ended' };
    let s = null;
    try { s = state(r.epoch, r.actor, r.session); } catch { s = null; }
    if (!s || s.status === 'ended') {
      let moved = false, other = false;
      try { moved = currentEpoch() !== r.epoch; } catch { moved = true; }
      try { other = !moved && currentAccount() !== r.account; } catch { other = false; }
      // Another account (T4a review nit): the row leaves as pass() would have it, silently, with no tombstone.
      if (other) { routes.delete(rowId); leave(rowId, now()); return { gone: true, reason: 'account' }; }
      const reason = moved ? 'overview' : 'ended';
      routes.delete(rowId); end(rowId, reason, now());
      return { gone: true, reason };
    }
    return OwnedThread.project({ state: s, now: now() });
  }

  // T4: main-only. The bound owned row's route, for the owner controls (never leaves main).
  function route(rowId) {
    const r = routes.get(rowId);
    return r ? { epoch: r.epoch, actor: r.actor, session: r.session, account: r.account } : null;
  }
  // T4: true when this epoch folded that owned session into its one reported row (so that row carries its controls).
  const folded = (at, session) => at === epoch && folds.get(idOf(at, session)) === true;

  return { pass, target, read, route, folded, clear() { routes.clear(); folds.clear(); ended.clear(); left.clear(); epoch = null; account = undefined; } };
}

module.exports = { createOwnedRows, MAX_ROWS, ENDED_MS, ENDED_MAX, REASONS };
