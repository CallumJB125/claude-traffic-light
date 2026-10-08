'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Shipped = require('../src/shipped-report.js');
const Digest = require('../src/digest.js');

const NOW = new Date(2026, 9, 8, 19, 30).getTime();
const H = 3600_000;
const opts = { home: '/Users/alice', username: 'alice' };
const rec = (o) => ({ adapter: 'claude', folder: 'shop', branch: 'fix-cart', status: 'ended', title: 'Fix the cart', updated_at: new Date(NOW - H).toISOString(), ...o });
const cost = { items: [
  { title: 'Fix the cart', usd: 4.5, pr: { number: 12, url: 'https://github.com/a/b/pull/12' } },
  { title: 'shop · main', usd: 1.25, pr: null },
  { title: 'free', usd: 0, pr: null },
] };

test('strips tag text from titles and falls back when nothing is left', () => {
  assert.equal(Shipped.stripTags('<command-message>go</command-message> Fix <b>the</b> cart'), 'Fix the cart');
  const s = Shipped.sections({ records: [rec({ title: '<command-name>/x</command-name>' })], now: NOW });
  assert.equal(s[0].items[0], 'Claude Code session in shop');
});

test('builds work done, PRs, spend and busiest days from fixtures', () => {
  const records = [
    rec({ title: 'Fix the cart' }),
    rec({ title: 'Add search <tag>x</tag>', branch: 'search', updated_at: new Date(NOW - 2 * H).toISOString() }),
    rec({ status: 'working', title: 'Still going', updated_at: new Date(NOW - 30 * H).toISOString() }),
    rec({ title: 'Too old', updated_at: new Date(NOW - 20 * 24 * H).toISOString() }),
  ];
  const s = Shipped.sections({ records, cost, prs: { search: { number: 15 } }, now: NOW });
  assert.deepEqual(s.map((x) => x.id), ['shipped', 'prs', 'spend-by-work', 'busiest']);
  assert.equal(s[0].summary, '2 pieces of work finished or ready for review.');
  assert.deepEqual(s[0].items, ['Fix the cart', 'Add search']);
  assert.deepEqual(s[1].items, ['PR #15: Add search', 'PR #12: Fix the cart']);
  assert.deepEqual(s[2].items, ['Fix the cart: $4.50', 'shop · main: $1.25']);
  assert.match(s[3].items[0], /Thursday 8 October: 2 sessions/);
  assert.equal(s[3].items.length, 2);
});

test('an empty week gives no sections', () => {
  assert.deepEqual(Shipped.sections({ now: NOW }), []);
});

test('the weekly digest includes the sections and copies them; the daily digest does not', () => {
  const records = [rec({ title: 'Fix the cart in /Users/alice/code/shop' })];
  const week = Digest.compose(Digest.gather({ period: 'week', now: NOW, records, shipped: { cost }, ...opts }));
  assert.ok(week.sections.some((x) => x.id === 'shipped'));
  assert.match(week.markdown, /## Pull requests\n- PR #12: Fix the cart/);
  assert.doesNotMatch(week.text, /alice/);
  const day = Digest.compose(Digest.gather({ period: 'day', now: NOW, records, shipped: { cost }, ...opts }));
  assert.ok(!day.sections.some((x) => x.id === 'shipped'));
});
