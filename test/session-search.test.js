'use strict';
// Wave 2 lane 1: session search on top of the local memory index (src/memory/*).
// Typed filters, opening a hit's timeline, the ⌘K command and its IPC. Fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Indexer = require('../src/memory/indexer.js');
const Search = require('../src/memory/search.js');
const Palette = require('../src/command-palette.js');
const SearchMain = require('../src/session-search-main.js');
const { testTempDir } = require('./helpers/tmp');

const FIX = path.join(__dirname, 'fixtures', 'memory');
const CLAUDE_A = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-10-03T12:00:00Z');

function rig() {
  const base = testTempDir('plex-ssearch-');
  const home = path.join(base, 'home'), root = path.join(base, 'data');
  const claudeDir = path.join(home, '.claude', 'projects', '-Users-dev-work');
  const codexDir = path.join(home, '.codex', 'sessions', '2026', '10', '02');
  fs.mkdirSync(claudeDir, { recursive: true }); fs.mkdirSync(codexDir, { recursive: true }); fs.mkdirSync(root, { recursive: true });
  for (const f of fs.readdirSync(path.join(FIX, 'claude'))) fs.copyFileSync(path.join(FIX, 'claude', f), path.join(claudeDir, f));
  for (const f of fs.readdirSync(path.join(FIX, 'codex'))) fs.copyFileSync(path.join(FIX, 'codex', f), path.join(codexDir, f));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ mutedProjects: [] }));
  const ix = Indexer.openIndex(path.join(root, 'memory'));
  return { home, root, ix, claudeDir, done: () => { try { ix.close(); } catch { /* closed */ } fs.rmSync(base, { recursive: true, force: true }); } };
}
const pass = (r) => Indexer.indexPass(r.ix, { home: r.home, rootDir: r.root, days: Infinity, now: NOW, pause: async () => {} });
const find = (r, q) => Search.query(r.ix, { q }, { days: Infinity, now: NOW, home: r.home }).hits;

test('parseQuery lifts project:, tool:, after:, before: out of the words and leaves the rest', () => {
  const p = Search.parseQuery('invoice rounding project:billing-api tool:claude after:2026-10-01 before:2026-10-05');
  assert.equal(p.text.trim(), 'invoice rounding');
  assert.equal(p.project, 'billing-api'); assert.equal(p.tool, 'claude');
  assert.equal(p.from, new Date('2026-10-01T00:00:00').getTime());
  assert.equal(p.to, new Date('2026-10-05T00:00:00').getTime() - 1);
  const bad = Search.parseQuery('tool:vim after:yesterday words');
  assert.equal(bad.tool, null); assert.equal(bad.from, null);
  assert.equal(bad.text, 'tool:vim after:yesterday words');
  assert.equal(Search.parseQuery('plain ').text, 'plain ', 'trailing space still means the last word is complete');
});

test('typed filters narrow the ranked hits', async () => {
  const r = rig();
  try {
    await pass(r);
    assert.ok(find(r, 'rounding').some((h) => h.sid === CLAUDE_A));
    assert.ok(find(r, 'rounding project:billing-api').some((h) => h.sid === CLAUDE_A));
    assert.ok(find(r, 'rounding project:Billing-API').some((h) => h.sid === CLAUDE_A), 'project is case-insensitive');
    assert.deepEqual(find(r, 'rounding project:web-app'), []);
    assert.deepEqual(find(r, 'rounding project:%'), [], 'LIKE wildcards are literal');
    assert.deepEqual(find(r, 'rounding tool:codex'), []);
    assert.equal(find(r, 'debounce before:2026-10-03').length, 1);
    assert.deepEqual(find(r, 'debounce after:2026-10-04'), []);
    // Filters alone list recent sessions in that project.
    assert.ok(find(r, 'project:billing-api').every((h) => h.repo === 'billing-api'));
  } finally { r.done(); }
});

test('an API key in a transcript cannot be found by searching for it', async () => {
  const r = rig();
  try {
    const key = 'sk-ant-api03-' + 'Zq7'.repeat(30) + 'AA';
    const ts = '2026-10-02T10:00:00.000Z';
    fs.writeFileSync(path.join(r.claudeDir, '55555555-5555-4555-8555-555555555555.jsonl'), [
      { type: 'user', sessionId: 'k', cwd: '/Users/dev/work/keys', timestamp: ts, message: { role: 'user', content: `my wombatkey is ${key} please store it` } },
      { type: 'assistant', sessionId: 'k', cwd: '/Users/dev/work/keys', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: `Stored ${key}.` }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    await pass(r);
    assert.ok(find(r, 'wombatkey').length >= 1, 'the session itself is indexed');
    assert.deepEqual(find(r, key), []);
    assert.deepEqual(find(r, key.slice(0, 40)), []);
    for (const h of find(r, 'wombatkey')) assert.ok(!h.snippet.includes(key.slice(14, 40)));
  } finally { r.done(); }
});

function fakeIpc() {
  const handlers = new Map();
  return { handlers, ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) } };
}

test('memory:open-timeline opens the session timeline only for a valid key from the Search page', async () => {
  const r = rig();
  const { handlers, ipcMain } = fakeIpc();
  const opened = [];
  const page = { id: 'memory-page' };
  const api = Search.register({ ipcMain, rootDir: r.root, home: r.home, entitlements: { has: () => true, limits: () => ({}), plan: () => 'plus' }, fromPage: (e, id) => e === page && id === 'memory', electron: { clipboard: {}, shell: {} }, openTimeline: (s) => { opened.push(s); return true; } });
  try {
    const h = handlers.get('memory:open-timeline');
    assert.deepEqual(await h(page, { tool: 'claude', sid: CLAUDE_A }), { ok: true });
    assert.deepEqual(opened, [{ adapter: 'claude-code', sessionId: CLAUDE_A }]);
    assert.equal((await h({ other: true }, { tool: 'claude', sid: CLAUDE_A })).ok, false);
    assert.equal((await h(page, { tool: 'claude', sid: '../etc' })).ok, false);
    assert.equal((await h(page, { tool: 'vim', sid: 'abc' })).ok, false);
    assert.equal(opened.length, 1);
  } finally { api.client.stop(); api.handoff.stop(); r.done(); }
});

test('search:open-page opens Search everything for the Overview page only', () => {
  const { handlers, ipcMain } = fakeIpc();
  const opened = [], overview = {};
  SearchMain.register({ ipcMain, allowed: (e) => e === overview, openPage: (id) => opened.push(id) });
  const h = handlers.get('search:open-page');
  assert.equal(h({}), false);
  assert.equal(h(overview, 'x'), false);
  assert.equal(h(overview), true);
  assert.deepEqual(opened, ['memory']);
});

test('the palette always offers "Search past sessions"', () => {
  const idx = Palette.indexOf({ entries: [] });
  const cmd = idx.find((i) => i.kind === 'command');
  assert.equal(cmd.title, 'Search past sessions'); assert.equal(cmd.id, 'search-sessions');
  assert.equal(Palette.search(idx, 'search past')[0].id, 'search-sessions');
  assert.equal(Palette.search(idx, 'what did I ask')[0].id, 'search-sessions');
});

test('Search everything has a menu shortcut and the page offers Open timeline', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app-menu.js'), 'utf8');
  assert.match(src, /memory: 'CmdOrCtrl\+Shift\+F'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'memory.js'), 'utf8'), /'Open timeline'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'memory-preload.js'), 'utf8'), /memory:open-timeline/);
});
