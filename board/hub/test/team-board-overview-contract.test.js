import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { communicationRig, receiptOf, taskMessage } from './communication-helpers.js';
import { TTL_MS } from '../../shared/liveness.js';

const require = createRequire(import.meta.url);
const { createTeamHubClient } = require('../../../src/team-hub-client.js');
const { createOverviewService } = require('../../../src/overview-service.js');

function stack(x, user = x.users.amember) {
  const requests = [];
  const client = createTeamHubClient({ baseUrl: x.h.base, token: () => user.token, viewerId: user.id, boardDirectory: true,
    fetch: (url, options) => { requests.push({ path: new URL(url).pathname, method: options.method }); return fetch(url, options); } }, { now: () => x.h.clock.wall() });
  const view = createOverviewService({ now: () => x.h.clock.wall(), teamHub: () => client,
    work: async () => ({ sources: [], capture: [] }), owned: () => [],
    hubTeams: async () => ({ origin: x.h.base, teams: [{ id: x.A.team, name: 'Alpha' }] }) });
  return { client, view, requests, read: team => view.directory({ view: 'team', team: team ?? null }) };
}

test('LOCAL TEAM BOARD PROOF: real client and Overview discover own/uninvolved peers and preserve exact inbox receipt and linked reply stages', async t => {
  const x = await communicationRig(t), { view, read, requests } = stack(x), b = x.recipient;
  assert.ok(!(await x.as(x.users.amember, 'GET', '/api/my-day')).body.agents.some(r => r.card_id === b.run.card_id));
  let rows = await read(); assert.equal(rows.status, 'complete'); assert.equal(rows.entries.length, 2);
  assert.equal(rows.entries.filter(e => e.owner.self).length, 1, 'own run appears once');
  const peer = rows.entries.find(e => !e.owner.self); assert.ok(peer);
  assert.equal(peer.owner.name, 'admin'); assert.equal(peer.messageContract, 'task-inbox');
  assert.match(peer.notice, /Queued does not mean received or acknowledged/);
  assert.equal(peer.capabilities.receive.available, true); assert.equal(peer.capabilities.steer.available, false);
  assert.equal(peer.task.source, 'board'); assert.equal(peer.children.length, 0, 'no invented provider child telemetry');
  assert.ok(requests.some(r => r.path === '/api/account')); assert.ok(requests.some(r => r.path === '/api/team-session-directory'));
  const wire = JSON.stringify(rows);
  for (const raw of [b.run.run_id, b.run.card_id, x.users.amember.id, b.user.id, x.A.member, x.A.admin, x.A.repo, x.users.amember.token, 'board-run:']) assert.ok(!wire.includes(raw), raw);
  const exactText = 'Actual selected teammate inbox message';
  assert.deepEqual(await view.teamMessage({ id: peer.id, text: exactText }), { ok: true, status: 'queued', error: '' });
  assert.equal(x.h.db.get("SELECT COUNT(*) n FROM journal WHERE kind = 'message.create'").n, 1);
  const inbox = (await b.client.rpc(b.run, 'board_list_messages')).result.inbox;
  const message = inbox.find(m => m.body === exactText); assert.ok(message); assert.equal(message.card_id, b.run.card_id);
  assert.equal(message.author.account_id, x.users.amember.id); assert.equal(message.author.member_id, x.A.member);
  assert.equal(message.deliveries[0].recipient_run_id, b.run.run_id);
  rows = await read(rows.team.key);
  let delivery = rows.entries.find(e => e.id === peer.id).deliveries.find(d => d.text === exactText);
  assert.equal(delivery.state, 'queued', 'agent list alone is not host receipt');
  const receipt = receiptOf(message);
  assert.equal((await b.client.rpc(b.run, 'runner_messages_received', { receipts: [receipt] })).ok, true);
  rows = await read(rows.team.key); delivery = rows.entries.find(e => e.id === peer.id).deliveries.find(d => d.text === exactText);
  assert.equal(delivery.state, 'recorded', 'transport receipt is distinct from agent acknowledgement');
  assert.equal((await b.client.rpc(b.run, 'board_ack_message', receipt)).ok, true);
  rows = await read(rows.team.key); delivery = rows.entries.find(e => e.id === peer.id).deliveries.find(d => d.text === exactText);
  assert.equal(delivery.state, 'acknowledged'); assert.equal(delivery.response, '');
  const replyText = 'Correlated actual target response';
  assert.equal((await b.client.rpc(b.run, 'board_send_message', taskMessage(x.sender, { body: replyText, reply_to: message.id, thread_id: message.thread_id }))).ok, true);
  rows = await read(rows.team.key); delivery = rows.entries.find(e => e.id === peer.id).deliveries.find(d => d.text === exactText);
  assert.equal(delivery.state, 'replied'); assert.equal(delivery.response, replyText);
  const finalWire = JSON.stringify(rows);
  for (const raw of [message.id, message.request_id, message.thread_id, receipt.receipt_id, receipt.receipt_token, b.run.run_id, b.run.card_id, x.A.repo]) assert.ok(!finalWire.includes(raw), raw);
});

