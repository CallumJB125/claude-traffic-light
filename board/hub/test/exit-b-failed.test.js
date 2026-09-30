// Exit (b): kill -9 the CLI → the runner reports run.failed → red at once,
// dispatcher notified, and the handover (narrative ≤ 10 min old) with its
// per-layer "last synced" ages is in CardDetail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, runMsg } from './helpers.js';

test('exit (b): run.failed → failed{error} + notify + handover with last-synced ages', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const browser = await h.browser(alice);
    const run = await h.startRun(alice, runner, { title: 'Submit posts {}', body: 'Fix the payload' });

    await runner.out({ kind: 'facts', ...runMsg(run), items: [
      { kind: 'file', path: 'src/submit.ts', op: 'edit' },
      { kind: 'command', cmd: 'npm test', exit: 1, duration_ms: 4200, tail: 'FAIL submit.test.ts' },
      { kind: 'git', branch: run.branch, head_sha: 'abc1234def', commits_ahead: 1 },
    ] });
    await runner.out({ kind: 'handover.write', ...runMsg(run), patch: { hypothesis: 'serializer drops amount', next: 'patch toJSON', done: ['reproduced'] } });
    await runner.out({ kind: 'snapshot', ...runMsg(run), status: 'pushed', sha: 'abc1234def', ref: `refs/board/${run.key}/r${run.fence}`, reason: null });
    h.clock.advance(120_000);

    await runner.out({ kind: 'run.failed', ...runMsg(run), fail_kind: 'error', reason: 'CLI exited without result (signal SIGKILL)' });
    const c = h.card(run.card_id);
    assert.equal(c.run_state, 'failed');
    assert.equal(c.fail_kind, 'error');
    assert.equal(c.active_run_id, null, 'lease released');
    assert.match(c.fail_reason, /SIGKILL/);
    const up = await browser.next('card.upsert', (m) => m.card.id === run.card_id && m.card.run_state === 'failed');
    assert.equal(up.card.live, null, 'no live lease on a failed card');
    assert.equal(up.card.fail_kind, 'error');

    const notes = h.hub.notifications.filter((n) => n.rule === 'failed' && n.card_id === run.card_id);
    assert.equal(notes.length, 1);
    assert.deepEqual(notes[0].to, [h.ids.alice]);

    const detail = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body;
    assert.equal(detail.handover.doc.sections.hypothesis, 'serializer drops amount');
    assert.deepEqual(detail.handover.doc.sections.done, ['reproduced']);
    assert.equal(detail.handover.ages.narrative_ms, 120_000);
    assert.equal(detail.handover.ages.facts_ms, 120_000);
    assert.equal(detail.handover.ages.snapshot_ms, 120_000);
    assert.match(detail.handover.markdown, /Last synced: facts 2m ago · narrative 2m ago · code abc1234 2m ago \(pushed\)/);
    assert.ok(detail.feed.some((e) => e.kind === 'failed'));
    assert.ok(detail.feed.some((e) => e.kind === 'handover_frozen'));
    assert.equal(detail.run.snapshot.status, 'pushed');
    assert.deepEqual(detail.run.touched_paths, ['src/submit.ts']);

    const md = await h.api(alice, 'GET', `/api/cards/${run.card_id}/handover?format=md`);
    assert.match(md.headers.get('content-type'), /text\/markdown/);
    assert.match(md.text, /## Current hypothesis\nserializer drops amount/);

    // The dead run's HB is no longer current (RUN_ENDED); later writes are dropped.
    const ack = await runner.hb([{ run_id: run.run_id, card_id: run.card_id, fence: run.fence, child_alive: false, tool_in_flight: null, last_activity_age_ms: 0, cost_usd: 0, post_wake_activity: false, wake_age_ms: null, gate: 'open', local_state: 'ending' }]);
    assert.deepEqual([ack.runs[0].current, ack.runs[0].reason], [false, 'RUN_ENDED']);

    // Retry re-queues with a seeded handover, on the same member's runner.
    const retry = await h.action(alice, run.card_id, 'retry');
    assert.equal(retry.status, 200);
    const offer = await runner.next('offer', (o) => o.card_id === run.card_id && o.fence === run.fence + 1);
    assert.match(offer.seed.handover_md, /serializer drops amount/);
    assert.deepEqual(offer.seed.from_snapshot, { ref: `refs/board/${run.key}/r${run.fence}`, sha: 'abc1234def' });
    assert.equal(offer.seed.prev_run_n, run.fence);
  } finally {
    await h.destroy();
  }
});

test('exit (b): stop from any active state bumps the fence, sends the stop command and fails the card', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    const r = await h.action(alice, run.card_id, 'stop');
    assert.equal(r.status, 200);
    const c = h.card(run.card_id);
    assert.deepEqual([c.run_state, c.fail_kind, c.fence], ['failed', 'stopped', run.fence + 1]);
    const cmd = await runner.next('cmd', (m) => m.run_id === run.run_id);
    assert.deepEqual([cmd.cmd, cmd.fence], ['stop', run.fence]);
    assert.equal(r.body.card.stopped_by_name, 'Alice');
  } finally {
    await h.destroy();
  }
});
