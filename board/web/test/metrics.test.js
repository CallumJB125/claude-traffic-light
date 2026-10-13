// Dashboard metrics (metrics.js): pure over journal rows + CardViews.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardMetrics, foldRows, emptyFold, windowMetrics, cardMetrics, pullJournal, clockOffset, histories, percentile, median, cycleTime, HOUR, DAY, WEEK } from '../js/metrics.js';
import { view } from './fixtures.js';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

// A tiny journal writer: rows get increasing seq in call order.
function journal() {
  const rows = [];
  let seq = 0;
  const push = (card_id, kind, msAgo, payload = {}, actor_kind = 'member') => { rows.push({ seq: ++seq, board_id: 'b', card_id, run_id: null, at_hub: at(msAgo), hub_epoch: 'e', actor_kind, actor_id: null, kind, payload }); };
  return {
    rows,
    create: (id, msAgo, extra = {}) => push(id, 'card.create', msAgo, { key: `BDL-${id}`, title: `Card ${id}`, column_name: 'todo', ...extra }),
    move: (id, msAgo, from, to) => push(id, 'card.update', msAgo, { fields: { column_name: [from, to] } }),
    tr: (id, msAgo, from, to, kind = null) => push(id, 'card.transition', msAgo, { rule: 'x', event: 'e', from, to, state: { run_state: to, blocked_kind: kind } }, 'system'),
  };
}

// A Claude card: created, dispatched, claimed, running, (blocked), review, done.
function claudeCard(j, id, { created, dispatched, claimed, blocked = null, answered = null, review, done, kind = 'question' }) {
  j.create(id, created);
  j.tr(id, dispatched, 'todo', 'queued');
  j.tr(id, claimed, 'queued', 'claimed');
  j.tr(id, claimed - 60_000, 'claimed', 'running');
  if (blocked != null) { j.tr(id, blocked, 'running', 'blocked', kind); j.tr(id, answered, 'blocked', 'running'); }
  j.tr(id, review, 'running', 'in_review');
  if (done != null) j.tr(id, done, 'in_review', 'done');
}

test('percentile interpolates; median of even/odd sets; empty → null', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.85), 44);
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.85), 7);
  assert.equal(median([1, NaN, 3]), 2);
});

test('foldRows applies a batch in seq order, skips duplicates, board-level, unreadable and unused rows', () => {
  const rows = [
    { seq: 3, card_id: 'a', at_hub: at(1000), kind: 'card.transition', payload: {} },
    { seq: 1, card_id: 'a', at_hub: at(3000), kind: 'card.create', payload: {} },
    { seq: 1, card_id: 'a', at_hub: at(3000), kind: 'card.create', payload: {} },
    { seq: 2, card_id: null, at_hub: at(2000), kind: 'hub.restore_bump', payload: {} },
    { seq: 4, card_id: 'a', at_hub: 'not a date', kind: 'card.update', payload: {} },
    { seq: 5, card_id: 'b', at_hub: at(500), kind: 'comment.create', payload: { comment_id: 'x' } },
  ];
  const fold = foldRows(emptyFold(), rows);
  assert.equal(fold.lastSeq, 5);
  assert.deepEqual([...fold.cards.keys()], ['a'], 'only card.create/update/transition make a history');
  const h = fold.cards.get('a');
  // No raw rows are kept: a history is a handful of fields.
  assert.deepEqual(Object.keys(h).sort(), ['card_id', 'done_at', 'done_by', 'first_start', 'key', 'open', 'state', 'title', 'waits']);
  // A later batch can't replay what was already folded.
  const v = fold.version;
  foldRows(fold, rows);
  assert.equal(fold.version, v);
});

test('cycle time: first claim → done for a Claude card, first move to In progress → done for a human card', () => {
  const j = journal();
  claudeCard(j, 'c1', { created: 10 * DAY, dispatched: 5 * DAY, claimed: 5 * DAY - HOUR, review: 4 * DAY, done: 3 * DAY });
  j.create('h1', 6 * DAY);
  j.move('h1', 5 * DAY, 'todo', 'in_progress');
  j.move('h1', 4 * DAY, 'in_progress', 'done');
  const hs = histories(j.rows);
  assert.equal(cycleTime(hs.get('c1')), 2 * DAY - HOUR);
  assert.equal(hs.get('c1').done_by, 'claude');
  assert.equal(cycleTime(hs.get('h1')), DAY);
  assert.equal(hs.get('h1').done_by, 'human');
});

