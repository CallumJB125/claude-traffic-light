'use strict';

// The local memory index: one SQLite FTS5 database, <data root>/memory/index.db
// (0600 in a 0700 folder), built from each AI tool's own transcripts by the
// adapters in ./adapters. Runs only in the memory worker (./worker.js): the
// main thread never reads a transcript or a session folder.
//
// What is stored: per session the tool, its id, folder, repo name, branch,
// title and times; per turn the person's prompt or the assistant's text reply
// (capped), and the tool names and file paths its tool calls named. Tool
// output is never read. Every text passes the shared secret scrubber
// (src/scrub.js → src/secret-patterns.js) before it is written, so a secret
// never reaches the file. Sessions in a muted project are skipped and removed.
// The repo is taken from the transcript (folder name, or the remote Codex
// recorded); the folder itself is never opened.

const fs = require('node:fs');
const path = require('node:path');
const { redactSecretsPass } = require('../scrub.js');
const { projectMuted } = require('../quiet.js');

const ADAPTERS = [require('./adapters/claude.js'), require('./adapters/codex.js'), require('./adapters/hermes.js'), require('./adapters/gemini.js'), require('./adapters/cursor.js')];
const DAY = 86400000;
const MAX_TEXT = 4000;
const MAX_TITLE = 120;
const MAX_FILES = 50;
const PASS_BUDGET_MS = 15000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, tool TEXT NOT NULL, sid TEXT NOT NULL, cwd TEXT, repo TEXT, branch TEXT, title TEXT,
  started INTEGER, ended INTEGER, cost REAL, source TEXT, UNIQUE(tool, sid));
