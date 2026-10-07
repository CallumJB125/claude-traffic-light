// Team activity (docs/TEAM-CONTEXT-CONTRACT.md "Hub activity log"): desktops
// publish scrubbed WorkRecords for repos their team owns; teammates read the
// feed, the latest record per session, or a live SSE stream. The hub flags
// collisions: two working/waiting records in one repo editing the same path.
//
// Authority: an account sign-in. Publishing needs this computer's own device
// sign-in and a writer membership in the team that owns the record's repo;
// a record_id stays with the account that first published it. Reading needs
// a current membership in the team. Storage is activity/log.js only.

import { HubError } from '../db.js';
import { can } from '../permissions.js';
import { limitOrThrow } from '../ratelimit.js';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../shared/protocol.js';
import { cleanPacketText, packetRelativePath } from '../../shared/packet-text.js';
import { ActivityLog } from './log.js';

export const ACTIVITY_LIMITS = Object.freeze({
  records: 50, bodyMax: 256 * 1024, recordBytes: 16 * 1024, files: 50, pathMax: 300,
  feedMax: 200, feedDefault: 100, currentMax: 500, collisionsPerRecord: 20,
  heartbeatMs: 25_000, streamsPerUser: 4, streamsTotal: 256, streamBufferMax: 1024 * 1024, retryMs: 5000,
});
const ADAPTERS = new Set(['claude', 'codex', 'gemini', 'hermes', 'cursor']);
const STATUSES = new Set(['working', 'waiting', 'review', 'ended', 'idle', 'paused_limit']);
const LIVE = ['working', 'waiting'];
const KEYS = new Set(['v', 'record_id', 'adapter', 'session_id', 'install_id', 'repo_id', 'folder', 'title', 'goal', 'summary', 'status',
  'files', 'branch', 'started_at', 'updated_at', 'rev', 'cost_usd', 'route', 'handover']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class Reject extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const bad = (reason) => { throw new Reject(reason); };

function text(v, max, { optional = true } = {}) {
  if (v == null || v === '') { if (optional) return ''; bad('invalid_text'); }
  if (typeof v !== 'string') bad('invalid_text');
  try { return cleanPacketText(v, max).trim(); } catch { return bad('text_too_long'); }
}
function time(v, { optional = false } = {}) {
  if (v == null && optional) return null;
  if (typeof v !== 'string' || !ISO.test(v) || !Number.isFinite(Date.parse(v))) bad('invalid_time');
  return new Date(Date.parse(v)).toISOString();
}
function paths(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > ACTIVITY_LIMITS.files) bad('invalid_files');
  const out = [];
  for (const p of list) {
    const ok = typeof p === 'string' && p.length <= ACTIVITY_LIMITS.pathMax ? packetRelativePath(p) : null;
    if (!ok) bad('invalid_path');
    if (!out.includes(ok)) out.push(ok);
  }
  return out;
}

/** A WorkRecord v1 as the hub stores it, or throws Reject. */
export function normalizeRecord(r, installId) {
  if (!object(r) || Object.keys(r).some((k) => !KEYS.has(k))) bad('invalid_record');
  if (r.v !== 1) bad('unsupported_version');
  if (typeof r.install_id !== 'string' || r.install_id.toLowerCase() !== installId) bad('install_mismatch');
  if (!ADAPTERS.has(r.adapter) || typeof r.session_id !== 'string' || !SESSION.test(r.session_id)) bad('invalid_identity');
  if (r.record_id !== `${r.install_id}:${r.adapter}:${r.session_id}`) bad('invalid_record_id');
  if (typeof r.repo_id !== 'string' || !UUID.test(r.repo_id)) bad('no_repo');
  if (!STATUSES.has(r.status)) bad('invalid_status');
  if (!Number.isSafeInteger(r.rev) || r.rev < 0) bad('invalid_rev');
  if (r.folder != null && (typeof r.folder !== 'string' || /[\\/]/.test(r.folder))) bad('invalid_folder');
  const folder = text(r.folder, 120);
  const title = text(r.title, 120);
  if (!title) bad('invalid_text');
  if (r.files != null && (!object(r.files) || Object.keys(r.files).some((k) => k !== 'edited' && k !== 'read'))) bad('invalid_files');
  if (r.branch != null && (typeof r.branch !== 'string' || r.branch.length > 200 || /[\s\u0000-\u001f\u007f]/.test(r.branch))) bad('invalid_branch');
  if (r.cost_usd != null && (typeof r.cost_usd !== 'number' || !Number.isFinite(r.cost_usd) || r.cost_usd < 0 || r.cost_usd > 1e6)) bad('invalid_cost');
  if (r.route != null && r.route !== 'primary' && r.route !== 'secondary') bad('invalid_route');
  let handover = null;
  if (r.handover != null) {
    if (!object(r.handover) || Object.keys(r.handover).some((k) => k !== 'available' && k !== 'written_at') || typeof r.handover.available !== 'boolean') bad('invalid_handover');
    handover = { available: r.handover.available, written_at: time(r.handover.written_at, { optional: true }) };
  }
  const out = {
    v: 1, record_id: r.record_id, adapter: r.adapter, session_id: r.session_id, install_id: installId, repo_id: r.repo_id.toLowerCase(),
    folder, title, goal: text(r.goal, 400), summary: text(r.summary, 1500), status: r.status,
    files: { edited: paths(r.files?.edited), read: paths(r.files?.read) },
    branch: r.branch == null ? null : text(r.branch, 200) || null,
    started_at: time(r.started_at), updated_at: time(r.updated_at), rev: r.rev,
    cost_usd: r.cost_usd ?? null, route: r.route ?? null, handover,
  };
  if (Buffer.byteLength(JSON.stringify(out)) > ACTIVITY_LIMITS.recordBytes) bad('record_too_large');
  return out;
}

