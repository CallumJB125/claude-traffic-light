// P1 Trust: a dead agent never looks green. Kill the runner → unresponsive at
// TTL → orphaned at T_orphan (after boot grace), orphan notification only
// after ≥ 10 min orphaned, green never shown once the predicate fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TTL_MS, T_ORPHAN_MS, ORPHAN_NOTIFY_MS, T_QUIET_MS } from '../../shared/liveness.js';
import { cardView } from '../views.js';
import { startHub, runHb, runMsg } from './helpers.js';

const view = (h, id) => cardView(h.hub, h.card(id), h.ids.alice);

test('killed runner: never green after TTL; unresponsive at TTL, orphaned at T_orphan, notify after 10 min', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    assert.equal(view(h, run.card_id).live.green, true);

    runner.terminate();
    let unresponsiveAt = null;
    let orphanedAt = null;
    for (let s = 1; s <= 330; s++) {
      await h.tick(1000);
      const v = view(h, run.card_id);
      if (s * 1000 > TTL_MS) assert.equal(v.live?.green ?? false, false, `green at +${s}s after kill`);
      if (v.run_state === 'unresponsive' && unresponsiveAt == null) unresponsiveAt = s;
      if (v.run_state === 'orphaned' && orphanedAt == null) orphanedAt = s;
    }
    assert.equal(unresponsiveAt, TTL_MS / 1000 + 1, 'unresponsive on the first tick past TTL');
    assert.equal(orphanedAt, T_ORPHAN_MS / 1000, 'orphaned at T_orphan of silence');
    assert.equal(h.card(run.card_id).resume_to, 'quiet');
    assert.equal(h.hub.notifications.filter((n) => n.rule === 'orphaned').length, 0, 'no orphan notification yet');

    await h.run(ORPHAN_NOTIFY_MS);
    const notes = h.hub.notifications.filter((n) => n.rule === 'orphaned' && n.card_id === run.card_id);
    assert.equal(notes.length, 1, 'orphan notification once, after ≥ 10 min orphaned');
    assert.deepEqual(notes[0].to, [h.ids.alice]);
    await h.run(5000);
    assert.equal(h.hub.notifications.filter((n) => n.rule === 'orphaned').length, 1, 'only once');
    const detail = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body;
    assert.ok(detail.feed.some((e) => e.kind === 'handover_frozen'));
  } finally {
    await h.destroy();
  }
});

test('boot grace: no orphaning before hub uptime ≥ T_orphan', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    runner.terminate();
    await h.run(T_ORPHAN_MS - 2000);
    assert.equal(h.card(run.card_id).run_state, 'unresponsive');
    await h.run(3000);
    assert.equal(h.card(run.card_id).run_state, 'orphaned');
  } finally {
    await h.destroy();
  }
});

test('tunnel self-probe unhealthy suspends orphaning; healthy again restarts the count', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    runner.terminate();
    await h.run(60_000);
    h.hub.noteTunnel(false);
    await h.run(T_ORPHAN_MS);
    assert.equal(h.card(run.card_id).run_state, 'unresponsive', 'TUNNEL_DOWN guard');
    h.hub.noteTunnel(true);
    await h.run(T_ORPHAN_MS - 2000);
    assert.equal(h.card(run.card_id).run_state, 'unresponsive', 'needs T_orphan of healthy tunnel');
    await h.run(3000);
    assert.equal(h.card(run.card_id).run_state, 'orphaned');
  } finally {
    await h.destroy();
  }
});