test('a card that went To do → Done with no start has no cycle time, but still counts as done', () => {
  const j = journal();
  j.create('h2', 6 * DAY);
  j.move('h2', 4 * DAY, 'todo', 'done');
  j.create('h3', 6 * DAY);
  j.move('h3', 5 * DAY, 'todo', 'in_review');
  j.move('h3', 4 * DAY, 'in_review', 'done');
  const hs = histories(j.rows);
  assert.equal(cycleTime(hs.get('h2')), null);
  assert.equal(cycleTime(hs.get('h3')), DAY, 'straight to Review counts as a start');
  const m = dashboardMetrics({ rows: j.rows, cards: [], now: NOW });
  assert.equal(m.cycle.count, 1);
  assert.equal(m.share.human, 2);
  assert.equal(m.throughput.total, 2);
});

test('a reopened card counts once, in the week it was last finished', () => {
  const j = journal();
  j.create('r', 20 * DAY);
  j.move('r', 19 * DAY, 'todo', 'in_progress');
  j.move('r', 18 * DAY, 'in_progress', 'done');
  j.move('r', 10 * DAY, 'done', 'in_progress');
  j.move('r', 2 * DAY, 'in_progress', 'done');
  const m = dashboardMetrics({ rows: j.rows, cards: [], now: NOW });
  assert.deepEqual(m.throughput.weeks.map((w) => w.count), [0, 0, 0, 0, 0, 0, 0, 1]);
});

test('median and p85 over the window only; buckets count each finished card once', () => {
  const j = journal();
  // Four cards finish inside the 28-day window, one well before it.
  const cycles = [30 * 60_000, 3 * HOUR, 10 * HOUR, 2 * DAY];
  cycles.forEach((c, i) => {
    const done = (i + 1) * DAY;
    claudeCard(j, `w${i}`, { created: done + c + DAY, dispatched: done + c + HOUR, claimed: done + c, review: done + 60_000, done });
  });
  claudeCard(j, 'old', { created: 60 * DAY, dispatched: 59 * DAY, claimed: 59 * DAY - HOUR, review: 50 * DAY, done: 40 * DAY });
  const m = dashboardMetrics({ rows: j.rows, cards: [], now: NOW });
  assert.equal(m.cycle.count, 4);
  assert.equal(m.cycle.median_ms, (3 * HOUR + 10 * HOUR) / 2);
  assert.equal(m.cycle.p85_ms, percentile(cycles, 0.85));
  assert.deepEqual(m.cycle.buckets.map((b) => b.count), [1, 1, 1, 1, 0, 0]);
});

test('throughput: done cards per rolling week, last 8 weeks, oldest first', () => {
  const j = journal();
  claudeCard(j, 'a', { created: 3 * DAY, dispatched: 3 * DAY, claimed: 3 * DAY - HOUR, review: 2 * DAY, done: DAY });
  claudeCard(j, 'b', { created: 12 * DAY, dispatched: 12 * DAY, claimed: 12 * DAY - HOUR, review: 11 * DAY, done: 10 * DAY });
  j.create('c', 12 * DAY);
  j.move('c', 9 * DAY, 'todo', 'done');
  claudeCard(j, 'd', { created: 70 * DAY, dispatched: 70 * DAY, claimed: 70 * DAY - HOUR, review: 69 * DAY, done: 60 * DAY });
  const m = dashboardMetrics({ rows: j.rows, cards: [], now: NOW });
  assert.equal(m.throughput.weeks.length, 8);
  assert.deepEqual(m.throughput.weeks.map((w) => w.count), [0, 0, 0, 0, 0, 0, 2, 1]);
  assert.equal(m.throughput.weeks[6].claude, 1);
  assert.equal(m.throughput.weeks[6].human, 1);
  assert.equal(m.throughput.total, 3);
  assert.equal(m.throughput.this_week, 1);
  assert.equal(m.throughput.last_week, 2);
  assert.equal(m.throughput.weeks[7].end_ms, NOW);
  assert.equal(m.throughput.weeks[0].start_ms, NOW - 8 * WEEK);
});

