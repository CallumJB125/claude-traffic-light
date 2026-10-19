// AI review before Review (066): settings and disclosure, the review_request
// effect on row 31, reviewer choice (a different provider, or the same one
// recorded honestly), review.result parsing and authority, caps, timeouts,
// and the fix / approve / dismiss actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHub, runHb, settle, until } from './helpers.js';
import { REVIEW_TIMEOUT_MS } from '../../shared/review.js';
import { cardFace } from '../../shared/cardface.js';

const AIS = [
  { id: 'claude', label: 'Claude Code', installed: true, signedIn: true, startable: true, capabilities: { budget: 'native', resume: true } },
  { id: 'codex', label: 'Codex', installed: true, signedIn: true, startable: true, capabilities: { budget: 'none', resume: true } },
];

async function rig(fn, { review = true, ais = AIS } = {}) {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const bob = await h.login('bob');
    const dev = await h.enroll(alice, 'MacBook');
    const runner = await h.runner(dev, { advertise: false });
    runner.send({ type: 'advertise', repos: [{ repo_id: h.ids.repo, approvals_from: [], auto_accept_from: [] }], ai: ais, ...(review ? { review: true } : {}) });
    await settle(40);
    await fn({ h, alice, bob, runner, dev });
  } finally {
    await h.destroy();
  }
}

const settings = (h, cookie, body) => h.api(cookie, 'PATCH', `/api/boards/${h.ids.board}/review-settings`, { request_id: randomUUID(), ...body });
const enable = (h, cookie, over = {}) => settings(h, cookie, { enabled: true, acknowledge_disclosure: true, ...over });

// Dispatch → claim → running → evidence → board_complete: the card is in_review.
async function finish(h, alice, runner, fields = {}) {
  const run = await h.startRun(alice, runner, fields);
  const n = 100 + Math.floor(Math.random() * 1000);
  h.github.setPull(n, { head_ref: run.branch });
  const pr = await runner.rpc(run, 'board_attach_evidence', { kind: 'pr', ref: `#${n}` });
  const tr = await runner.rpc(run, 'board_attach_evidence', { kind: 'test_run', ref: 'npm test', result: 'pass' });
  const done = await runner.rpc(run, 'board_complete', { summary: 'done', evidence_ids: [pr.result.evidence_id, tr.result.evidence_id] });
  assert.deepEqual(done.result, { state: 'in_review' });
  return run;
}

const reviewsOf = (h, cardId) => h.db.all('SELECT * FROM card_reviews WHERE card_id = ? ORDER BY created_at', cardId);
const result = (runner, offer, over = {}) => runner.send({ type: 'review.result', review_id: offer.review_id, card_id: offer.card_id, repo_id: offer.repo_id, ok: true,
  output: JSON.stringify({ verdict: 'changes_requested', summary: 'One real bug.', findings: [{ file: 'src/a.js', line: 3, severity: 'high', rationale: 'off by one' }] }),
  cost_usd: 0.03, files: ['src/a.js'], signals: [], truncated: false, model: 'sonnet', ...over });

test('settings: off by default; admins only; turning on needs the disclosure; caps are bounded', () => rig(async ({ h, alice, bob }) => {
  const read = await h.api(bob, 'GET', `/api/boards/${h.ids.board}/review-settings`);
  assert.equal(read.status, 200);
  assert.equal(read.body.settings.enabled, false);
  assert.match(read.body.disclosure, /diff/);
  assert.equal(read.body.can_edit, false);
  assert.equal((await enable(h, bob)).status, 403);
  const noAck = await settings(h, alice, { enabled: true });
  assert.equal(noAck.status, 400);
  assert.match(noAck.text, /DISCLOSURE_REQUIRED/);
  assert.equal((await enable(h, alice, { spend_cap_usd: 5 })).status, 400);
  assert.equal((await enable(h, alice, { provider: 'gemini' })).status, 400);
  const on = await enable(h, alice, { spend_cap_usd: 0.2, provider: 'auto' });
  assert.equal(on.status, 200, on.text);
  assert.deepEqual(on.body.settings, { enabled: true, provider: 'auto', model: 'sonnet', spend_cap_usd: 0.2, allow_uncapped: false, disclosure_ack: true });
  const switched = await settings(h, alice, { allow_uncapped: true });
  assert.equal(switched.status, 400, 'a reviewer without a cap needs the disclosure again');
  const off = await settings(h, alice, { enabled: false });
  assert.equal(off.body.settings.disclosure_ack, false);
  assert.equal((await settings(h, alice, { enabled: true })).status, 400, 'turning it on again asks again');
  assert.ok(h.db.get("SELECT 1 x FROM journal WHERE kind = 'board.ai_review'"));
}));

