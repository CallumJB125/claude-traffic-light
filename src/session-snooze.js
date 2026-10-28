'use strict';
// QoL3b: snooze one session's alerts for 15 minutes or an hour (its widget card, or its notification's button).
// Kept in its own file beside config.json (session-snoozes.json), never in config: no renderer config view shows it and
// no renderer config save can carry it (commitConfig also drops the key, review Q3-M1). Only main writes it, with
// main's clock; a value is honoured only when it ends within the next 61 minutes, so junk or a far-future value never
// mutes anything. Local sessions only: a remote or teammate row is never snoozable.
//
// What a snooze holds: that session's notifications, and the alert sound and the knock only when every session feeding
// the sounding rule is local and snoozed or project-muted (review Q3-M2). It never holds the widget's light, the
// needing queue, the silent badge or a GitHub rule's sound.

const MIN = 60000;
const KINDS = Object.freeze({ '15m': 15 * MIN, '1h': 60 * MIN });
const MAX_MS = 61 * MIN;
const CAP = 32;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const idOf = (v) => (typeof v === 'string' && ID.test(v) ? v : null);
const plain = (m) => !!m && typeof m === 'object' && !Array.isArray(m);

/** The end of a standing snooze for `id`, or 0. */
function snoozedUntil(map, id, now) {
  const key = idOf(id);
  if (!key || !plain(map) || !Object.hasOwn(map, key)) return 0;
  const until = map[key];
  return Number.isFinite(until) && now < until && until <= now + MAX_MS ? until : 0;
}

/** The next map: expired and junk entries dropped, `id` set to `until` (0 removes it), at most 32 kept (latest ends). */
function withSnooze(map, id, until, now) {
  const key = idOf(id);
  const out = {};
  for (const [k, v] of Object.entries(plain(map) ? map : {})) if (snoozedUntil(map, k, now)) out[k] = v;
  if (key) {
    delete out[key];
    if (Number.isFinite(until) && until > now && until <= now + MAX_MS) out[key] = until;
  }
  const kept = Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, CAP);
  return Object.fromEntries(kept);
}

/** "42m" left, rounded up; '' when not snoozed. */
function leftText(until, now) {
  if (!until || until <= now) return '';
  return `${Math.max(1, Math.ceil((until - now) / MIN))}m`;
}

/**
 * The store main uses. deps: { read() → parsed file or null, write(obj), now? }.
 * → { until(id), set(id, kind) → until (0 for 'off' or a bad id/kind), map() }
 */
function createStore({ read, write, now = Date.now }) {
  let map = null;
  const current = () => {
    if (map === null) { let f = null; try { f = read(); } catch { f = null; } map = withSnooze(plain(f) && plain(f.snoozes) ? f.snoozes : {}, null, 0, now()); }
    return map;
  };
  function until(id) { return snoozedUntil(current(), id, now()); }
  function set(id, kind) {
    const key = idOf(id);
    if (!key || !(kind === 'off' || Object.hasOwn(KINDS, kind))) return 0;
    const t = now();
    const end = kind === 'off' ? 0 : t + KINDS[kind];
    map = withSnooze(current(), key, end, t);
    try { write({ v: 1, snoozes: map }); } catch { /* the snooze still holds for this run */ }
    return end;
  }
  return { until, set, map: () => ({ ...current() }) };
}

const remoteRow = (s, isRemote) => !!(s && (s.remote || s.device || s.teammate || (typeof isRemote === 'function' && isRemote(s))));

/**
 * Q3-M2: hold the alert sound (or the knock) for snoozes? Only when the rule that owns the sound listens for session
 * signals, at least one session feeds it, and every feeding session is local and snoozed or muted.
 * rule: the owning rule ({when:{signal:[...]}}) or null; sessions: the aggregate list (local, paired and remote);
 * quiet(s) → true when that local session is snoozed or project-muted; gitSignals: signals a GitHub rule listens for.
 */
function soundHeld({ rule, sessions, quiet, isRemote = null, gitSignals = [] }) {
  const sigs = rule && rule.when && Array.isArray(rule.when.signal) ? rule.when.signal : [];
  if (!sigs.length || sigs.some((x) => gitSignals.includes(x))) return false;
  const feeding = (Array.isArray(sessions) ? sessions : []).filter((s) => s && sigs.includes(s.signal));
  if (!feeding.length) return false;
  return feeding.every((s) => !remoteRow(s, isRemote) && quiet(s) === true);
}

/** A notification for a snoozed local session stays quiet. n: {sessionId, session?}. */
function notificationHeld(n, until) {
  const s = n && n.session;
  const id = (s && s.sessionId) || (n && n.sessionId) || null;
  if (!id || (s && remoteRow(s)) || String(id).startsWith('remote:')) return false;
  return until(id) > 0;
}

module.exports = { KINDS, MAX_MS, CAP, idOf, snoozedUntil, withSnooze, leftText, createStore, soundHeld, notificationHeld };