test('Claude vs human share counts how each card reached done', () => {
  const j = journal();
  claudeCard(j, 'a', { created: 3 * DAY, dispatched: 3 * DAY, claimed: 3 * DAY - HOUR, review: 2 * DAY, done: DAY });
  claudeCard(j, 'b', { created: 5 * DAY, dispatched: 5 * DAY, claimed: 5 * DAY - HOUR, review: 4 * DAY, done: 2 * DAY });
  j.create('c', 4 * DAY);
  j.move('c', 2 * DAY, 'todo', 'done');
  // In review is not done.
  claudeCard(j, 'r', { created: 3 * DAY, dispatched: 3 * DAY, claimed: 3 * DAY - HOUR, review: DAY, done: null });
  const m = dashboardMetrics({ rows: j.rows, cards: [], now: NOW });
  assert.deepEqual({ claude: m.share.claude, human: m.share.human, total: m.share.total }, { claude: 2, human: 1, total: 3 });
  assert.equal(m.share.claude_pct, 2 / 3);
});

test('a card moved back out of done, or dispatched again, no longer counts as done', () => {
  const j = journal();
  j.create('x', 5 * DAY);
  j.move('x', 4 * DAY, 'todo', 'done');
  j.move('x', 3 * DAY, 'done', 'in_progress');
  j.create('y', 5 * DAY);
  j.move('y', 4 * DAY, 'todo', 'done');
  j.tr('y', 3 * DAY, 'todo', 'queued');
  const hs = histories(j.rows);
  assert.equal(hs.get('x').done_at, null);
  assert.equal(hs.get('y').done_at, null);
  assert.equal(dashboardMetrics({ rows: j.rows, cards: [], now: NOW }).share.total, 0);
});

test('blocked time sums blocked + parked per card and by kind, clipped to the window; open segments run to now', () => {
  const j = journal();
  claudeCard(j, 'a', { created: 10 * DAY, dispatched: 10 * DAY, claimed: 10 * DAY - HOUR, blocked: 9 * DAY, answered: 9 * DAY - 2 * HOUR, review: 8 * DAY, done: 7 * DAY, kind: 'permission' });
  j.create('b', 2 * DAY);
  j.tr('b', 2 * DAY, 'todo', 'queued');
  j.tr('b', 2 * DAY - HOUR, 'queued', 'claimed');
  j.tr('b', 2 * DAY - 2 * HOUR, 'claimed', 'running');
  j.tr('b', 3 * HOUR, 'running', 'blocked', 'question');
  j.tr('b', 2 * HOUR, 'blocked', 'parked', 'question');
  // Blocked 40 days ago: outside the window.
  claudeCard(j, 'old', { created: 45 * DAY, dispatched: 45 * DAY, claimed: 45 * DAY - HOUR, blocked: 40 * DAY, answered: 40 * DAY - 5 * HOUR, review: 39 * DAY, done: 38 * DAY });
  const m = dashboardMetrics({ rows: j.rows, cards: [view({ id: 'b', key: 'BDL-9', title: 'Parked one', run_state: 'parked' })], now: NOW });
  assert.equal(m.blocked.total_ms, 5 * HOUR);
  assert.equal(m.blocked.cards, 2);
  assert.deepEqual(m.blocked.top.map((x) => [x.card_id, x.value]), [['b', 3 * HOUR], ['a', 2 * HOUR]]);
  assert.equal(m.blocked.top[0].key, 'BDL-9');
  assert.equal(m.blocked.top[0].on_board, true);
  assert.equal(m.blocked.top[1].key, 'BDL-a');
  assert.equal(m.blocked.top[1].on_board, false);
  assert.deepEqual(m.blocked.by_kind, [{ kind: 'question', value: 3 * HOUR }, { kind: 'permission', value: 2 * HOUR }]);
});

test('blocked with no kind in the payload is grouped as unknown', () => {
  const rows = [
    { seq: 1, card_id: 'a', at_hub: at(2 * HOUR), kind: 'card.transition', payload: { from: 'running', to: 'blocked' } },
    { seq: 2, card_id: 'a', at_hub: at(HOUR), kind: 'card.transition', payload: { from: 'blocked', to: 'running' } },
  ];
  assert.deepEqual(dashboardMetrics({ rows, cards: [], now: NOW }).blocked.by_kind, [{ kind: 'unknown', value: HOUR }]);
});

test('cost per card: total, median and top 5 from budget.spent_usd', () => {
  const cards = [1.5, 0.25, 4, 0, 2, 3, 0.75].map((usd, i) => view({ id: `c${i}`, key: `BDL-${i}`, budget: { spent_usd: usd, cap_usd: 5 } }));
  cards.push(view({ id: 'nb', key: 'BDL-99', budget: null }));
  const m = dashboardMetrics({ rows: [], cards, now: NOW });
  assert.equal(m.cost.total_usd, 11.5);
  assert.equal(m.cost.cards, 6);
  assert.equal(m.cost.median_usd, 1.75);
  assert.deepEqual(m.cost.top.map((x) => x.value), [4, 3, 2, 1.5, 0.75]);
  assert.equal(m.cost.top[0].key, 'BDL-2');
});

