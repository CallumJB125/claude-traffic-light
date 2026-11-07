'use strict';
// The AI tools page's Connections panel (src/connections-view.js): Fix shows only where the bus sync can help.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/connections-view.js');

const cap = (id, mcp, extra = {}) => ({ id, label: id.toUpperCase(), installed: mcp !== 'not-installed', mcp, hooks: 'n/a', instructions: 'none', tier: 'unverified_client', reason: `${id} reason`, file: `~/.${id}`, restart: null, ...extra });

test('each MCP state becomes one plain status, and Fix appears only for missing, stale or mismatched entries', () => {
  const by = Object.fromEntries(V.rows([
    cap('claude', 'ours', { tier: 'local_attested', hooks: 'connected' }), cap('codex', 'missing', { tier: 'local_attested' }), cap('gemini', 'stale'),
    cap('cursor', 'conflict'), cap('vscode', 'other-channel'), cap('claude-desktop', 'not-installed'), cap('hermes', 'off'), cap('x', 'untrusted'), cap('y', 'mismatch'),
  ]).map((r) => [r.id, r]));
  assert.deepEqual([by.claude.state, by.claude.status, by.claude.fix], ['connected', 'Connected', false]);
  assert.match(by.claude.tier, /hand off work/);
  assert.equal(by.claude.hooks, 'Status lights on');
  assert.deepEqual([by.codex.state, by.codex.status, by.codex.fix], ['fix', 'Not connected', true]);
  assert.deepEqual([by.gemini.state, by.gemini.status, by.gemini.fix], ['fix', 'Out of date', true]);
  assert.equal(by.y.fix, true);
  for (const id of ['cursor', 'vscode', 'x']) assert.deepEqual([by[id].state, by[id].fix], ['blocked', false], id);
  assert.equal(by.cursor.detail, 'cursor reason', 'the registry\'s own words say what to do');
  assert.deepEqual([by['claude-desktop'].state, by['claude-desktop'].fix, by['claude-desktop'].tier], ['missing', false, null]);
  assert.deepEqual([by.hermes.state, by.hermes.fix], ['off', false]);
});

test('rows needing action come first and missing tools last; the summary counts them', () => {
  const rows = V.rows([cap('a', 'not-installed'), cap('b', 'ours'), cap('c', 'missing'), cap('d', 'conflict')]);
  assert.deepEqual(rows.map((r) => r.id), ['c', 'd', 'b', 'a']);
  assert.equal(V.summary(rows), '1 connected · 1 needs a fix · 1 needs you');
  assert.equal(V.summary(V.rows([cap('a', 'not-installed')])), 'No AI tools found yet.');
  assert.deepEqual(V.rows(null), []);
  assert.deepEqual(V.rows([null, { label: 'no id' }]), []);
});

test('the page and its IPC: Connections and Fix go through two channels only, ids checked in main', () => {
  const fs = require('node:fs'), path = require('node:path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('aitools-preload.js'), /connections: \(\) => ipcRenderer\.invoke\('aitools:connections'\)/);
  assert.match(read('aitools-preload.js'), /fixConnection: \(id\) => ipcRenderer\.invoke\('aitools:fix-connection', id\)/);
  const main = read('src/ai-tools-main.js');
  assert.match(main, /on\('aitools:fix-connection', \(id\) => \(KNOWN_CONN\(id\)/);
  assert.match(read('aitools.html'), /<script src="src\/connections-view\.js"><\/script><script src="aitools\.js"><\/script>/);
});

test('main\'s fix-connection handler refuses odd ids and calls fixConnection for real ones', async () => {
  const handlers = new Map();
  const Main = require('../src/ai-tools-main.js');
  const calls = [];
  Main.register({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, fromPage: () => true, shell: {}, clipboard: {},
    tools: { connections: () => [cap('codex', 'missing')], fixConnection: async (id) => { calls.push(id); return { ok: true, id }; } } });
  assert.deepEqual(await handlers.get('aitools:connections')({}), [cap('codex', 'missing')]);
  assert.deepEqual(await handlers.get('aitools:fix-connection')({}, 'claude-desktop'), { ok: true, id: 'claude-desktop' });
  assert.equal((await handlers.get('aitools:fix-connection')({}, '../etc')).ok, false);
  assert.equal((await handlers.get('aitools:fix-connection')({}, 42)).ok, false);
  assert.deepEqual(calls, ['claude-desktop']);
});

test('every status has matching words: out of date says older version, not "not connected"', () => {
  const noReason = (id, mcp) => cap(id, mcp, { reason: undefined });
  const by = Object.fromEntries(V.rows(['ours', 'missing', 'stale', 'mismatch', 'off', 'conflict', 'not-installed', 'weird'].map((m) => noReason(m, m))).map((r) => [r.id, r]));
  const pairs = Object.fromEntries(Object.entries(by).map(([id, r]) => [id, [r.status, r.detail]]));
  assert.deepEqual(pairs.stale[0], 'Out of date');
  assert.match(pairs.stale[1], /older version; press Fix to update it/);
  assert.doesNotMatch(pairs.stale[1], /Not connected/);
  assert.deepEqual(pairs.missing[0], 'Not connected');
  assert.match(pairs.missing[1], /^Not connected yet/);
  assert.match(pairs.mismatch[1], /try again/);
  assert.doesNotMatch(pairs.mismatch[1], /Not connected/);
  assert.deepEqual(pairs.ours, ['Connected', 'Connected to Plexiform.']);
  assert.deepEqual(pairs.off[0], 'Agent bus off');
  assert.deepEqual(pairs.conflict[0], 'Needs you');
  assert.deepEqual(pairs['not-installed'], ['Not installed', 'Not installed here.']);
  assert.deepEqual(pairs.weird[0], 'Unknown');
  for (const [id, [s, d]] of Object.entries(pairs)) assert.ok(s && d, id);
});
