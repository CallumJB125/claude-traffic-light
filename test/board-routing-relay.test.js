'use strict';
// Routing audit (2026-11-07): an AI never guesses its board. bus_hello says where the caller's cards go (the same
// answer as bus_peers, with why), and a hand-off carries the asker's board: a team route key, or 'local' when the
// asker's cards go to My board, so the run never lands on a team board its asker's work would not.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./helpers/bind-world.js');

const KEY = 'c'.repeat(64);

async function rig(t, answer) {
  const w = world(t);
  const box = { answer };
  const aw = w.make({ mcpCaps: () => ({ claude: true, codex: true }), halted: () => false, boardFor: () => box.answer });
  t.after(() => aw.stop());
  await aw.build();
  await aw.refresh();
  const seen = [];
  const forward = async (op, args, caller) => { seen.push({ op, caller }); return op === 'hello' ? { agent_id: 'a', tier: 'local_attested', policy_summary: {} } : { state: 'offered' }; };
  return { w, aw, box, seen, forward };
}

test('bus_hello carries the caller\'s board with its why, like bus_peers; an unbound caller gets none', async (t) => {
  const r = await rig(t, { kind: 'team', name: 'App board', why: 'linked_repo', key: KEY });
  const hello = await r.aw.relay('hello', {}, { provider: 'claude', cwd: r.w.repoA }, r.w.call(101), { forward: r.forward });
  assert.deepEqual(hello.board, { kind: 'team', name: 'App board', why: 'linked_repo' });
  assert.ok(!JSON.stringify(hello).includes(KEY), 'the route key stays in main');
  r.box.answer = { kind: 'personal', why: 'withheld' };
  const mine = await r.aw.relay('hello', {}, { provider: 'claude', cwd: r.w.repoA }, r.w.call(101), { forward: r.forward });
  assert.equal(mine.board.kind, 'personal');
  assert.equal(mine.board.why, 'withheld');
  assert.match(mine.board.fix, /another team/);
  r.w.proc(300, { ppid: 1, exe: '/opt/homebrew/bin/node', cwd: r.w.repoA, args: 'node /x/mcp-server.js --profile bus', env: '' });
  const unbound = await r.aw.relay('hello', {}, { provider: 'claude', cwd: r.w.repoA }, r.w.call(300), { forward: r.forward });
  assert.ok(!('board' in unbound));
});

test('regression: a hand-off carries "local" when the asker\'s cards go to My board, and the team key when they go to a team board', async (t) => {
  for (const [answer, expected] of [
    [{ kind: 'team', name: 'App board', key: KEY }, KEY],
    [{ kind: 'personal', why: 'no_link' }, 'local'],
    [{ kind: 'personal', why: 'personal_mark' }, 'local'],
    [{ kind: 'untracked', why: 'personal_mark' }, 'local'],
    [{ kind: 'choose', why: 'choose' }, 'local'],
    [{ kind: 'readonly', why: 'read_only' }, 'local'],
    [{ kind: 'unknown' }, undefined],
    [{ kind: 'personal', why: 'deferred', pending_route: true }, undefined],
    [{ kind: 'team', name: 'x', key: 'not-a-key' }, undefined],
  ]) {
    const r = await rig(t, answer);
    await r.aw.relay('handoff', { title: 'Fix it' }, { provider: 'claude', cwd: r.w.repoA }, r.w.call(101), { forward: r.forward });
    const sent = r.seen.find((x) => x.op === 'handoff');
    assert.ok(sent?.caller.origin, JSON.stringify(answer));
    assert.equal(sent.caller.origin.board, expected, JSON.stringify(answer));
  }
});

test('regression: a folder git cannot answer for gets a My board card (path rules only), unless the person excluded it', async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const w = world(t);
  const broken = path.join(w.home, 'code', 'broken');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, '.git'), 'gitdir: /nonexistent/worktree\n');
  const aw = w.make({ mcpCaps: () => ({}), halted: () => false });
  t.after(() => aw.stop());
  assert.equal((await aw.classify(broken, [])).reason, 'UNRESOLVED');
  assert.equal(await aw.excludedForCards(broken), false);
  w.state.config = { agentBus: { exclude: [broken] } };
  aw.invalidate();
  assert.equal(await aw.excludedForCards(broken), true);
  w.state.config = { agentBus: { exclude: ['github.com/acme/app'] } };
  aw.invalidate();
  assert.equal(await aw.excludedForCards(broken), true, 'a remote entry can\'t be checked without git');
});