test('bottleneck: time in queued, blocked and in_review, and who is waited on', () => {
  const j = journal();
  claudeCard(j, 'a', { created: 3 * DAY, dispatched: 3 * DAY, claimed: 3 * DAY - 2 * HOUR, blocked: 2 * DAY, answered: 2 * DAY - HOUR, review: DAY, done: DAY - 4 * HOUR });
  const cards = [
    view({ id: 'p', run_state: 'blocked', blocked_kind: 'permission', ask: { kind: 'permission', summary: 'npm i', count: 2 }, approvers: ['m-bob', 'm-alice'], state_age_ms: 20 * 60_000 }),
    view({ id: 'q', run_state: 'blocked', blocked_kind: 'question', ask: { kind: 'question', summary: '?', count: 1 }, assignee_ids: ['m-bob'], state_age_ms: 5 * 60_000,
      run: { id: 'r', backend: 'claude_cli', owner: { member_id: 'm-bob', name: 'Bob' }, dispatched_by: { member_id: 'm-sam', name: 'Sam' } } }),
    view({ id: 'r', run_state: 'in_review', state_age_ms: HOUR }),
    view({ id: 's', run_state: 'queued', state_age_ms: 90_000 }),
    view({ id: 't', run_state: 'running', ask: null }),
  ];
  const m = dashboardMetrics({ rows: j.rows, cards, now: NOW });
  const st = Object.fromEntries(m.bottleneck.stages.map((s) => [s.id, s]));
  assert.equal(st.queued.total_ms, 2 * HOUR);
  assert.equal(st.blocked.total_ms, HOUR);
  assert.equal(st.in_review.total_ms, 4 * HOUR);
  assert.equal(m.bottleneck.slowest, 'in_review');
  assert.equal(st.blocked.now_count, 2);
  assert.equal(st.blocked.now_oldest_ms, 20 * 60_000);
  assert.equal(st.in_review.now_count, 1);
  assert.equal(st.queued.now_oldest_ms, 90_000);
  const people = Object.fromEntries(m.bottleneck.people.map((p) => [p.member_id, p]));
  assert.equal(m.bottleneck.people[0].member_id, 'm-bob');
  assert.deepEqual([people['m-bob'].cards, people['m-bob'].permissions, people['m-bob'].asks], [2, 2, 1]);
  assert.deepEqual([people['m-alice'].cards, people['m-alice'].permissions], [1, 2]);
  assert.equal(people['m-sam'].name, 'Sam');
  assert.equal(people['m-sam'].asks, 1);
});

test('out-of-order rows give the same answer as ordered rows', () => {
  const j = journal();
  claudeCard(j, 'a', { created: 5 * DAY, dispatched: 5 * DAY, claimed: 5 * DAY - HOUR, blocked: 4 * DAY, answered: 4 * DAY - HOUR, review: 3 * DAY, done: 2 * DAY });
  const shuffled = [...j.rows].reverse();
  assert.deepEqual(dashboardMetrics({ rows: shuffled, cards: [], now: NOW }), dashboardMetrics({ rows: j.rows, cards: [], now: NOW }));
});

test('a clock step backwards never makes a negative duration', () => {
  const rows = [
    { seq: 1, card_id: 'a', at_hub: at(HOUR), kind: 'card.transition', payload: { from: 'running', to: 'blocked', state: { blocked_kind: 'question' } } },
    { seq: 2, card_id: 'a', at_hub: at(2 * HOUR), kind: 'card.transition', payload: { from: 'blocked', to: 'running' } },
  ];
  const m = dashboardMetrics({ rows, cards: [], now: NOW });
  assert.equal(m.blocked.total_ms, 0);
});

test('unknown states and kinds are tolerated, not counted as a wait stage', () => {
  const rows = [
    { seq: 1, card_id: 'a', at_hub: at(3 * HOUR), kind: 'card.create', payload: { key: 'BDL-1', title: 'x' } },
    { seq: 2, card_id: 'a', at_hub: at(2 * HOUR), kind: 'card.transition', payload: { from: 'todo', to: 'warp_speed' } },
    { seq: 3, card_id: 'a', at_hub: at(HOUR), kind: 'card.transition', payload: { from: 'warp_speed' } },
    { seq: 4, card_id: 'a', at_hub: at(HOUR), kind: 'future.kind', payload: null },
  ];
  const h = histories(rows).get('a');
  assert.equal(h.state, 'unknown');
  assert.deepEqual(h.waits, []);
  const m = dashboardMetrics({ rows, cards: [], now: NOW });
  assert.ok(m.bottleneck.stages.every((s) => s.total_ms === 0));
});

