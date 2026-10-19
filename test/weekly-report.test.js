'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Weekly = require('../src/weekly-report.js');
const Digest = require('../src/digest.js');

const NOW = new Date(2026, 9, 8, 19, 30).getTime();
const H = 3600_000, D = 24 * H;
const opts = { home: '/Users/alice', username: 'alice' };
const rec = (folder, status, hoursAgo, o = {}) => ({ adapter: 'claude', folder, branch: null, status, title: `Work in ${folder}`, updated_at: new Date(NOW - hoursAgo * H).toISOString(), ...o });
const turn = (cwd, hoursAgo, out = 20000) => ({ ts: NOW - hoursAgo * H, modelKey: 'sonnet', model: 'claude-sonnet-4-5', input: 1000, output: out, cacheRead: 0, cacheWrite: 0, cwd });
const task = (where, state, hoursAgo) => ({ id: `t-${where}-${hoursAgo}`, title: 'A task', state, stateSince: NOW - hoursAgo * H, where });

test('groups the week by repo: sessions, finished, tasks done and spend, newest and busiest first', () => {
  const records = [rec('shop', 'ended', 1), rec('shop', 'working', 2), rec('shop', 'review', 3 * 24), rec('api', 'ended', 5), rec('old', 'ended', 9 * 24), rec('', 'ended', 1)];
  const tasks = [task('~/code/shop', 'done', 2), task('~/code/api', 'in_review', 3), task('~/code/api', 'failed', 3), task('~/code/shop', 'done', 10 * 24)];
  const turns = [turn('/Users/alice/code/shop', 1), turn('/Users/alice/code/shop', 2), turn('/Users/alice/code/api', 4), turn('/Users/alice/code/api', 9 * 24)];
  const repos = Weekly.byRepo({ records, tasks, turns, now: NOW });
  assert.deepEqual([...repos.keys()].sort(), ['api', 'shop']);
  assert.equal(repos.get('shop').sessions, 3); assert.equal(repos.get('shop').finished, 2); assert.equal(repos.get('shop').tasks, 1);
  assert.equal(repos.get('api').sessions, 1); assert.equal(repos.get('api').finished, 1); assert.equal(repos.get('api').tasks, 1);
  assert.ok(repos.get('shop').usd > repos.get('api').usd && repos.get('api').usd > 0);
  const s = Weekly.sections({ records, tasks, turns, now: NOW, prs: 2 });
  assert.deepEqual(s.map((x) => [x.id, x.heading]), [['week-overview', 'Your week'], ['by-repo', 'By repo'], ['where-it-went', 'Where the money went']]);
  assert.match(s[2].items[0], /^Most went to shop \(\$\d+\.\d\d\) and api \(\$\d+\.\d\d\), out of \$\d+\.\d\d\.$/);
  assert.equal(s[2].items.length, 1, 'no saving line without Opus turns');
  assert.equal(s[0].items.length, 3);
  assert.equal(s[0].items[0], 'You worked in 2 repos this week, most in shop (3 sessions of 4).');
  assert.equal(s[0].items[1], '5 pieces of work finished or ready for review and 2 pull requests opened.');
  assert.match(s[0].items[2], /^Spend was \$\d+\.\d\d, mostly on shop\.$/);
  assert.match(s[1].items[0], /^shop: 3 sessions, 2 finished, 1 task done, \$\d+\.\d\d$/);
  assert.match(s[1].items[1], /^api: 1 session, 1 finished, 1 task done, \$\d+\.\d\d$/);
});

test('an empty week gives no sections, one repo reads as one repo, and the same facts give the same words', () => {
  assert.deepEqual(Weekly.sections({ now: NOW }), []);
  const one = Weekly.sections({ records: [rec('shop', 'working', 1)], now: NOW });
  assert.equal(one[0].items[0], 'You worked in shop this week, across 1 session.');
  assert.equal(one[0].items[1], 'Nothing finished yet.');
  assert.equal(one[0].items.length, 2, 'no spend line without spend');
  assert.deepEqual(one, Weekly.sections({ records: [rec('shop', 'working', 1)], now: NOW }));
  const spread = Weekly.sections({ turns: [turn('/a/x', 1, 1000), turn('/a/y', 1, 1000), turn('/a/z', 1, 1000)], records: [rec('x', 'working', 1), rec('y', 'working', 1), rec('z', 'working', 1)], now: NOW });
  assert.match(spread[0].items[2], /^Spend was \$\d+\.\d\d, spread over x, y and z\.$/);
  const many = Weekly.sections({ records: Array.from({ length: 10 }, (_, i) => rec(`r${i}`, 'working', 1)), now: NOW });
  assert.equal(many[1].items.length, 9); assert.equal(many[1].items[8], 'And 2 more.');
});

test('the weekly digest opens with the overview and lists repos after what shipped; the daily one does not', () => {
  const records = [rec('shop', 'ended', 1, { title: 'Fix the cart in /Users/alice/code/shop' })];
  const turns = [turn('/Users/alice/code/shop', 1)];
  const week = Digest.compose(Digest.gather({ period: 'week', now: NOW, records, turns, shipped: { cost: { items: [{ title: 'Fix the cart', usd: 2, pr: { number: 9 } }] } }, ...opts }));
  const ids = week.sections.map((s) => s.id);
  assert.equal(ids[0], 'week-overview');
  assert.ok(ids.indexOf('by-repo') > ids.indexOf('shipped'), ids.join(','));
  assert.match(week.text, /You worked in shop this week, across 1 session\./);
  assert.match(week.text, /1 piece of work finished or ready for review and 1 pull request opened\./);
  assert.doesNotMatch(week.text, /alice|\/Users/);
  const day = Digest.compose(Digest.gather({ period: 'day', now: NOW, records, turns, ...opts }));
  assert.ok(!day.sections.some((s) => s.id === 'week-overview' || s.id === 'by-repo'));
});

test('where the money went: top three projects and the routine-Opus saving line, in plain words', () => {
  const opus = (cwd, hoursAgo, o = {}) => ({ ts: NOW - hoursAgo * H, modelKey: 'opus', model: 'claude-opus-4-1', input: 100, output: 100, cacheRead: 50000, cacheWrite: 0, cwd, ...o });
  const turns = [turn('/a/one', 1, 40000), turn('/a/two', 1, 30000), turn('/a/three', 1, 20000), turn('/a/four', 1, 1000), opus('/a/one', 2), opus('/a/one', 3), opus('/a/one', 4, { output: 5000 })];
  const lines = Weekly.whereItWent(Weekly.byRepo({ turns, now: NOW }), { turns, now: NOW });
  assert.match(lines[0], /^Most went to one \(\$\d+\.\d\d\), two \(\$\d+\.\d\d\) and three \(\$\d+\.\d\d\), out of \$\d+\.\d\d\.$/);
  assert.match(lines[1], /^About 67% of this week's Opus turns looked routine; Sonnet would have cost \$\d+\.\d\d(–\$\d+\.\d\d)? less\.$/);
  const solo = Weekly.whereItWent(Weekly.byRepo({ turns: [turn('/a/one', 1)], now: NOW }), { turns: [turn('/a/one', 1)], now: NOW });
  assert.match(solo[0], /^All \$\d+\.\d\d went to one \(\$\d+\.\d\d\)\.$/);
  const d = Digest.compose(Digest.gather({ period: 'week', now: NOW, turns, records: [rec('one', 'working', 1)], ...opts }));
  const sec = d.sections.find((x) => x.id === 'where-it-went');
  assert.ok(sec && sec.items.length === 2);
  assert.ok(d.text.includes('Where the money went'));
});
