import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHub, until } from './helpers.js';
import { tenancy } from './tenancy/fixture.js';
import { TeamCommunication } from '../communication.js';
import { mintRunToken } from '../auth.js';
import { rmSync } from 'node:fs';

export const packetData = (brief = 'Task brief') => ({ brief, decisions: ['Use the existing route'], progress: 'Implementation ready',
  nextAction: 'Review the result', artifacts: [{ kind: 'path', path: 'src/app.js' }], reportedChecks: ['I ran the focused tests'] });
const body = (data = packetData(), expected_version = 0) => ({ request_id: randomUUID(), expected_version, data });
async function rig(t) {
  const h = await startHub(); t.after(() => h.destroy());
  const cookie = await h.login('alice'), runner = await h.runner(await h.enroll(cookie)), run = await h.startRun(cookie, runner);
  h.db.run("UPDATE runs SET ai = 'codex', backend = 'codex_cli' WHERE id = ?", run.run_id);
  return { h, cookie, runner, run };
}

test('packets bind actual author/provider/fence, exact durable retry, immutable versions and observed evidence', async (t) => {
  const { h, runner, run } = await rig(t), data = packetData(), request = body(data);
  h.github.commits.add('a'.repeat(40));
  const ev = await runner.rpc(run, 'board_attach_evidence', { kind: 'commit', ref: 'a'.repeat(40), summary: 'Observed commit' }); assert.equal(ev.ok, true);
  data.artifacts.push({ kind: 'evidence', id: ev.result.evidence_id });
  const first = await runner.rpc(run, 'board_write_packet', request); assert.equal(first.ok, true, JSON.stringify(first.error));
  const p = first.result.packet; assert.equal(p.version, 1); assert.equal(p.author.provider, 'codex'); assert.equal(p.author.run_id, run.run_id);
  assert.equal(p.author.member_id, h.ids.alice); assert.equal(p.author.identity_source, 'hub_run'); assert.equal(p.fence, run.fence);
  assert.equal(p.reports_verified, false); assert.equal(p.grants_execution, false); assert.equal(p.evidence[0].verification, 'hub_verified');
  assert.deepEqual((await runner.rpc(run, 'board_write_packet', request)).result, first.result);
  assert.equal((await runner.rpc(run, 'board_write_packet', { ...request, data: packetData('Changed') })).error.code, 'CONFLICT');
  assert.equal((await runner.rpc(run, 'board_write_packet', body())).error.code, 'VERSION_CONFLICT');
  assert.equal((await runner.rpc(run, 'board_write_packet', body(packetData('Next'), 1))).result.packet.version, 2);
  assert.equal((await runner.rpc(run, 'board_read_packet', { version: 1 })).result.packet.data.brief, 'Task brief');
  assert.throws(() => h.db.run("UPDATE task_packets SET data = '{}' WHERE id = ?", p.id), /immutable/);
  const journal = h.db.all("SELECT * FROM journal WHERE kind = 'packet.version'"); assert.equal(journal.length, 2);
  assert.ok(!JSON.stringify(journal).includes('Task brief')); assert.ok(JSON.stringify(journal).includes('content_hmac'));
  assert.equal(h.db.get('SELECT COUNT(*) n FROM comments WHERE card_id = ?', run.card_id).n, 0);
});

