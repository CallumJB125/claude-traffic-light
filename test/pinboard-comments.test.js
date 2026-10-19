'use strict';
// "Comment" from a session (src/pinboard.js comment, team depth lane A): posts
// one comment to a moment or a card of the linked board with the hub sign-in;
// only the typed text travels, the hub parses @mentions, the folder path never leaves.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPinboard, register } = require('../src/pinboard.js');

const link = { route: { hub: 'https://hub.example.test', board_id: 'b1' }, token: () => 'tok' };
function make(status = 200, body = { comment: { id: 'cm1', mentions: ['m-alice'] } }) {
  const calls = [];
  const pb = createPinboard({ resolve: async () => link, fetch: async (url, init) => { calls.push({ url, init }); return { status, json: async () => body }; } });
  return { pb, calls };
}

test('a moment comment goes to the moment route of the linked board as text only', async () => {
  const { pb, calls } = make();
  const r = await pb.comment({ cwd: '/Users/me/secret/repo', target: { moment_id: 'm1' }, body: '  @alice ship it\r\nplease  ' });
  assert.deepEqual(r, { ok: true, comment_id: 'cm1', mentions: 1, board: 'b1' });
  assert.equal(calls[0].url, 'https://hub.example.test/api/boards/b1/moments/m1/comments');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.body, '@alice ship it\nplease');
  assert.deepEqual(Object.keys(sent).sort(), ['body', 'request_id']);
  assert.ok(!calls[0].init.body.includes('secret'));
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  assert.equal(calls[0].init.redirect, 'error');
});

test('a card comment goes to the card route; a card wins over a moment when both are named', async () => {
  const { pb, calls } = make(200, { comment: { id: 'cm2', mentions: [] } });
  const r = await pb.comment({ cwd: '/x', target: { card_id: 'c9', moment_id: 'm1' }, body: 'done' });
  assert.deepEqual(r, { ok: true, comment_id: 'cm2', mentions: 0, board: 'b1' });
  assert.equal(calls[0].url, 'https://hub.example.test/api/cards/c9/comments');
});

test('bad input, bad ids and hub refusals are said plainly, and nothing is sent', async () => {
  const { pb, calls } = make(403, { error: { message: 'viewers cannot change labels' } });
  assert.equal((await pb.comment({ cwd: '/x', target: {}, body: 'x' })).error, 'Choose a card or a moment to comment on.');
  assert.equal((await pb.comment({ cwd: '/x', target: { moment_id: '../etc' }, body: 'x' })).error, 'Choose a card or a moment to comment on.');
  assert.equal((await pb.comment({ cwd: '/x', target: { moment_id: 'm1' }, body: '   ' })).error, 'Write the comment first.');
  assert.equal(calls.length, 0);
  assert.equal((await pb.comment({ cwd: '/x', target: { moment_id: 'm1' }, body: 'hi' })).error, 'viewers cannot change labels');
  const gone = make(404, { error: { message: 'no such moment' } });
  assert.match((await gone.pb.comment({ cwd: '/x', target: { moment_id: 'm1' }, body: 'hi' })).error, /no longer on the board/);
  const unlinked = createPinboard({ resolve: async () => null, fetch: async () => { throw new Error('never'); } });
  assert.equal((await unlinked.comment({ cwd: '/x', target: { moment_id: 'm1' }, body: 'hi' })).error, 'This folder is not linked to a team board in Plexiform.');
  const down = createPinboard({ resolve: async () => link, fetch: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } });
  assert.equal((await down.comment({ cwd: '/x', target: { moment_id: 'm1' }, body: 'hi' })).error, 'The team hub could not be reached. Try again.');
});

test('moment() now returns the new moment id so the Comment follow-up can target it', async () => {
  const calls = [];
  const pb = createPinboard({ resolve: async () => link, fetch: async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => ({ moments: [{ id: 'm-new' }, { id: 'm-old' }] }) }; } });
  assert.deepEqual(await pb.moment({ cwd: '/x', kind: 'ship', label: 'Live' }), { ok: true, count: 2, board: 'b1', moment_id: 'm-new' });
});

test('the comments:add IPC resolves the session to its folder, keeps only id fields of the target, and refuses unknown senders', async () => {
  const handlers = {};
  const { pb, calls } = make();
  register({ ipcMain: { handle: (n, f) => { handlers[n] = f; } }, allowed: (e) => e.ok, pinboard: pb, cwdFor: async (k) => (k === 'sess' ? '/repo' : null) });
  assert.deepEqual(await handlers['comments:add']({ ok: false }, 'sess', { moment_id: 'm1' }, 'x'), { ok: false, error: 'Not allowed.' });
  assert.deepEqual(await handlers['comments:add']({ ok: true }, 'nope', { moment_id: 'm1' }, 'x'), { ok: false, error: 'No folder is known for this session.' });
  assert.deepEqual(await handlers['comments:add']({ ok: true }, 'sess', 'm1', 'x'), { ok: false, error: 'Choose a card or a moment to comment on.' });
  const r = await handlers['comments:add']({ ok: true }, 'sess', { moment_id: 'm1', extra: 'ignored' }, 'hello');
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hub.example.test/api/boards/b1/moments/m1/comments');
});