CREATE TABLE IF NOT EXISTS turns(id INTEGER PRIMARY KEY, session INTEGER NOT NULL, ts INTEGER NOT NULL, role TEXT NOT NULL,
  text TEXT NOT NULL, files TEXT NOT NULL DEFAULT '', tools TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS turns_session ON turns(session, ts);
CREATE INDEX IF NOT EXISTS turns_ts ON turns(ts);
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(text, files, content='turns', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN INSERT INTO turns_fts(rowid, text, files) VALUES (new.id, new.text, new.files); END;
CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN INSERT INTO turns_fts(turns_fts, rowid, text, files) VALUES ('delete', old.id, old.text, old.files); END;
CREATE TABLE IF NOT EXISTS sources(path TEXT PRIMARY KEY, tool TEXT NOT NULL, size INTEGER, mtime REAL, cursor TEXT);
`;

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// Redacted whole, then cut: cutting first could split a secret so no pattern matches the part left.
const clean = (s, n) => clip(redactSecretsPass(String(s ?? '')), n);
const tighten = (file) => { try { fs.chmodSync(file, 0o600); } catch { /* not there */ } };

function openIndex(dir) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'index.db');
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  tighten(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;');
  db.exec(SCHEMA);
  const ix = { db, dir, file };
  ix.tighten = () => { for (const f of [file, `${file}-wal`, `${file}-shm`]) tighten(f); };
  ix.tighten();
  ix.close = () => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* closing anyway */ } db.close(); ix.tighten(); };
  return ix;
}

const metaGet = (ix, k) => ix.db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
const metaSet = (ix, k, v) => ix.db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));

function tx(ix, fn) {
  ix.db.exec('BEGIN');
  try { const r = fn(); ix.db.exec('COMMIT'); return r; } catch (e) { try { ix.db.exec('ROLLBACK'); } catch { /* already */ } throw e; }
}

function dropSession(ix, id) {
  ix.db.prepare('DELETE FROM turns WHERE session = ?').run(id);
  ix.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// One adapter session (or the part of it one read produced) → rows. → turns written.
function addSession(ix, tool, s, source = null, muted = []) {
  if (!s || typeof s.sid !== 'string' || !s.sid) return 0;
  const sid = s.sid.slice(0, 200);
  const prev = ix.db.prepare('SELECT id, cwd FROM sessions WHERE tool = ? AND sid = ?').get(tool, sid);
  const cwd = typeof s.cwd === 'string' && s.cwd ? s.cwd.slice(0, 500) : prev?.cwd ?? null;
  if (cwd && projectMuted(muted, cwd)) { if (prev) dropSession(ix, prev.id); return 0; }
  const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  const row = ix.db.prepare(`INSERT INTO sessions(tool, sid, cwd, repo, branch, title, started, ended, cost, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tool, sid) DO UPDATE SET cwd = coalesce(excluded.cwd, cwd), repo = coalesce(excluded.repo, repo), branch = coalesce(excluded.branch, branch),
      title = coalesce(excluded.title, title), started = min(coalesce(excluded.started, started), coalesce(started, excluded.started)),
      ended = max(coalesce(excluded.ended, ended), coalesce(ended, excluded.ended)), cost = coalesce(excluded.cost, cost), source = coalesce(excluded.source, source)
    RETURNING id`).get(tool, sid, cwd, s.repo ? clip(s.repo, 200) : null, s.branch ? clip(s.branch, 200) : null, s.title ? clip(redactSecretsPass(s.title).replace(/\s+/g, ' '), MAX_TITLE) : null,
    num(s.started), num(s.ended), Number.isFinite(s.cost) ? s.cost : null, source);
  if (s.replace) ix.db.prepare('DELETE FROM turns WHERE session = ?').run(row.id);
  const ins = ix.db.prepare('INSERT INTO turns(session, ts, role, text, files, tools) VALUES (?, ?, ?, ?, ?, ?)');
  let n = 0;
  for (const t of Array.isArray(s.turns) ? s.turns : []) {
    if (!t || !Number.isFinite(t.ts) || (t.role !== 'user' && t.role !== 'assistant')) continue;
    const files = [...new Set((t.files || []).filter((f) => typeof f === 'string' && f))].slice(0, MAX_FILES).map((f) => clean(f, 500));
    const tools = [...new Set((t.tools || []).filter((x) => typeof x === 'string' && x))].slice(0, MAX_FILES).map((x) => clip(x, 80));
    ins.run(row.id, Math.round(t.ts), t.role, clean(t.text, MAX_TEXT), files.join('\n'), tools.join(' '));
    n += 1;
  }
  return n;
}

function readMuted(rootDir) {
  try { const c = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8')); return Array.isArray(c.mutedProjects) ? c.mutedProjects : []; } catch { return []; }
}

// The window this plan may index and search: limits()['memory.days'] (Infinity = everything).
const sinceOf = (days, now) => (Number.isFinite(days) && days > 0 ? now - days * DAY : 0);

// Drop what is outside the window, in a muted project, or from a tool no longer included.
function prune(ix, { since = 0, muted = [], tools = null } = {}) {
  tx(ix, () => {
    if (since > 0) {
      ix.db.prepare('DELETE FROM turns WHERE ts < ?').run(since);
      ix.db.prepare('DELETE FROM sessions WHERE (ended IS NULL OR ended < ?) AND NOT EXISTS (SELECT 1 FROM turns WHERE turns.session = sessions.id)').run(since);
    }
    for (const s of ix.db.prepare('SELECT id, tool, cwd FROM sessions').all()) {
      if ((s.cwd && projectMuted(muted, s.cwd)) || (tools && !tools.includes(s.tool))) dropSession(ix, s.id);
    }
    if (tools) for (const r of ix.db.prepare('SELECT path, tool FROM sources').all()) if (!tools.includes(r.tool)) ix.db.prepare('DELETE FROM sources WHERE path = ?').run(r.path);
  });
}

function wipe(ix) { tx(ix, () => { ix.db.exec('DELETE FROM turns; DELETE FROM sessions; DELETE FROM sources;'); }); }

// One indexing pass, newest transcripts first, yielding between reads so a
// search is answered meanwhile. → {sources, turns, more} (more: budget ran out).
async function indexPass(ix, { home, rootDir = null, days = Infinity, experimental = false, muted = rootDir ? readMuted(rootDir) : [], now = Date.now(),
  budgetMs = PASS_BUDGET_MS, adapters = ADAPTERS, platform = process.platform, env = process.env, pause = () => new Promise((r) => setImmediate(r)) } = {}) {
  const began = Date.now();
  const since = sinceOf(days, now);
  const active = adapters.filter((a) => experimental || !a.experimental);
  const prevSince = Number(metaGet(ix, 'since'));
  // A wider window (a plan upgrade) re-reads everything once; a narrower one only prunes.
  if (Number.isFinite(prevSince) && metaGet(ix, 'since') !== null && since < prevSince - DAY) wipe(ix);
  metaSet(ix, 'since', since);
  prune(ix, { since, muted, tools: active.map((a) => a.id) });
  const list = [];
  for (const a of active) {
    let found = [];
    try { found = a.sources({ home, since, platform, env }); } catch { found = []; }
    for (const src of found) list.push({ a, src });
  }
  list.sort((x, y) => y.src.mtimeMs - x.src.mtimeMs);
  let sources = 0, turns = 0;
  const getSrc = ix.db.prepare('SELECT size, mtime, cursor FROM sources WHERE path = ?');
  const putSrc = ix.db.prepare(`INSERT INTO sources(path, tool, size, mtime, cursor) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, cursor = excluded.cursor`);
  for (const { a, src } of list) {
    if (Date.now() - began > budgetMs) return { sources, turns, more: true };
    const row = getSrc.get(src.path);
    if (row && !src.always && row.size === src.size && row.mtime === src.mtimeMs) continue;
    let cursor = row && row.cursor ? JSON.parse(row.cursor) : null;
    sources += 1;
    for (;;) {
      let r;
      try { r = a.read(src, cursor, { since, home }); } catch { break; }
      if (r.reset) {
        // The file was replaced or truncated: its sessions are read again from the start.
        tx(ix, () => { for (const s of ix.db.prepare('SELECT id FROM sessions WHERE source = ?').all(src.path)) dropSession(ix, s.id); });
        cursor = null;
        continue;
      }
      turns += tx(ix, () => {
        let n = 0;
        for (const s of r.sessions) n += addSession(ix, a.id, s, src.path, muted);
        putSrc.run(src.path, a.id, r.more ? -1 : src.size, r.more ? -1 : src.mtimeMs, JSON.stringify(r.cursor ?? {}));
        return n;
      });
      cursor = r.cursor;
      await pause();
      if (!r.more) break;
      if (Date.now() - began > budgetMs) { ix.tighten(); return { sources, turns, more: true }; }
    }
  }
  metaSet(ix, 'lastPass', now);
  ix.tighten();
  return { sources, turns, more: false };
}

function stats(ix) {
  const t = ix.db.prepare('SELECT count(*) AS n, min(ts) AS oldest FROM turns').get();
  const s = ix.db.prepare('SELECT count(*) AS n FROM sessions').get();
  const byTool = ix.db.prepare('SELECT tool, count(*) AS n FROM sessions GROUP BY tool').all();
  return { turns: t.n, sessions: s.n, oldest: t.oldest ?? null, lastPass: Number(metaGet(ix, 'lastPass')) || null, byTool: Object.fromEntries(byTool.map((r) => [r.tool, r.n])) };
}

const sessionRow = (ix, tool, sid) => ix.db.prepare('SELECT id, tool, sid, cwd, repo, branch, title, started, ended, source FROM sessions WHERE tool = ? AND sid = ?').get(tool, sid) ?? null;

// Handover facts (hooks/handover-tap.js shape) from the index alone, for a
// tool whose transcript src/handover-transcripts.js cannot read.
const EDIT_TOOLS = /^(?:edit|write|multiedit|notebookedit|apply_patch|write_file|replace|edit_file|str_replace\w*)$/i;
function factsOf(ix, tool, sid, adapter = tool) {
  const s = sessionRow(ix, tool, sid);
  if (!s) return null;
  const turns = ix.db.prepare('SELECT ts, role, text, files, tools FROM turns WHERE session = ? ORDER BY ts, id').all(s.id);
  const users = turns.filter((t) => t.role === 'user' && t.text);
  const replies = turns.filter((t) => t.role === 'assistant' && t.text);
  const files = {}, tools = {};
  for (const t of turns) {
    const names = t.tools ? t.tools.split(' ') : [];
    for (const n of names) tools[n] = (tools[n] || 0) + 1;
    const kind = names.some((n) => EDIT_TOOLS.test(n)) ? 'edit' : 'read';
    for (const f of t.files ? t.files.split('\n') : []) if (Object.keys(files).length < 200 && files[f] !== 'edit') files[f] = kind;
  }
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  return {
    v: 1, adapter, sessionId: sid, cwd: s.cwd || '', startedAt: iso(s.started), lastActive: iso(s.ended),
    firstPrompt: users[0] ? clip(users[0].text, 400) : null, lastPrompt: users.length ? clip(users[users.length - 1].text, 400) : null,
    lastAssistant: replies.length ? clip(replies[replies.length - 1].text, 400) : null,
    tools, files, commands: [], source: 'transcript',
  };
}

module.exports = { ADAPTERS, openIndex, indexPass, addSession, prune, wipe, stats, sessionRow, factsOf, sinceOf, readMuted, DAY, MAX_TEXT };
