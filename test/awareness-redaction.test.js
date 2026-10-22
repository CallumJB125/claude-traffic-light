'use strict';
// AW8, hiding half: Plexiform's AI-facing listings never name an excluded or
// unresolved session's folder. GET /status (unauthenticated, any local
// program) redacts its cwd; buddy_sessions drops an excluded session and
// hides the folder of one the app has not resolved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testTempDir } = require('./helpers/tmp');
const M = require('../mcp-server.js');

async function serve(t, sessions, cwdVisible) {
  const rootDir = testTempDir('ctl-aw-status-');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const S = require('../src/signal-server.js')({ rootDir, sessionsDir: rootDir, requestsDir: rootDir, aggregateState: () => ({ look: null, sessions }), broadcastStatus: () => {}, port: 0, app: { on: () => {} }, ...(cwdVisible ? { cwdVisible } : {}) });
  const server = S.startSignalServer();
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  return (await fetch(`http://127.0.0.1:${server.address().port}/status`)).json();
}

test('GET /status: a folder only for a session awareness resolved as allowed; excluded, unresolved and remote ones are null', async (t) => {
  const sessions = [
    { sessionId: 'open', cwd: '/w/open', signal: 'tool-use', updatedAt: 'x' },
    { sessionId: 'secret', cwd: '/w/bondly', signal: 'stop', updatedAt: 'x' },
    { sessionId: 'x1', source: 'codex', cwd: '/w/unresolved', signal: 'stop', updatedAt: 'x' },
  ];
  const st = await serve(t, sessions, (s) => s.sessionId === 'open');
  assert.deepEqual(st.sessions.map((s) => s.cwd), ['/w/open', null, null]);
  assert.deepEqual(st.sessions.map((s) => s.source), ['claude', 'claude', 'codex']);
  const none = await serve(t, sessions);
  assert.deepEqual(none.sessions.map((s) => s.cwd), [null, null, null], 'without a resolver, nothing');
  const throws = await serve(t, sessions, () => { throw new Error('x'); });
  assert.deepEqual(throws.sessions.map((s) => s.cwd), [null, null, null]);
});

test('buddy_sessions: an excluded session is dropped, an unresolved one keeps its row without its folder, and with no fresh roster every folder is hidden', (t) => {
  const root = testTempDir('ctl-aw-mcp-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sessions'));
  fs.mkdirSync(path.join(root, 'requests'));
  fs.mkdirSync(path.join(root, 'awareness'));
  const now = Date.now();
  const session = (id, extra = {}) => ({ sessionId: id, host: 'h', cwd: `/w/${id}`, signal: 'tool-use', updatedAt: new Date(now - 1000).toISOString(), ...extra });
  for (const [n, d] of Object.entries({ open: session('open'), secret: session('secret'), fresh: session('fresh'), cx: session('cx', { source: 'codex' }) })) fs.writeFileSync(path.join(root, 'sessions', `${n}.json`), JSON.stringify(d));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ seasonal: false }));
  const roster = { v: 1, generated_at: new Date(now).toISOString(), peers: [], groups: [], self: { 'claude|open': { allowed: true, interactive: true }, 'claude|secret': { allowed: false }, 'codex|cx': { allowed: false } } };
  fs.writeFileSync(path.join(root, 'awareness', 'roster.json'), JSON.stringify(roster));
  fs.writeFileSync(path.join(root, 'port'), '1');
  const tool = M.TOOLS.find((x) => x.name === 'buddy_sessions');
  const rows = () => Object.fromEntries(tool.run({}, { root, now }).sessions.map((s) => [s.sessionId, s.cwd]));
  assert.deepEqual(rows(), { open: '/w/open', fresh: '(hidden)' });
  fs.rmSync(path.join(root, 'port'));
  assert.deepEqual(rows(), { open: '(hidden)', secret: '(hidden)', fresh: '(hidden)', cx: '(hidden)' }, 'app not running: no fresh roster');
  assert.equal(M.buddySessions({ root, now }).sessions.length, 4, 'the person\'s own `plexiform sessions` reads them unfiltered');
});
