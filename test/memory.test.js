'use strict';
// W1-D: local memory index (src/memory/*) and cross-tool hand-off (src/handoff.js).
// Fixtures only: every transcript lives in a temp HOME; nothing reads the real one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const Indexer = require('../src/memory/indexer.js');
const Search = require('../src/memory/search.js');
const Handoff = require('../src/handoff.js');
const { createCodexAppServer } = require('../src/codex-app-server.js');

const FIX = path.join(__dirname, 'fixtures', 'memory');
const FAKE_CODEX = path.join(__dirname, 'fixtures', 'fake-codex-app-server.js');
const CLAUDE_A = '11111111-1111-4111-8111-111111111111';
const CLAUDE_MUTED = '22222222-2222-4222-8222-222222222222';
const CODEX = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-10-03T12:00:00Z');
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

function rig({ muted = [] } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-memory-'));
  const home = path.join(base, 'home'), root = path.join(base, 'data');
  const claudeDir = path.join(home, '.claude', 'projects', '-Users-dev-work');
  const codexDir = path.join(home, '.codex', 'sessions', '2026', '10', '02');
  fs.mkdirSync(claudeDir, { recursive: true }); fs.mkdirSync(codexDir, { recursive: true }); fs.mkdirSync(root, { recursive: true });
  for (const f of fs.readdirSync(path.join(FIX, 'claude'))) fs.copyFileSync(path.join(FIX, 'claude', f), path.join(claudeDir, f));
  for (const f of fs.readdirSync(path.join(FIX, 'codex'))) fs.copyFileSync(path.join(FIX, 'codex', f), path.join(codexDir, f));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ mutedProjects: muted }));
  const ix = Indexer.openIndex(path.join(root, 'memory'));
  const done = () => { try { ix.close(); } catch { /* closed */ } fs.rmSync(base, { recursive: true, force: true }); };
  return { base, home, root, ix, claudeDir, codexDir, done };
}
const pass = (r, opts = {}) => Indexer.indexPass(r.ix, { home: r.home, rootDir: r.root, days: Infinity, now: NOW, pause: async () => {}, ...opts });
const find = (r, q, filters = {}, opts = {}) => Search.query(r.ix, { q, ...filters }, { days: Infinity, now: NOW, home: r.home, ...opts }).hits;

test('indexes fixture Claude and Codex transcripts: prompts and replies, never tool output or side chains', async () => {
  const r = rig();
  try {
    const res = await pass(r);
    assert.equal(res.more, false);
    const rounding = find(r, 'rounding');
    const claude = rounding.find((h) => h.sid === CLAUDE_A);
    assert.ok(claude, 'claude session found');
    assert.equal(claude.tool, 'claude'); assert.equal(claude.title, 'Invoice rounding fix'); assert.equal(claude.repo, 'billing-api'); assert.equal(claude.branch, 'fix/rounding');
    assert.match(claude.snippet, new RegExp(`${Search.MARK_OPEN}rounding${Search.MARK_CLOSE}`, 'i'));
    const codex = find(r, 'debounce');
    assert.equal(codex.length, 1);
    assert.equal(codex[0].tool, 'codex'); assert.equal(codex[0].sid, CODEX); assert.equal(codex[0].repo, 'web-app'); assert.equal(codex[0].branch, 'feat/search');
    assert.equal(codex[0].cwd, '/Users/dev/work/web-app');
    // A file path a tool call named is searchable.
    assert.equal(find(r, 'SearchBar.tsx')[0].sid, CODEX);
    assert.ok(find(r, 'totals.js').some((h) => h.sid === CLAUDE_A));
    // Tool output, side-chain and harness lines never reach the index.
    for (const word of ['zebracorn', 'platypusoid', 'quokkafish', 'environment_context']) assert.deepEqual(find(r, word), [], word);
    // Codex writes each message twice (response_item + event_msg): stored once.
    const turns = r.ix.db.prepare("SELECT role, text, tools, files FROM turns JOIN sessions s ON s.id = turns.session WHERE s.tool = 'codex' ORDER BY turns.id").all();
    assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant']);
    assert.equal(turns[1].tools, 'shell apply_patch'); assert.equal(turns[1].files, 'src/SearchBar.tsx');
    // Filters: tool, repo, date.
    assert.deepEqual(find(r, 'rounding', { tool: 'codex' }), []);
    assert.ok(find(r, 'rounding', { repo: 'billing-api' }).length >= 1);
    assert.deepEqual(find(r, 'rounding', { repo: 'web-app' }), []);
    assert.deepEqual(find(r, 'debounce', { from: Date.parse('2026-10-03T00:00:00Z') }), []);
    assert.equal(find(r, 'debounce', { to: Date.parse('2026-10-02T23:00:00Z') }).length, 1);
    // No words: recent sessions, newest first.
    const recent = find(r, '');
    assert.equal(recent[0].sid, CLAUDE_MUTED);
  } finally { r.done(); }
});

