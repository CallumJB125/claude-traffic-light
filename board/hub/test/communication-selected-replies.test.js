// Real account HTTP and enrolled protocol runs. No provider models, GUI or
// account configuration; private board filters model a narrowed native grant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { communicationRig, taskMessage } from './communication-helpers.js';

async function replies(t) {
  const x = await communicationRig(t), { A, h, sender: a, recipient: b } = x;
  const created = await x.as(x.users.ua, 'POST', '/api/boards', { request_id: randomUUID(), name: 'Unselected reply origin' });
  assert.equal(created.status, 200, created.text);
  const hiddenBoard = created.body.board.id;
  h.db.run('INSERT INTO board_repos(board_id,repo_id) VALUES(?,?)', hiddenBoard, A.repo);
  const hidden = await x.participant(x.users.s, A, { board: hiddenBoard });
  const original = await hidden.client.rpc(hidden.run, 'board_send_message', taskMessage(a, { body: 'Unselected origin narrative' }));
  assert.equal(original.ok, true, JSON.stringify(original.error));
  const origin = original.result.message;
  const path = `/api/cards/${a.run.card_id}/messages`;
  const payload = { ...taskMessage(b, { body: 'Permitted source reply', thread_id: origin.thread_id, reply_to: origin.id }), expected_fence: a.run.fence };
  const first = await x.as(a.user, 'POST', path, payload); assert.equal(first.status, 200, first.text);
  return { ...x, a, b, origin, first: first.body.message, hiddenBoard, path, payload, narrowed: `${path}?board_id=${encodeURIComponent(A.board)}` };
}

test('narrowed history keeps permitted reply content and redacts unselected reply and thread-origin references', async (t) => {
  const x = await replies(t);
  const broad = await x.as(x.a.user, 'GET', x.path); assert.equal(broad.status, 200);
  const ordinary = broad.body.messages.find((m) => m.id === x.first.id);
  assert.equal(ordinary.reply_to, x.origin.id); assert.equal(ordinary.thread_id, x.origin.thread_id);
  const response = await x.as(x.a.user, 'GET', x.narrowed); assert.equal(response.status, 200);
  const selected = response.body.messages.find((m) => m.id === x.first.id);
  assert.ok(selected, 'source reply on a permitted board remains readable');
  assert.equal(selected.body, 'Permitted source reply');
  assert.equal(selected.reply_to, null, 'an unselected origin UUID is not exported');
  assert.equal(selected.thread_id, null, 'an unselected thread seed UUID is not exported');
  assert.ok(!JSON.stringify(response.body).includes(x.origin.id));
  assert.ok(!JSON.stringify(response.body).includes(x.origin.thread_id));
  assert.ok(!JSON.stringify(response.body).includes('Unselected origin narrative'));
  assert.ok(selected.deliveries.some((r) => r.recipient_run_id === x.b.run.run_id));
});

for (const loss of ['selected_scope', 'origin_archive']) test(`durable exact reply retry revalidates ${loss} before replay without a new write`, async (t) => {
  const x = await replies(t);
  assert.equal((await x.as(x.a.user, 'POST', x.path, x.payload)).body.message.id, x.first.id, 'authorized exact retry works');
  const before = JSON.stringify({ messages: x.h.db.all('SELECT * FROM task_messages'), comments: x.h.db.all('SELECT * FROM comments'),
    journal: x.h.db.all("SELECT * FROM journal WHERE kind='message.create'") });
  if (loss === 'origin_archive') x.h.db.run('UPDATE boards SET archived_at=? WHERE id=?', x.h.hub.iso(), x.hiddenBoard);
  const path = loss === 'selected_scope' ? x.narrowed : x.path;
  const fresh = await x.as(x.a.user, 'POST', path, { ...x.payload, request_id: randomUUID() });
  assert.equal(fresh.status, 404, fresh.text);
  const retry = await x.as(x.a.user, 'POST', path, x.payload);
  assert.equal(retry.status, 404, 'stored result must meet the same current reply scope as a fresh request');
  assert.equal(JSON.stringify({ messages: x.h.db.all('SELECT * FROM task_messages'), comments: x.h.db.all('SELECT * FROM comments'),
    journal: x.h.db.all("SELECT * FROM journal WHERE kind='message.create'") }), before);
});
