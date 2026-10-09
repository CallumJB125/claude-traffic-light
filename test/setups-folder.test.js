const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { register } = require('../src/setups-folder.js');
const { testTempDir } = require('./helpers/tmp');

function wired(t, files) {
  const dir = fs.realpathSync(testTempDir('plx-setupsfolder-', t));
  const handlers = new Map();
  const trusted = {};
  register({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    allowed: (e) => e === trusted,
    source: async () => ({ payload: { files } }),
    pickFolder: async () => dir,
  });
  const call = (channel, ...args) => handlers.get(channel)(trusted, ...args);
  return { dir, call, handlers, trusted };
}
const files = [{ relative_path: '.claude/CLAUDE.md', content: 'new\n' }, { relative_path: 'a.txt', content: 'A' }];

test('dry run writes nothing and returns a diff without file contents', async (t) => {
  const f = wired(t, files);
  fs.writeFileSync(path.join(f.dir, 'a.txt'), 'old');
  const r = await f.call('setups:folder-plan', 'h');
  assert.equal(r.ok, true);
  assert.equal(r.changes, 2);
  assert.deepEqual(r.entries.map((e) => e.action), ['create', 'update']);
  assert.equal(r.entries.some((e) => 'content' in e), false);
  assert.equal(fs.existsSync(path.join(f.dir, '.claude')), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'a.txt'), 'utf8'), 'old');
});

test('apply needs the dry-run token, then undo restores', async (t) => {
  const f = wired(t, files);
  fs.writeFileSync(path.join(f.dir, 'a.txt'), 'old');
  const plan = await f.call('setups:folder-plan', 'h');
  for (const bad of [undefined, 'x', 'f'.repeat(64)]) assert.equal((await f.call('setups:folder-apply', plan.planId, bad)).ok, false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'a.txt'), 'utf8'), 'old');
  const done = await f.call('setups:folder-apply', plan.planId, plan.token);
  assert.equal(done.ok, true);
  assert.equal(fs.readFileSync(path.join(f.dir, 'a.txt'), 'utf8'), 'A');
  assert.equal((await f.call('setups:folder-apply', plan.planId, plan.token)).ok, false);
  const undone = await f.call('setups:folder-undo', done.undoId);
  assert.equal(undone.ok, true);
  assert.equal(fs.readFileSync(path.join(f.dir, 'a.txt'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(f.dir, '.claude')), false);
  assert.equal((await f.call('setups:folder-undo', done.undoId)).ok, false);
});

test('traversal and absolute paths are refused and nothing is written', async (t) => {
  for (const p of ['../escape.txt', '/etc/evil', 'a/../../b']) {
    const f = wired(t, [{ relative_path: p, content: 'x' }]);
    const r = await f.call('setups:folder-plan', 'h');
    assert.equal(r.ok, false);
    assert.equal(fs.readdirSync(f.dir).length, 0);
    assert.equal(fs.existsSync(path.join(path.dirname(f.dir), 'escape.txt')), false);
  }
});

test('foreign senders and unknown ids are refused', async (t) => {
  const f = wired(t, files);
  for (const ch of ['setups:folder-plan', 'setups:folder-apply', 'setups:folder-undo']) assert.equal(await f.handlers.get(ch)({}, 'h', 'x'), null);
  assert.equal((await f.call('setups:folder-apply', 'nope', 'a'.repeat(64))).ok, false);
  assert.equal((await f.call('setups:folder-undo', 'nope')).ok, false);
});
