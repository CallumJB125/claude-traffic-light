import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { communicationRig } from './communication-helpers.js';
import { grant, business } from './remote-helpers.js';
import { RemoteActions } from '../remote/actions.js';

async function rig(t) {
  const f = await communicationRig(t);
  f.h.hub.config.publicUrl = f.h.base;
  f.authority = f.h.hub.remoteAuthority; f.actions = new RemoteActions(f.h.hub);
  return { f, g: await grant(f), id: f.sender.run.card_id };
}
function request(f, id, artifacts = []) {
  return { card_id: id, request_id: randomUUID(), expected_version: 0, expected_fence: f.h.hub.card(id).fence,
    data: { brief: 'Current repository only', decisions: [], progress: '', nextAction: '', artifacts, reportedChecks: [] } };
}
function repository(f) {
  const repo = randomUUID();
  f.db.insert('repos', { id: repo, org_id: f.A.team, canonical_url: `github.com/provenance/${repo}`, short_name: 'current' });
  f.db.run('INSERT INTO board_repos(board_id,repo_id) VALUES(?,?)', f.A.board, repo);
  return repo;
}
const move = (f, id) => f.db.run('UPDATE cards SET repo_id=? WHERE id=?', repository(f), id);
async function attach(f) {
  const result = await f.sender.client.rpc(f.sender.run, 'board_attach_evidence', { kind: 'log',
    ref: 'https://current-repo.test/observed', summary: 'Current repository evidence' });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.result.evidence_id;
}
const unavailable = e => ['VALIDATION', 'NOT_FOUND', 'FORBIDDEN'].includes(e.code);

test('current run and evidence remain visible on write/read/replay with identical sealed data and hash', async t => {
  const { f, g, id } = await rig(t), evidence = await attach(f), args = request(f, id, [{ kind: 'evidence', id: evidence }]);
  const first = await f.actions.call(g.token, 'integration', 'plexiform_write_packet', args);
  const stored = f.db.get('SELECT * FROM task_packets WHERE id=?', first.packet.id);
  const views = [first, await f.actions.call(g.token, 'integration', 'plexiform_write_packet', args),
    await f.actions.call(g.token, 'integration', 'plexiform_read_packet', { card_id: id })];
  for (const { packet } of views) {
    assert.equal(packet.observed.active_run_id, f.sender.run.run_id);
    assert.equal(packet.evidence[0].id, evidence); assert.equal(packet.evidence[0].summary, 'Current repository evidence');
    assert.equal(packet.content_hash, stored.content_hash); assert.deepEqual(packet.data, JSON.parse(stored.data));
  }
  assert.deepEqual(f.db.get('SELECT * FROM task_packets WHERE id=?', first.packet.id), stored);
});

test('new-repository packets omit the former active run and retain exact packet bytes across read/replay', async t => {
  const { f, g, id } = await rig(t); move(f, id);
  const args = request(f, id), first = await f.actions.call(g.token, 'integration', 'plexiform_write_packet', args);
  const stored = f.db.get('SELECT * FROM task_packets WHERE id=?', first.packet.id);
  for (const { packet } of [first, await f.actions.call(g.token, 'integration', 'plexiform_write_packet', args),
    await f.actions.call(g.token, 'integration', 'plexiform_read_packet', { card_id: id })]) {
    assert.equal(packet.observed.active_run_id, null); assert.equal(JSON.stringify(packet).includes(f.sender.run.run_id), false);
    assert.equal(packet.content_hash, stored.content_hash); assert.deepEqual(packet.data, JSON.parse(stored.data));
  }
  assert.deepEqual(f.db.get('SELECT * FROM task_packets WHERE id=?', first.packet.id), stored);
});

test('new-repository evidence from the former run fails before packet, journal or receipt mutation', async t => {
  const { f, g, id } = await rig(t), evidence = await attach(f); move(f, id);
  const before = business(f);
  await assert.rejects(f.actions.call(g.token, 'integration', 'plexiform_write_packet', request(f, id, [{ kind: 'evidence', id: evidence }])), unavailable);
  assert.equal(business(f), before);
});

for (const dimension of ['foreign-card-run', 'unbound-run']) test(`same-card evidence with ${dimension} cannot assert current repository provenance`, async t => {
  const { f, g, id } = await rig(t), evidence = randomUUID();
  f.db.insert('evidence', { id: evidence, card_id: id, run_id: dimension === 'foreign-card-run' ? f.recipient.run.run_id : null,
    kind: 'log', ref: 'https://invalid-provenance.test/PRIVATE', summary: 'PRIVATE-UNBOUND-PROVENANCE', verification: 'self_reported', created_at: f.h.hub.iso() });
  const before = business(f);
  await assert.rejects(f.actions.call(g.token, 'integration', 'plexiform_write_packet', request(f, id, [{ kind: 'evidence', id: evidence }])), unavailable);
  assert.equal(business(f), before);
});

test('stale evidence provenance invalidates sealed read/replay without rewriting bytes or durable receipts', async t => {
  const { f, g, id } = await rig(t), evidence = await attach(f), args = request(f, id, [{ kind: 'evidence', id: evidence }]);
  const first = await f.actions.call(g.token, 'integration', 'plexiform_write_packet', args), stored = f.db.get('SELECT * FROM task_packets WHERE id=?', first.packet.id);
  f.db.run('UPDATE runs SET repo_id=? WHERE id=?', repository(f), f.sender.run.run_id);
  const before = business(f);
  await assert.rejects(f.actions.call(g.token, 'integration', 'plexiform_read_packet', { card_id: id }), unavailable);
  await assert.rejects(f.actions.call(g.token, 'integration', 'plexiform_write_packet', args), unavailable);
  assert.equal(business(f), before); assert.deepEqual(f.db.get('SELECT * FROM task_packets WHERE id=?', first.packet.id), stored);
});

test('sealed runner packet author provenance is rechecked against its current run on remote reads', async t => {
  const { f, g, id } = await rig(t), args = request(f, id), { card_id, expected_fence, ...body } = args;
  const first = await f.sender.client.rpc(f.sender.run, 'board_write_packet', body); assert.equal(first.ok, true, JSON.stringify(first.error));
  const stored = f.db.get('SELECT * FROM task_packets WHERE id=?', first.result.packet.id);
  assert.equal((await f.actions.call(g.token, 'integration', 'plexiform_read_packet', { card_id: id })).packet.author.run_id, f.sender.run.run_id);
  f.db.run('UPDATE runs SET repo_id=? WHERE id=?', repository(f), f.sender.run.run_id);
  await assert.rejects(f.actions.call(g.token, 'integration', 'plexiform_read_packet', { card_id: id }), unavailable);
  assert.deepEqual(f.db.get('SELECT * FROM task_packets WHERE id=?', first.result.packet.id), stored);
});

for (const dimension of ['fence-changed', 'ended']) test(`packet observations omit an ${dimension} active-run pointer`, async t => {
  const { f, g, id } = await rig(t), args = request(f, id);
  if (dimension === 'fence-changed') f.db.run('UPDATE runs SET fence=fence+1 WHERE id=?', f.sender.run.run_id);
  else f.db.run('UPDATE runs SET ended_at=? WHERE id=?', f.h.hub.iso(), f.sender.run.run_id);
  const first = await f.actions.call(g.token, 'integration', 'plexiform_write_packet', args);
  for (const { packet } of [first, await f.actions.call(g.token, 'integration', 'plexiform_write_packet', args),
    await f.actions.call(g.token, 'integration', 'plexiform_read_packet', { card_id: id })]) {
    assert.equal(packet.observed.active_run_id, null);
  }
});
