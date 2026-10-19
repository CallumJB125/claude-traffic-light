// Collaboration paths: trusted @claude comments reach the live run and are
// acked as delivered; agent comments; request changes re-queues with the
// review seeded; release (requeue / fail); board_get_card / board_recall;
// take over → take over myself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHub, runMsg } from './helpers.js';

test('comments: @claude comment → comment.deliver → comment.delivered; agent comment is stored as trusted agent text', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, r);
    const c = await h.api(alice, 'POST', `/api/cards/${run.card_id}/comments`, { request_id: randomUUID(), body: 'also cover the empty case', for_agent: true });
    const del = await r.next('comment.deliver', (m) => m.run_id === run.run_id);
    assert.deepEqual(del.comments.map((x) => [x.comment_id, x.author_name, x.body]), [[c.body.comment.id, 'Alice', 'also cover the empty case']]);
    await r.out({ kind: 'comment.delivered', ...runMsg(run), comment_ids: [c.body.comment.id], via: 'post_tool_use' });
    await r.out({ kind: 'comment.create', ...runMsg(run), text: 'Done: added the empty case', reply_to: c.body.comment.id });
    const d = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body;
    assert.ok(d.comments[0].delivered_age_ms != null, 'seen by Claude');
    assert.deepEqual([d.comments[1].source, d.comments[1].trusted, d.comments[1].author_name, d.comments[1].reply_to], ['agent', true, "Alice's Claude Code", c.body.comment.id]);

    const got = await r.rpc(run, 'board_get_card');
    assert.equal(got.result.card.key, run.key);
    assert.equal(got.result.comments.length, 2);
    await r.out({ kind: 'status.update', ...runMsg(run), summary: 'writing tests' });
    await r.out({ kind: 'progress.append', ...runMsg(run), text: 'tests green locally' });
    const d2 = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body;
    assert.equal(d2.run.status_summary, 'writing tests');
    assert.ok(d2.feed.some((e) => e.kind === 'progress' && e.text === 'tests green locally'));
  } finally {
    await h.destroy();
  }
});

test('request changes → queued with the review seeded; release requeue / release fail', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, r);
    h.github.setPull(7, { head_ref: run.branch });
    const pr = await r.rpc(run, 'board_attach_evidence', { kind: 'pr', ref: '7' });
    const tr = await r.rpc(run, 'board_attach_evidence', { kind: 'test_run', ref: 'npm test', result: 'pass' });
    await r.rpc(run, 'board_complete', { summary: 'ok', evidence_ids: [pr.result.evidence_id, tr.result.evidence_id] });
    const rc = await h.action(alice, run.card_id, 'request_changes', { comment: 'Rename the helper' });
    assert.equal(rc.status, 200);
    assert.equal(h.card(run.card_id).run_state, 'queued');
    const offer = await r.next('offer', (o) => o.card_id === run.card_id && o.fence === run.fence + 1);
    assert.equal(offer.seed.review, 'Rename the helper');

    const cl = await r.claim(offer);
    const run2 = { ...run, run_id: cl.run_id, fence: cl.fence, run_token: cl.run_token };
    await r.out({ kind: 'activity', ...runMsg(run2), source: 'init' });
    await r.out({ kind: 'handover.write', ...runMsg(run2), patch: { next: 'someone with DB access' } });
    const rel = await r.rpc(run2, 'board_release', { reason: 'needs DB access', requeue: true });
    assert.deepEqual(rel.result, { state: 'queued' });
    const offer3 = await r.next('offer', (o) => o.card_id === run.card_id && o.fence === run2.fence + 1);
    assert.match(offer3.seed.handover_md, /someone with DB access/);
    const cl3 = await r.claim(offer3);
    const run3 = { ...run, run_id: cl3.run_id, fence: cl3.fence, run_token: cl3.run_token };
    await r.out({ kind: 'activity', ...runMsg(run3), source: 'init' });
    const rel2 = await r.rpc(run3, 'board_release', { reason: 'product decision needed', requeue: false });
    assert.deepEqual(rel2.result, { state: 'failed' });
    const c = h.card(run.card_id);
    assert.deepEqual([c.fail_kind, c.fail_reason], ['released', 'product decision needed']);
    const ended = await r.rpc(run3, 'board_get_card');
    assert.equal(ended.error.code, 'RUN_ENDED');
  } finally {
    await h.destroy();
  }
});

test('take over from failed → handed_over → take over myself → todo assigned to the taker; board_recall finds the handoff', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const bob = await h.login('bob');
    const r = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, r);
    await r.out({ kind: 'handover.write', ...runMsg(run), patch: { hypothesis: 'cache key collides' } });
    await r.out({ kind: 'run.failed', ...runMsg(run), fail_kind: 'limit', reason: 'usage limit' });
    const t = await h.action(bob, run.card_id, 'take_over');
    assert.equal(t.status, 200);
    assert.equal(t.body.card.run_state, 'handed_over');
    assert.equal(t.body.card.handover_target_name, 'Bob');
    const me = await h.action(bob, run.card_id, 'take_over_myself');
    assert.equal(me.body.card.run_state, 'todo');
    assert.ok(me.body.card.assignee_ids.includes(h.ids.bob));

    const other = await h.startRun(alice, r);
    const rec = await r.rpc(other, 'board_recall', { query: 'cache key' });
    assert.equal(rec.result.memories.length, 1);
    assert.match(rec.result.memories[0].body, /Bob took over.*hypothesis cache key collides/);
    assert.equal(rec.result.memories[0].card_key, run.key);
    const tc = await r.rpc(other, 'team_context');
    assert.match(tc.result.text, /handoff: r1 → next: Bob took over/);
  } finally {
    await h.destroy();
  }
});