test('packet sanitation removes credentials, complete keys, signed URLs and absolute paths; closed authority stays rejected', async (t) => {
  const { h, runner, run } = await rig(t);
  const raw = 'API_TOKEN=fixtureSecret123 /srv/private/config C:\\private\\key.txt btk_' + 'a'.repeat(43) + '\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\nhttps://name:password@example.test/path?signature=private#secret';
  const saved = await runner.rpc(run, 'board_write_packet', body(packetData(raw))); assert.equal(saved.ok, true);
  const durable = JSON.stringify(h.db.all('SELECT data FROM task_packets')); for (const secret of ['fixtureSecret123', '/srv/private', 'private-material', 'signature=private', 'name:password', 'btk_']) assert.ok(!durable.includes(secret), secret);
  for (const field of ['approval', 'permissionLevel', 'provider', 'account_id', 'run_id', 'root']) {
    const request = body({ ...packetData(), [field]: true }, 1);
    assert.equal((await runner.rpc(run, 'board_write_packet', request)).error.code, 'VALIDATION');
  }
  for (const p of ['../other', '/srv/private', 'C:/private', '.git/config', '.env.local', 'src/../secret', 'credentials/a', 'private.pem']) {
    const data = { ...packetData(), artifacts: [{ kind: 'path', path: p }] };
    assert.equal((await runner.rpc(run, 'board_write_packet', body(data, 1))).error.code, 'VALIDATION', p);
  }
  assert.equal((await runner.rpc(run, 'board_write_packet', body({ ...packetData(), artifacts: [{ kind: 'evidence', id: randomUUID() }] }, 1))).error.code, 'VALIDATION');
});

test('staff packets have no verified provider identity and guests/foreign teams/viewer writes are refused', async () => {
  const f = await tenancy();
  try {
    const { A, B, users, as, h } = f, request = { ...body(), expected_fence: h.hub.card(A.card).fence };
    const p = await as(users.amember, 'POST', `/api/cards/${A.card}/packet`, request); assert.equal(p.status, 200, p.text);
    assert.equal(p.body.packet.author.account_id, users.amember.id); assert.equal(p.body.packet.author.provider, null); assert.equal(p.body.packet.author.run_id, null);
    assert.equal((await as(users.aviewer, 'GET', `/api/cards/${A.card}/packet`)).status, 200);
    assert.equal((await as(users.aviewer, 'POST', `/api/cards/${A.card}/packet`, request)).status, 403);
    assert.equal((await as(users.ua, 'GET', `/api/cards/${B.card}/packet`)).status, 404);
    assert.equal((await as(users.bguest, 'GET', `/api/cards/${B.card}/packet`)).status, 404);
    assert.equal((await as(users.amember, 'POST', `/api/cards/${A.card}/packet`, { ...request, provider: 'codex' })).status, 400);
    assert.equal((await as(users.amember, 'POST', `/api/cards/${A.card}/packet`, { ...request, expected_fence: 100 })).status, 409);
    h.db.run('UPDATE boards SET archived_at = ? WHERE id = ?', h.hub.iso(), A.board);
    assert.equal((await as(users.amember, 'GET', `/api/cards/${A.card}/packet`)).status, 409);
  } finally { await f.h.close(); }
});

for (const loss of ['role', 'credential', 'member', 'user', 'fence']) test(`queued staff packet writes and durable retries fail closed after ${loss} loss`, async () => {
  const f = await tenancy(); let release;
  try {
    const { A, h, users, as } = f, request = { ...body(), expected_fence: h.hub.card(A.card).fence };
    assert.equal((await as(users.amember, 'POST', `/api/cards/${A.card}/packet`, request)).status, 200);
    const before = JSON.stringify(h.db.all('SELECT * FROM task_packets'));
    const held = h.hub.withBoard(A.board, () => new Promise((resolve) => release = resolve)); await new Promise((resolve) => setImmediate(resolve));
    const original = h.hub.withBoard.bind(h.hub); let queued = false; h.hub.withBoard = (id, fn) => { if (id === A.board) queued = true; return original(id, fn); };
    const pending = as(users.amember, 'POST', `/api/cards/${A.card}/packet`, request); await until(() => queued);
    if (loss === 'role') h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", A.member);
    if (loss === 'member') h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', h.hub.iso(), A.member);
    if (loss === 'user') h.db.run('UPDATE users SET deleted_at = ? WHERE id = ?', h.hub.iso(), users.amember.id);
    if (loss === 'credential') h.db.run('UPDATE user_devices SET revoked_at = ? WHERE id = ?', h.hub.iso(), users.amember.device_id);
    if (loss === 'fence') h.db.run('UPDATE cards SET fence = fence + 1 WHERE id = ?', A.card);
    release(); await held; const result = await pending;
    assert.ok([401, 403, 404, 409].includes(result.status), result.text); assert.equal(JSON.stringify(h.db.all('SELECT * FROM task_packets')), before);
  } finally { release?.(); await f.h.close(); }
});