function intParam(query, name, { min = 0, max = Number.MAX_SAFE_INTEGER, dflt }) {
  const raw = query.get(name);
  if (raw == null || raw === '') return dflt;
  if (!/^\d{1,15}$/.test(raw)) throw new HubError('VALIDATION', `${name} must be a whole number`);
  return Math.min(max, Math.max(min, Number(raw)));
}

export class Activity {
  constructor(hub) {
    this.hub = hub;
    this.db = hub.db;
    this.log = new ActivityLog(hub);
    this.limits = { ...ACTIVITY_LIMITS, ...hub.config?.activityLimits };
    this.streams = new Set();
  }

  // ── authority ─────────────────────────────────────────────────────────────

  live(ident) {
    if (!ident?.cred || ident.cred.scope || !['device', 'session'].includes(ident.cred.kind) || !this.hub.accounts?.credValid(ident.cred)) {
      throw new HubError('UNAUTHENTICATED', 'sign in again');
    }
  }

  /** Teams the user currently belongs to. */
  teamIds(userId) {
    return this.db.all(`SELECT m.org_id FROM members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.removed_at IS NULL AND o.deleted_at IS NULL`, userId).map((r) => r.org_id);
  }

  repo(repoId) {
    return this.db.get('SELECT r.id, r.org_id FROM repos r JOIN orgs o ON o.id = r.org_id WHERE r.id = ? AND o.deleted_at IS NULL', repoId);
  }

  writer(userId, orgId) {
    const m = this.db.get('SELECT * FROM members WHERE user_id = ? AND org_id = ? AND removed_at IS NULL', userId, orgId);
    return m && can(m, 'card.write') ? m : null;
  }

  /** The read scope: every team of the caller, or the one owning repo_id. */
  scope(ident, query) {
    this.live(ident);
    const teams = this.teamIds(ident.user.id);
    const raw = query.get('repo_id');
    if (raw == null || raw === '') return { teamIds: teams, repoId: null };
    const repo = UUID.test(raw) ? this.repo(raw.toLowerCase()) : null;
    if (!repo || !teams.includes(repo.org_id)) throw new HubError('NOT_FOUND', 'repo not found');
    return { teamIds: [repo.org_id], repoId: repo.id };
  }

  names() {
    const cache = new Map();
    return (teamId, userId) => {
      if (!userId) return null;
      const key = `${teamId}|${userId}`;
      if (!cache.has(key)) {
        const m = this.db.get('SELECT display_name FROM members WHERE org_id = ? AND user_id = ? ORDER BY removed_at IS NULL DESC, created_at DESC LIMIT 1', teamId, userId);
        const u = m?.display_name ? null : this.db.get('SELECT display_name FROM users WHERE id = ? AND deleted_at IS NULL', userId);
        cache.set(key, m?.display_name || u?.display_name || 'Teammate');
      }
      return cache.get(key);
    };
  }

  // ── publish ───────────────────────────────────────────────────────────────