test('a second pass reads only what was appended', async () => {
  const r = rig();
  try {
    await pass(r);
    const count = () => r.ix.db.prepare('SELECT count(*) AS n FROM turns').get().n;
    const before = count();
    assert.equal((await pass(r)).sources, 0, 'unchanged files are not read again');
    fs.appendFileSync(path.join(r.claudeDir, `${CLAUDE_A}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: CLAUDE_A, cwd: '/Users/dev/work/billing-api', timestamp: '2026-10-01T09:05:00.000Z', message: { role: 'user', content: 'Now add a regression test for wombatfloat' } })}\n`);
    await pass(r);
    assert.equal(count(), before + 1);
    assert.equal(find(r, 'wombatfloat')[0].sid, CLAUDE_A);
  } finally { r.done(); }
});

test('sessions in a muted project are skipped, and removed once muted', async () => {
  const r = rig({ muted: ['secret-client'] });
  try {
    await pass(r);
    assert.ok(!find(r, 'rounding').some((h) => h.sid === CLAUDE_MUTED));
    assert.equal(r.ix.db.prepare('SELECT count(*) AS n FROM sessions WHERE sid = ?').get(CLAUDE_MUTED).n, 0);
    // Indexed while unmuted, then muted: gone on the next pass.
    fs.writeFileSync(path.join(r.root, 'config.json'), JSON.stringify({ mutedProjects: [] }));
    Indexer.wipe(r.ix); await pass(r);
    assert.ok(find(r, 'rounding').some((h) => h.sid === CLAUDE_MUTED));
    fs.writeFileSync(path.join(r.root, 'config.json'), JSON.stringify({ mutedProjects: ['/Users/dev/secret-client'] }));
    await pass(r);
    assert.ok(!find(r, 'rounding').some((h) => h.sid === CLAUDE_MUTED));
  } finally { r.done(); }
});

test('secrets from src/secret-patterns.js never reach index.db (the test greps the database files)', async () => {
  const rows = require('./fixtures/secret-patterns-positives.json').rows.map((x) => ({ kind: x.kind, text: x.text.join(''), secret: x.secret.join('') }));
  const r = rig();
  try {
    const file = path.join(r.claudeDir, '44444444-4444-4444-8444-444444444444.jsonl');
    const lines = [];
    rows.forEach((x, i) => {
      const ts = new Date(Date.parse('2026-10-02T00:00:00Z') + i * 1000).toISOString();
      lines.push(JSON.stringify({ type: 'user', sessionId: 'x', cwd: '/Users/dev/work/leaky', timestamp: ts, message: { role: 'user', content: `please use this: ${x.text}` } }));
      lines.push(JSON.stringify({ type: 'assistant', sessionId: 'x', cwd: '/Users/dev/work/leaky', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: `Noted, ${x.text}` }, { type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: x.text } }] } }));
    });
    lines.push(JSON.stringify({ type: 'ai-title', sessionId: 'x', aiTitle: rows[0].text }));
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    await pass(r);
    assert.ok(r.ix.db.prepare('SELECT count(*) AS n FROM turns').get().n >= rows.length, 'the leaky session was indexed');
    r.ix.close();
    const dir = path.join(r.root, 'memory');
    const bytes = fs.readdirSync(dir).filter((f) => f.startsWith('index.db')).map((f) => fs.readFileSync(path.join(dir, f)).toString('latin1')).join('\n');
    const leaked = rows.filter((x) => x.secret.length >= 8 && bytes.includes(x.secret)).map((x) => x.kind);
    assert.deepEqual(leaked, []);
  } finally { r.done(); }
});

test('index.db is 0600 in a 0700 folder', { skip: process.platform === 'win32' }, async () => {
  const r = rig();
  try {
    await pass(r);
    const dir = path.join(r.root, 'memory');
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('index.db'))) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
  } finally { r.done(); }
});

test('the free plan indexes and searches its 7-day window; a wider plan re-reads full history', async () => {
  const r = rig();
  try {
    await pass(r, { days: 7 });
    assert.deepEqual(find(r, 'ledger', {}, { days: 7 }), [], 'September is outside the free window');
    assert.equal(r.ix.db.prepare('SELECT count(*) AS n FROM turns WHERE ts < ?').get(NOW - 7 * 86400000).n, 0, 'and not stored');
    const w = Search.windowOf({ days: 7, now: NOW });
    assert.equal(w.limited, true);
    await pass(r, { days: Infinity });
    assert.equal(find(r, 'ledger')[0].sid, CLAUDE_A);
    // Search enforces the window even over rows already indexed.
    assert.deepEqual(find(r, 'ledger', {}, { days: 7 }), []);
  } finally { r.done(); }
});

