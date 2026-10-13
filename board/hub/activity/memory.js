// Team memory (docs/TEAM-CONTEXT-CONTRACT.md "Team memory"): a ranked
// full-text index over the team's current WorkRecords, so a teammate's AI can
// ask "has anyone already done or decided X?". The only module that touches
// memory_docs / memory_fts. ActivityLog calls the store half inside its own
// write transactions, so the index never disagrees with activity_current:
// an upsert replaces the row by record_id, and the same retention removes it.
//
// What is indexed is what teammates already see in the activity log (the
// hub-normalized, scrubbed record) plus the handover text its author chose
// to share; both are scrubbed again here, so an older row or a scrubber gap
// on one desktop never becomes searchable. Never transcripts.

import { HubError } from '../db.js';
import { cleanPacketText } from '../../shared/packet-text.js';
import { redactSecrets } from '../../shared/secret-patterns.mjs';

export const MEMORY_LIMITS = Object.freeze({
  qMin: 2, qMax: 200, terms: 12, limitMax: 50, limitDefault: 20, snippetTokens: 24, handoverMax: 8000,
});
const MARK_OPEN = '\u0002', MARK_CLOSE = '\u0003';
// title, goal, summary, files, branch, author, repo, handover
const WEIGHTS = [8, 4, 2, 2, 1.5, 1, 1, 1.5];
// Words a question carries that say nothing about the work.
const STOP = new Set(['a', 'an', 'and', 'any', 'anyone', 'are', 'as', 'at', 'be', 'been', 'by', 'did', 'do', 'does', 'done', 'for', 'from', 'has', 'have',
  'how', 'in', 'is', 'it', 'of', 'on', 'or', 'our', 'so', 'someone', 'that', 'the', 'this', 'to', 'was', 'we', 'what', 'when', 'where', 'who', 'why', 'with', 'yet']);

const scrub = (v, max) => {
  if (typeof v !== 'string' || !v) return '';
  try { return redactSecrets(cleanPacketText(v.slice(0, max), max)).replace(/[\u0002\u0003]/g, '').trim(); } catch { return ''; }
};
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * Someone's words → an FTS5 query, or null when nothing is searchable. Every
 * word is a quoted phrase (nothing typed is FTS syntax); words are ORed so a
 * question finds partial matches, which bm25 ranks below fuller ones; the last
 * word is a prefix while still being typed.
 */
export function toMatch(q) {
  const raw = String(q ?? '').slice(0, MEMORY_LIMITS.qMax);
  const parts = [];
  for (const term of raw.trim().split(/\s+/).filter(Boolean)) {
    const toks = term.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
    if (!toks) continue;
    if (toks.length === 1 && STOP.has(toks[0])) continue;
    const phrase = `"${toks.slice(0, 8).map((t) => t.slice(0, 64)).join(' ')}"`;
    if (!parts.includes(phrase)) parts.push(phrase);
    if (parts.length >= MEMORY_LIMITS.terms) break;
  }
  if (!parts.length) return null;
  if (!/\s$/.test(raw)) parts[parts.length - 1] += '*';
  return parts.join(' OR ');
}

export class TeamMemory {
  constructor(hub) {
    this.hub = hub;
    this.db = hub.db;
  }

  // ── store (ActivityLog, inside its transaction) ───────────────────────────

  names(teamId, userId, repoId) {
    const m = this.db.get('SELECT display_name FROM members WHERE org_id = ? AND user_id = ? ORDER BY removed_at IS NULL DESC, created_at DESC LIMIT 1', teamId, userId);
    const r = this.db.get('SELECT short_name, canonical_url FROM repos WHERE id = ?', repoId);
    return { author: scrub(m?.display_name, 120) || 'Teammate', repo: scrub([r?.short_name, r?.canonical_url].filter(Boolean).join(' '), 400) };
  }

  /** The searchable subset of a hub-normalized WorkRecord. */
  static fields(p) {
    const list = (k) => (Array.isArray(p?.files?.[k]) ? p.files[k].filter((x) => typeof x === 'string').slice(0, 50).map((x) => scrub(x, 300)).filter(Boolean) : []);
    return {
      adapter: typeof p?.adapter === 'string' ? p.adapter.slice(0, 20) : 'ai',
      title: scrub(p?.title, 120), goal: scrub(p?.goal, 400), summary: scrub(p?.summary, 1500),
      files: { edited: list('edited'), read: list('read') }, branch: scrub(p?.branch, 200) || null,
      folder: scrub(p?.folder, 120) || null, status: typeof p?.status === 'string' ? p.status : 'idle',
      started_at: typeof p?.started_at === 'string' ? p.started_at : null, updated_at: typeof p?.updated_at === 'string' ? p.updated_at : null,
      handover_available: p?.handover?.available === true,
    };
  }

