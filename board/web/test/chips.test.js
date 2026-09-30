// Card-face chips for what is unique to Plexiform: proof, handover age, cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byClass, textOf, findAll } from '../js/h.js';
import { displayFace } from '../js/view.js';
import { cardChips, HANDOVER_STALE_MS } from '../js/chips.js';
import { card } from '../js/render-board.js';
import { view, model } from './fixtures.js';

const chipsOf = (v, opts = {}) => cardChips(v, displayFace(v, opts), opts);
const ids = (cs) => cs.map((c) => c.id);
const review = (extra = {}) => view({ run_state: 'in_review', live: null, state_age_ms: 5000, pr: { number: 1042, url: 'https://github.com/o/r/pull/1042', state: 'open' }, evidence: { tests: 'pass', verification: 'hub_verified' }, ...extra });

test('in review: proof chip with tests, PR number and who verified it; a link to the PR', () => {
  const [proof] = chipsOf(review());
  assert.equal(proof.id, 'proof');
  assert.equal(proof.text, 'tests ✓ · PR #1042 · hub-verified');
  assert.equal(proof.tone, 'green');
  assert.equal(proof.icon, 'check');
  assert.equal(proof.href, 'https://github.com/o/r/pull/1042');
  assert.match(proof.title, /Verified by the hub/);
});

test('in review: self-reported evidence is not green, failing tests are red, no tests is called out', () => {
  assert.equal(chipsOf(review({ evidence: { tests: 'pass', verification: 'self_reported' } }))[0].tone, 'quiet');
  assert.match(chipsOf(review({ evidence: { tests: 'pass', verification: 'self_reported' } }))[0].text, /self-reported$/);
  const fail = chipsOf(review({ evidence: { tests: 'fail', verification: 'hub_verified' } }))[0];
  assert.deepEqual([fail.tone, fail.icon, fail.text.startsWith('tests ✗')], ['red', 'cross', true]);
  const none = chipsOf(review({ evidence: { tests: 'none', verification: 'self_reported' } }))[0];
  assert.equal(none.tone, 'amber');
  assert.match(none.text, /^no tests · PR #1042/);
  assert.equal(chipsOf(review({ pr: null, evidence: null, budget: null })).length, 0, 'nothing to prove, no chip');
});

test('done: a compact proof, without the verification word', () => {
  const done = view({ run_state: 'done', live: null, pr: { number: 88, url: 'https://x/pr/88', state: 'merged', merged_age_ms: 3000 }, evidence: { tests: 'pass', verification: 'hub_verified' }, budget: null });
  const [proof] = chipsOf(done);
  assert.equal(proof.text, 'tests ✓ · PR #88');
  const merged = chipsOf(view({ run_state: 'done', live: null, budget: null, pr: { number: 9, url: 'u', state: 'merged' }, evidence: null }))[0];
  assert.deepEqual([merged.text, merged.icon], ['PR #9', 'check']);
});

test('proof only on in review and done', () => {
  assert.ok(!ids(chipsOf(view({ pr: { number: 1, url: 'u', state: 'open' }, evidence: { tests: 'pass', verification: 'hub_verified' } }))).includes('proof'));
});

test('handover: age on live runs, ticking with elapsed time; amber once stale while work is live', () => {
  const v = view({ handover: { version: 3, synced_age_ms: 120_000 } });
  const fresh = chipsOf(v).find((c) => c.id === 'handover');
  assert.equal(fresh.text, 'handover 2m');
  assert.equal(fresh.tone, 'quiet');
  const later = chipsOf(v, { elapsed_ms: 60_000 }).find((c) => c.id === 'handover');
  assert.equal(later.text, 'handover 3m');
  const stale = chipsOf(view({ handover: { version: 3, synced_age_ms: HANDOVER_STALE_MS + 1000 } })).find((c) => c.id === 'handover');
  assert.equal(stale.tone, 'amber');
  assert.match(stale.title, /anything newer is lost/);
});

test('handover: not shown where the pill reason already says it, or without a run', () => {
  const ho = { version: 2, synced_age_ms: 5000 };
  assert.ok(!ids(chipsOf(view({ run_state: 'orphaned', live: null, handover: ho }))).includes('handover'), 'orphaned reason: "handover synced …"');
  assert.ok(!ids(chipsOf(view({ run_state: 'handed_over', live: null, handover: ho }))).includes('handover'));
  assert.ok(!ids(chipsOf(view({ handover: null }))).includes('handover'));
  assert.ok(!ids(chipsOf(view({ run_state: 'todo', run: null, live: null, handover: ho }))).includes('handover'));
});

test('cost: compact spent/cap with a ratio and a level; hidden on an idle card with nothing spent', () => {
  const c = chipsOf(view({ budget: { spent_usd: 1.2, cap_usd: 5 } })).find((x) => x.id === 'cost');
  assert.deepEqual([c.text, c.tone], ['$1.20/$5', 'quiet']);
  assert.ok(Math.abs(c.ratio - 0.24) < 1e-9);
  assert.equal(chipsOf(view({ budget: { spent_usd: 4.2, cap_usd: 5 } })).find((x) => x.id === 'cost').tone, 'amber');
  assert.equal(chipsOf(view({ budget: { spent_usd: 5, cap_usd: 5 } })).find((x) => x.id === 'cost').tone, 'red');
  assert.equal(chipsOf(view({ run_state: 'todo', run: null, live: null, budget: { spent_usd: 0, cap_usd: 5 } })).length, 0);
  assert.equal(chipsOf(view({ budget: null })).find((x) => x.id === 'cost'), undefined);
});

test('order is proof, handover, cost', () => {
  const v = review({ run: view().run, handover: { version: 1, synced_age_ms: 1000 }, budget: { spent_usd: 1, cap_usd: 5 } });
  // in_review has no live run state in handover set, so only proof + cost here
  assert.deepEqual(ids(chipsOf(v)), ['proof', 'cost']);
  const live = view({ handover: { version: 1, synced_age_ms: 1000 }, budget: { spent_usd: 1, cap_usd: 5 } });
  assert.deepEqual(ids(chipsOf(live)), ['handover', 'cost']);
});

test('card face: chips render in one row; the in-review pill drops its reason because the chip carries it', () => {
  const v = review({ budget: { spent_usd: 0.5, cap_usd: 5 } });
  const n = card({ view: v, face: displayFace(v), elapsed_ms: 0 }, model([]));
  const row = byClass(n, 'card-chips')[0];
  assert.match(textOf(row), /tests ✓ · PR #1042 · hub-verified/);
  assert.match(textOf(row), /\$0\.50\/\$5/);
  assert.equal(findAll(row, (x) => x.tag === 'a' && x.props.href === 'https://github.com/o/r/pull/1042').length, 1);
  assert.equal(byClass(n, 'pill-reason').length, 0, 'not said twice');
  assert.equal(byClass(n, 'budget').length, 0, 'the old full-width bar is gone from the card');
  const running = view({ handover: { version: 1, synced_age_ms: 90_000 } });
  const r = card({ view: running, face: displayFace(running), elapsed_ms: 0 }, model([]));
  assert.match(textOf(byClass(r, 'pill')[0]), /editing deals\.ts/, 'the live step stays in the pill');
  assert.match(textOf(byClass(r, 'card-chips')[0]), /handover 1m/);
});