test('off: a finished run goes to Review with no review and no offer', () => rig(async ({ h, alice, runner }) => {
  const run = await finish(h, alice, runner);
  await settle(40);
  assert.equal(h.card(run.card_id).run_state, 'in_review');
  assert.deepEqual(reviewsOf(h, run.card_id), []);
  assert.equal(runner.all('review.offer').length, 0);
}));

test('on: row 31 asks for a review; only Claude can honour the cap, so it reviews Claude\'s work as the same provider', () => rig(async ({ h, alice, runner }) => {
  await enable(h, alice, { spend_cap_usd: 0.15 });
  const run = await finish(h, alice, runner, { acceptance: 'totals match' });
  const offer = await runner.next('review.offer', (o) => o.card_id === run.card_id);
  assert.equal(h.card(run.card_id).run_state, 'in_review', 'the review never moves the card');
  assert.equal(offer.ai, 'claude');
  assert.equal(offer.author_ai, 'claude');
  assert.equal(offer.budget_usd, 0.15);
  assert.equal(offer.model, 'sonnet');
  assert.equal(offer.base_ref, 'main');
  assert.deepEqual(offer.heads, [run.branch]);
  assert.equal(offer.acceptance, 'totals match');
  assert.equal(offer.tests, 'pass');
  const row = reviewsOf(h, run.card_id)[0];
  assert.deepEqual([row.status, row.provider, row.independence, row.run_id, row.cap_cents], ['pending', 'claude', 'same_provider', run.run_id, 15]);
  const view = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body;
  assert.equal(view.card.review.status, 'pending');
  assert.equal(view.reviews[0].independence, 'same_provider');
}));

test('on with uncapped reviewers allowed: a different provider (Codex) reviews Claude\'s work, with no dollar cap', () => rig(async ({ h, alice, runner }) => {
  await enable(h, alice, { allow_uncapped: true });
  const run = await finish(h, alice, runner);
  const offer = await runner.next('review.offer', (o) => o.card_id === run.card_id);
  assert.equal(offer.ai, 'codex');
  assert.equal(offer.budget_usd == null, true);
  assert.equal(reviewsOf(h, run.card_id)[0].independence, 'other_provider');
}));

test('review.result: parsed into a bounded review with secrets removed; only the offered device, only once', () => rig(async ({ h, alice, bob, runner }) => {
  await enable(h, alice);
  const run = await finish(h, alice, runner);
  const offer = await runner.next('review.offer', (o) => o.card_id === run.card_id);
  const other = await h.runner(await h.enroll(alice, 'Other'), { advertise: false });
  result(other, offer, { output: '{"verdict":"approve","findings":[]}' });
  await settle(60);
  assert.equal(reviewsOf(h, run.card_id)[0].status, 'pending', 'another device cannot answer');
  result(runner, offer, {
    output: `Here: ${JSON.stringify({ verdict: 'approve', summary: 'ok ghp_abcdefghijklmnopqrstuvwxyz0123456789', findings: [
      { file: 'src/a.js', line: 3, severity: 'high', rationale: 'key ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked' },
      { file: '/etc/hosts', line: 1, severity: 'low', rationale: 'not in the diff' }] })}`,
  });
  await until(() => reviewsOf(h, run.card_id)[0].status === 'done');
  const row = reviewsOf(h, run.card_id)[0];
  assert.equal(row.verdict, 'changes_requested', 'approve with a high finding is not an approve');
  assert.equal(row.cost_cents, 3);
  assert.ok(!JSON.stringify(row).includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'secrets removed');
  assert.deepEqual(JSON.parse(row.findings).map((f) => f.file), ['src/a.js']);
  assert.ok(JSON.parse(row.flags).includes('inconsistent'));
  result(runner, offer, { output: '{"verdict":"approve","findings":[]}' });
  await settle(60);
  assert.equal(reviewsOf(h, run.card_id)[0].verdict, 'changes_requested', 'a second result is ignored');
  assert.equal(h.card(run.card_id).run_state, 'in_review');
  const card = (await h.api(bob, 'GET', `/api/cards/${run.card_id}`)).body.card;
  assert.deepEqual([card.review.verdict, card.review.open_findings, card.review.provider_label], ['changes_requested', 1, 'Claude Code']);
  assert.ok(h.db.get("SELECT 1 x FROM journal WHERE kind = 'card_review.result'"));
}));

