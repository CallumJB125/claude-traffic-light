'use strict';

// WP3: the Sessions "What's in context" drawer from Burst's inspector, and its two actions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectView } = require('../src/burst-inspect.js');
const Ipc = require('../src/burst-ipc.js');
const { createBurstClient } = require('../src/burst-client.js');
const { createFakeBurst, stateV019 } = require('./fixtures/fake-burst.js');

const SID = '0f6e3c1a-2b4d-4e5f-8a9b-0c1d2e3f4a5b';
const SECRET = 'TOP-SECRET-CONVERSATION-TEXT';
const ID1 = 'a1b2c3d4e5f60718', ID2 = '0123456789abcdef';
// Shape of claude-burst router.ContextReport / ctxview.Item (preview and Full included, as Burst would send).
const report = () => ({
  session: SID, repo: 'plexiform', repo_root: '/Users/me/plexiform', model: 'claude-opus', at: '2026-10-07T10:00:00Z', context: 52000, estimate: false, prompts: 3, flagged: 1,
  items: [
    { group: 'System prompt', name: 'System prompt', bytes: 40000, tokens: 10000, preview: SECRET, Full: SECRET },
    { group: 'Tool results', name: 'Read src/a.js', turn: 2, turns_ago: 1, bytes: 80000, tokens: 20000, flags: ['large and 1 prompts old'], preview: SECRET, id: ID1, removable: true, full: SECRET },
    { group: 'Instruction files', name: 'CLAUDE.md', bytes: 8000, tokens: 2000, preview: SECRET, id: ID2, removable: true, removed: true },
    { group: 'Your prompts', name: 'Prompt 1', turn: 1, bytes: 400, tokens: 100, preview: SECRET },
    { group: 'Built-in tools', name: 'Bash', bytes: 79600, tokens: 19900, preview: SECRET, nested: { preview: SECRET } },
    { group: 'Tool results', name: 'Bad id', bytes: 4, tokens: 0, id: 'not-hex', removable: true, preview: SECRET },
  ],
});

test('inspectView drops previews and full text, keeps names, sizes and flags; totals match the fixture', () => {
  const v = inspectView(report(), { engine: 'claude' });
  assert.ok(!JSON.stringify(v).includes(SECRET), 'no conversation text');
  assert.ok(!/preview|full/i.test(JSON.stringify(v)), 'no preview/Full keys');
  assert.equal(v.totalTokens, report().items.reduce((s, i) => s + i.tokens, 0));
  assert.equal(v.totalTokens, 52000);
  assert.equal(v.reportedTokens, 52000);
  assert.deepEqual(v.groups.map((g) => g.group), ['Instruction files', 'System prompt', 'Built-in tools', 'Your prompts', 'Tool results']);
  const results = v.groups.find((g) => g.group === 'Tool results');
  assert.equal(results.tokens, 20000);
  assert.deepEqual(results.items[0], { id: ID1, name: 'Read src/a.js', turn: 2, tokens: 20000, flags: ['large and 1 prompts old'], removable: true, removed: false });
  assert.deepEqual(results.items[1], { id: null, name: 'Bad id', turn: 0, tokens: 0, flags: [], removable: false, removed: false }, 'a malformed id is never offered for removal');
  assert.equal(v.groups[0].items[0].removed, true);
  assert.equal(v.engine, 'claude');
  assert.equal(inspectView(report(), { engine: 'codex' }).engine, 'codex');
});

test('inspectView: unknown shapes give null; huge groups are bounded with a count of the rest', () => {
  for (const bad of [null, 'x', [], {}, { session: SID }, { items: [] }]) assert.equal(inspectView(bad), null);
  const many = { session: SID, items: Array.from({ length: 100 }, (_, i) => ({ group: 'Tool results', name: `r${i}`, tokens: i })) };
  const g = inspectView(many).groups[0];
  assert.equal(g.items.length, 40);
  assert.equal(g.more, 60);
  assert.equal(g.items[0].tokens, 99, 'largest first');
  assert.equal(g.tokens, 4950, 'group total counts every item');
});

