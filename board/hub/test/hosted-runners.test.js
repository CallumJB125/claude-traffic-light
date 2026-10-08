// Hosted (cloud) runners (067, docs/CLOUD-RUNNER-RUNBOOK.md): admin-created
// enrolments that outlive the creating install, "Run in the cloud" dispatches
// that only a hosted runner claims (and that never leak to the owner's laptop),
// honest status when none is enrolled or it is offline, and sealed per-team
// provider keys that leave the hub only to a hosted runner, per run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tenancy } from './tenancy/fixture.js';
import { FakeRunner, settle } from './helpers.js';

const rid = () => randomUUID();
const KEY = 'sk-ant-api03-team-hosted-key-0123456789';

async function connect(fx, token, team, repo) {
  const r = new FakeRunner(fx.h.base, { device_id: '', device_token: token, team });
  await r.open();
  await r.hello();
  await r.advertise([{ repo_id: repo, approvals_from: [], auto_accept_from: [] }]);
  return r;
}

async function newCard(fx, u, T, title) {
  const c = await fx.as(u, 'POST', `/api/boards/${T.board}/cards`, { request_id: rid(), title, repo_id: T.repo });
  assert.equal(c.status, 200, c.text);
  return c.body.card.id;
}

const offersFor = (r, cardId) => r.all('offer', (m) => m.card_id === cardId);

test('create: admins only, from the app, token shown once; status is honest about none, offline and online', async () => {
  const fx = await tenancy();
  try {
    const { users, A } = fx;
    let s = await fx.as(users.ua, 'GET', `/api/teams/${A.team}/hosted-runners`);
    assert.equal(s.status, 200, s.text);
    assert.deepEqual([s.body.runners, s.body.mine, s.body.online], [[], false, false], 'no cloud runner yet');
    assert.equal((await fx.as(users.amember, 'POST', `/api/teams/${A.team}/hosted-runners`, { name: 'pi' })).status, 403, 'members cannot add one');
    const c = await fx.as(users.ua, 'POST', `/api/teams/${A.team}/hosted-runners`, { name: 'Pi 5' });
    assert.equal(c.status, 200, c.text);
    assert.match(c.body.runner_token, /^brt_/);
    s = await fx.as(users.ua, 'GET', `/api/teams/${A.team}/hosted-runners`);
    assert.deepEqual(s.body.runners.map((r) => [r.name, r.online, r.mine]), [['Pi 5', false, true]], 'enrolled but offline');
    assert.ok(!s.text.includes(c.body.runner_token));
    const r = await connect(fx, c.body.runner_token, A.team, A.repo);
    s = await fx.as(users.ua, 'GET', `/api/teams/${A.team}/hosted-runners`);
    assert.equal(s.body.online, true);
    const en = await fx.as(users.ua, 'GET', `/api/teams/${A.team}/enrolments`);
    assert.deepEqual(en.body.enrolments.filter((e) => e.hosted).map((e) => [e.name, e.current, e.online]), [['Pi 5', false, true]]);
    // The laptop that created it signs out: the cloud runner keeps working.
    assert.equal((await fx.as(users.ua, 'POST', '/api/auth/signout', {})).status, 200);
    fx.h.hub.enrolments.recheck();
    await settle(50);
    assert.equal(r.closeCode, null, 'a hosted runner outlives the install that created it');
    assert.equal(fx.db.get('SELECT revoked_at FROM runner_enrollments WHERE id = ?', c.body.enrollment_id).revoked_at, null);
    r.terminate();
  } finally { await fx.h.close(); }
});

