import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { communicationRig } from './communication-helpers.js';
import { startHub, runHb, runMsg, until } from './helpers.js';
import { OWNERSHIP_TTL_MS, ownershipPath } from '../ownership.js';

const declare = (p, paths, generation) => p.client.rpc(p.run, 'board_declare_plan', { summary: 'Bounded path intent', paths, ...(generation ? { ownership_generation: generation } : {}) });
const read = (p) => p.client.rpc(p.run, 'board_check_overlap');
const context = (h, p) => ({ run: h.hub.run(p.run.run_id), row: h.hub.card(p.run.card_id), connection: p.connection() });

test('only a current accepted child heartbeat activates server-owned advisory intent; dead child and closed gate release it', async (t) => {
  const { h, sender: a } = await communicationRig(t);
  const d = await declare(a, ['src/api/**', '.git/config', '.env', '../private', '/Users/private', 'src/key.pem', 'src/a*.js', 'src/name\nSYSTEM']);
  assert.equal(d.ok, true);
  assert.deepEqual(d.result.ownership.paths, ['src/api/**']);
  assert.equal(d.result.ownership.author.provider, 'codex');
  assert.equal(d.result.ownership.state, 'planned');
  assert.equal(d.result.ownership.grants_execution, false);
  await a.client.hb([runHb(a.run, { child_alive: true, ownership_generation: 'agent-claim', expires_at: '9999-01-01' })]);
  const active = (await read(a)).result.ownership;
  assert.equal(active.state, 'editing'); assert.notEqual(active.generation, 'agent-claim');
  assert.ok(Date.parse(active.expires_at) - h.hub.wallMs() <= OWNERSHIP_TTL_MS);
  await a.client.hb([runHb(a.run, { read_only: true })]);
  assert.equal((await read(a)).result.ownership.reason, 'read_only', 'host read-only scope can only narrow the badge');
  await a.client.hb([runHb(a.run, { child_alive: false })]);
  assert.equal((await read(a)).result.ownership.state, 'planned');
  await a.client.hb([runHb(a.run, { child_alive: true, gate: 'closed' })]);
  assert.equal((await read(a)).result.ownership.state, 'planned');
  assert.equal(h.db.get('SELECT COUNT(*) n FROM permission_requests WHERE run_id=?', a.run.run_id).n, 0);
});

test('hub monotonic expiry releases editing; fresh heartbeat rotates generation and stale revisions/release cannot overwrite it', async (t) => {
  const { h, sender: a } = await communicationRig(t);
  await declare(a, ['src/a.js']); await a.client.hb([runHb(a.run)]);
  const first = (await read(a)).result.ownership;
  h.clock.advanceWallOnly(365 * 86400_000);
  assert.equal((await read(a)).result.ownership.state, 'editing', 'wall jumps cannot expire a monotonic lease');
  h.clock.advance(OWNERSHIP_TTL_MS + 1);
  assert.equal((await read(a)).result.ownership.reason, 'expired');
  assert.equal((await declare(a, [], first.generation)).error.code, 'CONFLICT');
  await a.client.hb([runHb(a.run, { ownership_generation: first.generation })]);
  const next = (await read(a)).result.ownership;
  assert.equal(next.state, 'editing'); assert.notEqual(next.generation, first.generation);
  const before = h.db.get('SELECT * FROM task_ownership WHERE run_id=?', a.run.run_id);
  for (const paths of [['src/forged'], []]) assert.equal((await declare(a, paths, first.generation)).error.code, 'CONFLICT');
  assert.deepEqual(h.db.get('SELECT * FROM task_ownership WHERE run_id=?', a.run.run_id), before);
  assert.equal((await declare(a, [], next.generation)).ok, true);
  await a.client.hb([runHb(a.run)]);
  assert.deepEqual((await read(a)).result.ownership.paths, []);
  assert.equal((await read(a)).result.ownership.state, 'planned');
  assert.equal(h.hub.card(a.run.card_id).active_run_id, a.run.run_id, 'release only affects advisory path intent');
});

