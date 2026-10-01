// Independent real HTTP/WS fail-before regressions, preserved for the sign-in rollout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { tenancy } from './tenancy/fixture.js';
import { FakeRunner, until, settle, runMsg, runHb } from './helpers.js';

async function rig(t, { running = false } = {}) {
  const fx = await tenancy();
  const runners = [];
  t.after(async () => { for (const r of runners) r.terminate(); await fx.h.close(); });
  const enrolled = await fx.as(fx.users.amember, 'POST', `/api/teams/${fx.A.team}/enrol`, {});
  assert.equal(enrolled.status, 200, enrolled.text);
  fx.open = async () => {
    const r = new FakeRunner(fx.h.base, { device_id: '', device_token: enrolled.body.runner_token, team: fx.A.team });
    runners.push(r); await r.open(); await r.hello(); await r.advertise([{ repo_id: fx.A.repo }]); return r;
  };
  fx.r = await fx.open(); fx.conn = fx.h.hub.runners.get(fx.r.welcome.device_id);
  fx.dispatch = async () => {
    const body = { request_id: randomUUID(), budget_usd: 5 };
    const res = await fx.as(fx.users.amember, 'POST', `/api/cards/${fx.A.card}/actions/dispatch`, body);
    assert.equal(res.status, 200, res.text);
    return { offer: await fx.r.next('offer', o => o.card_id === fx.A.card), body, res };
  };
  if (running) {
    const { offer } = await fx.dispatch(), claim = await fx.r.claim(offer); assert.equal(claim.ok, true);
    fx.run = { ...claim, card_id: fx.A.card, repo_id: fx.A.repo };
    await fx.r.out({ ...runMsg(fx.run), kind: 'activity', source: 'init' }); await fx.r.hb([runHb(fx.run)]);
  }
  return fx;
}
const state = fx => createHash('sha256').update(JSON.stringify(['cards', 'runs', 'dispatches', 'comments', 'asks', 'permission_requests', 'evidence', 'events', 'journal'].map(table => fx.db.all(`SELECT * FROM ${table} ORDER BY rowid`)))).digest('hex');
async function held(fx, call, change) {
  const original = fx.h.hub.withBoard.bind(fx.h.hub); let release, signal;
  const entered = new Promise(resolve => signal = resolve);
  const hold = original(fx.A.board, () => new Promise(resolve => release = resolve));
  await new Promise(resolve => setImmediate(resolve));
  fx.h.hub.withBoard = (id, fn) => { if (id === fx.A.board) signal(); return original(id, fn); };
  try {
    const pending = call(); await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(Error('no queued effect observed')), 5000).unref())]);
    await change(); const before = state(fx); release(); await hold;
    const result = await pending; assert.equal(state(fx), before, `queued denied operation must leave effect tables unchanged; ok=${result?.ok}; status=${result?.status}; error=${result?.error?.code}; run_state=${fx.h.hub.card(fx.A.card)?.run_state}`); return result;
  } finally { release(); await hold; fx.h.hub.withBoard = original; }
}

