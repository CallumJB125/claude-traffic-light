// History view feed: GET /api/boards/:id/runs is a bounded, read-only window of
// runs with a derived outcome; a team never sees another team's runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from './helpers.js';
import { tenancy, MARK } from './tenancy/fixture.js';

const runs = (h, cookie, qs = '') => h.api(cookie, 'GET', `/api/boards/${h.ids.board}/runs${qs}`);

test('runs in the window carry AI, outcome, cost and handover flag; cost is null where the AI reports none', async (t) => {
  const h = await startHub(); t.after(() => h.destroy());
  const alice = await h.login('alice');
  const runner = await h.runner(await h.enroll(alice));
  const live = await h.startRun(alice, runner, { title: 'Live card' });
  const done = await h.startRun(alice, runner, { title: 'Codex card' });
  h.db.run("UPDATE runs SET ai = 'codex', backend = 'codex_cli', cost_cents = 500, ended_at = ?, end_reason = 'complete' WHERE id = ?", new Date().toISOString(), done.run_id);
  const res = await runs(h, alice);
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.body.runs.map((r) => [r.id, r]));
  assert.equal(byId[live.run_id].outcome, 'running');
  assert.equal(byId[live.run_id].ended_at, null);
  assert.equal(byId[live.run_id].ai, 'claude');
  assert.equal(byId[done.run_id].outcome, 'finished');
  assert.equal(byId[done.run_id].ai_label, 'Codex');
  assert.equal(byId[done.run_id].cost_usd, null, 'Codex reports no dollars: unavailable, never $5 or $0');
  assert.equal(typeof byId[done.run_id].has_handover, 'boolean');
  assert.equal(byId[done.run_id].key, done.key);
});

test('outcomes: budget, limit, stopped and failed are told apart; runs outside the window are left out', async (t) => {
  const h = await startHub(); t.after(() => h.destroy());
  const alice = await h.login('alice');
  const runner = await h.runner(await h.enroll(alice));
  const mk = async (reason, extra = '') => { const r = await h.startRun(alice, runner, { title: reason }); h.db.run(`UPDATE runs SET ended_at = ?, end_reason = ?${extra} WHERE id = ?`, new Date().toISOString(), reason, r.run_id); return r.run_id; };
  const ids = { budget: await mk('failed:budget'), limit: await mk('failed:limit'), stopped: await mk('stopped'), failed: await mk('failed:error') };
  const old = await mk('complete');
  h.db.run("UPDATE runs SET started_at = '2020-01-01T00:00:00.000Z', ended_at = '2020-01-01T01:00:00.000Z' WHERE id = ?", old);
  const res = await runs(h, alice);
  const byId = Object.fromEntries(res.body.runs.map((r) => [r.id, r.outcome]));
  for (const [outcome, id] of Object.entries(ids)) assert.equal(byId[id], outcome);
  assert.ok(!(old in byId));
  const past = await runs(h, alice, '?from=2019-12-31T00:00:00Z&to=2020-01-02T00:00:00Z');
  assert.deepEqual(past.body.runs.map((r) => r.id), [old]);
});

test('the window is bounded and validated', async (t) => {
  const h = await startHub(); t.after(() => h.destroy());
  const alice = await h.login('alice');
  assert.equal((await runs(h, alice, '?from=nope')).status, 400);
  assert.equal((await runs(h, alice, '?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z')).status, 400);
  assert.equal((await runs(h, alice, '?from=2026-01-01T00:00:00Z&to=2026-10-01T00:00:00Z')).status, 400);
});

test('T-HISTORY: B runs are 404 from A and A never sees B marks', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, B } = fx;
    assert.equal((await as(users.ua, 'GET', `/api/boards/${B.board}/runs`)).status, 404);
    const mine = await as(users.ua, 'GET', `/api/boards/${A.board}/runs`);
    assert.equal(mine.status, 200);
    assert.ok(!mine.text.includes(MARK));
  } finally {
    await fx.h.close();
  }
});
