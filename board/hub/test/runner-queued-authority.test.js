import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tenancy } from './tenancy/fixture.js';
import { FakeRunner, until, settle, runMsg, runHb } from './helpers.js';

async function rig(t) {
  const fx = await tenancy(); const runners = []; t.after(async () => { for (const r of runners) r.terminate(); await fx.h.close(); });
  const { A, users, h } = fx; const u = users.amember;
  const e = await fx.as(u, 'POST', `/api/teams/${A.team}/enrol`, {}); assert.equal(e.status, 200);
  const open = async () => {
    const r = new FakeRunner(h.base, { device_id: '', device_token: e.body.runner_token, team: A.team }); runners.push(r);
    await r.open(); await r.hello(); await r.advertise([{ repo_id: A.repo }]); return r;
  };
  const r = await open();
  const dispatch = async () => {
    const c = await fx.as(u, 'POST', `/api/boards/${A.board}/cards`, { request_id: randomUUID(), title: 'authority probe', repo_id: A.repo }); assert.equal(c.status, 200);
    const d = await fx.as(u, 'POST', `/api/cards/${c.body.card.id}/actions/dispatch`, { request_id: randomUUID(), budget_usd: 5 }); assert.equal(d.status, 200);
    return r.next('offer', (o) => o.card_id === c.body.card.id);
  };
  const offer = await dispatch(), claim = await r.claim(offer); assert.equal(claim.ok, true);
  const run = { ...claim, card_id: offer.card_id, repo_id: A.repo };
  await r.out({ ...runMsg(run), kind: 'activity', source: 'init' }); await r.hb([runHb(run)]);
  const conn = h.hub.runners.get(r.welcome.device_id);
  return { fx, h, A, u, r, conn, run, dispatch, open };
}

for (const invalidation of ['unenrol', 'replacement', 'revoke-row', 'downgrade', 'removed']) for (const kind of ['comment', 'terminal', 'heartbeat', 'suspending', 'decline', 'salvage']) {
  test(`queued ${kind} is denied after ${invalidation} with a live device row`, async (t) => {
    const x = await rig(t), { h, A, conn, run, r } = x;
    const offer = kind === 'decline' ? await x.dispatch() : null;
    const state = () => JSON.stringify({ run: h.hub.run(run.run_id), card: h.hub.card(offer?.card_id ?? run.card_id),
      lease: h.db.get('SELECT * FROM leases WHERE card_id = ?', run.card_id),
      live: h.hub.lease(run.run_id),
      comments: h.db.all('SELECT * FROM comments WHERE card_id = ?', run.card_id),
      events: h.db.all('SELECT * FROM events WHERE run_id = ?', run.run_id), seq: h.hub.device(conn.device_id).last_seq_acked });
    const before = state();
    let release; const held = h.hub.withBoard(A.board, () => new Promise((resolve) => release = resolve)); await new Promise((resolve) => setImmediate(resolve)); t.after(() => release());
    const withBoard = h.hub.withBoard.bind(h.hub); let queued = false;
    h.hub.withBoard = (id, fn) => { queued = true; return withBoard(id, fn); };
    if (kind === 'comment' || kind === 'terminal') await r.out({ ...runMsg(run), kind: kind === 'comment' ? 'comment.create' : 'run.failed', text: 'FORBIDDEN', fail_kind: 'error', reason: 'FORBIDDEN' }, { wait: false });
    else if (kind === 'heartbeat') r.send({ type: 'hb', seq_hb: ++r.seqHb, mono_ms: 1, wall_ms: 1, slept_ms: 0, runs: [{ ...runHb(run), child_alive: false, cost_usd: 90 }] });
    else if (kind === 'suspending') r.send({ type: 'host.suspending', runs: [runHb(run)] });
    else if (kind === 'decline') r.send({ type: 'decline', card_id: offer.card_id, request_id: offer.request_id, reason: 'FORBIDDEN' });
    else r.send({ type: 'salvage', ...runMsg(run), kind: 'note', payload: { text: 'FORBIDDEN' } });
    await until(() => queued); const pending = conn.chain;
    if (invalidation === 'unenrol') assert.equal((await x.fx.as(x.u, 'DELETE', `/api/teams/${A.team}/enrol`, {})).status, 200);
    else if (invalidation === 'replacement') await x.open();
    else {
      assert.equal(conn.closed, false, 'the queue recheck must work before socket cleanup');
      if (invalidation === 'revoke-row') h.db.run('UPDATE runner_enrollments SET revoked_at = ?, token_hash = NULL WHERE id = ?', h.hub.iso(), conn.enrollmentId);
      else if (invalidation === 'downgrade') h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", A.member);
      else h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', h.hub.iso(), A.member);
    }
    assert.equal(h.hub.device(conn.device_id).revoked_at, null);
    release(); await held; await pending; await settle();
    assert.equal(state(), before);
  });
}
