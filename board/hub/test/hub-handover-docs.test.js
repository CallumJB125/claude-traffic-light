// Every managed run that ends abnormally, is stopped, stalls or hits its
// budget leaves a handover. When the AI wrote none, the hub writes a
// facts-only one and says so; the AI's own narrative always wins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TTL_MS, T_HANDOVER_MS } from '../../shared/liveness.js';
import { startHub, runMsg, runHb } from './helpers.js';

const rows = (h, cardId) => h.db.all('SELECT * FROM handovers WHERE card_id = ? ORDER BY version', cardId);
const doc = async (h, cookie, cardId) => (await h.api(cookie, 'GET', `/api/cards/${cardId}/handover`)).body;

async function withFacts(runner, run) {
  await runner.out({ kind: 'facts', ...runMsg(run), items: [
    { kind: 'file', path: 'src/submit.ts', op: 'edit' },
    { kind: 'command', cmd: 'npm test', exit: 1, duration_ms: 1000, tail: 'FAIL' },
  ] });
}

test('runner dies: the orphaned run gets a labelled hub-written handover', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    await withFacts(runner, run);
    runner.terminate();
    await h.run(300_000);
    assert.equal(h.card(run.card_id).run_state, 'orphaned');
    const r = rows(h, run.card_id);
    assert.equal(r.length, 1, 'written once, at the stall; the orphaning does not add another');
    assert.equal(r[0].written_by, 'system');
    assert.equal(r[0].provenance, 'hub_facts_only');
    assert.equal(r[0].run_id, run.run_id);
    const d = await doc(h, alice, run.card_id);
    assert.match(d.markdown, /Hub-written handover \(facts only\): the runner stopped answering/);
    assert.match(d.markdown, /src\/submit\.ts · edit/);
    assert.match(d.markdown, /npm test/);
  } finally { await h.destroy(); }
});

test('stopping a run whose runner is offline still leaves a handover', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    runner.terminate();
    const stop = await h.action(alice, run.card_id, 'stop');
    assert.equal(stop.status, 200);
    const [row] = rows(h, run.card_id);
    assert.equal(row.written_by, 'system');
    assert.match((await doc(h, alice, run.card_id)).markdown, /Hub-written handover \(facts only\): the run was stopped/);
  } finally { await h.destroy(); }
});

test('budget stop leaves a handover too', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    await runner.out({ kind: 'run.failed', ...runMsg(run), fail_kind: 'budget', reason: 'budget reached', budget_scope: 'card' });
    assert.equal(h.card(run.card_id).fail_kind, 'budget');
    assert.match((await doc(h, alice, run.card_id)).markdown, /the run stopped at its budget/);
  } finally { await h.destroy(); }
});

test('the AI\'s own narrative for the run is never replaced by a hub-written one', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    await runner.out({ kind: 'handover.write', ...runMsg(run), patch: { hypothesis: 'serializer drops amount' } });
    await runner.out({ kind: 'run.failed', ...runMsg(run), fail_kind: 'error', reason: 'CLI exited' });
    const r = rows(h, run.card_id);
    assert.deepEqual(r.map((x) => x.written_by), ['claude']);
    assert.doesNotMatch((await doc(h, alice, run.card_id)).markdown, /Hub-written/);
  } finally { await h.destroy(); }
});

test('a stall is written once; recovery keeps the facts live and the AI may still write its own', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    h.clock.advance(TTL_MS + 5000);
    await h.tick();
    await h.tick(1000);
    assert.equal(rows(h, run.card_id).length, 1);
    await runner.hb([runHb(run)]);
    await runner.out({ kind: 'handover.write', ...runMsg(run), patch: { next: 'finish the serializer' } });
    const r = rows(h, run.card_id);
    assert.deepEqual(r.map((x) => x.written_by), ['system', 'claude']);
    assert.doesNotMatch((await doc(h, alice, run.card_id)).markdown, /Hub-written/, 'the AI narrative supersedes the label');
  } finally { await h.destroy(); }
});

test('strict hold handover: a runner that never confirms leaves the hub-written doc and starts no replacement', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    const view = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body.card;
    runner.terminate();
    const res = await h.action(alice, run.card_id, 'hand_over', { target: { kind: 'hold' }, expected_fence: view.fence, prior_run_id: run.run_id });
    assert.equal(res.status, 200);
    await h.run(T_HANDOVER_MS + 2000);
    const c = h.card(run.card_id);
    assert.equal(c.run_state, 'handed_over');
    assert.equal(c.handover_provenance, 'checkpoint_incomplete');
    assert.equal(h.hub.pendingDispatch(run.card_id), null, 'no autoqueue after an unconfirmed handover');
    assert.equal(rows(h, run.card_id).at(-1).written_by, 'system');
    const next = await h.action(alice, run.card_id, 'take_over_with_claude', { expected_fence: c.fence, prior_run_id: run.run_id });
    assert.equal(next.status, 409, 'the next AI cannot start until the stop is confirmed');
  } finally { await h.destroy(); }
});