test('a card with no history still counts for cost; no journal means no history', () => {
  const m = dashboardMetrics({ rows: [], cards: [view({ id: 'solo', budget: { spent_usd: 2, cap_usd: 5 } })], now: NOW });
  assert.equal(m.has_history, false);
  assert.equal(m.cycle.count, 0);
  assert.equal(m.cycle.median_ms, null);
  assert.equal(m.cost.total_usd, 2);
  assert.equal(cycleTime({ done_at: null, first_start: null }), null);
});

test('an empty board gives zeros and nulls, never NaN', () => {
  const m = dashboardMetrics({ rows: [], cards: [], now: NOW });
  assert.equal(m.has_history, false);
  assert.equal(m.throughput.total, 0);
  assert.equal(m.share.claude_pct, null);
  assert.equal(m.blocked.total_ms, 0);
  assert.deepEqual(m.blocked.top, []);
  assert.equal(m.cost.median_usd, null);
  assert.equal(m.cost.total_usd, 0);
  assert.equal(m.bottleneck.slowest, null);
  assert.deepEqual(m.bottleneck.people, []);
  assert.ok(!JSON.stringify(m).includes('NaN'));
});

test('cost ignores cards with no budget (the hub sends budget: null for them) and says how many', () => {
  const cards = [
    view({ id: 'a', key: 'BDL-1', budget: { spent_usd: 2, cap_usd: 5 } }),
    view({ id: 'b', key: 'BDL-2', budget: { spent_usd: 0, cap_usd: 5 } }),
    view({ id: 'u1', key: 'BDL-3', budget: null }),
    view({ id: 'u2', key: 'BDL-4', budget: null }),
  ];
  const m = dashboardMetrics({ rows: [], cards, now: NOW });
  assert.equal(m.cost.total_usd, 2);
  assert.equal(m.cost.cards, 1);
  assert.equal(m.cost.unbudgeted, 2);
  assert.deepEqual(m.cost.top.map((x) => x.card_id), ['a']);
});

test('clockOffset reads the hub clock from a Date header against the request midpoint', () => {
  const sent = Date.parse('2026-09-30T12:00:00.000Z');
  // The hub is 90 s ahead; the header truncates to the second.
  assert.equal(clockOffset('Wed, 30 Sep 2026 12:01:30 GMT', sent, sent + 200), 90_000 + 500 - 100);
  assert.equal(clockOffset(null, sent, sent), null);
  assert.equal(clockOffset('garbage', sent, sent), null);
});

test('skew: metrics run on hub time, so a slow browser clock never cuts an open wait short', () => {
  const hubNow = NOW;
  const browserNow = NOW - 10 * 60_000; // browser 10 min behind the hub
  const rows = [
    { seq: 1, card_id: 'a', at_hub: at(20 * 60_000), kind: 'card.transition', payload: { from: 'running', to: 'blocked', state: { blocked_kind: 'question' } } },
  ];
  const offset = clockOffset(new Date(hubNow).toUTCString(), browserNow, browserNow) - 500;
  assert.equal(offset, 10 * 60_000);
  const m = dashboardMetrics({ rows, cards: [], now: browserNow + offset });
  assert.equal(m.blocked.total_ms, 20 * 60_000);
  // On the raw browser clock the wait would read as half as long.
  assert.equal(dashboardMetrics({ rows, cards: [], now: browserNow }).blocked.total_ms, 10 * 60_000);
});

test('incremental folding matches folding everything at once', () => {
  const j = journal();
  claudeCard(j, 'a', { created: 5 * DAY, dispatched: 5 * DAY, claimed: 5 * DAY - HOUR, blocked: 4 * DAY, answered: 4 * DAY - HOUR, review: 3 * DAY, done: 2 * DAY });
  claudeCard(j, 'b', { created: 3 * DAY, dispatched: 3 * DAY, claimed: 3 * DAY - HOUR, blocked: 2 * DAY, answered: DAY, review: 12 * HOUR, done: null });
  const fold = emptyFold();
  for (let i = 0; i < j.rows.length; i += 3) foldRows(fold, j.rows.slice(i, i + 3));
  const whole = foldRows(emptyFold(), j.rows);
  assert.deepEqual(windowMetrics(fold, NOW), windowMetrics(whole, NOW));
  // The card-dependent join recomputes without touching the window part.
  const win = windowMetrics(fold, NOW);
  const withCards = cardMetrics(win, fold, [view({ id: 'b', key: 'BDL-7', title: 'B', run_state: 'in_review', state_age_ms: HOUR })]);
  assert.equal(withCards.bottleneck.stages.find((s) => s.id === 'in_review').now_count, 1);
  assert.equal(withCards.blocked.top.find((x) => x.card_id === 'b').key, 'BDL-7');
});