test('injection: a signal from the runner stops an approve even when the reviewer was fooled', () => rig(async ({ h, alice, runner }) => {
  await enable(h, alice);
  const run = await finish(h, alice, runner);
  const offer = await runner.next('review.offer', (o) => o.card_id === run.card_id);
  result(runner, offer, { output: '{"verdict":"approve","summary":"Looks good","findings":[]}', signals: [{ file: 'src/a.js', line: 2 }] });
  await until(() => reviewsOf(h, run.card_id)[0].status === 'done');
  const row = reviewsOf(h, run.card_id)[0];
  assert.equal(row.verdict, 'needs_human');
  assert.equal(JSON.parse(row.findings)[0].severity, 'high');
  assert.ok(JSON.parse(row.flags).includes('injection_suspected'));
}));

test('Ask author to fix: request_changes to the original AI, seeded with the open findings; dismissed ones stay out', () => rig(async ({ h, alice, runner }) => {
  await enable(h, alice);
  const run = await finish(h, alice, runner);
  const offer = await runner.next('review.offer', (o) => o.card_id === run.card_id);
  result(runner, offer, { output: JSON.stringify({ verdict: 'changes_requested', summary: 's', findings: [
    { file: 'src/a.js', line: 3, severity: 'high', rationale: 'off by one in the loop' }, { file: 'src/a.js', line: 9, severity: 'low', rationale: 'naming nit' }] }) });
  await until(() => reviewsOf(h, run.card_id)[0].status === 'done');
  const rv = reviewsOf(h, run.card_id)[0];
  const dis = await h.api(alice, 'POST', `/api/cards/${run.card_id}/reviews/${rv.id}/findings/1/dismiss`, { request_id: randomUUID() });
  assert.equal(dis.status, 200, dis.text);
  assert.equal(dis.body.review.open_findings, 1);
  assert.equal((await h.api(alice, 'POST', `/api/cards/${run.card_id}/reviews/${rv.id}/findings/7/dismiss`, { request_id: randomUUID() })).status, 404);
  await runner.hb([]);
  const fix = await h.api(alice, 'POST', `/api/cards/${run.card_id}/reviews/${rv.id}/fix`, { request_id: randomUUID() });
  assert.equal(fix.status, 200, fix.text);
  assert.equal(fix.body.card.run_state, 'queued');
  assert.equal(fix.body.review.human_action, 'fix_requested');
  const d = h.db.get("SELECT * FROM dispatches WHERE card_id = ? AND state = 'pending'", run.card_id);
  assert.equal(d.ai, 'claude', 'the original provider');
  const again = await runner.next('offer', (o) => o.card_id === run.card_id && o.seed?.review);
  assert.match(again.seed.review, /off by one in the loop/);
  assert.ok(!again.seed.review.includes('naming nit'), 'a dismissed finding is not sent');
  const view = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body.card;
  assert.equal(view.review.human_action, 'fix_requested');
  assert.equal(cardFace(view).review, null, 'no verdict chip once the card left Review');
}));