  text(rowId, rec, names, handover) {
    this.db.run('DELETE FROM memory_fts WHERE rowid = ?', rowId);
    this.db.run('INSERT INTO memory_fts (rowid, title, goal, summary, files, branch, author, repo, handover) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      rowId, rec.title, rec.goal, rec.summary, [...rec.files.edited, ...rec.files.read].join('\n'), rec.branch ?? '', names.author, names.repo, handover ?? '');
  }

  /** Idempotent upsert by record_id; the shared handover text survives a new rev. */
  put({ recordId, teamId, repoId, rev, status, authorUserId, payload, at }) {
    const rec = TeamMemory.fields(payload);
    const prev = this.db.get('SELECT id, rev, author_user_id, team_id, handover, handover_at FROM memory_docs WHERE record_id = ?', recordId);
    if (prev && prev.rev > rev) return;
    // A record moved to another team starts over: its old shared text was for its old readers.
    const keep = prev && prev.team_id === teamId && prev.author_user_id === authorUserId;
    const handover = keep ? prev.handover : null;
    this.db.run(`INSERT INTO memory_docs (record_id, team_id, repo_id, author_user_id, rev, status, record, handover, handover_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET team_id = excluded.team_id, repo_id = excluded.repo_id, author_user_id = excluded.author_user_id, rev = excluded.rev,
      status = excluded.status, record = excluded.record, handover = excluded.handover, handover_at = excluded.handover_at, updated_at = excluded.updated_at`,
    recordId, teamId, repoId, authorUserId, rev, status, JSON.stringify(rec), handover, keep ? prev.handover_at : null, at);
    const id = this.db.get('SELECT id FROM memory_docs WHERE record_id = ?', recordId).id;
    this.text(id, rec, this.names(teamId, authorUserId, repoId), handover);
  }

  /** The handover text a record's author shared with the team (null clears it). → false when it is not their record. */
  setHandover(recordId, authorUserId, text) {
    const row = this.db.get('SELECT * FROM memory_docs WHERE record_id = ?', recordId);
    if (!row || row.author_user_id !== authorUserId) return false;
    const clean = text == null ? null : String(text).split('\n').slice(0, 400).map((l) => scrub(l, 500)).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MEMORY_LIMITS.handoverMax) || null;
    this.db.run('UPDATE memory_docs SET handover = ?, handover_at = ? WHERE id = ?', clean, clean ? this.hub.iso() : null, row.id);
    this.text(row.id, parse(row.record) ?? TeamMemory.fields(null), this.names(row.team_id, row.author_user_id, row.repo_id), clean);
    return true;
  }

  handover(recordId) { return this.db.get('SELECT handover FROM memory_docs WHERE record_id = ?', recordId)?.handover ?? null; }

  drop(ids) {
    for (const id of ids) {
      this.db.run('DELETE FROM memory_fts WHERE rowid = ?', id);
      this.db.run('DELETE FROM memory_docs WHERE id = ?', id);
    }
    return ids.length;
  }

  /** The activity log's retention for current rows (log.js RETENTION), applied to the index. */
  sweep(nowMs, { endedMs, staleMs }) {
    const iso = (ms) => new Date(nowMs - ms).toISOString();
    const ids = this.db.all(`SELECT id FROM memory_docs WHERE (status = 'ended' AND updated_at < ?) OR updated_at < ?
      OR team_id IN (SELECT id FROM orgs WHERE deleted_at IS NOT NULL)`, iso(endedMs), iso(staleMs)).map((r) => r.id);
    return this.drop(ids);
  }

  forgetUser(userId) { return this.drop(this.db.all('SELECT id FROM memory_docs WHERE author_user_id = ?', userId).map((r) => r.id)); }

  // ── read (scoped by the caller: a current member of teamId) ───────────────

  view(row, name) {
    const rec = parse(row.record) ?? {};
    return {
      record_id: row.record_id, team_id: row.team_id, repo_id: row.repo_id, repo: row.repo_name ?? null, author: name(row.team_id, row.author_user_id),
      adapter: rec.adapter ?? 'ai', title: rec.title ?? '', goal: rec.goal || null, summary: rec.summary || null, status: row.status, branch: rec.branch ?? null,
      files: rec.files ?? { edited: [], read: [] }, started_at: rec.started_at ?? null, updated_at: rec.updated_at ?? null, received_at: row.updated_at,
      handover_shared: row.handover != null, rev: row.rev,
    };
  }

  /** Ranked matches in one team (and one repo when given) updated since `since`. */
  search({ teamId, repoId = null, match, since = null, limit = MEMORY_LIMITS.limitDefault }, name) {
    const where = ['memory_fts MATCH ?', 'd.team_id = ?'];
    const args = [match, teamId];
    if (repoId) { where.push('d.repo_id = ?'); args.push(repoId); }
    if (since) { where.push('d.updated_at >= ?'); args.push(since); }
    const rows = this.db.all(`SELECT d.*, r.short_name AS repo_name,
        snippet(memory_fts, -1, char(2), char(3), '…', ${MEMORY_LIMITS.snippetTokens}) AS snip,
        bm25(memory_fts, ${WEIGHTS.join(', ')}) AS score
      FROM memory_fts JOIN memory_docs d ON d.id = memory_fts.rowid
      JOIN repos r ON r.id = d.repo_id AND r.org_id = d.team_id
      JOIN orgs o ON o.id = d.team_id AND o.deleted_at IS NULL
      WHERE ${where.join(' AND ')} ORDER BY score, d.updated_at DESC, d.id LIMIT ?`, ...args, limit);
    return rows.map((r) => ({ ...this.view(r, name), snippet: r.snip && r.snip.includes(MARK_OPEN) ? r.snip : null, score: Math.round(-r.score * 1000) / 1000 }));
  }

  get(teamId, recordId, name) {
    const row = this.db.get(`SELECT d.*, r.short_name AS repo_name FROM memory_docs d
      JOIN repos r ON r.id = d.repo_id AND r.org_id = d.team_id JOIN orgs o ON o.id = d.team_id AND o.deleted_at IS NULL
      WHERE d.record_id = ? AND d.team_id = ?`, recordId, teamId);
    if (!row) throw new HubError('NOT_FOUND', 'record not found');
    return { ...this.view(row, name), handover: row.handover ?? null, handover_at: row.handover_at ?? null };
  }
}

export { MARK_OPEN, MARK_CLOSE };