// A fake journal endpoint over rows, paging like the hub.
function pager(rows, { offset = null } = {}) {
  const calls = [];
  const fetchPage = async (after, limit) => {
    calls.push(after);
    const out = rows.filter((r) => r.seq > after).slice(0, limit);
    return { rows: out, next_after_seq: out.length ? out.at(-1).seq : after, offset_ms: offset };
  };
  return { fetchPage, calls };
}

test('pullJournal pages to the end, then appends only new rows', async () => {
  const j = journal();
  for (let i = 0; i < 5; i++) claudeCard(j, `c${i}`, { created: 5 * DAY, dispatched: 4 * DAY, claimed: 4 * DAY - HOUR, review: 3 * DAY, done: 2 * DAY + i });
  const rows = j.rows.map((r) => ({ ...r, hub_epoch: 'e1' }));
  const first = rows.slice(0, 20);
  const p = pager(first, { offset: 1234 });
  const res = await pullJournal(emptyFold(), p.fetchPage, { pageSize: 7 });
  assert.deepEqual(p.calls, [0, 7, 14]);
  assert.equal(res.fold.lastSeq, 20);
  assert.equal(res.offset, 1234);
  const p2 = pager(rows);
  const res2 = await pullJournal(res.fold, p2.fetchPage, { pageSize: 7 });
  assert.equal(p2.calls[0], 20, 'the refresh starts after the last folded seq');
  assert.equal(res2.fold.lastSeq, rows.length);
  assert.deepEqual(windowMetrics(res2.fold, NOW), windowMetrics(foldRows(emptyFold(), rows), NOW));
});

test('pullJournal: rows from many hub epochs (one per boot) are just rows, never a re-read', async () => {
  const j = journal();
  for (let i = 0; i < 4; i++) claudeCard(j, `c${i}`, { created: 5 * DAY, dispatched: 4 * DAY, claimed: 4 * DAY - HOUR, review: 3 * DAY, done: 2 * DAY + i });
  const rows = j.rows.map((r, i) => ({ ...r, hub_epoch: `e${Math.floor(i / 5)}` }));
  const p = pager(rows.slice(0, 12));
  const held = (await pullJournal(emptyFold(), p.fetchPage, { pageSize: 5 })).fold;
  const p2 = pager(rows);
  const res = await pullJournal(held, p2.fetchPage, { pageSize: 5 });
  assert.equal(p2.calls[0], 12, 'continues after the last seq across an epoch change');
  assert.ok(!p2.calls.includes(0));
  assert.equal(res.fold.lastSeq, rows.length);
  assert.deepEqual(windowMetrics(res.fold, NOW), windowMetrics(foldRows(emptyFold(), rows), NOW));
});

test('a card a person moved to Done while its AI still reports fresh work does not count as finished', () => {
  const j = journal();
  j.create('a', 3 * DAY); j.move('a', 2 * DAY, 'todo', 'in_progress'); j.move('a', DAY, 'in_progress', 'done');
  j.create('b', 3 * DAY); j.move('b', 2 * DAY, 'todo', 'in_progress'); j.move('b', DAY, 'in_progress', 'done');
  const capture = { source: 'local_observation', fresh: true, status: 'working' };
  const cards = [view({ id: 'a', run_state: 'todo', run: null, live: null, column: 'done', capture }), view({ id: 'b', run_state: 'todo', run: null, live: null, column: 'done' })];
  const m = dashboardMetrics({ rows: j.rows, cards, now: NOW });
  assert.equal(m.throughput.total, 1);
  assert.deepEqual(m.cycle.items.map((i) => i.card_id), ['b']);
  const stale = dashboardMetrics({ rows: j.rows, cards: [{ ...cards[0], capture: { ...capture, fresh: false, status: 'unknown' } }, cards[1]], now: NOW });
  assert.equal(stale.throughput.total, 2);
});