test('actual client/Overview cached teammate target refuses role, membership, device, heartbeat, fence, repository and ended-run changes without journaling', async t => {
  const x = await communicationRig(t), { view, client, read } = stack(x), b = x.recipient, db = x.h.db;
  const rows = await read(), peer = rows.entries.find(e => !e.owner.self), team = rows.team.key;
  const cached = (await client.sessions(client.viewer(), x.A.team)).find(e => !e.owner.self);
  assert.ok(peer && cached); assert.equal(peer.capabilities.receive.available, true);
  const refused = async label => {
    const before = db.get('SELECT COUNT(*) n FROM task_messages').n;
    assert.equal((await view.teamMessage({ id: peer.id, text: label })).ok, false, label + ' main cached handle');
    assert.equal((await client.send(client.viewer(), x.A.team, cached.ref, label, randomUUID())).ok, false, label + ' client cached route');
    assert.equal(db.get('SELECT COUNT(*) n FROM task_messages').n, before, label + ' has no durable side effect');
  };
  const restored = async () => { const r = await read(team); assert.equal(r.entries.find(e => e.id === peer.id)?.capabilities.receive.available, true, 'fresh target is writable before the next isolated change'); };
  db.run("UPDATE members SET role = 'viewer' WHERE id = ?", x.A.member);
  await refused('viewer downgrade');
  const viewerRows = await read(team); assert.ok(viewerRows.entries.some(e => e.id === peer.id)); assert.ok(viewerRows.entries.every(e => !e.capabilities.receive.available));
  db.run("UPDATE members SET role = 'member' WHERE id = ?", x.A.member); await restored();
  db.run('UPDATE members SET removed_at = ? WHERE id = ?', x.h.hub.iso(), x.A.member); await refused('removed membership');
  db.run('UPDATE members SET removed_at = NULL WHERE id = ?', x.A.member); await restored();
  db.run('UPDATE devices SET revoked_at = ? WHERE id = ?', x.h.hub.iso(), b.client.welcome.device_id); await refused('revoked recipient device');
  db.run('UPDATE devices SET revoked_at = NULL WHERE id = ?', b.client.welcome.device_id); await restored();
  const lease = x.h.hub.lease(b.run.run_id), heartbeat = lease.hb_mono;
  lease.hb_mono = x.h.hub.mono() - TTL_MS - 10; await refused('expired heartbeat'); lease.hb_mono = heartbeat; await restored();
  const repo = randomUUID(); db.insert('repos', { id: repo, org_id: x.A.team, canonical_url: 'github.com/alpha/other', short_name: 'other' });
  db.run('INSERT INTO board_repos VALUES (?, ?)', x.A.board, repo); b.connection().repos.set(repo, {});
  db.run('UPDATE runs SET repo_id = ? WHERE id = ?', repo, b.run.run_id); db.run('UPDATE cards SET repo_id = ? WHERE id = ?', repo, b.run.card_id);
  await refused('changed repository');
  db.run('UPDATE runs SET repo_id = ? WHERE id = ?', x.A.repo, b.run.run_id); db.run('UPDATE cards SET repo_id = ? WHERE id = ?', x.A.repo, b.run.card_id); await restored();
  db.run('UPDATE runs SET ended_at = ? WHERE id = ?', x.h.hub.iso(), b.run.run_id); await refused('ended run');
  db.run('UPDATE runs SET ended_at = NULL WHERE id = ?', b.run.run_id); await restored();
  db.run('UPDATE runs SET fence = fence + 1 WHERE id = ?', b.run.run_id); db.run('UPDATE cards SET fence = fence + 1 WHERE id = ?', b.run.card_id);
  await refused('replaced ownership fence');
});
