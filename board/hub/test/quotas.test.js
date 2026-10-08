// Actual account HTTP/SQLite and enrolled protocol clients; no AI executable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tenancy } from './tenancy/fixture.js';
import { communicationRig, taskMessage } from './communication-helpers.js';
import { runMsg, startHub } from './helpers.js';

const cards = (f, team) => f.db.get('SELECT COUNT(*) n FROM cards c JOIN boards b ON b.id=c.board_id WHERE b.org_id=?', team.team).n;
const comments = (f, team) => f.db.get('SELECT COUNT(*) n FROM comments c JOIN cards t ON t.id=c.card_id JOIN boards b ON b.id=t.board_id WHERE b.org_id=?', team.team).n;
function fillCards(f, team, total) {
  const now = f.h.hub.iso(), tag = randomUUID();
  f.db.tx(() => {
    for (let n = cards(f, team); n < total; n++) f.db.insert('cards', {
      id: `${tag}:${n}`, board_id: team.board, key: `QUOTA-${tag}-${n}`, title: 'Synthetic retained card',
      created_by: team.owner, created_at: now, updated_at: now, state_since: now,
      archived_at: n % 2 ? now : null, archived_by: n % 2 ? team.owner : null,
    });
  });
  assert.equal(cards(f, team), total);
}
function fillComments(f, team, total) {
  const now = f.h.hub.iso(), tag = randomUUID();
  const archived = f.db.get('SELECT c.id FROM cards c JOIN boards b ON b.id=c.board_id WHERE b.org_id=? AND c.archived_at IS NOT NULL LIMIT 1', team.team)?.id;
  f.db.tx(() => {
    for (let n = comments(f, team); n < total; n++) f.db.insert('comments', {
      id: `${tag}:${n}`, card_id: n % 2 && archived ? archived : team.card, author_member_id: team.owner,
      source: n % 2 ? 'integration' : 'web', trusted: n % 2 ? 0 : 1, body: 'Synthetic retained comment', created_at: now,
    });
  });
  assert.equal(comments(f, team), total);
}
async function rig(t) { const f = await tenancy(); t.after(() => f.h.close()); return f; }
const counts = f => JSON.stringify(['cards', 'journal', 'workflow_instances', 'workflow_step_cards', 'work_capture_cards', 'client_feedback', 'task_message_threads', 'task_messages', 'task_message_recipients', 'task_message_receipts'].map(table => [table, f.db.get(`SELECT COUNT(*) n FROM ${table}`).n]));

test('card cap spans boards and archived cards; concurrent writers cannot consume the last slot twice or affect another team', async t => {
  const f = await rig(t), second = await f.as(f.users.ua, 'POST', `/api/teams/${f.A.team}/boards`, { name: 'Second quota board' });
  assert.equal(second.status, 200, second.text);
  fillCards(f, f.A, 4999); const other = f.snapshotB();
  const before = f.db.all('SELECT id,next_key FROM boards WHERE org_id=? ORDER BY id', f.A.team);
  const results = await Promise.all([f.A.board, second.body.board.id].map(board => f.as(f.users.ua, 'POST', `/api/boards/${board}/cards`, { request_id: randomUUID(), title: 'Last team slot' })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 403]);
  const failure = results.find(r => r.status === 403).body.error;
  assert.equal(failure.code, 'QUOTA_EXCEEDED'); assert.equal(failure.resource, 'cards'); assert.equal(failure.limit, 5000);
  assert.equal(cards(f, f.A), 5000); assert.equal(f.snapshotB(), other);
  const after = f.db.all('SELECT id,next_key FROM boards WHERE org_id=? ORDER BY id', f.A.team);
  assert.equal(after.reduce((n, row, i) => n + row.next_key - before[i].next_key, 0), 1);
});

