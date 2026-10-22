// The local agent bus log (board/AGENT-BUS.md §3): bus.db in the tasks engine's
// data dir, opened only inside the tasks utilityProcess, never Electron main.
// Append-only events with one monotonic offset, consumer offsets, the claim CAS
// with a fence, the day's spend, bus state and hop records. Cursor and
// dead-letter semantics follow board/hub/bus.js (at-least-once, a failing row
// is retried and then dead-lettered so it never blocks the rest).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS = Object.freeze({ handoff: 30 * DAY_MS, claim: 30 * DAY_MS, result: 30 * DAY_MS, control: 90 * DAY_MS });
export const DEAD_AFTER = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bus_events (
  offset INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, topic TEXT NOT NULL, kind TEXT NOT NULL,
  handoff_id TEXT, request_key TEXT UNIQUE, dedupe_key TEXT, agent_id TEXT, card_id TEXT, repo_root TEXT,
  hop INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, env TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS bus_events_handoff ON bus_events (handoff_id, topic);
CREATE INDEX IF NOT EXISTS bus_events_topic ON bus_events (topic, offset);
CREATE TABLE IF NOT EXISTS bus_offsets (consumer_id TEXT NOT NULL, topic TEXT NOT NULL, offset INTEGER NOT NULL, PRIMARY KEY (consumer_id, topic));
CREATE TABLE IF NOT EXISTS bus_dead (offset INTEGER NOT NULL, consumer_id TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (offset, consumer_id));
CREATE TABLE IF NOT EXISTS bus_claims (handoff_id TEXT PRIMARY KEY, fence INTEGER NOT NULL, state TEXT NOT NULL, holder TEXT NOT NULL,
  task_id TEXT, lease_until INTEGER NOT NULL, reserved_usd REAL NOT NULL DEFAULT 0, report TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bus_spend (day TEXT PRIMARY KEY, reserved_usd REAL NOT NULL DEFAULT 0, spent_usd REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS bus_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bus_hops (domain TEXT PRIMARY KEY, hop INTEGER NOT NULL, at INTEGER NOT NULL);
`;

export function openBusLog(file, { now = Date.now } = {}) {
  const fd = fs.openSync(file, 'a', 0o600);
  fs.closeSync(fd);
  fs.chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;');
  db.exec(SCHEMA);
  const q = new Map();
  const st = (sql) => { let s = q.get(sql); if (!s) { s = db.prepare(sql); q.set(sql, s); } return s; };
  const row = (r) => (r ? { ...JSON.parse(r.env), offset: r.offset } : null);
  const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  return {
    /** ev: an envelope without id/offset. requestKey dedupes (source, request_id); returns the stored event. */
    append(ev, { requestKey = null, dedupeKey = null } = {}) {
      const id = `evt_${crypto.randomBytes(10).toString('hex')}`;
      const full = { ...ev, id, offset: 0 };
      const r = st(`INSERT INTO bus_events (id, topic, kind, handoff_id, request_key, dedupe_key, agent_id, card_id, repo_root, hop, created_at, expires_at, env)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ev.topic, ev.kind, ev.handoff_id ?? null, requestKey, dedupeKey, ev.source?.agent_id ?? null,
        ev.card_id ?? null, ev.repo?.root ?? null, ev.hop ?? 0, ev.created_at, ev.expires_at, JSON.stringify(full));
      return { ...full, offset: Number(r.lastInsertRowid) };
    },
    byRequest(requestKey) { return row(st('SELECT * FROM bus_events WHERE request_key = ?').get(requestKey)); },
    byDedupe(dedupeKey, since) { return row(st("SELECT * FROM bus_events WHERE dedupe_key = ? AND kind = 'handoff.offer' AND created_at >= ? ORDER BY offset DESC LIMIT 1").get(dedupeKey, since)); },
    handoff(handoffId) { return row(st("SELECT * FROM bus_events WHERE handoff_id = ? AND kind = 'handoff.offer'").get(handoffId)); },
    chain(handoffId) { return st('SELECT * FROM bus_events WHERE handoff_id = ? ORDER BY offset').all(handoffId).map(row); },
    result(handoffId) { return row(st("SELECT * FROM bus_events WHERE handoff_id = ? AND topic = 'result' ORDER BY offset DESC LIMIT 1").get(handoffId)); },
    read({ topics, after = 0, limit = 50, cardId = null }) {
      const marks = topics.map(() => '?').join(',');
      const rows = cardId
        ? st(`SELECT * FROM bus_events WHERE topic IN (${marks}) AND offset > ? AND card_id = ? ORDER BY offset LIMIT ?`).all(...topics, after, cardId, limit)
        : st(`SELECT * FROM bus_events WHERE topic IN (${marks}) AND offset > ? ORDER BY offset LIMIT ?`).all(...topics, after, limit);
      return rows.map(row);
    },
    recent(limit = 100) { return st('SELECT * FROM bus_events ORDER BY offset DESC LIMIT ?').all(limit).map(row); },
    head() { return st('SELECT COALESCE(MAX(offset), 0) AS o FROM bus_events').get().o; },
    /** Accepted offers since `since`, narrowed by agent, card or repo. */
    countOffers({ since, agentId, cardId, repoRoot }) {
      const where = ["kind = 'handoff.offer'", 'created_at >= ?'];
      const args = [since];
      if (agentId) { where.push('agent_id = ?'); args.push(agentId); }
      if (cardId) { where.push('card_id = ?'); args.push(cardId); }
      if (repoRoot) { where.push('repo_root = ?'); args.push(repoRoot); }
      return st(`SELECT COUNT(*) AS n FROM bus_events WHERE ${where.join(' AND ')}`).get(...args).n;
    },
    countFailures({ since, cardId, repoRoot }) {
      return cardId
        ? st("SELECT COUNT(*) AS n FROM bus_events WHERE kind = 'result.failed' AND created_at >= ? AND card_id = ?").get(since, cardId).n
        : st("SELECT COUNT(*) AS n FROM bus_events WHERE kind = 'result.failed' AND created_at >= ? AND repo_root = ?").get(since, repoRoot).n;
    },

    // Consumer offsets (bus.js cursor): a new consumer starts at the head unless told otherwise.
    offsetOf(consumer, topic, { fromHead = true } = {}) {
      const r = st('SELECT offset FROM bus_offsets WHERE consumer_id = ? AND topic = ?').get(consumer, topic);
      if (r) return r.offset;
      const start = fromHead ? this.head() : 0;
      st('INSERT INTO bus_offsets (consumer_id, topic, offset) VALUES (?, ?, ?)').run(consumer, topic, start);
      return start;
    },
    advance(consumer, topic, offset) { st('UPDATE bus_offsets SET offset = ? WHERE consumer_id = ? AND topic = ? AND offset < ?').run(offset, consumer, topic, offset); },
    deadLetter(offset, consumer, reason) { st('INSERT OR IGNORE INTO bus_dead (offset, consumer_id, reason, at) VALUES (?, ?, ?, ?)').run(offset, consumer, String(reason).slice(0, 200), now()); },

    // Claims: exactly one start per handoff. A fresh claim gets fence 1; a reopened one fence+1.
    claim(handoffId, holder, leaseMs) {
      return tx(() => {
        const c = st('SELECT * FROM bus_claims WHERE handoff_id = ?').get(handoffId);
        if (c && c.state !== 'reopened') return null;
        const fence = c ? c.fence + 1 : 1;
        st(`INSERT INTO bus_claims (handoff_id, fence, state, holder, lease_until, updated_at) VALUES (?, ?, 'granted', ?, ?, ?)
          ON CONFLICT(handoff_id) DO UPDATE SET fence = excluded.fence, state = 'granted', holder = excluded.holder, lease_until = excluded.lease_until, task_id = NULL, updated_at = excluded.updated_at`)
          .run(handoffId, fence, holder, now() + leaseMs, now());
        return { fence };
      });
    },
    claimOf(handoffId) { return st('SELECT * FROM bus_claims WHERE handoff_id = ?').get(handoffId) ?? null; },
    claimOfTask(taskId) { return st('SELECT * FROM bus_claims WHERE task_id = ?').get(taskId) ?? null; },
    /** Updates a claim only while `fence` is current: a stale holder changes nothing. */
    setClaim(handoffId, fence, fields) {
      const keys = Object.keys(fields);
      const r = st(`UPDATE bus_claims SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE handoff_id = ? AND fence = ?`)
        .run(...keys.map((k) => fields[k]), now(), handoffId, fence);
      return r.changes === 1;
    },
    openClaims() { return st("SELECT * FROM bus_claims WHERE state IN ('granted', 'started')").all(); },

    // Spend (local reservation and measured cost per calendar day).
    spend(day) { return st('SELECT reserved_usd AS reserved, spent_usd AS spent FROM bus_spend WHERE day = ?').get(day) ?? { reserved: 0, spent: 0 }; },
    reserve(day, usd) { st('INSERT INTO bus_spend (day, reserved_usd) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET reserved_usd = reserved_usd + excluded.reserved_usd').run(day, usd); },
    settle(day, reservation, cost) {
      st('INSERT INTO bus_spend (day, reserved_usd, spent_usd) VALUES (?, 0, ?) ON CONFLICT(day) DO UPDATE SET reserved_usd = MAX(0, reserved_usd - ?), spent_usd = spent_usd + ?')
        .run(day, cost, reservation, cost);
    },

    state(k, fallback = null) { const r = st('SELECT v FROM bus_state WHERE k = ?').get(k); return r ? JSON.parse(r.v) : fallback; },
    setState(k, v) { st('INSERT INTO bus_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v)); },

    // Hop inheritance: the highest hop a domain consumed recently.
    hopOf(domain, since) { const r = st('SELECT hop FROM bus_hops WHERE domain = ? AND at >= ?').get(domain, since); return r ? r.hop : 0; },
    consumed(domain, hop, since) {
      const cur = this.hopOf(domain, since);
      if (hop > cur) st('INSERT INTO bus_hops (domain, hop, at) VALUES (?, ?, ?) ON CONFLICT(domain) DO UPDATE SET hop = excluded.hop, at = excluded.at').run(domain, hop, now());
    },

    sweep() {
      const t = now();
      for (const [topic, ms] of Object.entries(RETENTION_MS)) st('DELETE FROM bus_events WHERE topic = ? AND created_at < ?').run(topic, t - ms);
      st("DELETE FROM bus_claims WHERE state NOT IN ('granted', 'started') AND updated_at < ?").run(t - RETENTION_MS.claim);
      st('DELETE FROM bus_hops WHERE at < ?').run(t - DAY_MS);
      st('DELETE FROM bus_dead WHERE at < ?').run(t - RETENTION_MS.handoff);
    },
    close() { db.close(); },
  };
}