test('independent held HTTP create rechecks credential ownership, not just liveness', async t => {
  const fx = await rig(t), u = fx.users.amember;
  const r = await held(fx, () => fx.as(u, 'POST', `/api/boards/${fx.A.board}/cards`, { request_id: randomUUID(), title: 'must not be created' }),
    () => fx.db.run('UPDATE user_devices SET user_id=? WHERE id=?', fx.users.n.id, u.device_id));
  assert.equal(r.status, 401, r.text);
});
test('independent held HTTP create rejects current repo opt-out', async t => {
  const fx = await rig(t);
  const r = await held(fx, () => fx.as(fx.users.amember, 'POST', `/api/boards/${fx.A.board}/cards`, { request_id: randomUUID(), title: 'must not be created', repo_id: fx.A.repo }),
    () => fx.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?', fx.A.board, fx.A.repo));
  assert.equal(r.status, 404, r.text);
});
test('independent cached paid retry rejects current repo opt-out before replay', async t => {
  const fx = await rig(t), { body } = await fx.dispatch();
  fx.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?', fx.A.board, fx.A.repo);
  const before = state(fx);
  const r = await fx.as(fx.users.amember, 'POST', `/api/cards/${fx.A.card}/actions/dispatch`, body);
  assert.equal(state(fx), before, 'a retry must not make another dispatch');
  assert.equal(r.status, 404, r.text); assert.equal(r.headers.get('board-replayed'), null);
});
for (const operation of ['create', 'patch']) test(`independent cached ${operation} request rejects current requested repo opt-out`, async t => {
  const fx = await rig(t), u = fx.users.amember;
  const method = operation === 'create' ? 'POST' : 'PATCH';
  const path = operation === 'create' ? `/api/boards/${fx.A.board}/cards` : `/api/cards/${fx.A.card}`;
  const body = { request_id: randomUUID(), repo_id: fx.A.repo, ...(operation === 'create' ? { title: 'cached fixture' } : { version: fx.h.hub.card(fx.A.card).version }) };
  const first = await fx.as(u, method, path, body); assert.equal(first.status, 200, first.text);
  fx.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?', fx.A.board, fx.A.repo);
  const before = state(fx), retry = await fx.as(u, method, path, body);
  assert.equal(state(fx), before); assert.equal(retry.status, 404, retry.text); assert.equal(retry.headers.get('board-replayed'), null);
});
test('independent held WS claim rejects repo opt-out before starting a paid run', async t => {
  const fx = await rig(t), { offer } = await fx.dispatch();
  const r = await held(fx, () => fx.r.claim(offer), () => fx.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?', fx.A.board, fx.A.repo));
  assert.equal(r.ok, false); assert.equal(fx.h.hub.card(fx.A.card).active_run_id, null);
});
test('independent held WS claim rejects restore epoch before starting a paid run', async t => {
  const fx = await rig(t), { offer } = await fx.dispatch();
  const r = await held(fx, () => fx.r.claim(offer), () => fx.db.setMeta('session_epoch', Number(fx.db.meta('session_epoch')) + 1));
  assert.equal(r.ok, false); assert.equal(r.error.code, 'POLICY_DENIED');
});
for (const loss of ['epoch', 'account', 'device-owner']) test(`independent held WS RPC rejects ${loss} loss`, async t => {
  const fx = await rig(t, { running: true });
  const r = await held(fx, () => fx.r.rpc(fx.run, 'board_ask_human', { kind: 'question', text: 'must not persist' }), () => {
    if (loss === 'epoch') fx.db.setMeta('session_epoch', Number(fx.db.meta('session_epoch')) + 1);
    else if (loss === 'account') fx.db.run('UPDATE users SET deleted_at=? WHERE id=?', fx.h.hub.iso(), fx.users.amember.id);
    else fx.db.run('UPDATE devices SET member_id=? WHERE id=?', fx.A.owner, fx.conn.device_id);
  });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'FORBIDDEN');
});
for (const loss of ['user-device', 'team', 'epoch', 'replacement', 'provider-error']) test(`independent awaited WS evidence cannot persist after ${loss}`, async t => {
  const fx = await rig(t, { running: true }); let answer, fail, entered;
  const requested = new Promise(resolve => entered = resolve);
  fx.h.hub.github.getCommit = () => { entered(); return new Promise((resolve, reject) => { answer = resolve; fail = reject; }); };
  const id = `independent-${randomUUID()}`;
  fx.r.send({ type: 'rpc', id, ...runMsg(fx.run), run_token: fx.run.run_token, method: 'board_attach_evidence', params: { kind: 'commit', ref: 'a'.repeat(40) } });
  await requested;
  if (loss === 'team') fx.db.run('UPDATE orgs SET deleted_at=? WHERE id=?', fx.h.hub.iso(), fx.A.team);
  else if (loss === 'epoch') fx.db.setMeta('session_epoch', Number(fx.db.meta('session_epoch')) + 1);
  else if (loss === 'replacement') await fx.open();
  else fx.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?', fx.h.hub.iso(), fx.users.amember.device_id);
  const before = state(fx);
  if (loss === 'provider-error') fail(Error('synthetic upstream failure')); else answer({ sha: 'a'.repeat(40) });
  await fx.conn.chain; await settle();
  assert.equal(state(fx), before, 'evidence must not fall back to a persisted self-report after authority loss');
  assert.ok(!fx.r.all('rpc.result', m => m.re === id).some(m => m.ok));
  if (loss === 'replacement') assert.equal(fx.conn.closed, true);
  else assert.equal(fx.r.all('rpc.result', m => m.re === id)[0]?.error?.code, 'FORBIDDEN');
});
test('independent label replay binds the effective strip operation including query input', async t => {
  const fx = await rig(t), u = fx.users.aadmin;
  assert.equal((await fx.as(u, 'POST', `/api/boards/${fx.A.board}/labels`, { name: 'replay-probe', color: 'red' })).status, 200);
  fx.db.run('UPDATE cards SET labels=? WHERE id=?', JSON.stringify(['replay-probe']), fx.A.card);
  const body = { request_id: randomUUID() }, url = `/api/boards/${fx.A.board}/labels/replay-probe`;
  assert.equal((await fx.as(u, 'DELETE', url, body)).status, 200);
  const before = state(fx), r = await fx.as(u, 'DELETE', url + '?strip=1', body);
  assert.equal(state(fx), before); assert.equal(r.status, 409, r.text);
});