test('placement: "Run in the cloud" is offered only to the hosted runner, other dispatches never are; offline queues until it connects', async () => {
  const fx = await tenancy();
  try {
    const { users, A } = fx;
    const laptop = await fx.as(users.ua, 'POST', `/api/teams/${A.team}/enrol`, { device_name: 'laptop' });
    const cloud = await fx.as(users.ua, 'POST', `/api/teams/${A.team}/hosted-runners`, { name: 'pi' });
    const lap = await connect(fx, laptop.body.runner_token, A.team, A.repo);
    // Runner offline: the cloud card waits in the queue, and the preview says so.
    const c1 = await newCard(fx, users.ua, A, 'cloud work');
    const d1 = await fx.as(users.ua, 'POST', `/api/cards/${c1}/actions/dispatch`, { request_id: rid(), placement: 'hosted', confirm: true });
    assert.equal(d1.status, 200, d1.text);
    await settle(50);
    assert.equal(offersFor(lap, c1).length, 0, 'never the laptop');
    assert.equal(d1.body.card.run_state ?? 'queued', 'queued');
    const pv = await fx.as(users.ua, 'GET', `/api/cards/${c1}/overlap-preview?repo_id=${A.repo}`);
    assert.deepEqual([pv.body.hosted.enrolled, pv.body.hosted.online], [true, false]);
    assert.equal(pv.body.runners.length, 1, 'the laptop stays its own choice');
    const pi = await connect(fx, cloud.body.runner_token, A.team, A.repo);
    const offer = await pi.next('offer', (m) => m.card_id === c1);
    assert.equal(offer.card_id, c1, 'the queued cloud card reaches the hosted runner when it connects');
    const pv2 = await fx.as(users.ua, 'GET', `/api/cards/${c1}/overlap-preview?repo_id=${A.repo}`);
    assert.deepEqual([pv2.body.hosted.online, pv2.body.hosted.runners[0].serves_repo], [true, true]);
    // An ordinary dispatch never reaches the hosted runner.
    const c2 = await newCard(fx, users.ua, A, 'laptop work');
    assert.equal((await fx.as(users.ua, 'POST', `/api/cards/${c2}/actions/dispatch`, { request_id: rid(), confirm: true })).status, 200);
    await lap.next('offer', (m) => m.card_id === c2);
    await settle(50);
    assert.equal(offersFor(pi, c2).length, 0);
    // A cloud run is the caller's own cloud runner, never a teammate's.
    const c3 = await newCard(fx, users.ua, A, 'teammate');
    const bad = await fx.as(users.ua, 'POST', `/api/cards/${c3}/actions/dispatch`, { request_id: rid(), placement: 'hosted', target_member_id: A.member, confirm: true });
    assert.equal(bad.status, 403, bad.text);
    assert.equal(bad.body.error.reason, 'HOSTED_SELF_ONLY');
    assert.equal(fx.h.hub.pendingDispatch(c3), null);
    assert.equal((await fx.as(users.ua, 'POST', `/api/cards/${c3}/actions/dispatch`, { request_id: rid(), placement: 'mars', confirm: true })).status, 400);
    lap.terminate(); pi.terminate();
  } finally { await fx.h.close(); }
});

