import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { communicationRig, taskMessage, receiptOf } from './communication-helpers.js';
import { until, settle, runMsg } from './helpers.js';
import { startHub, runHb } from './helpers.js';
import { rmSync } from 'node:fs';
import { TeamCommunication } from '../communication.js';

test('messages cross actual accounts with hub run provenance, durable retries and explicit receipt stages; never resume', async (t) => {
  const x = await communicationRig(t), { h, sender: a, recipient: b } = x;
  const request = taskMessage(b), states = JSON.stringify(h.db.all('SELECT request_id, state FROM dispatches'));
  const first = await a.client.rpc(a.run, 'board_send_message', request); assert.equal(first.ok, true, JSON.stringify(first.error));
  const m = first.result.message; assert.equal(m.author.account_id, a.user.id); assert.equal(m.author.provider, 'codex'); assert.equal(m.author.run_id, a.run.run_id);
  assert.equal(m.for_agent, false); assert.equal(m.auto_resume, false); assert.equal(m.deliveries[0].state, 'pending');
  assert.deepEqual((await a.client.rpc(a.run, 'board_send_message', request)).result, first.result);
  assert.equal((await a.client.rpc(a.run, 'board_send_message', { ...request, body: 'Other payload' })).error.code, 'CONFLICT');
  await settle(); assert.equal(b.client.all('comment.deliver').length, 0); assert.equal(b.client.all('answer').length, 0);
  assert.equal(JSON.stringify(h.db.all('SELECT request_id, state FROM dispatches')), states);
  const comment = h.db.get('SELECT * FROM comments WHERE id = (SELECT comment_id FROM task_messages WHERE id = ?)', m.id);
  assert.equal(comment.for_agent, 0); assert.equal(comment.author_run_id, a.run.run_id);
  const inbox = await b.client.rpc(b.run, 'board_list_messages'); assert.equal(inbox.ok, true, JSON.stringify(inbox.error));
  assert.equal(inbox.result.inbox.length, 1); assert.equal(inbox.result.inbox[0].id, m.id);
  assert.ok(inbox.result.peers.some((p) => p.run_id === a.run.run_id && p.provider === 'codex'));
  const cap = receiptOf(inbox.result.inbox[0]);
  assert.equal((await b.client.rpc(b.run, 'board_ack_message', cap)).error.code, 'CONFLICT', 'agent acknowledgement cannot fabricate host receipt');
  assert.equal((await a.client.rpc(a.run, 'board_ack_message', cap)).error.code, 'FORBIDDEN');
  assert.equal((await b.client.rpc(b.run, 'runner_messages_received', { receipts: [cap] })).ok, true);
  const ack = await b.client.rpc(b.run, 'board_ack_message', cap); assert.equal(ack.ok, true); assert.equal(ack.result.acknowledgement_source, 'agent_reported');
  assert.equal((await b.client.rpc(b.run, 'board_list_messages')).result.inbox.length, 0);
  const history = await x.as(x.users.ua, 'GET', `/api/cards/${a.run.card_id}/messages`); assert.equal(history.status, 200, history.text);
  assert.equal(history.body.messages[0].deliveries[0].state, 'acknowledged'); assert.ok(!JSON.stringify(history.body).includes(cap.receipt_token));
  assert.equal(h.db.get('SELECT COUNT(*) n FROM task_messages').n, 1);
  assert.throws(() => h.db.run("UPDATE task_messages SET body = 'forged' WHERE id = ?", m.id), /immutable/);
  assert.throws(() => h.db.run('UPDATE task_message_receipts SET connection_generation = ? WHERE id = ?', randomUUID(), cap.receipt_id), /immutable/);
});

test('replacement cannot acknowledge or report receipt with a previous host generation, and can read a fresh attempt', async (t) => {
  const x = await communicationRig(t), { sender: a, recipient: b, h } = x;
  assert.equal((await a.client.rpc(a.run, 'board_send_message', taskMessage(b))).ok, true);
  const old = receiptOf((await b.client.rpc(b.run, 'board_list_messages')).result.inbox[0]);
  const oldGeneration = b.connection().generation, replacement = await b.open([{ run_id: b.run.run_id, card_id: b.run.card_id, fence: b.run.fence }]);
  assert.notEqual(h.hub.runners.get(replacement.welcome.device_id).generation, oldGeneration);
  assert.equal((await replacement.rpc(b.run, 'runner_messages_received', { receipts: [old] })).error.code, 'FORBIDDEN');
  assert.equal((await replacement.rpc(b.run, 'board_ack_message', old)).error.code, 'FORBIDDEN');
  const fresh = receiptOf((await replacement.rpc(b.run, 'board_list_messages')).result.inbox[0]); assert.notEqual(fresh.receipt_id, old.receipt_id);
  assert.equal((await replacement.rpc(b.run, 'runner_messages_received', { receipts: [fresh] })).ok, true);
  assert.equal((await replacement.rpc(b.run, 'board_ack_message', fresh)).ok, true);
});