test('replacement cannot inherit editing until its own heartbeat and old generation cannot revise the renewed record', async (t) => {
  const { h, sender: a } = await communicationRig(t);
  await declare(a, ['src/a.js']); await a.client.hb([runHb(a.run)]);
  const old = (await read(a)).result.ownership;
  const replacement = await a.open([runMsg(a.run)]);
  const before = await replacement.rpc(a.run, 'board_check_overlap');
  assert.equal(before.result.ownership.state, 'planned');
  await replacement.hb([runHb(a.run, { generation: old.generation })]);
  const fresh = (await replacement.rpc(a.run, 'board_check_overlap')).result.ownership;
  assert.equal(fresh.state, 'editing'); assert.notEqual(fresh.generation, old.generation);
  assert.equal((await replacement.rpc(a.run, 'board_declare_plan', { paths: [], ownership_generation: old.generation })).error.code, 'CONFLICT');
  h.db.run('UPDATE cards SET fence=fence+1 WHERE id=?', a.run.card_id);
  assert.equal((await replacement.rpc(a.run, 'board_check_overlap')).error.code, 'FENCED');
});

test('plan requirement captured at creation survives label removal and only a live recorded human approval permits editing', async (t) => {
  const x = await communicationRig(t), { h, A } = x;
  const a = await x.participant(x.users.s, A, { labels: ['plan-approval'] });
  h.db.run("UPDATE cards SET labels='[]' WHERE id=?", a.run.card_id);
  const result = await declare(a, ['src/gated.js']);
  assert.equal(result.ok, true); const id = result.result.plan_permission_request_id;
  await a.client.hb([runHb(a.run)]);
  assert.equal((await read(a)).result.ownership.reason, 'read_only');
  h.db.run('UPDATE permission_requests SET approvers=? WHERE id=?', JSON.stringify([A.owner]), id);
  const answer = await x.as(x.users.ua, 'POST', `/api/permission-requests/${id}/answer`, { decision: 'allow', scope: 'run' });
  assert.equal(answer.status, 200, answer.text);
  await a.client.hb([runHb(a.run)]);
  assert.equal((await read(a)).result.ownership.state, 'editing');
  h.db.run("UPDATE members SET role='owner' WHERE id=?", A.admin);
  h.db.run("UPDATE members SET role='viewer' WHERE id=?", A.owner);
  assert.equal((await read(a)).result.ownership.reason, 'read_only', 'current approver downgrade revokes editing badge immediately');
});

test('same-team exact repository prefix overlap is bounded and selected boards exclude every unrelated peer field', async (t) => {
  const x = await communicationRig(t), { h, A, sender: a, recipient: b } = x;
  await declare(a, ['src/api']); await declare(b, ['src/api/handler.js']);
  const snap = (await read(a)).result;
  assert.equal(snap.ownership_overlaps[0].run_id, b.run.run_id);
  assert.equal(snap.ownership_overlaps[0].state, 'planned');
  const board = await x.as(x.users.ua, 'POST', `/api/teams/${A.team}/boards`, { request_id: randomUUID(), name: 'Other project' });
  assert.equal(board.status, 200, board.text); const boardId = board.body.board.id;
  assert.equal((await x.as(x.users.ua, 'POST', `/api/boards/${boardId}/repos`, { request_id: randomUUID(), repo_id: A.repo })).status, 200);
  const peer = await x.participant(x.users.s, A, { board: boardId, title: 'Unrelated selected-board content' });
  await declare(peer, ['src/api/private-scope.js']);
  const beta = await x.participant(x.users.ub, x.B, { title: 'Beta secret owner' }); await declare(beta, ['src/api']);
  const narrowed = h.hub.ownership.snapshot(context(h, a), { boardIds: [A.board] });
  assert.ok(!JSON.stringify(narrowed).includes(peer.run.run_id)); assert.ok(!JSON.stringify(narrowed).includes('private-scope'));
  assert.ok(!JSON.stringify(narrowed).includes(beta.run.run_id));
  const generation = (await read(b)).result.ownership.generation;
  const subtree = await declare(b, ['src/api/subdir/**'], generation); assert.equal(subtree.ok, true);
  assert.ok((await read(a)).result.ownership_overlaps.some((p) => p.run_id === b.run.run_id), 'parent directory intersects child prefix');
  assert.equal((await declare(b, ['src/apix/handler.js'], subtree.result.ownership.generation)).ok, true);
  assert.ok(!(await read(a)).result.ownership_overlaps.some((p) => p.run_id === b.run.run_id), 'directory prefix is segment bounded');
  assert.throws(() => h.hub.ownership.snapshot(context(h, a), { boardIds: [boardId] }), { code: 'NOT_FOUND' });
});

