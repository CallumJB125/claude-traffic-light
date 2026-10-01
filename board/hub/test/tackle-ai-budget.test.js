import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHub, runMsg } from './helpers.js';
import { validate } from '../../shared/protocol.js';

const codex = (over = {}) => ({ id: 'codex', label: 'Codex', installed: true, version: '0.159.2', signedIn: true, startable: true, capabilities: { budget: 'none', resume: true }, ...over });
async function advertise(h, runner, ai) {
  runner.send({ type: 'advertise', repos: [{ repo_id: h.ids.repo }], ai });
  for (let n = 0; n < 100; n++) {
    if (h.hub.runners.get(runner.dev.device_id)?.ai?.[0]?.startable === ai[0]?.startable && h.hub.runners.get(runner.dev.device_id)?.ai?.[0]?.signedIn === ai[0]?.signedIn) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('runner capability update did not arrive');
}
async function fixture(t) {
  const h = await startHub(); t.after(() => h.destroy());
  const alice = await h.login('alice'), bob = await h.login('bob');
  const runner = await h.runner(await h.enroll(alice));
  return { h, alice, bob, runner };
}

test('explicit Codex dispatch reaches only a ready Codex device, persists backend and carries no dollar cap', async (t) => {
  const { h, alice, runner } = await fixture(t);
  await advertise(h, runner, [codex()]);
  const card = await h.createCard(alice);
  assert.equal((await h.action(alice, card.id, 'dispatch', { ai: 'codex', budget_usd: null })).status, 200);
  const offer = await runner.next('offer', (m) => m.card_id === card.id);
  assert.equal(offer.ai, 'codex'); assert.equal(offer.budget_usd, null); assert.equal(offer.budget_mode, 'none');
  const claim = await runner.claim(offer); assert.equal(claim.ok, true);
  const run = h.hub.run(claim.run_id); assert.equal(run.backend, 'codex_cli'); assert.equal(run.ai, 'codex'); assert.equal(run.budget_cents, null);
  const detail = await h.api(alice, 'GET', `/api/cards/${card.id}`);
  assert.equal(detail.body.card.run.ai_label, 'Codex');
  assert.equal(detail.body.run.cost_usd, null); assert.equal(detail.body.run.cost_source, 'unavailable');
  // Historical/fabricated numbers must not turn missing Codex telemetry
  // into a measured/free claim, and agent comments name the actual AI.
  h.db.run('UPDATE runs SET cost_cents = 123 WHERE id = ?', run.id);
  await runner.out({ ...runMsg({ ...run, run_id: run.id }), kind: 'comment.create', text: 'A Codex comment' });
  const after = await h.api(alice, 'GET', `/api/cards/${card.id}`);
  assert.equal(after.body.run.cost_usd, null); assert.equal(after.body.run.cost_source, 'unavailable');
  assert.equal(after.body.comments[0].author_name, "Alice's Codex");
});

test('legacy dollar projections distinguish unavailable telemetry from an observed zero', async (t) => {
  const { h, alice, runner } = await fixture(t);
  const run = await h.startRun(alice, runner, { budget_usd: 5 });
  h.db.run('UPDATE runs SET cost_cents = 0 WHERE id = ?', run.run_id);
  const detail = () => h.api(alice, 'GET', `/api/cards/${run.card_id}`);
  assert.equal((await detail()).body.run.cost_usd, null);
  await runner.out({ ...runMsg(run), kind: 'facts', items: [{ kind: 'cost', cost_usd: 0 }] });
  assert.equal((await detail()).body.run.cost_usd, 0);
  assert.equal((await detail()).body.run.cost_source, 'provider_reported');
  await runner.out({ ...runMsg(run), kind: 'facts', items: [{ kind: 'cost', cost_usd: 1.25 }] });
  assert.equal((await detail()).body.run.cost_usd, 1.25);
});

test('old runners cannot steal Codex dispatch by guessing a claim; readiness changes re-offer it', async (t) => {
  const { h, alice, runner } = await fixture(t);
  const card = await h.createCard(alice);
  const request_id = randomUUID();
  assert.equal((await h.action(alice, card.id, 'dispatch', { request_id, ai: 'codex', budget_usd: null })).status, 200);
  const forged = { card_id: card.id, request_id, fence: h.card(card.id).fence };
  assert.equal((await runner.claim(forged)).error.code, 'POLICY_DENIED');
  assert.equal(runner.all('offer', (m) => m.card_id === card.id).length, 0);
  await advertise(h, runner, [codex({ signedIn: false })]);
  assert.equal((await runner.claim(forged)).error.code, 'POLICY_DENIED');
  await advertise(h, runner, [codex({ startable: false })]);
  assert.equal((await runner.claim(forged)).error.code, 'POLICY_DENIED');
  await advertise(h, runner, [codex()]);
  assert.equal((await runner.claim(await runner.next('offer', (m) => m.card_id === card.id))).ok, true);
});

test('Codex refuses a native dollar cap and a mismatched backend without changing the card', async (t) => {
  const { h, alice } = await fixture(t);
  const card = await h.createCard(alice);
  for (const body of [{ ai: 'codex', budget_usd: 5 }, { ai: 'codex' }, { ai: 'codex', backend: 'claude_cli', budget_usd: null }, { ai: 'unknown', budget_usd: null }]) {
    assert.notEqual((await h.action(alice, card.id, 'dispatch', body)).status, 200);
    assert.equal(h.card(card.id).run_state, null); assert.equal(h.hub.pendingDispatch(card.id), null);
  }
});

test('uncapped teammate dispatch requires the machine owner or an admin', async (t) => {
  const { h, alice, bob } = await fixture(t);
  const card = await h.createCard(alice);
  const denied = await h.action(bob, card.id, 'dispatch', { ai: 'codex', budget_usd: null, target_member_id: h.ids.alice });
  assert.equal(denied.status, 403); assert.equal(denied.body.error.reason, 'BUDGET_REQUIRED');
  assert.equal((await h.action(alice, card.id, 'dispatch', { ai: 'codex', budget_usd: null, target_member_id: h.ids.bob })).status, 200);
});

test('legacy capped retries offer remaining card budget and prevent other writers raising spent caps', async (t) => {
  const { h, alice, bob, runner } = await fixture(t);
  const run = await h.startRun(alice, runner, { budget_usd: 5 });
  await runner.out({ ...runMsg(run), kind: 'facts', items: [{ kind: 'cost', cost_usd: 3 }] });
  await runner.out({ ...runMsg(run), kind: 'run.failed', fail_kind: 'error', reason: 'fixture' });
  const denial = await h.action(bob, run.card_id, 'retry', { budget_usd: 8 }); assert.equal(denial.status, 403);
  const retry = await h.action(alice, run.card_id, 'retry'); assert.equal(retry.status, 200);
  const offer = await runner.next('offer', (m) => m.card_id === run.card_id && m.fence !== run.fence);
  assert.equal(offer.budget_usd, 2); assert.equal(offer.ai, undefined);
  const claim = await runner.claim(offer); assert.equal(h.hub.run(claim.run_id).budget_cents, 200);
});

test('a legacy board-default cap cannot be raised by an unrelated writer after spend', async (t) => {
  const { h, alice, bob, runner } = await fixture(t);
  h.db.run('UPDATE boards SET settings = ? WHERE id = ?', JSON.stringify({ default_budget_usd: 5 }), h.ids.board);
  const run = await h.startRun(alice, runner);
  assert.equal(h.card(run.card_id).budget_cents, null);
  await runner.out({ ...runMsg(run), kind: 'facts', items: [{ kind: 'cost', cost_usd: 1 }] });
  await runner.out({ ...runMsg(run), kind: 'run.failed', fail_kind: 'error' });
  assert.equal((await h.action(bob, run.card_id, 'retry', { budget_usd: 8 })).status, 403);
});

test('dispatch choices are idempotent and a reused request cannot replace its AI or cap', async (t) => {
  const { h, alice } = await fixture(t);
  const card = await h.createCard(alice), request_id = randomUUID();
  const body = { request_id, ai: 'codex', budget_usd: null };
  assert.equal((await h.action(alice, card.id, 'dispatch', body)).status, 200);
  assert.equal((await h.action(alice, card.id, 'dispatch', body)).status, 200);
  assert.equal((await h.action(alice, card.id, 'dispatch', { request_id, ai: 'claude', budget_usd: 5 })).status, 409);
  assert.equal(h.hub.pendingDispatch(card.id).ai, 'codex');
});

test('overlap preview returns bounded capability projections and scopes the selected repo', async (t) => {
  const { h, alice, runner } = await fixture(t);
  await advertise(h, runner, [codex({ label: 'Untrusted custom label' })]);
  const card = await h.createCard(alice);
  const response = await h.api(alice, 'GET', `/api/cards/${card.id}/overlap-preview`);
  assert.equal(response.body.runners[0].ai[0].label, 'Codex');
  assert.deepEqual(Object.keys(response.body.runners[0].ai[0]).sort(), ['available', 'budget', 'id', 'label', 'legacy', 'reason']);
  assert.equal((await h.api(alice, 'GET', `/api/cards/${card.id}/overlap-preview?repo_id=foreign-repo`)).status, 404);
});

test('wire capability validation rejects malformed, repeated and unsupported providers', () => {
  const frame = (ai) => ({ type: 'advertise', repos: [], ai });
  assert.equal(validate('runner→hub', frame([codex()])), null);
  for (const list of [null, new Array(9).fill(codex()), [codex(), codex()], [codex({ id: '../codex' })], [codex({ signedIn: 'yes' })], [codex({ startable: 'yes' })], [codex({ capabilities: { budget: 'unlimited', resume: true } })], [codex({ label: 'Codex\n/path' })]]) assert.equal(validate('runner→hub', frame(list)).code, 'VALIDATION');
});

test('queued paid dispatch rechecks the actor role before creating a dispatch', async (t) => {
  const { h, alice } = await fixture(t);
  const card = await h.createCard(alice);
  h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", h.ids.bob);
  let release;
  const held = h.hub.withBoard(h.ids.board, () => new Promise((r) => { release = r; }));
  await new Promise((r) => setImmediate(r));
  const pending = h.action(alice, card.id, 'dispatch', { ai: 'codex', budget_usd: null });
  await new Promise((r) => setTimeout(r, 30));
  h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", h.ids.alice);
  release(); await held;
  assert.equal((await pending).status, 403); assert.equal(h.hub.pendingDispatch(card.id), null);
});

test('queued claim rechecks device revocation inside the board queue', async (t) => {
  const { h, alice, runner } = await fixture(t);
  await advertise(h, runner, [codex()]);
  const card = await h.createCard(alice);
  await h.action(alice, card.id, 'dispatch', { ai: 'codex', budget_usd: null });
  const offer = await runner.next('offer', (m) => m.card_id === card.id);
  let release;
  const held = h.hub.withBoard(h.ids.board, () => new Promise((r) => { release = r; }));
  await new Promise((r) => setImmediate(r));
  const pending = runner.claim(offer);
  await new Promise((r) => setTimeout(r, 30));
  h.db.run('UPDATE devices SET revoked_at = ? WHERE id = ?', h.hub.iso(), runner.dev.device_id);
  release(); await held;
  assert.equal((await pending).error.code, 'POLICY_DENIED');
  assert.equal(h.card(card.id).run_state, 'queued'); assert.equal(h.hub.latestRun(card.id), null);
});
