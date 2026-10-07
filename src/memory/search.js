'use strict';

// "Search everything": ranked full-text search over the local memory index,
// and the main-process wiring for the Search page (register(ctx), called by
// src/paid-wiring.js). query()/facets() run inside the memory worker; the
// main thread only posts messages to it, so it never reads a transcript.
//
// Plans: search is free over the last limits()['memory.days'] days (7), and
// unlimited on Plus/Team. "Copy handover" is free (handoff.copy); one-click
// "Hand to Codex/Claude" is Plus (handoff.launch, src/handoff.js).

const fs = require('node:fs');
const path = require('node:path');

const DAY = 86400000;
const TOOLS = ['claude', 'codex', 'hermes', 'gemini', 'cursor'];
const KEY_SID = /^[\w.:-]{1,200}$/;
const HIT_ROWS = 300;
const MARK_OPEN = '\u0002', MARK_CLOSE = '\u0003';

// The person's words → an FTS5 query: every word must appear, a word with
// punctuation (a file name) is a phrase, and the last word is a prefix while
// still being typed. Nothing they type is FTS syntax. null when nothing searchable.
function toMatch(q) {
  const raw = String(q ?? '').slice(0, 500);
  const parts = [];
  for (const term of raw.trim().split(/\s+/).filter(Boolean).slice(0, 12)) {
    const toks = term.match(/[\p{L}\p{N}_]+/gu);
    if (toks) parts.push(`"${toks.slice(0, 8).map((t) => t.slice(0, 64)).join(' ')}"`);
  }
  if (!parts.length) return null;
  if (!/\s$/.test(raw)) parts[parts.length - 1] += '*';
  return parts.join(' ');
}

const tilde = (p, home) => (typeof p === 'string' && home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);

// The earliest time a search may reach: the plan's window, narrowed by the person's own date filter.
function windowOf({ days = Infinity, from = null, now = Date.now() } = {}) {
  const plan = Number.isFinite(days) && days > 0 ? now - days * DAY : 0;
  return { since: Math.max(plan, Number.isFinite(from) ? from : 0), limited: plan > 0, planSince: plan };
}

// → {hits: [{tool, sid, title, repo, branch, cwd, ts, role, snippet, matches}], limited, tookMs}
function query(ix, { q = '', tool = null, repo = null, from = null, to = null, limit = 30 } = {}, { days = Infinity, now = Date.now(), home = null } = {}) {
  const began = process.hrtime.bigint();
  const { since, limited } = windowOf({ days, from, now });
  const until = Number.isFinite(to) ? to : 8.64e15;
  const where = ['t.ts >= ?', 't.ts <= ?'], args = [since, until];
  if (TOOLS.includes(tool)) { where.push('s.tool = ?'); args.push(tool); }
  if (typeof repo === 'string' && repo) { where.push('s.repo = ?'); args.push(repo.slice(0, 200)); }
  const match = toMatch(q);
  const n = Math.max(1, Math.min(100, Number(limit) || 30));
  let hits = [];
  if (match) {
    const rows = ix.db.prepare(`SELECT t.ts, t.role, t.files, s.id AS session, s.tool, s.sid, s.title, s.repo, s.branch, s.cwd,
        snippet(turns_fts, 0, char(2), char(3), '…', 16) AS snip, bm25(turns_fts, 1.0, 0.5) AS rank
      FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid JOIN sessions s ON s.id = t.session
      WHERE turns_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ${HIT_ROWS}`).all(match, ...args);
    const by = new Map();
    for (const r of rows) {
      const h = by.get(r.session);
      if (h) { h.matches += 1; continue; }
      if (by.size >= n) continue;
      const snippet = r.snip && r.snip.includes(MARK_OPEN) ? r.snip : r.files.split('\n').find((f) => f) || r.snip;
      by.set(r.session, { tool: r.tool, sid: r.sid, title: r.title, repo: r.repo, branch: r.branch, cwd: tilde(r.cwd, home), ts: r.ts, role: r.role, snippet, matches: 1 });
    }
    hits = [...by.values()];
  } else {
    // No words: the most recent sessions in the window and filters.
    hits = ix.db.prepare(`SELECT s.tool, s.sid, s.title, s.repo, s.branch, s.cwd, max(t.ts) AS ts,
        (SELECT text FROM turns WHERE session = s.id AND role = 'user' AND text <> '' ORDER BY ts DESC LIMIT 1) AS last
      FROM sessions s JOIN turns t ON t.session = s.id WHERE ${where.join(' AND ')} GROUP BY s.id ORDER BY ts DESC LIMIT ${n}`).all(...args)
      .map((r) => ({ tool: r.tool, sid: r.sid, title: r.title, repo: r.repo, branch: r.branch, cwd: tilde(r.cwd, home), ts: r.ts, role: 'user', snippet: r.last ? r.last.slice(0, 240) : '', matches: 0 }));
  }
  return { hits, limited, since, tookMs: Number(process.hrtime.bigint() - began) / 1e6 };
}

