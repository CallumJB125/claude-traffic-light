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

test('review 6: buddy_why, buddy_pending_requests and buddy_recent_transitions drop an excluded session and hide an unresolved one\'s folder', (t) => {
  const root = testTempDir('ctl-aw-mcp6-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['sessions', 'requests', 'awareness']) fs.mkdirSync(path.join(root, d));
  const now = Date.now();
  const ids = { open: 'aaaaaaaa-open', secret: 'bbbbbbbb-secret', cur: 'cccccccc-cursor', fresh: 'dddddddd-fresh' };
  const session = (id, cwd, extra = {}) => ({ sessionId: id, host: 'h', cwd, signal: 'tool-use', updatedAt: new Date(now - 1000).toISOString(), ...extra });
  fs.writeFileSync(path.join(root, 'sessions', 'a.json'), JSON.stringify(session(ids.open, '/w/open')));
  fs.writeFileSync(path.join(root, 'sessions', 'b.json'), JSON.stringify(session(ids.secret, '/w/bondly-secret')));
  fs.writeFileSync(path.join(root, 'sessions', 'c.json'), JSON.stringify(session(ids.cur, '/w/bondly-cursor', { source: 'cursor' })));
  fs.writeFileSync(path.join(root, 'sessions', 'd.json'), JSON.stringify(session(ids.fresh, '/w/fresh-unresolved')));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ seasonal: false, askFromWidget: true }));
  const roster = { v: 1, generated_at: new Date(now).toISOString(), peers: [], groups: [], self: { [`claude|${ids.open}`]: { allowed: true, interactive: true }, [`claude|${ids.secret}`]: { allowed: false }, [`cursor|${ids.cur}`]: { allowed: false } } };
  fs.writeFileSync(path.join(root, 'awareness', 'roster.json'), JSON.stringify(roster));
  fs.writeFileSync(path.join(root, 'port'), '1');
  const run = (name, a = {}) => JSON.stringify(M.TOOLS.find((x) => x.name === name).run(a, { root, now }));
  const why = JSON.parse(run('buddy_why', { query: 'lamp' })).context.resolvedAgainst.filter((e) => e.sessionId);
  assert.deepEqual(why.map((e) => [e.sessionId, e.cwd]).sort(), [[ids.open, '/w/open'], [ids.fresh, '(hidden)']], 'excluded dropped, allowed shown, unresolved hidden');
  const created = new Date(now - 2000).toISOString();
  for (const [n, id, cwd] of [['r1', ids.open, '/w/open'], ['r2', ids.secret, '/w/bondly-secret'], ['r3', ids.fresh, '/w/fresh-unresolved']]) {
    fs.writeFileSync(path.join(root, 'requests', `${n}.json`), JSON.stringify({ id: n, sessionId: id, cwd, tool: 'Bash', summary: `run in ${cwd}`, createdAt: created }));
  }
  const at = new Date(now).toISOString();
  fs.writeFileSync(path.join(root, 'app.log'), [['aaaaaaaa', 'w/open'], ['bbbbbbbb', 'w/bondly-secret'], ['cccccccc', 'w/bondly-cursor'], ['dddddddd', 'w/fresh-unresolved']]
    .map(([s, p]) => `${at} [log] [state] ${s} ${p} — → tool-use (hook signal)`).join('\n'));
  for (const [name, a] of [['buddy_why', { query: 'lamp' }], ['buddy_pending_requests', {}], ['buddy_recent_transitions', {}], ['buddy_sessions', {}]]) {
    const out = run(name, a);
    assert.ok(!out.includes('bondly'), `${name} never names an excluded folder`);
    assert.ok(!out.includes('fresh-unresolved'), `${name} hides an unresolved folder`);
  }
  assert.ok(!run('buddy_why', { query: 'lamp' }).includes('/w/open'), 'a pending request\'s folder has no session to vouch for it: hidden');
  const pending = M.TOOLS.find((x) => x.name === 'buddy_pending_requests').run({}, { root, now }).requests;
  assert.deepEqual(pending.map((q) => q.id).sort(), ['r1', 'r3']);
  const tr = M.TOOLS.find((x) => x.name === 'buddy_recent_transitions').run({}, { root, now }).transitions;
  assert.deepEqual(tr.map((x) => [x.session, x.project]).sort(), [['aaaaaaaa', 'w/open'], ['dddddddd', '(hidden)']]);
  assert.ok(JSON.stringify(M.buddyPendingRequests({ root, now })).includes('bondly-secret'), 'the person\'s own views stay unfiltered');
});