  publish(ident, body) {
    this.live(ident);
    if (ident.cred.kind !== 'device') throw new HubError('FORBIDDEN', "publishing activity needs this computer's own Plexiform sign-in");
    if (!object(body) || Object.keys(body).some((k) => k !== 'install_id' && k !== 'records')) throw new HubError('VALIDATION', 'unknown activity fields');
    if (typeof body.install_id !== 'string' || !UUID.test(body.install_id)) throw new HubError('VALIDATION', 'install_id must be a UUID');
    if (!Array.isArray(body.records) || !body.records.length) throw new HubError('VALIDATION', 'records must be a non-empty list');
    if (body.records.length > this.limits.records) throw new HubError('PAYLOAD_TOO_LARGE', `at most ${this.limits.records} records per request`);
    const userId = ident.user.id;
    limitOrThrow(this.hub, 'activity_write_user', userId);
    const installId = body.install_id.toLowerCase();
    const results = [];
    this.log.write(() => {
      for (const raw of body.records) {
        const id = object(raw) && typeof raw.record_id === 'string' ? raw.record_id.slice(0, 300) : null;
        try {
          results.push(this.apply(userId, normalizeRecord(raw, installId)));
        } catch (e) {
          if (!(e instanceof Reject)) throw e;
          results.push({ record_id: id, rev: Number.isSafeInteger(raw?.rev) ? raw.rev : null, status: 'rejected', reason: e.reason });
        }
      }
    });
    return { results, head_seq: this.log.head() };
  }

  apply(userId, rec) {
    const repo = this.repo(rec.repo_id);
    if (!repo || !this.writer(userId, repo.org_id)) bad('repo_not_owned');
    const prev = this.log.current(rec.record_id);
    if (prev && prev.author_user_id !== userId) bad('record_not_yours');
    if (prev && prev.rev >= rec.rev) return { record_id: rec.record_id, rev: rec.rev, status: 'stale' };
    const at = this.hub.iso();
    const base = { teamId: repo.org_id, repoId: repo.id, recordId: rec.record_id, rev: rec.rev, authorUserId: userId, at };
    this.log.putCurrent({ ...base, status: rec.status, payload: rec });
    const seq = this.log.append({ ...base, type: rec.status === 'ended' ? 'record.end' : 'record.upsert', payload: rec });
    const collisions = this.collide(rec, prev, base);
    return { record_id: rec.record_id, rev: rec.rev, status: 'applied', seq, ...(collisions ? { collisions } : {}) };
  }

  /** New overlaps between this record's edited paths and other live records of its repo. */
  collide(rec, prev, base) {
    if (!LIVE.includes(rec.status) || !rec.files.edited.length) return 0;
    const before = prev && LIVE.includes(prev.status) && prev.repo_id === rec.repo_id ? new Set(prev.payload?.files?.edited ?? []) : new Set();
    let n = 0;
    for (const other of this.log.liveIn(rec.repo_id, LIVE)) {
      if (other.record_id === rec.record_id) continue;
      const theirs = new Set(other.payload?.files?.edited ?? []);
      for (const path of rec.files.edited) {
        if (!theirs.has(path) || before.has(path)) continue;
        if (n >= this.limits.collisionsPerRecord) return n;
        this.log.append({ ...base, type: 'collision', payload: { repo_id: rec.repo_id, path, records: [rec.record_id, other.record_id], authors: [base.authorUserId, other.author_user_id] } });
        n++;
      }
    }
    return n;
  }

  // ── read ──────────────────────────────────────────────────────────────────

  view(row, name) {
    if (row.type === 'collision') {
      const p = row.payload ?? {};
      return { seq: row.seq, type: 'collision', team_id: row.team_id, repo_id: row.repo_id, path: p.path ?? null, records: p.records ?? [],
        people: (p.authors ?? []).map((u) => name(row.team_id, u)), created_at: row.created_at };
    }
    return { seq: row.seq, type: row.type, team_id: row.team_id, repo_id: row.repo_id, record_id: row.record_id, rev: row.rev,
      author: name(row.team_id, row.author_user_id), record: row.payload, created_at: row.created_at };
  }

  feed(ident, query) {
    const scope = this.scope(ident, query);
    limitOrThrow(this.hub, 'activity_read_user', ident.user.id);
    const after = intParam(query, 'after', { dflt: 0 });
    const limit = intParam(query, 'limit', { min: 1, max: this.limits.feedMax, dflt: this.limits.feedDefault });
    const rows = this.log.events({ ...scope, after, limit });
    const name = this.names();
    const tail = this.log.tail();
    return { events: rows.map((r) => this.view(r, name)), next_seq: rows.length ? rows.at(-1).seq : after, head_seq: this.log.head(),
      ...(after > 0 && tail > after + 1 ? { truncated: true } : {}) };
  }

