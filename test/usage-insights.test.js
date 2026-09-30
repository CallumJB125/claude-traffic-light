const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../usage-insights.js');

const NOW = new Date('2026-09-30T15:00:00').getTime();
const row = (key, o = {}) => ({ key, turns: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTurns: 0, routineTurns: 0, routineCost: 0, routineSonnetCost: 0, ...o });

test('period: ranges end today, and the previous period is the same length just before', () => {
  const p = I.period('7d', NOW);
  assert.deepEqual([p.from, p.to, p.days], ['2026-09-24', '2026-09-30', 7]);
  assert.deepEqual(p.prev, { from: '2026-09-17', to: '2026-09-23' });
  const y = I.period('1y', NOW);
  assert.equal(y.days, 365);
  assert.equal(I.period('nonsense', NOW).days, 30);
  const all = I.period('all', NOW, '2026-06-01');
  assert.deepEqual([all.from, all.days, all.prev], ['2026-06-01', 122, null]);
  assert.equal(I.period('all', NOW, null).days, 1);
});

test('period: day arithmetic survives a DST change', () => {
  const tz = process.env.TZ;
  assert.equal(I.addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(I.addDays('2026-03-08', -1), '2026-03-07');
  assert.equal(I.daysBetween('2026-10-31', '2026-11-03'), 4);
  assert.ok(tz === undefined || typeof tz === 'string');
});

test('tiles: totals, change against the previous period, and cache hit in points', () => {
  const cur = [row('a', { cost: 30, turns: 100, input: 100, output: 1000, cacheRead: 600, cacheWrite: 300 })];
  const prev = [row('a', { cost: 20, turns: 80, input: 100, output: 900, cacheRead: 800, cacheWrite: 100 })];
  const [cost, turns, tokens, cache] = I.tiles(cur, prev);
  assert.deepEqual([cost.value, cost.change.abs, cost.change.pct], [30, 10, 0.5]);
  assert.equal(turns.change.abs, 20);
  assert.equal(tokens.value, 2000);
  assert.equal(cache.value, 0.6);
  assert.equal(Math.round(cache.change.abs * 100), -20);
  assert.equal(cache.change.points, true);
  assert.deepEqual(I.tiles(cur, null).map((t) => t.change), [null, null, null, null], '"all" has nothing to compare');
  assert.equal(I.tiles([], []).find((t) => t.id === 'cache').value, null, 'no traffic, no rate');
  assert.equal(I.change(5, 0).pct, null, 'no percentage from zero');
});

test('dailySeries: every day is present, zero where nothing happened', () => {
  const s = I.dailySeries([row('2026-09-28|opus', { cost: 5, turns: 2, routineTurns: 1 }), row('2026-09-30|sonnet', { cost: 1, turns: 1 }), row('2026-10-05|opus', { cost: 99 })], '2026-09-28', '2026-09-30');
  assert.deepEqual(s.map((d) => [d.day, d.cost]), [['2026-09-28', 5], ['2026-09-29', 0], ['2026-09-30', 1]]);
  assert.equal(s[0].families.opus.routineTurns, 1);
});

test('steps: empty days are their own step and the rest split the busiest day in quarters', () => {
  assert.deepEqual(I.steps([0, 1, 25, 50, 51, 100]), [0, 1, 1, 2, 3, 4], 'quarters are (0,25%], (25,50%], (50,75%], (75,100%]');
  assert.deepEqual(I.steps([0, 0]), [0, 0]);
  assert.deepEqual(I.steps([]), []);
});

test('workGrid and calendar: a 7×24 grid, and Monday-first weeks with a leading gap', () => {
  const g = I.workGrid([row('2:10', { turns: 4 }), row('2:10', { turns: 1 }), row('6:23', { turns: 2 })]);
  assert.equal(g.length, 7);
  assert.equal(g[2][10], 5);
  assert.equal(g[6][23], 2);
  const series = I.dailySeries([row('2026-09-30|opus', { cost: 10 })], '2026-09-28', '2026-10-04'); // Mon..Sun
  const cal = I.calendar(series);
  assert.equal(cal.weeks.length, 1);
  assert.equal(cal.weeks[0][0].day, '2026-09-28');
  assert.equal(cal.weeks[0][2].step, 4);
  const wed = I.calendar(I.dailySeries([], '2026-09-30', '2026-10-01')); // Wed, Thu
  assert.deepEqual(wed.weeks[0].map((c) => c && c.day), [null, null, '2026-09-30', '2026-10-01']);
});

const series = (costs) => costs.map((c, i) => ({ day: I.addDays('2026-09-01', i), cost: c, families: {} }));

test('callouts: Opus share moves only when both periods have turns and it shifts 10+ points', () => {
  const mk = (opus, other) => [row('opus', { turns: opus }), row('sonnet', { turns: other })];
  const base = { cur: [row('x')], prev: [row('x')], series: [], periodLabel: 'last month' };
  const up = I.callouts({ ...base, curFamily: mk(68, 32), prevFamily: mk(50, 50) });
  assert.deepEqual(up.map((c) => c.text), ['Opus share up 18 pts vs last month']);
  assert.deepEqual(I.callouts({ ...base, curFamily: mk(55, 45), prevFamily: mk(50, 50) }), [], 'only 5 points');
  assert.deepEqual(I.callouts({ ...base, curFamily: mk(20, 10), prevFamily: mk(5, 10) }), [], 'too few turns');
  assert.match(I.callouts({ ...base, curFamily: mk(30, 70), prevFamily: mk(60, 40) })[0].text, /down 30 pts/);
  assert.deepEqual(I.callouts({ ...base, prev: null, curFamily: mk(90, 10), prevFamily: null }), [], 'nothing to compare in "all"');
});

test('callouts: a falling cache hit rate names the project that lost the most', () => {
  const cur = [row('a', { turns: 60, input: 100, cacheRead: 500, cacheWrite: 400 })];
  const prev = [row('a', { turns: 60, input: 100, cacheRead: 700, cacheWrite: 200 })];
  const curProject = [row('x', { cacheRead: 100, input: 50, cacheWrite: 350 }), row('y', { cacheRead: 400, input: 50, cacheWrite: 50 })];
  const prevProject = [row('x', { cacheRead: 400, input: 50, cacheWrite: 50 }), row('y', { cacheRead: 300, input: 50, cacheWrite: 150 })];
  const c = I.callouts({ cur, prev, series: [], curProject, prevProject });
  assert.deepEqual(c.map((x) => x.text), ['Cache hit rate fell from 70% to 50%, mostly in x']);
  assert.deepEqual(I.callouts({ cur, prev, series: [] }).map((x) => x.text), ['Cache hit rate fell from 70% to 50%'], 'no project split, no name');
  const small = [row('a', { turns: 10, input: 100, cacheRead: 500, cacheWrite: 400 })];
  assert.deepEqual(I.callouts({ cur: small, prev, series: [] }), [], 'under 30 turns');
  const dip = [row('a', { turns: 60, input: 100, cacheRead: 650, cacheWrite: 250 })];
  assert.deepEqual(I.callouts({ cur: dip, prev, series: [] }), [], 'a 5-point dip is noise');
});

test('callouts: the busiest day needs a week of days, twice the median and $5', () => {
  const quiet = series([3, 4, 3, 5, 4, 3, 4, 41]);
  const base = { cur: [row('x')], prev: null };
  assert.deepEqual(I.callouts({ ...base, series: quiet }).map((c) => c.text), ['Your busiest day was Tue 8 Sep ($41.00)']);
  assert.deepEqual(I.callouts({ ...base, series: series([3, 4, 3, 5, 4, 3, 41]) }).map((c) => c.id), ['busiest'], 'a week of days is enough');
  assert.deepEqual(I.callouts({ ...base, series: series([3, 4, 3, 41]) }), [], 'too few days');
  assert.deepEqual(I.callouts({ ...base, series: series([3, 4, 3, 5, 4, 3, 4, 6]) }), [], 'no standout');
  assert.deepEqual(I.callouts({ ...base, series: series([0.2, 0.3, 0.2, 0.3, 0.2, 0.3, 1.5]) }), [], 'under $5');
});

test('callouts: never more than three', () => {
  const mk = (o, s) => [row('opus', { turns: o }), row('sonnet', { turns: s })];
  const c = I.callouts({
    cur: [row('a', { turns: 60, input: 100, cacheRead: 500, cacheWrite: 400 })], prev: [row('a', { turns: 60, input: 100, cacheRead: 700, cacheWrite: 200 })],
    series: series([3, 4, 3, 5, 4, 3, 4, 41]), curFamily: mk(80, 20), prevFamily: mk(50, 50),
  });
  assert.equal(c.length, 3);
  assert.deepEqual(c.map((x) => x.id), ['opus-share', 'cache-fell', 'busiest']);
});

test('routineOpus: share of Opus turns that looked routine, with the Sonnet saving range', () => {
  const s = I.dailySeries([row('2026-09-28|opus', { turns: 10, routineTurns: 4, routineCost: 10, routineSonnetCost: 4 }), row('2026-09-29|sonnet', { turns: 3 })], '2026-09-28', '2026-09-30');
  const r = I.routineOpus(s);
  assert.deepEqual(r[0], { day: '2026-09-28', share: 0.4, low: 4.6, high: 6 });
  assert.equal(r[1].share, null, 'a day with no Opus turns has no share');
  assert.equal(r[2].share, null);
});

test('toCsv: spreadsheet formulas in project-like cells are quoted, commas and quotes are escaped', () => {
  const csv = I.toCsv([row('2026-09-28|opus', { turns: 2, cost: 5 }), row('2026-09-29|=HYPERLINK("x")', { turns: 1 }), row('2026-09-30|a,b', {})]);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'day,family,turns,cost,input,output,cacheRead,cacheWrite,unpricedTurns');
  assert.equal(lines[1], '2026-09-28,opus,2,5,0,0,0,0,0');
  assert.match(lines[2], /^2026-09-29,"'=HYPERLINK\(""x""\)",1/);
  assert.match(lines[3], /^2026-09-30,"a,b"/);
});