test('orphaned runner that returns: RECOVER to quiet, relabelled, orphan notification cancelled; green needs fresh activity', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const dev = await h.enroll(alice);
    const r1 = await h.runner(dev);
    const run = await h.startRun(alice, r1);
    r1.terminate();
    await h.run(T_ORPHAN_MS + 5000);
    assert.equal(h.card(run.card_id).run_state, 'orphaned');

    const r2 = await h.runner(dev, { runs: [{ run_id: run.run_id, card_id: run.card_id, fence: run.fence, local_state: 'paused_offline' }] });
    const ack = await r2.hb([runHb(run, { last_activity_age_ms: T_ORPHAN_MS + 60_000 })]);
    assert.equal(ack.runs[0].current, true);
    assert.equal(h.card(run.card_id).run_state, 'quiet');
    assert.equal(view(h, run.card_id).live.green, false, 'not green after recovery');
    // Append-only relabel (P-1): a new row joins onto the orphaned line; the feed shows it.
    const orphanEv = h.db.get("SELECT id, payload FROM events WHERE card_id = ? AND kind = 'orphaned'", run.card_id);
    assert.equal(JSON.parse(orphanEv.payload).relabel, undefined, 'the orphaned row is never rewritten');
    const rl = h.db.get("SELECT payload FROM events WHERE card_id = ? AND kind = 'orphan_relabel'", run.card_id);
    assert.deepEqual(JSON.parse(rl.payload), { event_id: orphanEv.id, relabel: 'was asleep' });
    const feed = (await h.api(await h.login('alice'), 'GET', `/api/cards/${run.card_id}`)).body.feed;
    assert.equal(feed.find((e) => e.kind === 'orphaned').text, 'Orphaned (was asleep)');
    assert.ok(h.db.get("SELECT 1 AS x FROM journal WHERE card_id = ? AND kind = 'feed.relabel'", run.card_id));

    await r2.out({ kind: 'activity', ...runMsg(run), source: 'replay' }, { delayed: true });
    assert.equal(h.card(run.card_id).run_state, 'quiet', 'delayed activity never moves a card');
    await r2.out({ kind: 'activity', ...runMsg(run), source: 'tool_start' });
    await r2.hb([runHb(run)]);
    assert.equal(h.card(run.card_id).run_state, 'running');
    assert.equal(view(h, run.card_id).live.green, true);
    await h.run(ORPHAN_NOTIFY_MS + 1000, 5000);
    assert.equal(h.hub.notifications.filter((n) => n.rule === 'orphaned').length, 0, 'returned before 10 min: nothing sent');
  } finally {
    await h.destroy();
  }
});

test('child not alive or no progress → never green; quiet after T_quiet; tool within bound keeps progress', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    await runner.hb([runHb(run, { child_alive: false })]);
    assert.equal(view(h, run.card_id).live.green, false, 'child dead');
    await runner.hb([runHb(run)]);
    assert.equal(view(h, run.card_id).live.green, true);

    // A long Bash within its bound keeps it running; HBs keep the lease.
    await runner.out({ kind: 'facts', ...runMsg(run), items: [{ kind: 'tool_start', name: 'Bash', summary: 'npm test', bash_timeout_ms: 600_000 }] });
    for (let t = 0; t < T_QUIET_MS + 60_000; t += 15_000) {
      h.clock.advance(15_000);
      await runner.hb([runHb(run, { last_activity_age_ms: t + 15_000, tool_in_flight: { name: 'Bash', summary: 'npm test', age_ms: t + 15_000, bash_timeout_ms: 600_000 } })]);
      await h.tick();
    }
    assert.equal(h.card(run.card_id).run_state, 'running', 'tool within bound');
    // Tool ends, no more activity → quiet after T_quiet, never green.
    await runner.out({ kind: 'facts', ...runMsg(run), items: [{ kind: 'tool_end', name: 'Bash', ok: true }] });
    for (let t = 0; t < 60_000; t += 15_000) {
      h.clock.advance(15_000);
      await runner.hb([runHb(run, { last_activity_age_ms: T_QUIET_MS + 120_000 })]);
      await h.tick();
    }
    assert.equal(h.card(run.card_id).run_state, 'quiet');
    assert.equal(view(h, run.card_id).live.green, false);
  } finally {
    await h.destroy();
  }
});