test('Approve: a person marks the card done; an integration acting for a member cannot', () => rig(async ({ h, alice, runner }) => {
  await enable(h, alice);
  const run = await finish(h, alice, runner);
  const offer = await runner.next('review.offer', (o) => o.card_id === run.card_id);
  result(runner, offer, { output: '{"verdict":"approve","summary":"fine","findings":[]}' });
  await until(() => reviewsOf(h, run.card_id)[0].status === 'done');
  await runner.hb([]);
  const rv = reviewsOf(h, run.card_id)[0];
  const member = h.hub.activeMember(h.ids.alice);
  await assert.rejects(h.hub.actVia({ connection_id: 'c1', member_id: member.id, name: 'Bot' }, () => h.hub.reviews.approve(h.app.api, member, run.card_id, rv.id, { request_id: randomUUID() })), /a person must approve/);
  assert.equal(h.card(run.card_id).run_state, 'in_review');
  const ok = await h.api(alice, 'POST', `/api/cards/${run.card_id}/reviews/${rv.id}/approve`, { request_id: randomUUID() });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(h.card(run.card_id).run_state, 'done');
  assert.equal(reviewsOf(h, run.card_id)[0].human_action, 'approved');
}));

test('caps: the daily cap blocks a review it cannot afford; review cost counts toward it; over-cap spend is flagged', () => rig(async ({ h, alice, runner }) => {
  await enable(h, alice, { spend_cap_usd: 0.5 });
  const capped = await h.api(alice, 'PATCH', `/api/boards/${h.ids.board}`, { request_id: randomUUID(), daily_cap_usd: 0.5 });
  assert.equal(capped.status, 200, capped.text);
  const run = await finish(h, alice, runner);
  await runner.hb([runHb(run, { cost_usd: 0.02 })]);
  await settle(40);
  const row = reviewsOf(h, run.card_id)[0];
  assert.equal(row.status, 'unavailable');
  assert.match(row.error, /daily spend cap/);
  assert.equal(runner.all('review.offer').length, 0);

  await h.api(alice, 'PATCH', `/api/boards/${h.ids.board}`, { request_id: randomUUID(), daily_cap_usd: null });
  await settings(h, alice, { spend_cap_usd: 0.1 });
  const second = await finish(h, alice, runner);
  const offer = await runner.next('review.offer', (o) => o.card_id === second.card_id);
  const before = h.hub.spentTodayCents(h.ids.board);
  result(runner, offer, { cost_usd: 0.25 });
  await until(() => reviewsOf(h, second.card_id)[0].status === 'done');
  assert.equal(h.hub.spentTodayCents(h.ids.board) - before, 25);
  assert.ok(JSON.parse(reviewsOf(h, second.card_id)[0].flags).includes('over_cap'));
}));

test('a runner without the review run kind is never offered one; a pending review times out honestly', () => rig(async ({ h, alice, runner }) => {
  await enable(h, alice);
  const run = await finish(h, alice, runner);
  await settle(40);
  assert.equal(runner.all('review.offer').length, 0);
  assert.equal(reviewsOf(h, run.card_id)[0].status, 'pending');
  h.clock.advance(REVIEW_TIMEOUT_MS + 1000);
  h.hub.reviews.sweep();
  const row = reviewsOf(h, run.card_id)[0];
  assert.deepEqual([row.status, row.error], ['unavailable', 'no runner that can review was online']);
}, { review: false }));

test('a review waits for a capable runner and is offered when one advertises', () => rig(async ({ h, alice, runner }) => {
  await enable(h, alice);
  const run = await finish(h, alice, runner);
  await settle(40);
  assert.equal(runner.all('review.offer').length, 0);
  runner.send({ type: 'advertise', repos: [{ repo_id: h.ids.repo, approvals_from: [], auto_accept_from: [] }], ai: AIS, review: true });
  const offer = await runner.next('review.offer', (o) => o.card_id === run.card_id);
  assert.equal(offer.review_id, reviewsOf(h, run.card_id)[0].id);
}, { review: false }));

test('my day: a changes-requested review is a decision for the people on the card', () => rig(async ({ h, alice, runner }) => {
  await enable(h, alice);
  const run = await finish(h, alice, runner);
  const offer = await runner.next('review.offer', (o) => o.card_id === run.card_id);
  result(runner, offer);
  await until(() => reviewsOf(h, run.card_id)[0].status === 'done');
  const { myDay } = await import('../my-day.js');
  const day = myDay(h.hub, { member: h.hub.activeMember(h.ids.alice) });
  const d = day.decisions.find((x) => x.kind === 'review');
  assert.equal(d.card_id, run.card_id);
  assert.match(d.summary, /asked for changes · 1 open finding/);
}));