test('observed capture cannot bypass card cap; updating its existing card at cap remains truthful and does not create a receipt', async t => {
  const f = await rig(t), path = `/api/boards/${f.A.board}/work-capture`;
  const data = { install_id: randomUUID(), provider: 'codex', session_id: 'quota-observation', task_id: 'one', repo_id: f.A.repo, title: 'Observed work', status: 'working' };
  const first = await f.as(f.users.amember, 'POST', path, data); assert.equal(first.status, 200, first.text);
  fillCards(f, f.A, 5000); const before = counts(f), key = f.h.hub.board(f.A.board).next_key;
  const blocked = await f.as(f.users.amember, 'POST', path, { ...data, task_id: 'two' }); assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, 'QUOTA_EXCEEDED');
  assert.equal(counts(f), before); assert.equal(f.h.hub.board(f.A.board).next_key, key);
  const update = await f.as(f.users.amember, 'POST', path, { ...data, status: 'waiting' }); assert.equal(update.status, 200, update.text);
  assert.equal(update.body.card.id, first.body.card.id); assert.equal(update.body.capture.reported_status, 'waiting'); assert.equal(cards(f, f.A), 5000);
});

test('multi-card workflow rolls back all keys/cards/provenance when the team has only one free slot', async t => {
  const f = await rig(t);
  const definition = { name: 'Bounded quota workflow', description: '', steps: [{ title: 'First', body: '', acceptance: '', plan_approval: true }, { title: 'Second', body: '', acceptance: '', plan_approval: true }] };
  const created = await f.as(f.users.ua, 'POST', '/api/workflows', { request_id: randomUUID(), definition }); assert.equal(created.status, 200, created.text);
  fillCards(f, f.A, 4999); const before = counts(f), key = f.h.hub.board(f.A.board).next_key, workflow = created.body.workflow;
  const response = await f.as(f.users.ua, 'POST', `/api/boards/${f.A.board}/workflows/${workflow.id}/apply`, { request_id: randomUUID(), version: workflow.version, content_hash: workflow.content_hash });
  assert.equal(response.status, 403); assert.equal(response.body.error.code, 'QUOTA_EXCEEDED');
  assert.equal(counts(f), before); assert.equal(f.h.hub.board(f.A.board).next_key, key); assert.equal(cards(f, f.A), 4999);
});

test('delegated client feedback refuses at the destination cap before card/key/feedback provenance commits', async t => {
  const f = await rig(t);
  f.db.run('UPDATE client_grants SET scopes=? WHERE guest_id=? AND project_id=?', JSON.stringify(['status.read', 'feedback.create']), f.B.clientGuest, f.B.clientProject);
  fillCards(f, f.B, 5000); const before = counts(f), key = f.h.hub.board(f.B.board).next_key;
  const response = await f.as(f.users.bguest, 'POST', `/api/client/items/${f.B.clientItem}/feedback`, { request_id: randomUUID(), message: 'Please review this client observation.' });
  assert.equal(response.status, 403); assert.equal(response.body.error.code, 'QUOTA_EXCEEDED');
  assert.equal(counts(f), before); assert.equal(f.h.hub.board(f.B.board).next_key, key);
});

test('comment cap counts every author and concurrent accepted comments consume one slot; another team stays unchanged', async t => {
  const f = await rig(t); fillCards(f, f.A, 2); fillComments(f, f.A, 49999); const other = f.snapshotB();
  const responses = await Promise.all([f.users.ua, f.users.amember].map(user => f.as(user, 'POST', `/api/cards/${f.A.card}/comments`, { request_id: randomUUID(), body: 'One final human comment' })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 403]); assert.equal(comments(f, f.A), 50000);
  const error = responses.find(r => r.status === 403).body.error; assert.equal(error.resource, 'comments'); assert.equal(error.limit, 50000);
  assert.equal(f.snapshotB(), other);
});

