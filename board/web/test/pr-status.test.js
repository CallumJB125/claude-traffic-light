// The PR chip on a card face for every PR/check/review combination, and the "Needs your review" filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byClass, textOf, findAll, byAttr } from '../js/h.js';
import { displayFace } from '../js/view.js';
import { cardChips } from '../js/chips.js';
import { card } from '../js/render-board.js';
import { prChip, linkedPr, waitingOnYou } from '../js/pr-status.js';
import { applyFilters, filterOptions, emptyFilters } from '../js/filters.js';
import { filterBar } from '../js/render-filters.js';
import { view, model, MEMBERS } from './fixtures.js';

const URL = 'https://github.com/o/r/pull/123';
const bob = { member_id: 'm-bob', name: 'Bob' };
const linked = (status, extra = {}) => view({ pr: { number: 123, url: URL, state: 'open' }, pr_link_status: { state: 'open', checks: null, review: null, ...status }, ...extra });

test('every open-PR check and review combination: text, tone and icon', () => {
  const checks = { passing: 'checks passing', failing: 'checks failing', pending: 'checks running', none: null, [null]: null };
  const reviews = { approved: 'review: approved', changes_requested: 'review: changes requested', requested: 'review: waiting', none: null, [null]: null };
  for (const [c, ctext] of Object.entries(checks)) {
    for (const [r, rtext] of Object.entries(reviews)) {
      const chip = prChip(linked({ checks: c === 'null' ? null : c, review: r === 'null' ? null : r }));
      assert.equal(chip.text, ['PR #123', ctext, rtext].filter(Boolean).join(' · '), `${c}/${r}`);
      assert.equal(chip.href, URL);
      const tone = c === 'failing' ? 'red' : r === 'changes_requested' ? 'amber' : c === 'passing' && r === 'approved' ? 'green' : 'quiet';
      assert.equal(chip.tone, tone, `${c}/${r} tone`);
      assert.equal(chip.icon, { red: 'cross', amber: 'warn', green: 'check', quiet: 'branch' }[tone]);
      assert.match(chip.title, /^Pull request #123 is open/);
    }
  }
});

test('draft, merged and closed PRs: a draft keeps its checks; a finished PR says only how it ended', () => {
  assert.equal(prChip(linked({ state: 'draft', checks: 'pending' })).text, 'PR #123 · draft · checks running');
  const merged = prChip(linked({ state: 'merged', checks: 'failing', review: 'requested' }));
  assert.deepEqual([merged.text, merged.tone, merged.icon], ['PR #123 · merged', 'quiet', 'check']);
  const closed = prChip(linked({ state: 'closed', checks: 'passing' }));
  assert.deepEqual([closed.text, closed.icon], ['PR #123 · closed', 'branch']);
  assert.match(closed.title, /closed without merging/);
  assert.equal(prChip(view({ pr: { number: 7, url: 'u', state: 'merged' }, pr_link_status: { state: 'open' } })).text, 'PR #7 · merged', 'the hub\'s merge evidence wins');
});

test('where the PR comes from: the hub evidence, the integration link alone, or My board\'s own GitHub poll', () => {
  assert.equal(prChip(view({ pr: { number: 5, url: 'https://github.com/o/r/pull/5', state: 'open' } })).text, 'PR #5', 'evidence without integration facts');
  assert.deepEqual(linkedPr(view({ pr_link_status: { number: 9, url: 'https://github.com/o/r/pull/9', state: 'open', checks: 'passing', review: 'none' } })),
    { number: 9, url: 'https://github.com/o/r/pull/9', state: 'open', checks: 'passing', review: 'none' });
  const local = view({ run_state: null, run: null, live: null, budget: null, capture: { source: 'local_observation', pr: { number: 44, url: 'https://github.com/me/app/pull/44', state: 'open', checks: 'failing', review: 'changes_requested' } } });
  assert.deepEqual([prChip(local).text, prChip(local).tone], ['PR #44 · checks failing · review: changes requested', 'red']);
  assert.equal(prChip(view({ pr_link_status: { state: 'open', checks: 'passing' } })), null, 'no number, no chip');
  assert.equal(prChip(view()), null);
});

test('the chip renders as a link on the card face, first in the chip row', () => {
  const v = linked({ checks: 'failing', review: 'requested' });
  const n = card({ view: v, face: displayFace(v), elapsed_ms: 0 }, model([]));
  const row = byClass(n, 'card-chips')[0];
  const [a] = findAll(row, (x) => x.tag === 'a');
  assert.equal(a.props.href, URL);
  assert.equal(a.props.rel, 'noopener noreferrer');
  assert.equal(a.props['data-tone'], 'red');
  assert.match(textOf(a), /PR #123 · checks failing · review: waiting/);
  assert.equal(cardChips(v, displayFace(v))[0].id, 'pr');
});

test('in review the pill drops its reason (the PR chip carries it); while running the live step stays', () => {
  const v = linked({ checks: 'passing' }, { run_state: 'in_review', live: null, evidence: null, budget: null });
  assert.equal(byClass(card({ view: v, face: displayFace(v), elapsed_ms: 0 }, model([])), 'pill-reason').length, 0);
  const running = linked({ checks: 'pending' });
  assert.match(textOf(byClass(card({ view: running, face: displayFace(running), elapsed_ms: 0 }, model([])), 'pill')[0]), /editing deals\.ts/);
});

test('waiting on you: an open PR with a review requested, not yours, and you are its reviewer', () => {
  const bobs = (status, extra = {}) => linked({ review: 'requested', ...status }, { assignee_ids: ['m-bob'], run: { ...view().run, owner: bob, dispatched_by: bob }, ...extra });
  assert.equal(waitingOnYou(bobs(), 'm-alice'), true, 'nobody named: anyone but the author');
  assert.equal(waitingOnYou(bobs(), 'm-bob'), false, 'never your own PR');
  assert.equal(waitingOnYou(bobs({}, { approvers: ['m-carol'] }), 'm-alice'), false, 'someone else is the named reviewer');
  assert.equal(waitingOnYou(bobs({}, { approvers: ['m-alice'] }), 'm-alice'), true);
  assert.equal(waitingOnYou(bobs({ review: 'approved' }), 'm-alice'), false);
  assert.equal(waitingOnYou(bobs({ review: 'none' }), 'm-alice'), false);
  assert.equal(waitingOnYou(bobs({ state: 'merged' }), 'm-alice'), false);
  assert.equal(waitingOnYou(bobs({ state: 'draft' }), 'm-alice'), true);
  assert.equal(waitingOnYou(bobs(), null), false, 'no viewer, no match');
  assert.equal(waitingOnYou(view({ pr: null }), 'm-alice'), false);
  assert.equal(waitingOnYou(bobs({}, { run: null, assignee_ids: ['m-alice'] }), 'm-alice'), false, 'an assignee is the author');
  assert.equal(waitingOnYou(bobs({}, { capture: { source: 'local_observation' } }), 'm-alice'), false, 'observed work is your own');
});

test('the Needs your review pill: count, filtering, and the bar', () => {
  const entry = (v) => ({ view: v, elapsed_ms: 0, face: displayFace(v) });
  const ctx = { viewerId: 'm-alice', members: MEMBERS };
  const forYou = linked({ review: 'requested' }, { id: 'x', key: 'BDL-9', assignee_ids: ['m-bob'], run: { ...view().run, owner: bob, dispatched_by: bob } });
  const mine = linked({ review: 'requested' }, { id: 'y', key: 'BDL-10' });
  const plain = view({ id: 'z', key: 'BDL-11' });
  const entries = [forYou, mine, plain].map(entry);
  const f = { ...emptyFilters(), chips: ['review'] };
  assert.deepEqual(applyFilters(entries, f, ctx).entries.map((e) => e.view.key), ['BDL-9']);
  const options = filterOptions(entries, ctx);
  assert.equal(options.counts.review, 1);
  const bar = filterBar(model(entries, { filters: f, filterInfo: { total: 3, shown: 1, options } }));
  const [pill] = byAttr(bar, 'data-chip', 'review');
  assert.equal(pill.props['aria-pressed'], 'true');
  assert.match(textOf(pill), /^Needs your review1$/);
});
