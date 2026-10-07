// The team activity log's storage (docs/TEAM-CONTEXT-CONTRACT.md): the only
// module that touches activity_events / activity_current. Kafka-like
// semantics on SQLite: append-only events, a monotonic offset (seq) readers
// resume from, and time-based retention. A broker adapter (NATS/Kafka) would
// replace this file and keep its interface; callers never see SQL.

import { EventEmitter } from 'node:events';

const DAY_MS = 86_400_000;
export const RETENTION = Object.freeze({ eventsMs: 30 * DAY_MS, endedMs: 7 * DAY_MS, staleMs: 30 * DAY_MS });

const decode = (row) => {
  if (!row) return null;
  let payload = null;
  try { payload = JSON.parse(row.payload); } catch { payload = null; }
  return { ...row, payload };
};
const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');

export class ActivityLog {
  constructor(hub) {
    this.hub = hub;
    this.db = hub.db;
    this.appended = new EventEmitter();
    this.appended.setMaxListeners(0);
  }

  /** Runs fn in one transaction; subscribers hear about new seqs only after it commits. */
  write(fn) { return this.hub.txn(fn); }

  /** fn(head_seq) after each commit that appended. Returns an unsubscribe. */
  subscribe(fn) {
    this.appended.on('append', fn);
    return () => this.appended.off('append', fn);
  }

  current(recordId) { return decode(this.db.get('SELECT * FROM activity_current WHERE record_id = ?', recordId)); }

  /** Insert or replace the latest record of a session. Caller has checked rev. */
  putCurrent({ recordId, teamId, repoId, rev, status, authorUserId, payload, at }) {
    this.db.run(`INSERT INTO activity_current (record_id, team_id, repo_id, rev, status, author_user_id, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET team_id = excluded.team_id, repo_id = excluded.repo_id, rev = excluded.rev, status = excluded.status,
      author_user_id = excluded.author_user_id, payload = excluded.payload, updated_at = excluded.updated_at`,
    recordId, teamId, repoId, rev, status, authorUserId, JSON.stringify(payload), at);
  }

  append({ teamId, repoId, recordId, rev, type, authorUserId = null, payload, at }) {
    const r = this.db.run('INSERT INTO activity_events (team_id, repo_id, record_id, rev, type, author_user_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      teamId, repoId, recordId, rev, type, authorUserId, JSON.stringify(payload), at);
    const seq = Number(r.lastInsertRowid);
    this.hub.later(() => this.appended.emit('append', seq));
    return seq;
  }

  /** Current records of one repo in the given statuses (collision candidates). */
  liveIn(repoId, statuses, limit = 200) {
    return this.db.all(`SELECT * FROM activity_current WHERE repo_id = ? AND status IN (${placeholders(statuses.length)}) ORDER BY updated_at DESC LIMIT ?`,
      repoId, ...statuses, limit).map(decode);
  }

  /** Events after a cursor, in seq order, for these teams (and one repo when given). */
  events({ teamIds, repoId = null, after = 0, limit = 200 }) {
    if (!teamIds.length) return [];
    const repo = repoId ? ' AND repo_id = ?' : '';
    return this.db.all(`SELECT * FROM activity_events WHERE seq > ? AND team_id IN (${placeholders(teamIds.length)})${repo} ORDER BY seq LIMIT ?`,
      after, ...teamIds, ...(repoId ? [repoId] : []), limit).map(decode);
  }

  currentFor({ teamIds, repoId = null, limit = 500 }) {
    if (!teamIds.length) return [];
    const repo = repoId ? ' AND repo_id = ?' : '';
    return this.db.all(`SELECT * FROM activity_current WHERE team_id IN (${placeholders(teamIds.length)})${repo} ORDER BY updated_at DESC LIMIT ?`,
      ...teamIds, ...(repoId ? [repoId] : []), limit).map(decode);
  }

  head() { return this.db.get('SELECT COALESCE(MAX(seq), 0) AS s FROM activity_events').s; }

  /** The oldest seq still kept: a cursor below it has missed events. */
  tail() { return this.db.get('SELECT COALESCE(MIN(seq), 0) AS s FROM activity_events').s; }

  sweep(nowMs = this.hub.wallMs()) {
    const iso = (ms) => new Date(nowMs - ms).toISOString();
    return this.write(() => {
      const events = this.db.run('DELETE FROM activity_events WHERE created_at < ?', iso(RETENTION.eventsMs)).changes;
      let current = this.db.run("DELETE FROM activity_current WHERE status = 'ended' AND updated_at < ?", iso(RETENTION.endedMs)).changes;
      current += this.db.run('DELETE FROM activity_current WHERE updated_at < ?', iso(RETENTION.staleMs)).changes;
      const gone = 'SELECT id FROM orgs WHERE deleted_at IS NOT NULL';
      const teams = this.db.run(`DELETE FROM activity_events WHERE team_id IN (${gone})`).changes
        + this.db.run(`DELETE FROM activity_current WHERE team_id IN (${gone})`).changes;
      return { events, current, teams };
    });
  }

  /** Account deletion: everything this user published goes now. */
  forgetUser(userId) {
    this.db.run('DELETE FROM activity_current WHERE author_user_id = ?', userId);
    this.db.run('DELETE FROM activity_events WHERE author_user_id = ?', userId);
    this.db.run("DELETE FROM activity_events WHERE type = 'collision' AND EXISTS (SELECT 1 FROM json_each(activity_events.payload, '$.authors') WHERE value = ?)", userId);
  }
}