test('coordination cannot bypass comment cap or leave partial threads; current replay and existing-run outbox outcomes remain accepted', async t => {
  const f = await communicationRig(t), request = taskMessage(f.recipient);
  const original = await f.sender.client.rpc(f.sender.run, 'board_send_message', request); assert.equal(original.ok, true, JSON.stringify(original.error));
  fillComments(f, f.A, 50000); const before = counts(f);
  const replay = await f.sender.client.rpc(f.sender.run, 'board_send_message', request); assert.equal(replay.ok, true); assert.equal(replay.result.message.id, original.result.message.id);
  const denied = await f.sender.client.rpc(f.sender.run, 'board_send_message', taskMessage(f.recipient)); assert.equal(denied.ok, false, JSON.stringify(denied)); assert.equal(denied.error.code, 'QUOTA_EXCEEDED'); assert.equal(counts(f), before);
  const packet = await f.sender.client.rpc(f.sender.run, 'board_write_packet', { request_id: randomUUID(), expected_version: 0, data: { brief: 'Retain current bounded context', decisions: [], progress: 'Working', nextAction: 'Review', artifacts: [], reportedChecks: [] } }); assert.equal(packet.ok, true, JSON.stringify(packet.error));
  const human = await f.as(f.users.ua, 'POST', `/api/cards/${f.sender.run.card_id}/comments`, { request_id: randomUUID(), body: 'Over cap' }); assert.equal(human.status, 403);
  await f.sender.client.out({ ...runMsg(f.sender.run), kind: 'comment.create', text: 'Observed outcome from an already running attempt' });
  assert.equal(comments(f, f.A), 50001); assert.equal(f.db.get('SELECT COUNT(*) n FROM comments WHERE author_run_id=? AND body=?', f.sender.run.run_id, 'Observed outcome from an already running attempt').n, 1);
});

test('authenticated runner child creation uses the same cap and preserves ordinary run/parent/repo provenance', async t => {
  const f = await communicationRig(t); fillCards(f, f.A, 4999);
  const accepted = await f.sender.client.rpc(f.sender.run, 'board_create_card', { title: 'Scoped child', body: 'Follow up', acceptance: 'Check the change' }); assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
  const child = f.h.hub.card(accepted.result.card_id), parent = f.h.hub.card(f.sender.run.card_id);
  assert.equal(child.parent_card_id, parent.id); assert.equal(child.created_by_run_id, f.sender.run.run_id); assert.equal(child.repo_id, parent.repo_id);
  assert.equal(child.created_by, f.A.member); assert.equal(child.active_run_id, null); assert.equal(child.column_name, 'todo'); assert.equal(child.budget_cents, null);
  const before = counts(f), key = f.h.hub.board(f.A.board).next_key;
  const blocked = await f.sender.client.rpc(f.sender.run, 'board_create_card', { title: 'Blocked scoped child' }); assert.equal(blocked.error.code, 'QUOTA_EXCEEDED');
  assert.equal(counts(f), before); assert.equal(f.h.hub.board(f.A.board).next_key, key); assert.equal(cards(f, f.A), 5000);
});

test('actual pro and self-hosted plan boundaries do not inherit the free cap; nonaccounts local ownership remains uncapped', async t => {
  const f = await rig(t); fillCards(f, f.A, 5000); f.db.run("UPDATE orgs SET plan='pro' WHERE id=?", f.A.team);
  const path = `/api/boards/${f.A.board}/cards`, create = () => f.as(f.users.ua, 'POST', path, { request_id: randomUUID(), title: 'Plan boundary' });
  assert.equal((await create()).status, 200); fillCards(f, f.A, 50000); assert.equal((await create()).status, 403);
  f.db.run("UPDATE orgs SET plan='self_hosted' WHERE id=?", f.A.team); assert.equal((await create()).status, 200); assert.equal(cards(f, f.A), 50001);
  const h = await startHub(); t.after(() => h.close()); const local = { h, db: h.db }, team = { team: h.hub.board(h.ids.board).org_id, board: h.ids.board, owner: h.ids.alice };
  fillCards(local, team, 5000); const cookie = await h.login('alice'); assert.equal((await h.api(cookie, 'POST', `/api/boards/${h.ids.board}/cards`, { request_id: randomUUID(), title: 'Local cap exempt' })).status, 200);
});
