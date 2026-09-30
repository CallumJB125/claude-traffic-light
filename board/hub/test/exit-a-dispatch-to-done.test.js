// Exit (a): Give to Claude → green ≤ 60 s → In review with a hub-verified PR
// + tests → Done on merge, with zero manual column moves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, runMsg, runHb } from './helpers.js';

test('exit (a): dispatch → claim → green → in_review (hub-verified PR + tests) → done on merge', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const dev = await h.enroll(alice, 'MacBook-Pro');
    const runner = await h.runner(dev);
    const browser = await h.browser(alice);

    const card = await h.createCard(alice, { title: 'Submit posts {}', body: 'Fix the payload', acceptance: 'bank sees the amount' });
    assert.equal(card.run_state, 'todo');
    const d = await h.action(alice, card.id, 'dispatch');
    assert.equal(d.status, 200);
    assert.equal(d.body.card.run_state, 'queued');
    assert.equal(d.body.card.target.is_viewer, true);

    const offer = await runner.next('offer', (o) => o.card_id === card.id);
    assert.equal(offer.key, card.key);
    assert.equal(offer.fence, 0);
    assert.equal(offer.needs_confirm, false);
    assert.equal(offer.dispatched_by.member_id, h.ids.alice);

    const claim = await runner.claim(offer);
    assert.equal(claim.ok, true);
    assert.equal(claim.fence, 1);
    assert.equal(claim.branch, `board/${card.key}-r1`);
    assert.equal(claim.snapshot_ref, `refs/board/${card.key}/r1`);
    assert.match(claim.run_token, /^brt1\./);
    assert.equal(h.card(card.id).run_state, 'claimed');

    const run = { card_id: card.id, run_id: claim.run_id, fence: 1, run_token: claim.run_token, repo_id: h.ids.repo };
    h.clock.advance(20_000);
    await runner.out({ kind: 'activity', ...runMsg(run), source: 'init' });
    const ack = await runner.hb([runHb(run)]);
    assert.deepEqual(ack.runs.map((r) => [r.current, r.state]), [[true, 'running']]);

    const view = (await h.api(alice, 'GET', `/api/cards/${card.id}`)).body.card;
    assert.equal(view.run_state, 'running');
    assert.equal(view.live.green, true, 'green within 60 s of dispatch');
    assert.equal(view.run.device_name, 'MacBook-Pro');
    assert.equal(view.run.owner.name, 'Alice');
    await h.tick();
    await browser.next('card.upsert', (m) => m.card.id === card.id && m.card.run_state === 'running');
    const tick = await browser.next('lease.tick', (m) => m.card_id === card.id);
    assert.equal(tick.live.green, true);

    // Evidence: a PR on the run branch (hub-verified) + a passing test run.
    h.github.setPull(12, { head_ref: run.branch ?? `board/${card.key}-r1` });
    const pr = await runner.rpc(run, 'board_attach_evidence', { kind: 'pr', ref: '#12', summary: 'PR' });
    assert.equal(pr.ok, true);
    assert.equal(pr.result.verification, 'hub_verified');
    const tr = await runner.rpc(run, 'board_attach_evidence', { kind: 'test_run', ref: 'npm test', result: 'pass' });
    assert.equal(tr.result.verification, 'self_reported');

    const missing = await runner.rpc(run, 'board_complete', { summary: 'done', evidence_ids: [tr.result.evidence_id] });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'EVIDENCE_MISSING');

    const done = await runner.rpc(run, 'board_complete', { summary: 'done', evidence_ids: [pr.result.evidence_id, tr.result.evidence_id] });
    assert.deepEqual(done.result, { state: 'in_review' });
    let c = h.card(card.id);
    assert.equal(c.run_state, 'in_review');
    assert.equal(c.column_name, 'in_review');
    const rv = (await h.api(alice, 'GET', `/api/cards/${card.id}`)).body.card;
    assert.equal(rv.pr.number, 12);
    assert.deepEqual(rv.evidence, { tests: 'pass', verification: 'hub_verified' });

    // Merge poll: open → nothing; merged → done.
    await h.hub.pollMerges();
    assert.equal(h.card(card.id).run_state, 'in_review');
    h.github.setPull(12, { head_ref: `board/${card.key}-r1`, state: 'closed', merged: true, merged_by: 'alice', merged_at: '2026-09-30T10:05:00Z' });
    await h.hub.pollMerges();
    c = h.card(card.id);
    assert.equal(c.run_state, 'done');
    assert.equal(c.column_name, 'done');
    const final = (await h.api(alice, 'GET', `/api/cards/${card.id}`)).body;
    assert.equal(final.card.pr.state, 'merged');
    assert.ok(final.feed.some((e) => e.kind === 'merged'));
    // Zero manual moves: no PATCH ever touched the column.
    assert.equal(h.db.get("SELECT count(*) AS n FROM audit WHERE action LIKE 'card.%'").n, 0);
  } finally {
    await h.destroy();
  }
});

test('exit (a): a closed-unmerged PR sends the card back to todo; approve_done needs a human', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    h.github.setPull(3, { head_ref: run.branch });
    const pr = await runner.rpc(run, 'board_attach_evidence', { kind: 'pr', ref: 'https://github.com/acme/app/pull/3' });
    const nt = await runner.rpc(run, 'board_attach_evidence', { kind: 'no_tests_reason', ref: 'docs only' });
    await runner.rpc(run, 'board_complete', { summary: 's', evidence_ids: [pr.result.evidence_id, nt.result.evidence_id] });
    h.github.setPull(3, { head_ref: run.branch, state: 'closed', merged: false });
    await h.hub.pollMerges();
    assert.equal(h.card(run.card_id).run_state, null, 'todo is stored as NULL');

    const second = await h.startRun(alice, runner);
    const pr2 = await runner.rpc(second, 'board_attach_evidence', { kind: 'commit', ref: 'abc1234' });
    assert.equal(pr2.result.verification, 'self_reported', 'unknown commit stays self-reported');
    h.github.commits.add('abcdef1');
    const c2 = await runner.rpc(second, 'board_attach_evidence', { kind: 'commit', ref: 'abcdef1' });
    assert.equal(c2.result.verification, 'hub_verified');
    const foreign = await runner.rpc(second, 'board_complete', { summary: 's', evidence_ids: [c2.result.evidence_id, nt.result.evidence_id] });
    assert.equal(foreign.error.code, 'EVIDENCE_MISSING', "another card's evidence never counts");
    const nt2 = await runner.rpc(second, 'board_attach_evidence', { kind: 'no_tests_reason', ref: 'docs only' });
    await runner.rpc(second, 'board_complete', { summary: 's', evidence_ids: [c2.result.evidence_id, nt2.result.evidence_id] });
    assert.equal(h.card(second.card_id).run_state, 'in_review');
    const ok = await h.action(alice, second.card_id, 'approve_done');
    assert.equal(ok.status, 200);
    assert.equal(h.card(second.card_id).run_state, 'done');
  } finally {
    await h.destroy();
  }
});
