// Exit (l): Hand over → "Handing over · waiting for checkpoint" → handed over
// within 3 min with a handoff memory; teammate approvals are first-wins and
// the second answer is rejected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { T_HANDOVER_MS, HANDOVER_WAIT_MS } from '../../shared/liveness.js';
import { cardFace } from '../../shared/cardface.js';
import { startHub, runMsg, runHb } from './helpers.js';

test('exit (l): hand over to the queue → handover_begin → handover.complete → handed_over + memory → requeued', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const b = await h.browser(alice);
    const run = await h.startRun(alice, r);

    const res = await h.action(alice, run.card_id, 'hand_over', { target: { kind: 'queue' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.card.run_state, 'handing_over');
    assert.match(cardFace(res.body.card).text, /Handing over · waiting for checkpoint/);
    const cmd = await r.next('cmd', (m) => m.cmd === 'handover_begin');
    assert.deepEqual([cmd.fence, cmd.wait_ms], [run.fence, HANDOVER_WAIT_MS]);

    await r.out({ kind: 'handover.write', ...runMsg(run), patch: { hypothesis: 'toJSON drops amount', next: 'add test' } });
    await r.out({ kind: 'snapshot', ...runMsg(run), status: 'pushed', sha: 'cafe123', ref: `refs/board/${run.key}/r${run.fence}` });
    await r.out({ kind: 'handover.complete', ...runMsg(run) });
    await h.hub.idle();
    const c = h.card(run.card_id);
    assert.equal(c.fence, run.fence + 1);
    // The queue follow-up re-dispatches right away.
    assert.equal(c.run_state, 'queued');
    const mem = h.db.get("SELECT * FROM memories WHERE card_id = ? AND kind = 'handoff'", run.card_id);
    assert.match(mem.body, /r1 → next: handed over \(checkpoint complete\); hypothesis toJSON drops amount; next add test/);
    await b.next('card.upsert', (m) => m.card.id === run.card_id && m.card.run_state === 'handed_over');
    const offer = await r.next('offer', (o) => o.card_id === run.card_id && o.fence === run.fence + 1);
    assert.match(offer.seed.handover_md, /toJSON drops amount/);
    const detail = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body;
    assert.equal(detail.memories.length, 1);
  } finally {
    await h.destroy();
  }
});

test('exit (l): no checkpoint within 3 min → handed_over (checkpoint incomplete); hand over to self → todo, assigned', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, r);
    await h.action(alice, run.card_id, 'hand_over', { target: { kind: 'self' } });
    for (let t = 0; t < T_HANDOVER_MS; t += 15_000) {
      h.clock.advance(15_000);
      await r.hb([runHb(run)]);
      await h.tick();
    }
    await h.hub.idle();
    const c = h.card(run.card_id);
    assert.equal(c.run_state, null, 'self → take_myself → todo');
    assert.equal(c.fence, run.fence + 1);
    assert.equal(h.db.get('SELECT role FROM card_assignees WHERE card_id = ? AND member_id = ?', run.card_id, h.ids.alice).role, 'owner');
    const mem = h.db.get("SELECT body FROM memories WHERE card_id = ? AND kind = 'handoff'", run.card_id);
    assert.match(mem.body, /checkpoint incomplete/);
  } finally {
    await h.destroy();
  }
});

