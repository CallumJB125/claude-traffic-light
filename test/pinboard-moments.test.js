'use strict';
// "Mark a moment" from a session (src/pinboard.js moment): posts one moment to the
// linked board with the hub sign-in; only the typed kind, label and note travel.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPinboard, register, MOMENTS } = require('../src/pinboard.js');

const link = { route: { hub: 'https://hub.example.test', board_id: 'b1' }, token: () => 'tok' };
function make(status = 200, body = { moments: [{ id: 'm1' }] }) {
  const calls = [];
  const pb = createPinboard({ resolve: async () => link, fetch: async (url, init) => { calls.push({ url, init }); return { status, json: async () => body }; } });
  return { pb, calls };
}

test('a moment travels as kind, label and note only, and the folder path never leaves', async () => {
  const { pb, calls } = make();
  const r = await pb.moment({ cwd: '/Users/me/secret/repo', kind: 'ship', label: '  Billing v2   live ', note: 'went out at 10' });
  assert.deepEqual(r, { ok: true, count: 1, board: 'b1' });
  assert.equal(calls[0].url, 'https://hub.example.test/api/boards/b1/moments');
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent.moment, { kind: 'ship', label: 'Billing v2 live', note: 'went out at 10' });
  assert.ok(!calls[0].init.body.includes('secret'));
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
});

test('bad input and hub refusals are said plainly', async () => {
  const { pb, calls } = make(403, { error: { message: 'viewers cannot change labels' } });
  assert.equal((await pb.moment({ cwd: '/x', kind: 'party', label: 'x' })).error, 'Choose moment, ship, decision or demo.');
  assert.equal((await pb.moment({ cwd: '/x', kind: 'ship', label: '   ' })).error, 'Say what the moment was.');
  assert.equal(calls.length, 0);
  assert.equal((await pb.moment({ cwd: '/x', kind: 'ship', label: 'ok' })).error, 'viewers cannot change labels');
  assert.deepEqual([...MOMENTS], ['moment', 'ship', 'decision', 'demo']);
});

test('the moments:mark IPC resolves the session to its folder and refuses unknown senders', async () => {
  const handlers = {};
  const { pb } = make();
  register({ ipcMain: { handle: (n, f) => { handlers[n] = f; } }, allowed: (e) => e.ok, pinboard: pb, cwdFor: async (k) => (k === 'sess' ? '/repo' : null) });
  assert.deepEqual(await handlers['moments:mark']({ ok: false }, 'sess', 'ship', 'x', ''), { ok: false, error: 'Not allowed.' });
  assert.deepEqual(await handlers['moments:mark']({ ok: true }, 'nope', 'ship', 'x', ''), { ok: false, error: 'No folder is known for this session.' });
  assert.equal((await handlers['moments:mark']({ ok: true }, 'sess', 'demo', 'Showed the board', '')).ok, true);
});

test('a shared view travels as its name and filter values only', async () => {
  const calls = [];
  const pb = createPinboard({ resolve: async () => null, fetch: async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => ({ views: [{ id: 'v1' }] }) }; } });
  const r = await pb.view({ link, name: ' Release  watch ', values: { person: 'Bob', focus: 'attention', 'bad key!': 'x', empty: '' } });
  assert.deepEqual(r, { ok: true, count: 1, board: 'b1' });
  assert.equal(calls[0].url, 'https://hub.example.test/api/boards/b1/views');
  assert.deepEqual(JSON.parse(calls[0].init.body).view, { name: 'Release watch', values: { person: 'Bob', focus: 'attention' } });
  assert.equal((await pb.view({ link, name: '', values: { person: 'Bob' } })).error, 'Name the view.');
  assert.equal((await pb.view({ link, name: 'x', values: {} })).error, 'Set at least one filter first.');
  assert.equal((await pb.view({ link: null, name: 'x', values: { person: 'Bob' } })).error, 'This team has no board linked in Plexiform.');
});