// The filter choices: tools and repos that have something in the window.
function facets(ix, { days = Infinity, now = Date.now() } = {}) {
  const { since } = windowOf({ days, now });
  const tools = ix.db.prepare('SELECT tool, count(*) AS n FROM sessions WHERE coalesce(ended, 0) >= ? GROUP BY tool').all(since).map((r) => r.tool);
  const repos = ix.db.prepare('SELECT repo, max(ended) AS m FROM sessions WHERE repo IS NOT NULL AND coalesce(ended, 0) >= ? GROUP BY repo ORDER BY m DESC LIMIT 100').all(since).map((r) => r.repo);
  return { tools, repos };
}

// ── Main process ────────────────────────────────────────────────────────────

const STARTUP_MS = 30 * 1000;
const EVERY_MS = 10 * 60 * 1000;
const STALE_MS = 2 * 60 * 1000;
const PAGE = 'memory';

// A request/response channel to the memory worker; restarted on next use if it dies.
function createClient({ file, workerData, Worker, log = () => {} }) {
  let w = null, seq = 0;
  const pending = new Map();
  function ensure() {
    if (w) return w;
    w = new Worker(file, { workerData }); // privacy-flow: memory-index
    const self = w;
    self.on('message', (m) => {
      const p = m && pending.get(m.id);
      if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    });
    const down = (e) => {
      if (w !== self) return;
      w = null;
      if (e && e.message) log(`[memory] worker stopped: ${e.message}`);
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('The search index stopped; try again.')); }
      pending.clear();
    };
    self.on('error', down);
    self.on('exit', () => down(null));
    return self;
  }
  function call(type, args = {}, ms = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type} timed out`)); }, ms);
      pending.set(id, { resolve, reject, timer });
      try { ensure().postMessage({ id, type, ...args }); } catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
    });
  }
  function stop() {
    const x = w;
    w = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('The search index stopped.')); }
    pending.clear();
    if (x) x.terminate().catch(() => {});
  }
  return { call, stop };
}

const keyOk = (k) => !!k && typeof k === 'object' && TOOLS.includes(k.tool) && typeof k.sid === 'string' && KEY_SID.test(k.sid);
const num = (v) => (Number.isFinite(v) ? v : null);

function register(ctx = {}) {
  const { ipcMain, rootDir, entitlements: E, fromPage = () => false, onQuit = () => {}, log = () => {} } = ctx;
  if (!ipcMain || !rootDir || !E || !E.has('memory.search')) return null;
  const os = require('node:os');
  const { Worker } = require('node:worker_threads');
  const { clipboard, shell } = ctx.electron ?? require('electron');
  const SessionHandover = require('../session-handover.js');
  const Handoff = require('../handoff.js');
  const home = ctx.home ?? os.homedir();
  const dir = path.join(rootDir, 'memory');
  const settingsFile = path.join(dir, 'settings.json');
  const client = createClient({ file: path.join(__dirname, 'worker.js'), workerData: { dir }, Worker, log });
  const days = () => { const d = E.limits()['memory.days']; return Number.isFinite(d) ? d : Infinity; };
  const settings = () => { try { const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); return { experimental: s.experimental === true }; } catch { return { experimental: false }; } };
  const saveSettings = (s) => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(settingsFile, JSON.stringify(s), { mode: 0o600 }); };

  let passing = null, lastPass = 0, followUp = null;
  function pass() {
    if (passing) return passing;
    passing = client.call('index', { home, rootDir, days: days(), experimental: settings().experimental }, 5 * 60 * 1000)
      .then((r) => { lastPass = Date.now(); if (r && r.more && !followUp) { followUp = setTimeout(() => { followUp = null; pass(); }, 2000); followUp.unref?.(); } return r; })
      .catch((e) => { log(`[memory] index pass failed: ${e && e.message}`); return null; })
      .finally(() => { passing = null; });
    return passing;
  }
  const startup = setTimeout(pass, STARTUP_MS); startup.unref?.();
  const every = setInterval(pass, EVERY_MS); every.unref?.();

  // The session's handover: the one Plexiform already keeps (with git facts), else one built from its transcript in the worker.
  const adapterOf = (tool) => (tool === 'claude' ? 'claude-code' : tool);
  async function docFor(k) {
    const file = path.join(rootDir, 'handovers', `${SessionHandover.keyOf(adapterOf(k.tool), k.sid)}.md`);
    try { const text = fs.readFileSync(file, 'utf8'); if (text.startsWith(SessionHandover.MARKER)) return { text, file }; } catch { /* none kept */ }
    const text = await client.call('handover', { tool: k.tool, sid: k.sid, home });
    return text ? { text, file: null } : null;
  }
  const handoff = Handoff.create({ entitlements: E, clipboard, docFor: async (k) => (await docFor(k))?.text ?? null, adapters: Handoff.defaultAdapters({ version: ctx.app?.getVersion?.() ?? '0' }), log });

  const allowed = (e) => fromPage(e, PAGE);
  const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed.' };
    try { return await fn(e, ...args); } catch (err) { log(`[memory] ${ch} failed: ${err && err.message}`); return { ok: false, error: 'Something went wrong. Try again.' }; }
  });

  handle('memory:status', async () => {
    if (Date.now() - lastPass > STALE_MS) pass();
    const stats = await client.call('stats');
    return { ok: true, stats, days: Number.isFinite(days()) ? days() : null, plan: E.plan(), canLaunch: E.has('handoff.launch'), experimental: settings().experimental, indexing: !!passing };
  });
  handle('memory:search', async (_e, req) => {
    const r = req && typeof req === 'object' ? req : {};
    const out = await client.call('search', { req: { q: typeof r.q === 'string' ? r.q.slice(0, 500) : '', tool: TOOLS.includes(r.tool) ? r.tool : null, repo: typeof r.repo === 'string' ? r.repo.slice(0, 200) : null, from: num(r.from), to: num(r.to) }, days: days(), home });
    return { ok: true, ...out, days: Number.isFinite(days()) ? days() : null };
  });
  handle('memory:facets', async () => ({ ok: true, ...(await client.call('facets', { days: days() })) }));
  handle('memory:reindex', async () => { pass(); return { ok: true }; });
  handle('memory:clear', async () => { await client.call('clear'); lastPass = 0; return { ok: true }; });
  handle('memory:settings', async (_e, s) => { saveSettings({ experimental: !!(s && s.experimental === true) }); pass(); return { ok: true, experimental: settings().experimental }; });
  handle('memory:handover', async (_e, action, k) => {
    if (!keyOk(k) || (action !== 'open' && action !== 'copy')) return { ok: false, error: 'Unknown session.' };
    if (action === 'copy') return handoff.copy(k);
    const doc = await docFor(k);
    if (!doc) return { ok: false, error: 'No handover could be built for this session.' };
    let file = doc.file;
    if (!file) {
      const out = path.join(dir, 'handovers');
      fs.mkdirSync(out, { recursive: true, mode: 0o700 });
      file = path.join(out, `${SessionHandover.keyOf(adapterOf(k.tool), k.sid)}.md`);
      fs.writeFileSync(file, doc.text, { mode: 0o600 });
    }
    return { ok: (await shell.openPath(file)) === '' };
  });
  handle('memory:hand', async (e, k, to) => {
    if (!keyOk(k)) return { ok: false, error: 'Unknown session.' };
    const sender = e.sender;
    return handoff.hand(k, to, (ev) => { if (!sender.isDestroyed()) sender.send('memory:handoff-event', ev); });
  });
  handle('memory:reply', async (_e, id, text) => handoff.reply(id, text));
  handle('memory:end', async (_e, id) => handoff.end(id));

  onQuit(() => { clearTimeout(startup); clearInterval(every); if (followUp) clearTimeout(followUp); handoff.stop(); client.stop(); });
  return { pass, client, handoff };
}

module.exports = { register, query, facets, toMatch, windowOf, createClient, TOOLS, MARK_OPEN, MARK_CLOSE };
