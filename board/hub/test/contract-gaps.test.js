// Phase 1 integration contract additions (CONTRACT §5.2–§6.9): dispatch budget,
// hub-confirmed handover versions, limit reset time, device form factor,
// salvage repo scope, plan-approval label, /api/health auth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_APPROVAL_LABEL } from '../../shared/states.js';
import { startHub, runMsg, runHb } from './helpers.js';

test('dispatch budget_usd becomes the card cap and rides the offer; bad budgets are refused', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const card = await h.createCard(alice);
    const bad = await h.action(alice, card.id, 'dispatch', { budget_usd: -1 });
    assert.equal(bad.status, 400);
    const d = await h.action(alice, card.id, 'dispatch', { budget_usd: 0.75 });
    assert.equal(d.status, 200);
    assert.deepEqual(d.body.card.budget, { spent_usd: 0, cap_usd: 0.75 });
    const offer = await r.next('offer', (o) => o.card_id === card.id);
    assert.equal(offer.budget_usd, 0.75);
  } finally {
    await h.destroy();
  }
});

test('plan approval is the `plan-approval` label: offer.require_plan_approval and plan asks follow it', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, r, { labels: [PLAN_APPROVAL_LABEL] });
    const offers = r.all('offer', (o) => o.card_id === run.card_id);
    assert.equal(offers[0].require_plan_approval, true);
  } finally {
    await h.destroy();
  }
});

test('handover.write ack carries the hub version; run.failed{limit} fills limit_resets_in_ms; hello form_factor → device_kind', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const dev = await h.enroll(alice);
    const r = await h.runner(dev, { hello: false, advertise: false });
    r.send({ type: 'hello', protocol: 1, device_id: dev.device_id, runner_version: 'test', outbox_head_seq: 0, runs: [], form_factor: 'laptop' });
    await r.next('welcome');
    await r.advertise([{ repo_id: h.ids.repo, approvals_from: [], auto_accept_from: [] }]);
    const run = await h.startRun(alice, r);

    const ack = await r.out({ kind: 'handover.write', ...runMsg(run), patch: { hypothesis: 'h1' } });
    assert.deepEqual(ack.versions, [{ seq: r.seq, version: 1 }]);
    const ack2 = await r.out({ kind: 'handover.write', ...runMsg(run), patch: { next: 'n2' } });
    assert.equal(ack2.versions[0].version, 2);

    let v = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body.card;
    assert.equal(v.device_kind, 'laptop');

    await r.out({ kind: 'run.failed', ...runMsg(run), fail_kind: 'limit', reason: 'usage limit', resets_in_ms: 3_600_000 });
    h.clock.advance(60_000);
    v = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body.card;
    assert.deepEqual([v.run_state, v.fail_kind], ['failed', 'limit']);
    assert.equal(v.limit_resets_in_ms, 3_540_000);
  } finally {
    await h.destroy();
  }
});

test('salvage must carry the run repo_id; /api/health says the auth mode', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, r);
    r.send({ type: 'salvage', run_id: run.run_id, card_id: run.card_id, fence: run.fence, kind: 'note', payload: { text: 'x' } });
    const e1 = await r.next('error', (m) => m.code === 'VALIDATION');
    assert.match(e1.message, /repo_id/);
    r.send({ type: 'salvage', ...runMsg(run), repo_id: 'other-repo', kind: 'note', payload: { text: 'x' } });
    const e2 = await r.next('error', (m) => m.code === 'FORBIDDEN');
    assert.match(e2.message, /repo_id/);
    await r.hb([runHb(run)]);
    const health = await h.api(null, 'GET', '/api/health');
    assert.equal(health.body.auth, 'dev');
  } finally {
    await h.destroy();
  }
});
