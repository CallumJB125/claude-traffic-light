'use strict';
// Solo mode: no hub signed in and no team. Every bus verb must answer plainly, never as a hub or team failure, and
// nothing may wait for a route that can never come (buddy-window's getRoutes answers {routes: [], complete: true}
// when no hub is signed in).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testTempDir } = require('./helpers/tmp');
const { createWorkCapture } = require('../src/work-capture.js');
const { world } = require('./helpers/bind-world.js');

const SOLO = async () => ({ routes: [], complete: true });
const HUBBY = /hub|could not reach|team activity|offline/i;
const session = (extra = {}) => ({ source: 'codex', sessionId: 'solo-1', host: 'mac', cwd: '/working/app', signal: 'tool-use', taskTitle: 'Fix the parser', updatedAt: new Date(100000).toISOString(), ...extra });

function solo(t, repo = 'github.com/me/app') {
  const dir = testTempDir('bus-solo-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  let time = 100000;
  const wc = createWorkCapture({ startEnabled: true, file: path.join(dir, 'capture.json'), host: 'mac', getRoutes: SOLO, resolveRepo: async () => repo,
    sendLocal: async (body) => { calls.push({ kind: 'local', body }); return { ok: true, card: { id: `local-${calls.length}` } }; },
    sendTeam: async () => { throw new Error('a solo person has no team board'); }, now: () => time });
  t.after(() => wc.stop());
  return { wc, calls, advance: (ms) => { time += ms; } };
}

test('solo: automatic cards and bus_card_add go to My board at once, never deferred or pending a route', async (t) => {
  for (const repo of ['github.com/me/app', null]) {
    const s = solo(t, repo);
    await s.wc.observe([session()]);
    assert.deepEqual(s.calls.map((c) => c.kind), ['local']);
    const card = await s.wc.addAgentCard(session(), { title: 'Write the tests', request_id: 'req-solo-000001', handle: 'codex-app-1a2b', folder: 'app' });
    assert.ok(card.card_id, JSON.stringify(card));
    assert.equal(card.board.kind, 'personal');
    assert.ok(!card.board.pending_route, 'nothing waits for a hub that will never come');
    assert.notEqual(card.board.why, 'deferred');
    for (let i = 0; i < 3; i++) { s.advance(20_000); await s.wc.observe([session({ updatedAt: new Date(100000 + (i + 1) * 20_000).toISOString() })]); }
    const rows = s.wc.snapshot();
    assert.ok(rows.length >= 2);
    for (const r of rows) {
      assert.ok(!r.pending_route, JSON.stringify(r));
      assert.ok(['no_link', 'no_repo'].includes(r.why), JSON.stringify(r));
    }
    const board = s.wc.boardFor(session());
    assert.equal(board.kind, 'personal');
    assert.ok(!board.pending_route);
  }
});

test('solo: bus_hello and bus_peers say My board in plain words, with no hub or team failure', async (t) => {
  const w = world(t);
  const aw = w.make({ mcpCaps: () => ({ claude: true, codex: true }), halted: () => false, boardFor: () => ({ kind: 'personal', why: 'no_link' }) });
  t.after(() => aw.stop());
  await aw.build();
  await aw.refresh();
  const forward = async (op) => (op === 'hello' ? { agent_id: 'a', tier: 'local_attested', policy_summary: { repo_enabled: true } } : { handoff_id: 'hof_0123456789abcdef', state: 'offered' });
  const hello = await aw.relay('hello', { provider: 'claude' }, { provider: 'claude', cwd: w.repoA }, w.call(101), { forward });
  assert.equal(hello.board.kind, 'personal');
  assert.doesNotMatch(JSON.stringify(hello.board), HUBBY);
  assert.doesNotMatch(hello.board.fix ?? '', /link the repo/i, 'no step a person with no team could take');
  const peers = await aw.relay('peers', {}, { provider: 'claude', cwd: w.repoA }, w.call(101), { forward });
  assert.ok(!peers.reason, JSON.stringify(peers));
  assert.equal(peers.board.kind, 'personal');
  assert.doesNotMatch(JSON.stringify(peers.board), HUBBY);
  // A solo hand-off carries 'local': its run's card lands on My board too.
  const seen = [];
  await aw.relay('handoff', { request_id: 'req-solo-000002', title: 'x', to: { provider: 'any' } }, { provider: 'claude', cwd: w.repoA }, w.call(101), { forward: async (op, a, c) => { seen.push(c); return { state: 'offered' }; } });
  assert.equal(seen[0]?.origin?.board, 'local');
});

test('solo: with Plexiform not running, a bus tool says the agent bus is unavailable, not team activity', async () => {
  const M = require('../mcp-server.js');
  const root = testTempDir('bus-solo-off-');
  try {
    const r = await M.busCall('hello', { provider: 'claude' }, { root });
    assert.equal(r.available, false);
    assert.equal(r.reason, 'app_not_running');
    assert.match(r.message, /agent bus/);
    assert.doesNotMatch(r.message, /team/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