test('search query building never passes FTS syntax through', () => {
  assert.equal(Search.toMatch('invoice rounding'), '"invoice" "rounding"*');
  assert.equal(Search.toMatch('totals.js '), '"totals js"');
  assert.equal(Search.toMatch('"x" OR NEAR(y*'), '"x" "OR" "NEAR y"*');
  assert.equal(Search.toMatch('  ** ""'), null);
  const r = rig();
  try { for (const q of ['"', 'NEAR(', 'a AND', '*', '-x', 'col:x', '^x']) assert.doesNotThrow(() => find(r, q), q); } finally { r.done(); }
});

test('ranked hits come back in under 200 ms on 10k turns', async () => {
  const r = rig();
  try {
    const words = ['refactor', 'migration', 'payment', 'webhook', 'cache', 'deploy', 'schema', 'retry', 'timeout', 'parser', 'router', 'session', 'index', 'token', 'render', 'layout'];
    const base = Date.parse('2026-09-30T00:00:00Z');
    Indexer.wipe(r.ix);
    r.ix.db.exec('BEGIN');
    for (let s = 0; s < 100; s++) {
      const turns = [];
      for (let t = 0; t < 100; t++) {
        const pick = (k) => words[(s * 7 + t * 3 + k * 5) % words.length];
        turns.push({ ts: base + s * 3600000 + t * 1000, role: t % 2 ? 'assistant' : 'user', text: `${pick(0)} ${pick(1)} the ${pick(2)} module and ${pick(3)} ${s === 42 && t === 7 ? 'kangaroo kangaroo kangaroo' : ''} step ${t}`, files: [`src/${pick(4)}.js`], tools: ['Read'] });
      }
      Indexer.addSession(r.ix, s % 2 ? 'codex' : 'claude', { sid: `perf-${s}`, cwd: `/w/repo${s % 5}`, repo: `repo${s % 5}`, title: `Session ${s}`, started: base, ended: base + s * 3600000 + 99000, turns });
    }
    r.ix.db.exec('COMMIT');
    assert.equal(r.ix.db.prepare('SELECT count(*) AS n FROM turns').get().n, 10000);
    find(r, 'payment webhook');
    for (const q of ['payment webhook', 'kangaroo', 'deploy', 'sch']) {
      const out = Search.query(r.ix, { q }, { days: Infinity, now: NOW });
      assert.ok(out.tookMs < 200, `${q}: ${out.tookMs} ms`);
      assert.ok(out.hits.length > 0, q);
    }
    const t0 = process.hrtime.bigint();
    const filtered = Search.query(r.ix, { q: 'deploy', tool: 'codex', repo: 'repo1', from: base + 50 * 3600000 }, { days: Infinity, now: NOW });
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200);
    assert.ok(filtered.hits.every((h) => h.tool === 'codex' && h.repo === 'repo1'));
    assert.equal(Search.query(r.ix, { q: 'kangaroo' }, { days: Infinity, now: NOW }).hits[0].sid, 'perf-42', 'best match ranks first');
  } finally { r.done(); }
});

function hermesDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL, ended_at REAL, cwd TEXT, git_branch TEXT, git_repo_root TEXT, title TEXT, last_activity_at REAL, estimated_cost_usd REAL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL);`);
  const t = Date.parse('2026-10-02T12:00:00Z') / 1000;
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('h1', 'cli', t, null, '/Users/dev/work/agent-kit', 'main', '/Users/dev/work/agent-kit', 'Hermes planning', t + 60, 0.12);
  const ins = db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)');
  ins.run('h1', 'user', 'Plan the capybara rollout', null, t + 1);
  ins.run('h1', 'assistant', 'Reading the plan file.', JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'docs/plan.md' }) } }]), t + 2);
  ins.run('h1', 'tool', 'TOOL ROW never indexed ocelotine', null, t + 3);
  ins.run('h1', 'assistant', 'The capybara rollout has three phases.', null, t + 4);
  db.close();
}

test('Hermes sessions are read from state.db (read-only); tool rows are not', async () => {
  const r = rig();
  try {
    hermesDb(path.join(r.home, '.hermes', 'state.db'));
    await pass(r);
    const h = find(r, 'capybara');
    assert.equal(h.length, 1);
    assert.equal(h[0].tool, 'hermes'); assert.equal(h[0].repo, 'agent-kit'); assert.equal(h[0].title, 'Hermes planning');
    assert.deepEqual(find(r, 'ocelotine'), []);
    assert.equal(find(r, 'plan.md')[0].tool, 'hermes');
    await pass(r);
    assert.equal(r.ix.db.prepare("SELECT count(*) AS n FROM turns JOIN sessions s ON s.id = turns.session WHERE s.tool = 'hermes'").get().n, 3, 'no duplicates on a second pass');
  } finally { r.done(); }
});

test('Gemini CLI and Cursor are experimental: indexed only when switched on, removed when off', async () => {
  const r = rig();
  try {
    const gem = path.join(r.home, '.gemini', 'tmp', 'abc123', 'chats');
    fs.mkdirSync(gem, { recursive: true });
    fs.writeFileSync(path.join(gem, 'session-2026-10-02T10-00-g1.json'), JSON.stringify({ sessionId: 'g1', startTime: '2026-10-02T10:00:00Z', lastUpdated: '2026-10-02T10:05:00Z', messages: [
      { type: 'user', content: 'Explain the narwhal cache', timestamp: '2026-10-02T10:00:00Z' },
      { type: 'gemini', content: 'The narwhal cache keeps recent pages.', timestamp: '2026-10-02T10:00:04Z', toolCalls: [{ name: 'read_file', args: { absolute_path: '/w/cache.ts' } }] },
    ] }));
    const { DatabaseSync } = require('node:sqlite');
    const cur = require('../src/memory/adapters/cursor.js').dbPath(r.home, 'darwin');
    fs.mkdirSync(path.dirname(cur), { recursive: true });
    const db = new DatabaseSync(cur);
    db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const put = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
    put.run('composerData:c1', JSON.stringify({ composerId: 'c1', name: 'Axolotl refactor', createdAt: Date.parse('2026-10-02T09:00:00Z'), lastUpdatedAt: Date.parse('2026-10-02T09:10:00Z') }));
    put.run('bubbleId:c1:b1', JSON.stringify({ type: 1, text: 'Refactor the axolotl parser' }));
    put.run('bubbleId:c1:b2', JSON.stringify({ type: 2, text: 'Split the axolotl parser into two passes.' }));
    db.close();
    await pass(r, { platform: 'darwin' });
    assert.deepEqual(find(r, 'narwhal'), []); assert.deepEqual(find(r, 'axolotl'), []);
    await pass(r, { platform: 'darwin', experimental: true });
    assert.equal(find(r, 'narwhal')[0].tool, 'gemini');
    const c = find(r, 'axolotl')[0];
    assert.equal(c.tool, 'cursor'); assert.equal(c.title, 'Axolotl refactor');
    await pass(r, { platform: 'darwin', experimental: false });
    assert.deepEqual(find(r, 'narwhal'), []); assert.deepEqual(find(r, 'axolotl'), []);
  } finally { r.done(); }
});

test('the worker indexes, searches and builds handovers off the main thread', async () => {
  const r = rig();
  r.ix.close();
  const client = Search.createClient({ file: path.join(__dirname, '..', 'src', 'memory', 'worker.js'), workerData: { dir: path.join(r.root, 'memory') }, Worker });
  try {
    const res = await client.call('index', { home: r.home, rootDir: r.root, days: Infinity });
    assert.ok(res.turns > 0);
    const out = await client.call('search', { req: { q: 'debounce' }, days: Infinity, home: r.home });
    assert.equal(out.hits[0].sid, CODEX);
    const stats = await client.call('stats');
    assert.equal(stats.byTool.codex, 1);
    const doc = await client.call('handover', { tool: 'codex', sid: CODEX, home: r.home });
    assert.match(doc, /# Session handover: codex 33333333/);
    assert.match(doc, /codex resume 33333333/);
    assert.match(doc, /Add debounce to the search box/);
    const cdoc = await client.call('handover', { tool: 'claude', sid: CLAUDE_A, home: r.home });
    assert.match(cdoc, /claude --resume 11111111/);
    assert.equal(await client.call('handover', { tool: 'claude', sid: 'nope', home: r.home }), null);
    await client.call('clear');
    assert.equal((await client.call('stats')).turns, 0);
  } finally { client.stop(); r.done(); }
});

const ent = (plan) => ({ has: (f) => (f === 'handoff.launch' ? plan !== 'free' : true) });
const clip = () => { const c = { text: null, writeText(t) { c.text = t; } }; return c; };
const DOC = '<!-- plexiform-session-handover v1 -->\n# Session handover: claude-code abc\n## Current goal\nShip the wombat importer\n';

test('Hand to Codex starts an owned Codex session with the handover as its first message (fake app-server)', async () => {
  const folders = [];
  const h = Handoff.create({ entitlements: ent('plus'), clipboard: clip(), docFor: async () => DOC,
    adapters: { codex: () => createCodexAppServer({ bin: FAKE_CODEX }), claude: () => ({ available: false }) },
    workspace: () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-handoff-')); folders.push(d); return d; } });
  const events = [];
  try {
    const res = await h.hand({ tool: 'claude', sid: 'abc' }, 'codex', (e) => events.push(e));
    assert.equal(res.ok, true); assert.equal(res.mode, 'launched'); assert.equal(res.to, 'codex');
    const msg = await until(() => events.find((e) => e.id === res.id && e.kind === 'message'));
    assert.match(msg.text, /^echo:Continue the work described below/);
    assert.match(msg.text, /Ship the wombat importer/);
    await until(() => events.find((e) => e.kind === 'done' && e.status === 'completed'));
    assert.deepEqual(await h.reply(res.id, 'and add tests'), { ok: true });
    await until(() => events.find((e) => e.kind === 'message' && e.text === 'echo:and add tests'));
    assert.equal(h.end(res.id).ok, true);
    assert.equal(fs.existsSync(folders[0]), false, 'the temporary folder goes with it');
    assert.equal((await h.reply(res.id, 'x')).ok, false);
  } finally { h.stop(); }
});

test('free plan: Hand to… copies the handover prompt instead of launching', async () => {
  const c = clip();
  let opened = false;
  const h = Handoff.create({ entitlements: ent('free'), clipboard: c, docFor: async () => DOC, adapters: { codex: () => { opened = true; return {}; }, claude: () => { opened = true; return {}; } } });
  const res = await h.hand({ tool: 'claude', sid: 'abc' }, 'codex');
  assert.equal(res.ok, true); assert.equal(res.mode, 'copied'); assert.equal(res.upgrade, true);
  assert.match(c.text, /^Continue the work described below/); assert.match(c.text, /Ship the wombat importer/);
  assert.equal(opened, false, 'no session is started');
  assert.equal((await h.copy({ tool: 'claude', sid: 'abc' })).mode, 'copied');
  assert.equal((await h.hand({ tool: 'claude', sid: 'abc' }, 'gemini')).ok, false);
});

test('Plus without the target CLI falls back to the copy', async () => {
  const c = clip();
  const h = Handoff.create({ entitlements: ent('plus'), clipboard: c, docFor: async () => DOC, adapters: { codex: () => ({ available: false }), claude: () => ({ available: false }) } });
  const res = await h.hand({ tool: 'codex', sid: 'x' }, 'claude');
  assert.equal(res.mode, 'copied'); assert.match(res.note, /not installed/);
  assert.ok(c.text);
});

test('register(ctx): every handler checks the memory page sender; nothing registers without the feature', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  assert.equal(Search.register({ ipcMain, rootDir: os.tmpdir(), entitlements: { has: () => false } }), null);
  assert.equal(handlers.size, 0);
  const r = rig();
  r.ix.close();
  const quits = [];
  let page = null;
  const reg = Search.register({ ipcMain, rootDir: r.root, entitlements: { has: () => true, limits: () => ({ 'memory.days': 7 }), plan: () => 'free' },
    home: r.home, fromPage: (e, id) => id === 'memory' && e.sender === page, onQuit: (fn) => quits.push(fn), electron: { clipboard: clip(), shell: { openPath: async () => '' } } });
  try {
    assert.deepEqual([...handlers.keys()].sort(), ['memory:clear', 'memory:end', 'memory:facets', 'memory:hand', 'memory:handover', 'memory:reindex', 'memory:reply', 'memory:search', 'memory:settings', 'memory:status']);
    const stranger = { sender: { id: 'other' } };
    for (const [ch, fn] of handlers) assert.deepEqual(await fn(stranger, {}), { ok: false, error: 'Not allowed.' }, ch);
    page = { isDestroyed: () => false, send() {} };
    const e = { sender: page };
    const status = await handlers.get('memory:status')(e);
    assert.equal(status.ok, true); assert.equal(status.days, 7); assert.equal(status.canLaunch, true);
    assert.equal((await handlers.get('memory:handover')(e, 'open', { tool: 'claude', sid: '../../etc' })).ok, false);
    assert.equal((await handlers.get('memory:hand')(e, { tool: 'nope', sid: 'x' }, 'codex')).ok, false);
  } finally { for (const fn of quits) fn(); void reg; r.done(); }
});