test('exit (l): teammate approval is first-wins; the second answer is rejected; non-approvers forbidden', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const bob = await h.login('bob');
    const add = await h.api(alice, 'POST', '/api/members', { request_id: randomUUID(), github_login: 'carol', github_id: -3, email: 'carol@dev.local', display_name: 'Carol', role: 'member' });
    assert.equal(add.status, 200);
    const carol = await h.login('carol');
    const r = await h.runner(await h.enroll(alice), { approvals_from: [h.ids.bob] });
    const run = await h.startRun(alice, r);

    const ap = await r.rpc(run, 'approval', { tool_name: 'Bash', input_summary: 'npm publish' });
    assert.equal(ap.ok, true);
    const prId = ap.result.permission_request_id;
    const c = h.card(run.card_id);
    assert.deepEqual([c.run_state, c.blocked_kind], ['blocked', 'permission']);
    const bobView = (await h.api(bob, 'GET', `/api/cards/${run.card_id}`)).body.card;
    assert.equal(bobView.viewer_can_approve, true);
    assert.deepEqual(new Set(bobView.approvers), new Set([h.ids.alice, h.ids.bob]));
    const carolView = (await h.api(carol, 'GET', `/api/cards/${run.card_id}`)).body.card;
    assert.equal(carolView.viewer_can_approve, false);

    const forbidden = await h.api(carol, 'POST', `/api/permission-requests/${prId}/answer`, { request_id: randomUUID(), decision: 'allow' });
    assert.equal(forbidden.status, 403);

    const [x, y] = await Promise.all([
      h.api(alice, 'POST', `/api/permission-requests/${prId}/answer`, { request_id: randomUUID(), decision: 'deny' }),
      h.api(bob, 'POST', `/api/permission-requests/${prId}/answer`, { request_id: randomUUID(), decision: 'allow', scope: 'run' }),
    ]);
    const statuses = [x.status, y.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const loser = x.status === 409 ? x : y;
    const winner = x.status === 200 ? x : y;
    assert.equal(loser.body.error.code, 'ALREADY_ANSWERED');
    assert.equal(loser.body.error.answered_by, winner === x ? 'Alice' : 'Bob');
    assert.equal(h.card(run.card_id).run_state, 'running');

    await r.hb([]);
    const answers = r.all('answer', (m) => m.permission_request_id === prId);
    assert.equal(answers.length, 1, 'exactly one answer reaches the runner');
    assert.equal(answers[0].answered_by.member_id, winner === x ? h.ids.alice : h.ids.bob);

    // Two stacked requests: first answer keeps the card blocked (9b).
    const p1 = await r.rpc(run, 'approval', { tool_name: 'Bash', input_summary: 'a' });
    const p2 = await r.rpc(run, 'approval', { tool_name: 'Bash', input_summary: 'b' });
    const v = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body.card;
    assert.equal(v.ask.count, 2);
    await h.api(alice, 'POST', `/api/permission-requests/${p1.result.permission_request_id}/answer`, { request_id: randomUUID(), decision: 'allow' });
    assert.equal(h.card(run.card_id).run_state, 'blocked');
    await h.api(alice, 'POST', `/api/permission-requests/${p2.result.permission_request_id}/answer`, { request_id: randomUUID(), decision: 'allow' });
    assert.equal(h.card(run.card_id).run_state, 'running');
  } finally {
    await h.destroy();
  }
});

test('approval_cancel: a CLI-cancelled prompt is withdrawn — card unblocks, late answers are refused, the card face had its id', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, r);
    const ap = await r.rpc(run, 'approval', { tool_name: 'Bash', input_summary: 'make deploy' });
    const prId = ap.result.permission_request_id;
    const view = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body.card;
    assert.equal(view.ask.permission_request_id, prId, 'CardView.ask carries the request id for one-click answers');
    const c1 = await r.rpc(run, 'approval_cancel', { permission_request_id: prId });
    assert.deepEqual([c1.ok, c1.result.state], [true, 'cancelled']);
    assert.equal(h.card(run.card_id).run_state, 'running');
    const late = await h.api(alice, 'POST', `/api/permission-requests/${prId}/answer`, { request_id: randomUUID(), decision: 'allow' });
    assert.equal(late.status, 409);
    const again = await r.rpc(run, 'approval_cancel', { permission_request_id: prId });
    assert.equal(again.result.state, 'cancelled', 'idempotent');
    const detail = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body;
    assert.equal(detail.permission_requests[0].state, 'cancelled');
    assert.ok(detail.feed.some((e) => e.kind === 'withdrawn'));
    const nf = await r.rpc(run, 'approval_cancel', { permission_request_id: 'nope' });
    assert.equal(nf.error.code, 'NOT_FOUND');
  } finally {
    await h.destroy();
  }
});
