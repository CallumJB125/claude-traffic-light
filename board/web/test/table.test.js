// Table view: pure row logic (table.js) and its render (render-table.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, byClass, byAttr, findAll } from '../js/h.js';
import { displayFace } from '../js/view.js';
import { tableRows, nextSort, matches, toRow, summary, DEFAULT_SORT } from '../js/table.js';
import { tableScreen } from '../js/render-table.js';
import { boardScreen } from '../js/render-board.js';
import { view, model, MEMBERS } from './fixtures.js';

const entry = (v, opts = {}) => ({ view: v, elapsed_ms: opts.elapsed_ms ?? 0, face: displayFace(v, opts) });

const running = view({ id: 'c-run', key: 'BDL-2', title: 'Running card', budget: { spent_usd: 1.2, cap_usd: 5 }, state_age_ms: 60_000 });
const blocked = view({ id: 'c-blk', key: 'BDL-10', title: 'Blocked on a question', run_state: 'blocked', blocked_kind: 'question', ask: { kind: 'question', summary: 'Which bank?', count: 1 }, budget: { spent_usd: 3.5, cap_usd: 5 }, state_age_ms: 120_000, labels: ['payments'] });
const todo = view({ id: 'c-todo', key: 'BDL-3', title: 'Write the docs', run_state: 'todo', column: 'todo', run: null, live: null, budget: null, assignee_ids: ['m-bob'], state_age_ms: 5_000, repo: null, branch: null, base_ref: null });
const entries = [entry(running), entry(blocked), entry(todo)];

test('default sort puts what needs a human first', () => {
  const rows = tableRows(entries, { members: MEMBERS });
  assert.deepEqual(rows.map((r) => r.key), ['BDL-10', 'BDL-2', 'BDL-3']);
  assert.deepEqual(DEFAULT_SORT, { by: 'status', dir: 'asc' });
});

test('key sort is numeric, not lexical (BDL-2 before BDL-10)', () => {
  const rows = tableRows(entries, { members: MEMBERS, sort: { by: 'key', dir: 'asc' } });
  assert.deepEqual(rows.map((r) => r.key), ['BDL-2', 'BDL-3', 'BDL-10']);
  const desc = tableRows(entries, { members: MEMBERS, sort: { by: 'key', dir: 'desc' } });
  assert.deepEqual(desc.map((r) => r.key), ['BDL-10', 'BDL-3', 'BDL-2']);
});

test('blank cost sorts last in both directions', () => {
  const asc = tableRows(entries, { members: MEMBERS, sort: { by: 'cost', dir: 'asc' } });
  assert.deepEqual(asc.map((r) => r.key), ['BDL-2', 'BDL-10', 'BDL-3']);
  const desc = tableRows(entries, { members: MEMBERS, sort: { by: 'cost', dir: 'desc' } });
  assert.deepEqual(desc.map((r) => r.key), ['BDL-10', 'BDL-2', 'BDL-3']);
});

test('age sort uses aged values (state_age_ms + elapsed)', () => {
  const aged = [entry(running, { elapsed_ms: 100_000 }), entry(blocked)];
  const rows = tableRows(aged, { members: MEMBERS, sort: { by: 'age', dir: 'desc' } });
  assert.equal(rows[0].key, 'BDL-2');
  assert.equal(rows[0].age_ms, 160_000);
});

test('nextSort flips the same column; cost and age start largest-first', () => {
  assert.deepEqual(nextSort({ by: 'key', dir: 'asc' }, 'key'), { by: 'key', dir: 'desc' });
  assert.deepEqual(nextSort({ by: 'key', dir: 'asc' }, 'title'), { by: 'title', dir: 'asc' });
  assert.deepEqual(nextSort({ by: 'key', dir: 'asc' }, 'cost'), { by: 'cost', dir: 'desc' });
});

test('filter matches every word across key, title, labels, people and status', () => {
  const rows = (f) => tableRows(entries, { members: MEMBERS, filter: f }).map((r) => r.key);
  assert.deepEqual(rows('payments'), ['BDL-10']);
  assert.deepEqual(rows('bob'), ['BDL-3']);
  assert.deepEqual(rows('BDL-2'), ['BDL-2']);
  assert.deepEqual(rows('needs'), ['BDL-10']);
  assert.deepEqual(rows('alice running'), ['BDL-2']);
  assert.deepEqual(rows('   '), ['BDL-10', 'BDL-2', 'BDL-3']);
  assert.equal(matches(toRow(entry(todo), MEMBERS), 'nothing-like-this'), false);
});

test('people are assignees plus the run owner, deduped', () => {
  const r = toRow(entry(view({ assignee_ids: ['m-alice', 'm-bob'] })), MEMBERS);
  assert.deepEqual(r.people.map((p) => p.name), ['Alice', 'Bob']);
});

test('summary counts rows, needs-attention and spend', () => {
  const s = summary(tableRows(entries, { members: MEMBERS }));
  assert.equal(s.count, 3);
  assert.equal(s.needs, 1);
  assert.equal(s.spent, 4.7);
});

test('render: one row per card, sortable headers with aria-sort, rows open the drawer', () => {
  const m = model(entries, { view: 'table', table: { sort: { by: 'key', dir: 'asc' }, filter: '' } });
  const v = tableScreen(m);
  const bodyRows = findAll(v, (n) => n.tag === 'tr' && n.props['data-card-id']);
  assert.equal(bodyRows.length, 3);
  const sorted = findAll(v, (n) => n.tag === 'th' && n.props['aria-sort'] === 'ascending');
  assert.equal(sorted.length, 1);
  assert.match(textOf(sorted[0]), /Key/);
  const opens = byAttr(v, 'data-action', 'open');
  assert.equal(opens.length, 3);
  assert.equal(opens[0].props['data-card'], 'c-run');
  assert.match(textOf(v), /3 cards/);
  assert.match(textOf(v), /1 need attention/);
});

test('render: filtered count and the empty states', () => {
  const m = model(entries, { view: 'table', table: { sort: DEFAULT_SORT, filter: 'payments' } });
  assert.match(textOf(tableScreen(m)), /1 of 3 cards/);
  const none = model(entries, { view: 'table', table: { sort: DEFAULT_SORT, filter: 'zzz' } });
  assert.match(textOf(tableScreen(none)), /No cards match that filter/);
  const empty = model([], { view: 'table', table: { sort: DEFAULT_SORT, filter: '' } });
  assert.match(textOf(tableScreen(empty)), /No cards yet/);
});

test('card and PR text reach the vnode tree as text, never as markup (D25)', () => {
  const evil = view({ id: 'c-x', title: '<img src=x onerror=alert(1)>', pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'open' } });
  const v = tableScreen(model([entry(evil)], { view: 'table', table: { sort: DEFAULT_SORT, filter: '' } }));
  assert.equal(findAll(v, (n) => n.tag === 'img').length, 0);
  assert.match(textOf(v), /<img src=x/);
  assert.equal(byClass(v, 'row-pr')[0].props.rel, 'noopener noreferrer');
});

test('board screen shows the view switcher with the current view pressed', () => {
  const v = boardScreen(model(entries, { view: 'table' }), tableScreen(model(entries, { view: 'table', table: { sort: DEFAULT_SORT, filter: '' } })));
  const pressed = findAll(v, (n) => n.props['data-action'] === 'view' && n.props['aria-pressed'] === 'true');
  assert.equal(pressed.length, 1);
  assert.equal(pressed[0].props['data-view'], 'table');
  assert.equal(byClass(v, 'board').length, 0);
  assert.equal(byClass(v, 'tableview').length, 1);
});