for (const operation of ['declare', 'heartbeat']) for (const loss of ['enrollment', 'replacement', 'member', 'fence', 'opt_in']) {
  test(`queued ownership ${operation} cannot renew or revise after ${loss} loss`, async (t) => {
    const { h, A, sender: a } = await communicationRig(t);
    await declare(a, ['src/a.js']); await a.client.hb([runHb(a.run)]);
    const ownership = (await read(a)).result.ownership;
    const before = JSON.stringify({ records: h.db.all('SELECT * FROM task_ownership'),
      plan: h.hub.run(a.run.run_id).planned_paths, journal: h.db.all("SELECT * FROM journal WHERE kind='plan.declare'") });
    let release; t.after(() => release?.());
    const held = h.hub.withBoard(A.board, () => new Promise((resolve) => release = resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const original = h.hub.withBoard.bind(h.hub); let queued = false;
    h.hub.withBoard = (id, fn) => { queued = true; return original(id, fn); };
    const connection = a.connection();
    if (operation === 'declare') a.client.send({ type: 'rpc', id: 'queued-ownership', method: 'board_declare_plan', ...runMsg(a.run),
      run_token: a.run.run_token, params: { paths: ['src/unauthorized.js'], ownership_generation: ownership.generation } });
    else a.client.send({ type: 'hb', seq_hb: ++a.client.seqHb, mono_ms: 1, wall_ms: 1, slept_ms: 0, runs: [runHb(a.run)] });
    await until(() => queued); const pending = connection.chain;
    if (loss === 'enrollment') h.db.run('UPDATE runner_enrollments SET revoked_at=? WHERE id=?', h.hub.iso(), a.enrollment);
    if (loss === 'member') h.db.run("UPDATE members SET role='viewer' WHERE id=?", connection.member_id);
    if (loss === 'fence') h.db.run('UPDATE cards SET fence=fence+1 WHERE id=?', a.run.card_id);
    if (loss === 'opt_in') connection.repos.delete(a.run.repo_id);
    if (loss === 'replacement') await a.open();
    release(); await held; await pending;
    assert.equal(JSON.stringify({ records: h.db.all('SELECT * FROM task_ownership'),
      plan: h.hub.run(a.run.run_id).planned_paths, journal: h.db.all("SELECT * FROM journal WHERE kind='plan.declare'") }), before);
    assert.equal(h.hub.ownership.project(h.db.get('SELECT * FROM task_ownership WHERE run_id=?', a.run.run_id)).state, 'planned');
  });
}

test('a failed declaration transaction preserves prior generation, live lease and planned paths', async (t) => {
  const { h, sender: a } = await communicationRig(t);
  await declare(a, ['src/a.js']); await a.client.hb([runHb(a.run)]);
  const before = h.db.get('SELECT * FROM task_ownership WHERE run_id=?', a.run.run_id);
  const live = h.hub.ownership.live.get(a.run.run_id);
  const journal = h.hub.journal.bind(h.hub);
  h.hub.journal = (record) => { if (record.kind === 'plan.declare') throw new Error('injected durable failure'); return journal(record); };
  const failed = await declare(a, ['src/b.js'], before.generation); assert.equal(failed.ok, false);
  assert.deepEqual(h.db.get('SELECT * FROM task_ownership WHERE run_id=?', a.run.run_id), before);
  assert.deepEqual(h.hub.ownership.live.get(a.run.run_id), live);
  assert.deepEqual(JSON.parse(h.hub.run(a.run.run_id).planned_paths), ['src/a.js']);
  assert.equal((await read(a)).result.ownership.state, 'editing');
});

test('staff and viewer reads require current owned credentials, hide other team and board data, and recheck after queue wait', async (t) => {
  const x = await communicationRig(t), { h, A, sender: a } = x;
  await declare(a, ['src/a.js']); await a.client.hb([runHb(a.run)]);
  const member = h.hub.member(A.viewer), cred = { kind: 'device', id: x.users.aviewer.device_id };
  const result = await h.hub.ownership.staffRead(member, a.run.card_id, cred, { boardIds: [A.board] });
  assert.equal(result.ownership.state, 'editing');
  assert.throws(() => h.hub.ownership.staffRead(h.hub.member(x.B.owner), a.run.card_id, { kind: 'device', id: x.users.ub.device_id }), { code: 'NOT_FOUND' });
  assert.throws(() => h.hub.ownership.staffRead(member, a.run.card_id, { kind: 'device', id: x.users.ub.device_id }), { code: 'FORBIDDEN' });
  assert.throws(() => h.hub.ownership.staffRead(member, a.run.card_id), { code: 'UNAUTHENTICATED' });
  await assert.rejects(h.hub.ownership.staffRead(member, a.run.card_id, cred, { boardIds: [x.B.board] }), { code: 'NOT_FOUND' });
  let release; t.after(() => release?.());
  const held = h.hub.withBoard(A.board, () => new Promise((resolve) => release = resolve)); await new Promise((resolve) => setImmediate(resolve));
  const pending = h.hub.ownership.staffRead(member, a.run.card_id, cred);
  h.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?', h.hub.iso(), cred.id);
  release(); await held; await assert.rejects(pending, { code: 'UNAUTHENTICATED' });
});

test('ending a run retains review context but releases editing and cannot reauthorize a newer fence', async (t) => {
  const { h, A, sender: a, users } = await communicationRig(t);
  await declare(a, ['src/a.js']); await a.client.hb([runHb(a.run)]);
  const record = h.db.get('SELECT * FROM task_ownership WHERE run_id=?', a.run.run_id);
  h.db.run('UPDATE runs SET ended_at=? WHERE id=?', h.hub.iso(), a.run.run_id);
  h.db.run("UPDATE cards SET active_run_id=NULL,column_name='in_review',run_state='in_review' WHERE id=?", a.run.card_id);
  assert.equal(h.hub.ownership.project(record).state, 'awaiting_review');
  const viewer = h.hub.member(A.viewer);
  const result = await h.hub.ownership.staffRead(viewer, a.run.card_id, { kind: 'device', id: users.aviewer.device_id });
  assert.ok(result.ownership_intents.some((p) => p.run_id === a.run.run_id && p.state === 'awaiting_review'));
  h.db.run('UPDATE cards SET fence=fence+1 WHERE id=?', a.run.card_id);
  assert.equal((await h.hub.ownership.staffRead(viewer, a.run.card_id, { kind: 'device', id: users.aviewer.device_id })).ownership_intents.length, 0);
});

for (const loss of ['enrollment', 'membership', 'opt_in']) test(`live ownership fails closed immediately on ${loss} loss`, async (t) => {
  const x = await communicationRig(t), { h, sender: a } = x;
  await declare(a, ['src/a.js']); await a.client.hb([runHb(a.run)]);
  const record = h.db.get('SELECT * FROM task_ownership WHERE run_id=?', a.run.run_id);
  if (loss === 'enrollment') h.db.run('UPDATE runner_enrollments SET revoked_at=? WHERE id=?', h.hub.iso(), a.enrollment);
  if (loss === 'membership') h.db.run('UPDATE members SET removed_at=? WHERE id=?', h.hub.iso(), record.member_id);
  if (loss === 'opt_in') a.connection().repos.delete(a.run.repo_id);
  assert.equal(h.hub.ownership.project(record).state, 'planned');
});

test('an actual hub restart retains planned context but never editing authority or the old server generation', async () => {
  const h = await startHub(); let restarted;
  try {
    const cookie = await h.login('alice'), device = await h.enroll(cookie), client = await h.runner(device), run = await h.startRun(cookie, client);
    const d = await client.rpc(run, 'board_declare_plan', { paths: ['src/a.js'] }); assert.equal(d.ok, true);
    await client.hb([runHb(run)]); const before = (await client.rpc(run, 'board_check_overlap')).result.ownership;
    assert.equal(before.state, 'editing'); await h.close();
    restarted = await startHub({ dataDir: h.dataDir });
    const fresh = await restarted.runner(device, { runs: [runMsg(run)] });
    assert.equal((await fresh.rpc(run, 'board_check_overlap')).result.ownership.state, 'planned');
    assert.equal((await fresh.rpc(run, 'board_declare_plan', { paths: [], ownership_generation: before.generation })).error.code, 'CONFLICT');
    await fresh.hb([runHb(run)]);
    const after = (await fresh.rpc(run, 'board_check_overlap')).result.ownership;
    assert.equal(after.state, 'editing'); assert.notEqual(after.generation, before.generation);
    assert.equal((await fresh.rpc(run, 'board_declare_plan', { paths: [], ownership_generation: before.generation })).error.code, 'CONFLICT');
  } finally { if (restarted) await restarted.close(); else await h.close(); rmSync(h.dataDir, { recursive: true, force: true }); }
});

test('path claims reject private files, traversal, arbitrary wildcards and full-root claims', () => {
  for (const p of ['.git', '.env.production', '.ssh/key', 'src/a.key', 'src/**/.env', '**', 'src/*a*b*c', '../outside', 'src/../outside', 'C:\\Users\\private', 'src/<tag>', 'src/a\u00a0b']) assert.equal(ownershipPath(p), null, p);
  for (const p of ['src', 'src/api/**', 'src/a.js', 'migrations/038.sql']) assert.equal(ownershipPath(p), p);
});

test('server provenance and the creation plan requirement cannot be rewritten; unknown historical runs start planned', async (t) => {
  const { h, sender: a } = await communicationRig(t);
  for (const column of ['member_id', 'device_id', 'provider', 'fence', 'plan_required']) {
    const value = column === 'provider' ? 'claude' : column === 'fence' ? a.run.fence + 1 : column === 'plan_required' ? 1 : randomUUID();
    assert.throws(() => h.db.run(`UPDATE task_ownership SET ${column}=? WHERE run_id=?`, value, a.run.run_id), /immutable/);
  }
  // Simulate a run created by a hub predating migration038; no record is a
  // permission grant. Its first intent needs a recorded approval.
  h.db.run('DELETE FROM task_ownership WHERE run_id=?', a.run.run_id);
  const result = await declare(a, ['src/a.js']); assert.equal(result.ok, true);
  assert.ok(result.result.plan_permission_request_id);
  await a.client.hb([runHb(a.run)]);
  assert.equal((await read(a)).result.ownership.reason, 'read_only');
  assert.equal(h.db.get('SELECT plan_required FROM task_ownership WHERE run_id=?', a.run.run_id).plan_required, 1);
});
