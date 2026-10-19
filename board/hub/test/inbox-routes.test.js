// Team depth lane B: the per-member hub inbox routes (plan acceptance B2, B3)
// and the live push to the member's own sockets only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAccounts } from './accounts-helpers.js';
import { until } from './helpers.js';
import { Api } from '../api.js';

test('GET /api/account/inbox lists only the caller\'s rows, unread first then the last 50 read; since narrows; 401 signed out', async () => {
  const h = await startAccounts();
  try {
    const a = await h.signIn('alice@dev.local');
    const b = await h.signIn('bob@dev.local');
    const api = new Api(h.hub);
    const notify = (m, kind, ref) => h.hub.txn(() => api.notify(m, kind, ref));
    const first = notify(h.ids.alice, 'mention', { card_id: 'c1', by: h.ids.bob });
    h.clock.advance(1000);
    for (let i = 0; i < 60; i++) { const id = notify(h.ids.alice, 'moment', { moment_id: `m${i}` }); h.db.run('UPDATE inbox SET read_at = created_at WHERE id = ?', id); }
    notify(h.ids.bob, 'reply', { card_id: 'c2', by: h.ids.alice });
    assert.equal((await h.call('GET', '/api/account/inbox')).status, 401);
    const mine = await h.call('GET', '/api/account/inbox', { token: a.body.device_token });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.unread, 1);
    assert.equal(mine.body.items.length, 51, 'one unread plus the last 50 read');
    assert.ok(mine.body.items.every((i) => i.org_id === h.ids.org && !('member_id' in i)));
    assert.ok(mine.body.items.some((i) => i.id === first && i.kind === 'mention' && i.ref.card_id === 'c1' && i.read_at === null));
    const theirs = await h.call('GET', '/api/account/inbox', { token: b.body.device_token });
    assert.deepEqual(theirs.body.items.map((i) => i.kind), ['reply']);
    assert.equal(theirs.body.unread, 1);
    const future = await h.call('GET', `/api/account/inbox?since=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`, { token: a.body.device_token });
    assert.deepEqual(future.body, { items: [], unread: 0 });
    assert.equal((await h.call('GET', '/api/account/inbox?since=nope', { token: a.body.device_token })).status, 400);
  } finally { await h.destroy(); }
});

test('POST /api/account/inbox/read marks the caller\'s unread rows by id or all; foreign ids are ignored, never 404', async () => {
  const h = await startAccounts();
  try {
    const a = await h.signIn('alice@dev.local');
    const b = await h.signIn('bob@dev.local');
    const api = new Api(h.hub);
    const ids = [1, 2, 3].map((i) => h.hub.txn(() => api.notify(h.ids.alice, 'mention', { card_id: `c${i}` })));
    const bobs = h.hub.txn(() => api.notify(h.ids.bob, 'mention', { card_id: 'cb' }));
    assert.equal((await h.call('POST', '/api/account/inbox/read', { body: { ids: [ids[0]] } })).status, 401);
    assert.equal((await h.call('POST', '/api/account/inbox/read', { token: a.body.device_token, body: {} })).status, 400);
    const one = await h.call('POST', '/api/account/inbox/read', { token: a.body.device_token, body: { ids: [ids[0], bobs, 'not-a-row'] } });
    assert.equal(one.status, 200);
    assert.deepEqual(one.body, { read: 1 });
    assert.equal(h.db.get('SELECT read_at FROM inbox WHERE id = ?', bobs).read_at, null, 'bob\'s row untouched');
    const all = await h.call('POST', '/api/account/inbox/read', { token: a.body.device_token, body: { all: true } });
    assert.deepEqual(all.body, { read: 2 });
    assert.deepEqual((await h.call('POST', '/api/account/inbox/read', { token: a.body.device_token, body: { all: true } })).body, { read: 0 });
    const after = await h.call('GET', '/api/account/inbox', { token: a.body.device_token });
    assert.equal(after.body.unread, 0);
    assert.equal(after.body.items.length, 3);
    assert.ok(after.body.items.every((i) => i.read_at));
    assert.equal((await h.call('GET', '/api/account/inbox', { token: b.body.device_token })).body.unread, 1);
  } finally { await h.destroy(); }
});

test('inbox.item reaches the member\'s own sockets only, whatever board they watch', async () => {
  const h = await startAccounts();
  try {
    const a = await h.signIn('alice@dev.local');
    const b = await h.signIn('bob@dev.local');
    const sa = await h.browser({ token: a.body.device_token });
    await sa.subscribe(h.ids.board);
    const sb = await h.browser({ token: b.body.device_token });
    await sb.subscribe(h.ids.board);
    const api = new Api(h.hub);
    const id = h.hub.txn(() => api.notify(h.ids.alice, 'mention', { card_id: 'c1', by: h.ids.bob }));
    h.hub.broadcastMember(h.ids.alice, 'inbox.item', { item: api.inboxItem(id) });
    await until(() => sa.all('inbox.item').length === 1);
    assert.equal(sa.all('inbox.item')[0].item.id, id);
    assert.equal(sa.all('inbox.item')[0].item.kind, 'mention');
    assert.equal(sb.all('inbox.item').length, 0, 'bob hears nothing');
  } finally { await h.destroy(); }
});

test('answering a question raised by a run on someone else\'s machine writes input_answered for that machine\'s owner; answering your own writes nothing', async (t) => {
  const { startHub } = await import('./helpers.js');
  const h = await startHub(); t.after(() => h.destroy());
  const alice = await h.login('alice'), bob = await h.login('bob');
  const dev = await h.enroll(alice), runner = await h.runner(dev);
  const run = await h.startRun(alice, runner, {});
  h.db.insert('card_assignees', { card_id: run.card_id, member_id: h.ids.bob, role: 'collaborator' });
  const ask = await runner.rpc(run, 'board_ask_human', { kind: 'question', text: 'Should I continue?' });
  const res = await h.action(bob, run.card_id, 'answer', { ask_id: ask.result.ask_id, answer: 'Yes' });
  assert.equal(res.status, 200, res.text);
  const rows = h.db.all('SELECT * FROM inbox ORDER BY created_at');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].member_id, h.ids.alice);
  assert.equal(rows[0].kind, 'input_answered');
  assert.deepEqual(JSON.parse(rows[0].ref_json), { card_id: run.card_id, board_id: h.ids.board, ask_id: ask.result.ask_id, by: h.ids.bob });
  const ask2 = await runner.rpc(run, 'board_ask_human', { kind: 'question', text: 'And now?' });
  assert.equal((await h.action(alice, run.card_id, 'answer', { ask_id: ask2.result.ask_id, answer: 'Go' })).status, 200);
  assert.equal(h.db.get('SELECT count(*) AS n FROM inbox').n, 1, 'no row for answering your own run');
});