test('staff/native text cannot claim verified provider or sender identity; foreign teams, repositories and guests stay absent', async (t) => {
  const x = await communicationRig(t), { h, sender: a, recipient: b, A, B, users } = x;
  const path = `/api/cards/${a.run.card_id}/messages`, request = { ...taskMessage(b), expected_fence: a.run.fence };
  const m = await x.as(users.ua, 'POST', path, request); assert.equal(m.status, 200, m.text);
  assert.equal(m.body.message.author.provider, null); assert.equal(m.body.message.author.run_id, null); assert.equal(m.body.message.author.kind, 'member');
  for (const extra of [{ provider: 'codex' }, { author_run_id: a.run.run_id }, { connection_generation: randomUUID() }, { for_agent: true }, { approval: 'allow' }]) {
    assert.equal((await x.as(users.ua, 'POST', path, { ...request, request_id: randomUUID(), ...extra })).status, 400);
  }
  assert.equal((await x.as(users.aviewer, 'GET', path)).status, 200);
  assert.equal((await x.as(users.aviewer, 'POST', path, request)).status, 403);
  assert.equal((await x.as(users.bguest, 'GET', `/api/cards/${B.card}/messages`)).status, 404);
  const service = new TeamCommunication(h.hub);
  assert.throws(() => service.staffListMessages(h.hub.member(A.member), a.run.card_id), /credential required/);
  assert.throws(() => service.staffListMessages(h.hub.member(A.member), a.run.card_id, { kind: 'device', id: users.ua.device_id }), /credential does not belong/);
  const foreign = await x.participant(users.ub, B);
  assert.equal((await a.client.rpc(a.run, 'board_send_message', taskMessage(foreign))).error.code, 'NOT_FOUND');
  assert.equal((await x.as(users.ua, 'GET', `/api/cards/${foreign.run.card_id}/messages`)).status, 404);
  const privateRepo = randomUUID(); h.db.insert('repos', { id: privateRepo, org_id: A.team, canonical_url: 'github.com/alpha/private', short_name: 'private' });
  h.db.run('INSERT INTO board_repos (board_id, repo_id) VALUES (?, ?)', A.board, privateRepo);
  h.db.run('UPDATE runs SET repo_id = ? WHERE id = ?', privateRepo, b.run.run_id); h.db.run('UPDATE cards SET repo_id = ? WHERE id = ?', privateRepo, b.run.card_id);
  assert.equal((await a.client.rpc(a.run, 'board_send_message', taskMessage(b))).error.code, 'NOT_FOUND');
  assert.ok(!(await a.client.rpc(a.run, 'board_list_messages')).result.peers.some((p) => p.run_id === b.run.run_id));
  assert.equal(h.db.get('SELECT COUNT(*) n FROM task_messages').n, 1);
});