async function harness(answer) {
  const fake = await createFakeBurst({
    '/api/state': { body: stateV019() }, '/api/upgrade-status': { body: {} }, '/api/requests': { body: [] }, '/api/coordination': { body: {} },
    '/api/inspect': { body: report() }, '/api/inspect/remove': { body: { ok: 'removed' } }, '/api/compaction/drop': { body: { ok: 'dropped' } },
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-inspect-'));
  const bin = path.join(home, '.local', 'bin', 'claude-burst');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.config', 'claude-burst'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify({ admin_listen: `127.0.0.1:${fake.port}` }));
  const client = createBurstClient({ home, platform: 'darwin', inspect: { launchdPid: async () => process.pid, listenerPid: async () => process.pid, exePath: async () => bin } });
  const handlers = {}, dialogs = [];
  const api = Ipc.register({
    utilityHandle: (c, allowed, f) => { handlers[c] = (e, ...a) => (allowed(e) ? f(e, ...a) : null); },
    settingsOnly: () => false, sessionsAllowed: (e) => e.from === 'sessions', isMac: true, client, home, shell: {}, scriptDir: '/x',
    dialog: { showMessageBox: async (o) => { dialogs.push(o); return { response: answer }; } },
  });
  await api.refresh(true);
  return { fake, handlers, dialogs, posts: () => fake.requests.filter((r) => r.method === 'POST'), done: async () => { await fake.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}
const SESSIONS = { from: 'sessions' };

test('burst:view inspect reaches the Sessions page without any preview text', async () => {
  const h = await harness(1);
  try {
    const r = await h.handlers['burst:view'](SESSIONS, 'inspect', { session: SID });
    assert.equal(r.view.totalTokens, 52000);
    assert.ok(!JSON.stringify(r).includes(SECRET));
    assert.match(h.fake.requests.find((x) => x.url.startsWith('/api/inspect')).url, new RegExp(`^/api/inspect\\?session=${SID}$`));
    assert.equal(h.posts().length, 0);
  } finally { await h.done(); }
});

test('Leave out, Put back and Send full history again: cancel sends nothing; confirm sends exactly one allow-listed POST', async () => {
  for (const [id, args, url, body] of [
    ['inspect-remove', { session: SID, id: ID1, engine: 'claude', preview: SECRET }, '/api/inspect/remove', { engine: '', session: SID, id: ID1, restore: false }],
    ['inspect-remove', { session: SID, id: ID2, engine: 'codex', restore: true }, '/api/inspect/remove', { engine: 'codex', session: SID, id: ID2, restore: true }],
    ['compaction-drop', { session: SID, extra: 'x' }, '/api/compaction/drop', { session: SID }],
  ]) {
    const no = await harness(0);
    assert.deepEqual(await no.handlers['burst-action'](SESSIONS, id, args), { ok: false, cancelled: true });
    assert.equal(no.dialogs.length, 1);
    assert.equal(no.posts().length, 0, `${id} cancel`);
    await no.done();
    const yes = await harness(1);
    assert.equal((await yes.handlers['burst-action'](SESSIONS, id, args)).ok, true);
    assert.equal(yes.posts().length, 1, `${id} confirm`);
    assert.equal(yes.posts()[0].url, url);
    assert.deepEqual(JSON.parse(yes.posts()[0].body), body);
    await yes.done();
  }
});

test('a malformed item id never reaches a dialog or Burst', async () => {
  const h = await harness(1);
  try {
    assert.deepEqual(await h.handlers['burst-action'](SESSIONS, 'inspect-remove', { session: SID, id: 'not-hex' }), { ok: false, error: 'Bad request.' });
    assert.equal(h.dialogs.length, 0);
    assert.equal(h.posts().length, 0);
  } finally { await h.done(); }
});