  current(ident, query) {
    const scope = this.scope(ident, query);
    limitOrThrow(this.hub, 'activity_read_user', ident.user.id);
    const name = this.names();
    return { records: this.log.currentFor({ ...scope, limit: this.limits.currentMax }).map((r) => ({ ...r.payload, team_id: r.team_id, author: name(r.team_id, r.author_user_id), received_at: r.updated_at })),
      head_seq: this.log.head() };
  }

  // ── stream (SSE) ──────────────────────────────────────────────────────────

  stream(ident, query, req, res) {
    const scope = this.scope(ident, query);
    limitOrThrow(this.hub, 'activity_stream_user', ident.user.id);
    const userId = ident.user.id;
    const mine = [...this.streams].filter((s) => s.userId === userId).length;
    if (mine >= this.limits.streamsPerUser || this.streams.size >= this.limits.streamsTotal) {
      throw new HubError('RATE_LIMITED', 'too many open activity streams', { retry_after_s: Math.ceil(this.limits.retryMs / 1000) });
    }
    const lastId = req.headers['last-event-id'];
    let cursor = typeof lastId === 'string' && /^\d{1,15}$/.test(lastId) ? Number(lastId) : intParam(query, 'after', { dflt: null });
    if (cursor == null) cursor = this.log.head();
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no', connection: 'keep-alive', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) });
    res.write(`retry: ${this.limits.retryMs}\n\n`);
    const s = { userId, ended: false, pumping: false, again: false };
    const end = () => {
      if (s.ended) return;
      s.ended = true;
      this.streams.delete(s);
      clearInterval(s.beat);
      s.unsub?.();
      if (!res.writableEnded) res.end();
    };
    s.end = end;
    const allowed = () => {
      try { this.live(ident); } catch { return null; }
      const teams = this.teamIds(userId);
      if (scope.repoId) return teams.includes(scope.teamIds[0]) ? scope : null;
      return { teamIds: teams, repoId: null };
    };
    const pump = async () => {
      if (s.ended) return;
      if (s.pumping) { s.again = true; return; }
      s.pumping = true;
      try {
        do {
          s.again = false;
          const now = allowed();
          if (!now) return end();
          for (;;) {
            const rows = this.log.events({ ...now, after: cursor, limit: this.limits.feedMax });
            if (!rows.length) break;
            const name = this.names();
            for (const row of rows) {
              if (s.ended) return;
              const v = this.view(row, name);
              const ok = res.write(`id: ${row.seq}\nevent: ${row.type}\ndata: ${JSON.stringify(v)}\n\n`);
              cursor = row.seq;
              if (res.writableLength > this.limits.streamBufferMax) return end();
              if (!ok) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
            }
            if (rows.length < this.limits.feedMax) break;
          }
        } while (s.again && !s.ended);
      } catch (e) {
        this.hub.log?.warn?.('activity stream failed', { err: e });
        end();
      } finally {
        s.pumping = false;
      }
    };
    s.beat = setInterval(() => {
      if (!allowed()) return end();
      res.write(': ping\n\n');
    }, this.limits.heartbeatMs);
    s.beat.unref?.();
    s.unsub = this.log.subscribe(() => { pump(); });
    this.streams.add(s);
    res.on('close', end);
    pump();
    return undefined;
  }

  // ── housekeeping ──────────────────────────────────────────────────────────

  sweep() { return this.log.sweep(); }
  forgetUser(userId) { this.log.forgetUser(userId); }
  close() { for (const s of [...this.streams]) s.end(); }

  routes(route) {
    const p = '/api/activity/v1';
    const o = { auth: 'user', replay: false };
    route('POST', `${p}/events`, ({ ident, body }) => this.publish(ident, body), { ...o, strictBody: true, maxBody: this.limits.bodyMax });
    route('GET', `${p}/feed`, ({ ident, query }) => this.feed(ident, query), o);
    route('GET', `${p}/current`, ({ ident, query }) => this.current(ident, query), o);
    route('GET', `${p}/stream`, ({ ident, query, req, res }) => this.stream(ident, query, req, res), o);
  }
}