test('threads cannot be reset by omitting IDs, fabricated replies or recipient loops; messages are bounded and sanitized', async (t) => {
  const x = await communicationRig(t), { sender: a, recipient: b, h } = x;
  const secret = 'API_TOKEN=fixtureSecret123 /srv/private bmr1.' + randomUUID() + '.' + 'a'.repeat(43);
  let last = (await a.client.rpc(a.run, 'board_send_message', taskMessage(b, { body: secret }))).result.message;
  assert.ok(!last.body.includes('fixtureSecret123')); assert.ok(!last.body.includes('/srv/private')); assert.ok(!last.body.includes('bmr1.'));
  assert.equal((await a.client.rpc(a.run, 'board_send_message', taskMessage(b, { thread_id: randomUUID() }))).error.code, 'VALIDATION');
  assert.equal((await a.client.rpc(a.run, 'board_send_message', taskMessage(b, { reply_to: randomUUID() }))).error.code, 'NOT_FOUND');
  const c = await x.participant(x.users.s);
  assert.equal((await c.client.rpc(c.run, 'board_send_message', taskMessage(a, { reply_to: last.id, thread_id: last.thread_id }))).error.code, 'NOT_FOUND');
  for (let depth = 1; depth <= 3; depth++) {
    const writer = depth % 2 ? b : a, receiver = depth % 2 ? a : b;
    const result = await writer.client.rpc(writer.run, 'board_send_message', taskMessage(receiver, { reply_to: last.id, thread_id: last.thread_id })); assert.equal(result.ok, true, JSON.stringify(result.error));
    last = result.result.message; assert.equal(last.depth, depth);
  }
  assert.equal((await a.client.rpc(a.run, 'board_send_message', taskMessage(b, { reply_to: last.id, thread_id: last.thread_id }))).error.code, 'QUOTA_EXCEEDED');
  const thread = last.thread_id;
  for (let n = 4; n < 8; n++) assert.equal((await a.client.rpc(a.run, 'board_send_message', taskMessage(b))).result.message.thread_id, thread);
  assert.equal((await a.client.rpc(a.run, 'board_send_message', taskMessage(b))).error.code, 'QUOTA_EXCEEDED');
  assert.equal((await a.client.rpc(a.run, 'board_send_message', taskMessage(b, { recipient_run_ids: Array.from({ length: 5 }, () => b.run.run_id) }))).error.code, 'VALIDATION');
  assert.equal((await a.client.rpc(a.run, 'board_send_message', taskMessage(b, { body: 'x'.repeat(4001) }))).error.code, 'VALIDATION');
  assert.ok(h.db.all('SELECT for_agent FROM comments').every((c) => c.for_agent === 0));
});

test('message/comment/recipient commit rolls back together and receipt batches do not partially succeed', async (t) => {
  const x = await communicationRig(t), { h, sender: a, recipient: b } = x;
  const insert = h.db.insert.bind(h.db);
  h.db.insert = (table, value) => { if (table === 'task_message_recipients') throw Error('storage failure'); return insert(table, value); };
  assert.equal((await a.client.rpc(a.run, 'board_send_message', taskMessage(b))).ok, false); h.db.insert = insert;
  for (const table of ['task_messages', 'task_message_threads', 'task_message_recipients']) assert.equal(h.db.get(`SELECT COUNT(*) n FROM ${table}`).n, 0);
  assert.equal(h.db.get('SELECT COUNT(*) n FROM comments WHERE card_id = ?', a.run.card_id).n, 0);
  assert.equal((await a.client.rpc(a.run, 'board_send_message', taskMessage(b))).ok, true);
  const cap = receiptOf((await b.client.rpc(b.run, 'board_list_messages')).result.inbox[0]);
  const batch = await b.client.rpc(b.run, 'runner_messages_received', { receipts: [cap, { ...cap, receipt_token: 'forged' }] }); assert.equal(batch.ok, false);
  assert.equal(h.db.get('SELECT received_at FROM task_message_receipts WHERE id = ?', cap.receipt_id).received_at, null);
  assert.equal(h.db.get("SELECT COUNT(*) n FROM journal WHERE kind = 'message.receipt'").n, 0);
});

test('same-team cross-board participants receive only exact addressed task messages and own context', async (t) => {
  const x = await communicationRig(t), { sender: a, A } = x;
  const board = await x.as(x.users.ua, 'POST', '/api/boards', { request_id: randomUUID(), name: 'Related project' }); assert.equal(board.status, 200, board.text);
  x.h.db.run('INSERT INTO board_repos (board_id, repo_id) VALUES (?, ?)', board.body.board.id, A.repo);
  const other = await x.participant(x.users.s, A, { board: board.body.board.id, title: 'Related task' });
  const sent = await a.client.rpc(a.run, 'board_send_message', taskMessage(other)); assert.equal(sent.ok, true, JSON.stringify(sent.error));
  assert.equal((await other.client.rpc(other.run, 'board_list_messages')).result.inbox[0].id, sent.result.message.id);
  assert.equal((await x.recipient.client.rpc(x.recipient.run, 'board_list_messages')).result.inbox.length, 0);
  assert.equal((await other.client.rpc(other.run, 'board_read_packet')).result.packet, null, 'messages never widen the packet/card scope');
  x.h.db.run('UPDATE cards SET archived_at = ? WHERE id = ?', x.h.hub.iso(), a.run.card_id);
  assert.equal((await other.client.rpc(other.run, 'board_list_messages')).result.inbox.length, 0, 'archived source content is not exported');
});