test('ended/fenced runs cannot read or retry old packets; a newly authenticated current run can read predecessor context', async (t) => {
  const { h, runner, run, cookie } = await rig(t), request = body(); assert.equal((await runner.rpc(run, 'board_write_packet', request)).ok, true);
  h.db.run('UPDATE cards SET fence = fence + 1 WHERE id = ?', run.card_id);
  assert.equal((await runner.rpc(run, 'board_read_packet')).error.code, 'FENCED');
  assert.equal((await runner.rpc(run, 'board_write_packet', request)).error.code, 'FENCED');
  const service = new TeamCommunication(h.hub); const packet = await service.staffReadPacket(h.hub.member(h.ids.alice), run.card_id, {});
  assert.equal(packet.packet.version, 1); assert.equal(packet.packet.fence, run.fence);
  const old = h.hub.run(run.run_id), fresh = randomUUID(), dispatch = randomUUID();
  h.db.run('UPDATE runs SET ended_at = ? WHERE id = ?', h.hub.iso(), old.id);
  h.db.insert('dispatches', { request_id: dispatch, card_id: run.card_id, dispatched_by: h.ids.alice, state: 'claimed', created_at: h.hub.iso() });
  h.db.insert('runs', { ...old, id: fresh, fence: old.fence + 1, dispatch_request_id: dispatch, ended_at: null });
  h.db.run('UPDATE cards SET active_run_id = ? WHERE id = ?', fresh, run.card_id);
  const next = { ...run, run_id: fresh, fence: old.fence + 1, run_token: mintRunToken(h.hub.secret, { card_id: run.card_id, run_id: fresh, fence: old.fence + 1, hub_epoch: h.hub.db.meta('hub_epoch') }) };
  assert.equal((await runner.rpc(next, 'board_read_packet')).result.packet.version, 1);
  assert.equal((await runner.rpc(next, 'board_write_packet', body(packetData('Continued'), 1))).result.packet.version, 2);
  h.db.run('UPDATE cards SET repo_id = NULL, run_state = NULL, active_run_id = NULL WHERE id = ?', run.card_id);
  assert.equal((await h.api(cookie, 'GET', `/api/cards/${run.card_id}/packet`)).status, 404);
});

test('packet commit is atomic with journal and versions survive actual hub restart', async () => {
  const h = await startHub(); let restarted;
  try {
    const cookie = await h.login('alice'), card = await h.createCard(cookie), request = { ...body(), expected_fence: card.fence };
    const saved = await h.api(cookie, 'POST', `/api/cards/${card.id}/packet`, request); assert.equal(saved.status, 200, saved.text);
    const insert = h.db.insert.bind(h.db), before = JSON.stringify(h.db.all('SELECT * FROM task_packets'));
    h.db.insert = (table, value) => { if (table === 'journal') throw Error('storage failure'); return insert(table, value); };
    const failed = await h.api(cookie, 'POST', `/api/cards/${card.id}/packet`, { ...body(packetData('Must roll back'), 1), expected_fence: card.fence });
    h.db.insert = insert; assert.equal(failed.status, 500); assert.equal(JSON.stringify(h.db.all('SELECT * FROM task_packets')), before);
    await h.close(); restarted = await startHub({ dataDir: h.dataDir });
    const fresh = await restarted.login('alice');
    assert.deepEqual((await restarted.api(fresh, 'POST', `/api/cards/${card.id}/packet`, request)).body, saved.body);
    assert.equal((await restarted.api(fresh, 'GET', `/api/cards/${card.id}/packet`)).body.packet.version, 1);
  } finally { if (restarted) await restarted.close(); else await h.close(); rmSync(h.dataDir, { recursive: true, force: true }); }
});
