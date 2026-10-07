// Collision alerts (docs/TEAM-CONTEXT-CONTRACT.md, "Reading it back"): the hub
// flags two working sessions in one repo editing the same file. Pure: classifies
// activity-stream events, keeps the open collisions that involve a session on
// this Mac, and builds the notification text and the board link to the other
// record. Main wires it to src/activity-stream.js, a notification and the
// Sessions/Home rows; this module never calls the hub.
'use strict';

const CONTRACT = Object.freeze({
  eventCollision: 'collision',
  eventsEnd: Object.freeze(['record.end']),
  fragmentKey: 'plexiform-record',
  fragmentVersion: 1,
  boardPage: 'board',
});

const MAX_OPEN = 50;
const MAX_REMEMBERED = 200;
// record_id is "<install_id>:<adapter>:<session_id>"; session ids can hold ':'.
const RECORD_RE = /^([A-Za-z0-9_-]{1,64}):(claude|codex|gemini|hermes|cursor):([^\s]{1,200})$/;
const REPO_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const clip = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

function parseRecordId(id) {
  const m = typeof id === 'string' ? RECORD_RE.exec(id) : null;
  return m ? { record_id: id, install_id: m[1], adapter: m[2], session_id: m[3] } : null;
}

// The feed may carry bare record ids or record summaries.
function side(r) {
  const parsed = parseRecordId(typeof r === 'string' ? r : r && r.record_id);
  if (!parsed) return null;
  const o = r && typeof r === 'object' ? r : {};
  return { ...parsed, title: clip(o.title, 120), author: clip(o.author ?? o.author_name ?? o.display_name, 80) };
}

const pathOf = (p) => (typeof p === 'string' && p.length <= 400 && !p.startsWith('/') && !p.split('/').includes('..') ? p : null);

// mine(parsed) → true when the record is a session on this Mac.
// → { collision } for a collision touching exactly one of my sessions as `mine`
//   (when both sides are mine, the first is `mine`), { end: record_id } for an
//   ended record, else null.
function classify(ev, mine) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return null;
  if (CONTRACT.eventsEnd.includes(ev.type)) {
    const id = ev.record_id ?? ev.payload?.record_id;
    return parseRecordId(id) ? { end: id } : null;
  }
  if (ev.type !== CONTRACT.eventCollision) return null;
  const path = pathOf(ev.path);
  if (!path || typeof ev.repo_id !== 'string' || !REPO_RE.test(ev.repo_id) || !Array.isArray(ev.records) || ev.records.length !== 2) return null;
  const [a, b] = ev.records.map(side);
  if (!a || !b || a.record_id === b.record_id) return null;
  const ownA = !!mine(a), ownB = !!mine(b);
  if (!ownA && !ownB) return null;
  const [me, other] = ownA ? [a, b] : [b, a];
  const key = `${[a.record_id, b.record_id].sort().join('|')}|${path}`;
  return { collision: { key, repo_id: ev.repo_id, path, mine: me, other, both_mine: ownA && ownB, seq: Number.isSafeInteger(ev.seq) ? ev.seq : null } };
}

const basename = (p) => p.split('/').pop();
function text(c) {
  const who = c.both_mine ? 'Another of your sessions' : c.other.author ? `${c.other.author}'s session` : "A teammate's session";
  return `${who}${c.other.title ? ` (${c.other.title})` : ''} is also editing ${basename(c.path)}`;
}

function fragment(c) {
  return `${CONTRACT.fragmentKey}=${Buffer.from(JSON.stringify({ v: CONTRACT.fragmentVersion, record_id: c.other.record_id, repo_id: c.repo_id })).toString('base64url')}`;
}

// → { handle(ev, mine), forSession(adapter, sessionId), get(key), list(), clear() }
// One notification per collision key; it ends when either record ends.
function createCollisions() {
  const open = new Map();
  const notified = new Set();
  const remember = (id) => { notified.add(id); if (notified.size > MAX_REMEMBERED) notified.delete(notified.values().next().value); };
  return {
    // → { changed, notify, collision }
    handle(ev, mine = () => false) {
      const c = classify(ev, mine);
      if (!c) return { changed: false, notify: false };
      if (c.end) {
        let changed = false;
        for (const [k, v] of open) if (v.mine.record_id === c.end || v.other.record_id === c.end) { open.delete(k); notified.delete(k); changed = true; }
        return { changed, notify: false };
      }
      const prev = open.get(c.collision.key);
      open.delete(c.collision.key);
      open.set(c.collision.key, c.collision);
      if (open.size > MAX_OPEN) open.delete(open.keys().next().value);
      const notify = !notified.has(c.collision.key);
      if (notify) remember(c.collision.key);
      return { changed: !prev || prev.other.title !== c.collision.other.title || prev.other.author !== c.collision.other.author, notify, collision: c.collision };
    },
    forSession(adapter, sessionId) {
      const out = [];
      for (const c of open.values()) for (const s of c.both_mine ? [c.mine, c.other] : [c.mine]) {
        if (s.session_id === sessionId && (!adapter || s.adapter === adapter)) out.push({ key: c.key, path: c.path, text: text(c), other: c.both_mine && s === c.other ? c.mine.record_id : c.other.record_id });
      }
      return out.reverse();
    },
    get: (key) => open.get(key) || null,
    list: () => [...open.values()].reverse(),
    clear() { open.clear(); },
  };
}

// Session rows: Claude Code's own hook writes no source.
const adapterOfRow = (row) => (row && (row.source == null || row.source === 'claude-code') ? 'claude' : row && typeof row.source === 'string' ? row.source : null);
// Rows carrying the hub's collisions for that session (session-overview's `collisions` option).
const rowCollisions = (alerts) => (row) => (row && typeof row.sessionId === 'string' ? alerts.forSession(adapterOfRow(row), row.sessionId) : []);
// A record is mine when its session is one of the local session rows.
function mineFrom(rows) {
  const ids = new Set((Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.sessionId === 'string').map((r) => `${adapterOfRow(r)}:${r.sessionId}`));
  return (parsed) => ids.has(`${parsed.adapter}:${parsed.session_id}`);
}

// The activity stream module is another component; accept the subscription
// shapes a Node event source normally offers. → unsubscribe function, or null.
function attach(stream, onEvent) {
  if (!stream || typeof onEvent !== 'function') return null;
  if (typeof stream.subscribe === 'function') { const off = stream.subscribe(onEvent); return typeof off === 'function' ? off : () => {}; }
  if (typeof stream.on === 'function') { stream.on('event', onEvent); return () => (stream.off || stream.removeListener).call(stream, 'event', onEvent); }
  return null;
}

module.exports = { CONTRACT, classify, createCollisions, text, fragment, parseRecordId, attach, adapterOfRow, rowCollisions, mineFrom };