test('pending task messages survive an actual hub restart and old transport attempts cannot acknowledge the new connection', async () => {
  const h = await startHub(); let restarted;
  try {
    const alice = await h.login('alice'), bob = await h.login('bob'), da = await h.enroll(alice), db = await h.enroll(bob);
    const a = await h.runner(da), b = await h.runner(db), ar = await h.startRun(alice, a), br = await h.startRun(bob, b);
    const request = { request_id: randomUUID(), kind: 'handoff', body: 'Resume from the saved packet', recipient_run_ids: [br.run_id] };
    const sent = await a.rpc(ar, 'board_send_message', request); assert.equal(sent.ok, true);
    const old = receiptOf((await b.rpc(br, 'board_list_messages')).result.inbox[0]);
    await h.close(); restarted = await startHub({ dataDir: h.dataDir });
    const fresh = await restarted.runner(db, { runs: [runMsg(br)] }); await fresh.hb([runHb(br)]);
    assert.equal((await fresh.rpc(br, 'runner_messages_received', { receipts: [old] })).error.code, 'FORBIDDEN');
    const inbox = await fresh.rpc(br, 'board_list_messages'); assert.equal(inbox.ok, true, JSON.stringify(inbox.error));
    assert.equal(inbox.result.inbox[0].id, sent.result.message.id); assert.equal(inbox.result.inbox[0].body, request.body);
    const cap = receiptOf(inbox.result.inbox[0]); assert.notEqual(cap.receipt_id, old.receipt_id);
    assert.equal((await fresh.rpc(br, 'runner_messages_received', { receipts: [cap] })).ok, true);
    assert.equal((await fresh.rpc(br, 'board_ack_message', cap)).ok, true);
    assert.equal((await fresh.rpc(br, 'board_list_messages')).result.inbox.length, 0);
  } finally { if (restarted) await restarted.close(); else await h.close(); rmSync(h.dataDir, { recursive: true, force: true }); }
});

for (const loss of ['enrollment', 'fence', 'role', 'archive']) test(`queued message validates the exact recipient after ${loss} loss`, async (t) => {
  const x = await communicationRig(t), { h, A, sender: a, recipient: b } = x; let release; t.after(() => release?.());
  const held = h.hub.withBoard(A.board, () => new Promise((resolve) => release = resolve)); await new Promise((resolve) => setImmediate(resolve));
  const original = h.hub.withBoard.bind(h.hub); let queued = false; h.hub.withBoard = (id, fn) => { if (id === A.board) queued = true; return original(id, fn); };
  const pending = a.client.rpc(a.run, 'board_send_message', taskMessage(b)); await until(() => queued);
  if (loss === 'enrollment') h.db.run('UPDATE runner_enrollments SET revoked_at = ? WHERE id = ?', h.hub.iso(), b.enrollment);
  if (loss === 'fence') h.db.run('UPDATE cards SET fence = fence + 1 WHERE id = ?', b.run.card_id);
  if (loss === 'role') h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", b.connection().member_id);
  if (loss === 'archive') h.db.run('UPDATE cards SET archived_at = ? WHERE id = ?', h.hub.iso(), b.run.card_id);
  release(); await held; assert.equal((await pending).ok, false);
  assert.equal(h.db.get('SELECT COUNT(*) n FROM task_messages').n, 0); assert.equal(h.db.get('SELECT COUNT(*) n FROM comments WHERE card_id = ?', a.run.card_id).n, 0);
});