test('provider keys: admins set them sealed, nobody reads them back; only a hosted runner gets this run\'s key over its socket', async () => {
  const fx = await tenancy();
  try {
    const { users, A } = fx;
    assert.equal((await fx.as(users.amember, 'PUT', `/api/teams/${A.team}/provider-configs/claude`, { api_key: KEY })).status, 403);
    const put = await fx.as(users.ua, 'PUT', `/api/teams/${A.team}/provider-configs/claude`, { api_key: KEY, model: 'claude-sonnet-4-5' });
    assert.equal(put.status, 200, put.text);
    assert.ok(!put.text.includes(KEY));
    const row = fx.db.get('SELECT * FROM team_provider_configs WHERE org_id = ? AND provider = ?', A.team, 'claude');
    assert.ok(row.ciphertext && !Buffer.from(row.ciphertext).toString('latin1').includes(KEY), 'sealed at rest');
    const get = await fx.as(users.amember, 'GET', `/api/teams/${A.team}/provider-configs`);
    assert.deepEqual(get.body.providers.map((p) => [p.provider, p.has_key, p.model]), [['claude', true, 'claude-sonnet-4-5']]);
    assert.ok(!get.text.includes(KEY));
    // Model change keeps the key; hermes-dgx needs a literal IP endpoint.
    await fx.as(users.ua, 'PUT', `/api/teams/${A.team}/provider-configs/claude`, { model: 'claude-opus-4-1' });
    assert.ok(fx.db.get('SELECT key_id FROM team_provider_configs WHERE org_id = ? AND provider = ?', A.team, 'claude').key_id);
    assert.equal((await fx.as(users.ua, 'PUT', `/api/teams/${A.team}/provider-configs/hermes-dgx`, { base_url: 'http://dgx.internal:8888' })).status, 400);
    assert.equal((await fx.as(users.ua, 'PUT', `/api/teams/${A.team}/provider-configs/hermes-dgx`, { base_url: 'http://100.68.66.98:8888' })).status, 200);
    assert.equal((await fx.as(users.ua, 'PUT', `/api/teams/${A.team}/provider-configs/claude`, { base_url: 'http://1.2.3.4' })).status, 400);
    assert.equal((await fx.as(users.ua, 'PUT', `/api/teams/${A.team}/provider-configs/gemini`, { api_key: 'x'.repeat(30) })).status, 404, 'Gemini is not offered on hosted runners');

    // A desktop runner claiming ordinary work cannot ask for the key.
    const laptop = await fx.as(users.ua, 'POST', `/api/teams/${A.team}/enrol`, { device_name: 'laptop' });
    const lap = await connect(fx, laptop.body.runner_token, A.team, A.repo);
    const c1 = await newCard(fx, users.ua, A, 'laptop');
    await fx.as(users.ua, 'POST', `/api/cards/${c1}/actions/dispatch`, { request_id: rid(), confirm: true });
    const o1 = await lap.next('offer', (m) => m.card_id === c1);
    const cl1 = await lap.claim(o1);
    assert.equal(cl1.ok, true, JSON.stringify(cl1));
    const r1 = await lap.rpc({ run_id: cl1.run_id, card_id: c1, fence: cl1.fence, repo_id: A.repo, run_token: cl1.run_token }, 'runner_provider_config');
    assert.equal(r1.ok, false);
    assert.equal(r1.error.code, 'FORBIDDEN');
    assert.ok(!JSON.stringify(r1).includes(KEY));

    const cloud = await fx.as(users.ua, 'POST', `/api/teams/${A.team}/hosted-runners`, { name: 'pi' });
    const pi = await connect(fx, cloud.body.runner_token, A.team, A.repo);
    const c2 = await newCard(fx, users.ua, A, 'cloud');
    await fx.as(users.ua, 'POST', `/api/cards/${c2}/actions/dispatch`, { request_id: rid(), placement: 'hosted', confirm: true });
    const o2 = await pi.next('offer', (m) => m.card_id === c2);
    const cl2 = await pi.claim(o2);
    assert.equal(cl2.ok, true, JSON.stringify(cl2));
    const r2 = await pi.rpc({ run_id: cl2.run_id, card_id: c2, fence: cl2.fence, repo_id: A.repo, run_token: cl2.run_token }, 'runner_provider_config');
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.deepEqual(r2.result, { provider: 'claude', configured: true, api_key: KEY, model: 'claude-opus-4-1' });
    const s = await fx.as(users.ua, 'GET', `/api/teams/${A.team}/hosted-runners`);
    assert.deepEqual(s.body.recent_runs.map((x) => [x.card_key, x.ai, typeof x.cost_usd]), [[o2.key, 'claude', 'number']], 'cloud runs and their cost');
    assert.equal(s.body.runners[0].active_runs, 1);
    // Delete.
    const del = await fx.as(users.ua, 'DELETE', `/api/teams/${A.team}/provider-configs/claude`, {});
    assert.equal(del.status, 200, del.text);
    const r3 = await pi.rpc({ run_id: cl2.run_id, card_id: c2, fence: cl2.fence, repo_id: A.repo, run_token: cl2.run_token }, 'runner_provider_config');
    assert.deepEqual(r3.result, { provider: 'claude', configured: false });
    lap.terminate(); pi.terminate();
  } finally { await fx.h.close(); }
});

test('a deleted team\'s provider keys are erased with it', async () => {
  const fx = await tenancy();
  try {
    const { h, B } = fx;
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM team_provider_configs WHERE org_id = ?', B.team).n, 1);
    h.hub.txn(() => {
      fx.db.run('UPDATE orgs SET deleted_at = ? WHERE id = ?', h.hub.iso(), B.team);
      h.hub.revokeDeletedTeamConnections(h.hub.iso());
    });
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM team_provider_configs WHERE org_id = ?', B.team).n, 0);
  } finally { await fx.h.close(); }
});