for (const operation of ['read', 'retry']) test(`queued staff message ${operation} rechecks revoked credentials instead of replaying a response`, async (t) => {
  const x = await communicationRig(t), { h, A, sender: a, recipient: b } = x; let release; t.after(() => release?.());
  const path = `/api/cards/${a.run.card_id}/messages`, request = { ...taskMessage(b), expected_fence: a.run.fence };
  assert.equal((await x.as(a.user, 'POST', path, request)).status, 200);
  const before = JSON.stringify(h.db.all('SELECT * FROM task_messages'));
  const held = h.hub.withBoard(A.board, () => new Promise((resolve) => release = resolve)); await new Promise((resolve) => setImmediate(resolve));
  const original = h.hub.withBoard.bind(h.hub); let queued = false; h.hub.withBoard = (id, fn) => { if (id === A.board) queued = true; return original(id, fn); };
  const pending = x.as(a.user, operation === 'read' ? 'GET' : 'POST', path, operation === 'read' ? undefined : request); await until(() => queued);
  h.db.run('UPDATE user_devices SET revoked_at = ? WHERE id = ?', h.hub.iso(), a.user.device_id); release(); await held;
  assert.equal((await pending).status, 401); assert.equal(JSON.stringify(h.db.all('SELECT * FROM task_messages')), before);
});

for (const operation of ['send', 'list', 'receive', 'ack']) for (const loss of ['enrollment', 'replacement', 'member', 'fence']) {
  test(`queued task message ${operation} fails closed after ${loss} loss`, async (t) => {
    const x = await communicationRig(t), { h, A, sender: a, recipient: b } = x; let release;
    t.after(() => release?.());
    const record = await a.client.rpc(a.run, 'board_send_message', taskMessage(b)); assert.equal(record.ok, true);
    const cap = receiptOf((await b.client.rpc(b.run, 'board_list_messages')).result.inbox[0]);
    if (operation === 'ack') assert.equal((await b.client.rpc(b.run, 'runner_messages_received', { receipts: [cap] })).ok, true);
    const who = operation === 'send' ? a : b;
    const before = JSON.stringify({ messages: h.db.all('SELECT * FROM task_messages'), receipts: h.db.all('SELECT * FROM task_message_receipts'), comments: h.db.all('SELECT * FROM comments'), journal: h.db.all('SELECT * FROM journal WHERE kind IN (\'message.create\',\'message.receipt\')') });
    const held = h.hub.withBoard(A.board, () => new Promise((resolve) => release = resolve)); await new Promise((resolve) => setImmediate(resolve));
    const original = h.hub.withBoard.bind(h.hub); let queued = false, queuedWork; h.hub.withBoard = (id, fn) => { const p = original(id, fn); if (id === A.board && !queuedWork) { queued = true; queuedWork = p; } return p; };
    const method = { send: 'board_send_message', list: 'board_list_messages', receive: 'runner_messages_received', ack: 'board_ack_message' }[operation];
    const args = operation === 'send' ? taskMessage(b) : operation === 'list' ? {} : operation === 'receive' ? { receipts: [cap] } : cap;
    let pending;
    if (loss === 'replacement') who.client.send({ type: 'rpc', id: 'queued-replace', method, ...runMsg(who.run), run_token: who.run.run_token, params: args });
    else pending = who.client.rpc(who.run, method, args).catch((error) => error);
    await until(() => queued);
    if (loss === 'enrollment') h.db.run('UPDATE runner_enrollments SET revoked_at = ? WHERE id = ?', h.hub.iso(), who.enrollment);
    if (loss === 'member') h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", who.connection().member_id);
    if (loss === 'fence') h.db.run('UPDATE cards SET fence = fence + 1 WHERE id = ?', who.run.card_id);
    let replacement;
    if (loss === 'replacement') replacement = who.open();
    // Replacement hello itself enters no board queue when it advertises no
    // resumable runs, and closes the old authenticated socket immediately.
    if (replacement) await replacement;
    release(); await held;
    const outcome = await queuedWork.then((value) => ({ value }), (error) => ({ error }));
    assert.ok(outcome.error, 'the actual queued RPC must reject before any effect'); assert.ok(['FORBIDDEN', 'FENCED'].includes(outcome.error.code));
    if (pending) { const response = await pending; assert.equal(response.ok, false, JSON.stringify(response)); }
    else { assert.equal(await who.client.closed(), 4409); assert.equal(who.client.all('rpc.result', (m) => m.re === 'queued-replace').length, 0); }
    const after = JSON.stringify({ messages: h.db.all('SELECT * FROM task_messages'), receipts: h.db.all('SELECT * FROM task_message_receipts'), comments: h.db.all('SELECT * FROM comments'), journal: h.db.all('SELECT * FROM journal WHERE kind IN (\'message.create\',\'message.receipt\')') });
    assert.equal(after, before); assert.equal(h.hub.device(who.client.welcome.device_id).revoked_at, null);
  });
}
