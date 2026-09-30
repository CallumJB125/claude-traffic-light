// Filters: URL form, matching, counts, and the bar it renders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byClass, byAttr, textOf, findAll } from '../js/h.js';
import { displayFace } from '../js/view.js';
import {
  emptyFilters, isFiltering, parseFilters, writeFilters, toggleIn, matchEntry, applyFilters, filterOptions, CHIPS,
} from '../js/filters.js';
import { filterBar } from '../js/render-filters.js';
import { boardScreen, column } from '../js/render-board.js';
import { tableScreen } from '../js/render-table.js';
import { view, model, MEMBERS } from './fixtures.js';

const entry = (v) => ({ view: v, elapsed_ms: 0, face: displayFace(v) });
const ctx = { viewerId: 'm-alice', members: MEMBERS };
const f = (over = {}) => ({ ...emptyFilters(), ...over });

const mineRunning = view({ id: 'a', key: 'BDL-1', title: 'Fix login redirect', labels: ['api'] });
const bobBlocked = view({
  id: 'b', key: 'BDL-2', title: 'Payments decline copy', run_state: 'blocked', blocked_kind: 'question', ask: { kind: 'question', summary: 'Which bank?', count: 1 },
  assignee_ids: ['m-bob'], labels: ['payments'], branch: 'board/BDL-2-r1', run: { id: 'r2', backend: 'claude_cli', device_name: 'ThinkPad', owner: { member_id: 'm-bob', name: 'Bob' }, dispatched_by: { member_id: 'm-bob', name: 'Bob' } },
});
const aliceBlocked = view({
  id: 'c', key: 'BDL-3', title: 'Approve the migration', run_state: 'blocked', blocked_kind: 'permission', ask: { kind: 'permission', summary: 'npm run migrate', count: 1, permission_request_id: 'pr1' },
  labels: ['api', 'db'], branch: 'board/BDL-3-r1',
});
const todo = view({ id: 'd', key: 'BDL-4', title: 'Write the docs', run_state: 'todo', column: 'todo', run: null, live: null, assignee_ids: ['m-bob'], labels: [], repo: null, branch: null });
const entries = [mineRunning, bobBlocked, aliceBlocked, todo].map(entry);
const keys = (fl) => applyFilters(entries, fl, ctx).entries.map((e) => e.view.key);

test('URL form round-trips q and f, including labels with commas and unknown tokens', () => {
  const fl = f({ q: 'login flow', chips: ['mine', 'blocked'], labels: ['api', 'a,b'], assignee: 'm-bob' });
  const p = writeFilters(fl, new URLSearchParams('view=table'));
  assert.equal(p.get('view'), 'table', 'other params are left alone');
  assert.deepEqual(parseFilters(`?${p}`), fl);
  assert.deepEqual(parseFilters('?f=mine,nonsense,l:,a:,%E0%A4%A'), f({ chips: ['mine'] }), 'junk is dropped, not thrown');
  assert.deepEqual(parseFilters('?f=mine,mine,l:x,l:x').chips, ['mine']);
  const cleared = writeFilters(emptyFilters(), new URLSearchParams('q=old&f=mine&view=board'));
  assert.equal(cleared.toString(), 'view=board');
});

test('isFiltering and toggleIn', () => {
  assert.equal(isFiltering(emptyFilters()), false);
  assert.equal(isFiltering(f({ q: '  ' })), false, 'whitespace is not a filter');
  assert.equal(isFiltering(f({ assignee: 'x' })), true);
  assert.deepEqual(toggleIn(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleIn(['a', 'b'], 'a'), ['b']);
});

test('text search: every word must match key, title, label, person or status', () => {
  assert.deepEqual(keys(f({ q: 'bdl-1' })), ['BDL-1']);
  assert.deepEqual(keys(f({ q: 'LOGIN redirect' })), ['BDL-1']);
  assert.deepEqual(keys(f({ q: 'payments' })), ['BDL-2'], 'label');
  assert.deepEqual(keys(f({ q: 'bob' })).sort(), ['BDL-2', 'BDL-4'], 'person');
  assert.deepEqual(keys(f({ q: 'login nothing' })), []);
  assert.equal(keys(f()).length, 4);
});

test('chips: Mine, Needs you, Claude working, Blocked', () => {
  assert.deepEqual(keys(f({ chips: ['mine'] })), ['BDL-1', 'BDL-3']);
  assert.deepEqual(keys(f({ chips: ['working'] })), ['BDL-1']);
  assert.deepEqual(keys(f({ chips: ['blocked'] })).sort(), ['BDL-2', 'BDL-3']);
  assert.deepEqual(keys(f({ chips: ['needs'] })), ['BDL-3'], 'only what is on your attention strip');
  assert.deepEqual(keys(f({ chips: ['mine', 'blocked'] })), ['BDL-3'], 'chips AND together');
});

test('labels are any-of, the person filter is exact, and they combine with text', () => {
  assert.deepEqual(keys(f({ labels: ['payments', 'db'] })).sort(), ['BDL-2', 'BDL-3']);
  assert.deepEqual(keys(f({ labels: ['api'] })).sort(), ['BDL-1', 'BDL-3']);
  assert.deepEqual(keys(f({ assignee: 'm-bob' })).sort(), ['BDL-2', 'BDL-4']);
  assert.deepEqual(keys(f({ labels: ['api'], q: 'migration' })), ['BDL-3']);
});

test('applyFilters reports shown and total, and leaves the list alone when nothing is set', () => {
  const none = applyFilters(entries, f(), ctx);
  assert.equal(none.entries, entries);
  const some = applyFilters(entries, f({ chips: ['blocked'] }), ctx);
  assert.deepEqual([some.shown, some.total], [2, 4]);
});

test('filterOptions: per-chip counts, labels by frequency, people on cards', () => {
  const o = filterOptions(entries, ctx);
  assert.deepEqual(o.counts, { mine: 2, needs: 1, working: 1, blocked: 2 });
  assert.deepEqual(o.labels, [{ label: 'api', n: 2 }, { label: 'db', n: 1 }, { label: 'payments', n: 1 }]);
  assert.deepEqual(o.people.map((p) => p.id), ['m-alice', 'm-bob']);
  assert.equal(CHIPS.length, 4);
});

// ── render ──────────────────────────────────────────────────────────────────

const withFilters = (fl, extra = {}) => {
  const applied = applyFilters(entries, fl, ctx);
  return model(entries, {
    filters: fl, visible: applied.entries,
    filterInfo: { total: applied.total, shown: applied.shown, options: filterOptions(entries, ctx) }, ...extra,
  });
};

test('filter bar: search with "/", four chips with counts and pressed state, label and person pickers', () => {
  const bar = filterBar(withFilters(f({ chips: ['blocked'], q: 'x' })));
  const input = byAttr(bar, 'data-input', 'filter-q')[0];
  assert.equal(input.props.value, 'x');
  assert.equal(input.props['aria-keyshortcuts'], '/');
  const chips = byAttr(bar, 'data-action', 'filter-chip');
  assert.deepEqual(chips.map((c) => [c.props['data-chip'], c.props['aria-pressed']]), [['mine', 'false'], ['needs', 'false'], ['working', 'false'], ['blocked', 'true']]);
  assert.match(textOf(chips[3]), /Blocked2/);
  assert.equal(byAttr(bar, 'data-change', 'filter-label').length, 1);
  assert.equal(byAttr(bar, 'data-change', 'filter-assignee').length, 1);
  assert.match(textOf(byClass(bar, 'filter-count')[0]), /^0 of 4 cards$/);
  assert.equal(byAttr(bar, 'data-action', 'filter-clear').length, 1);
});

test('filter bar: idle state shows the total and no Clear; chosen labels become removable chips', () => {
  const idle = filterBar(withFilters(f()));
  assert.match(textOf(byClass(idle, 'filter-count')[0]), /^4 cards$/);
  assert.equal(byAttr(idle, 'data-action', 'filter-clear').length, 0);
  const lab = filterBar(withFilters(f({ labels: ['api'] })));
  const off = byAttr(lab, 'data-action', 'filter-label-off')[0];
  assert.equal(off.props['data-label'], 'api');
  assert.match(off.props['aria-label'], /remove filter/);
  const opts = findAll(byAttr(lab, 'data-change', 'filter-label')[0], (n) => n.tag === 'option').map((o) => o.props.value);
  assert.deepEqual(opts, ['', 'db', 'payments'], 'a chosen label leaves the picker');
});

test('the board and the table show only the filtered cards; the dashboard has no filter bar', () => {
  const m = withFilters(f({ chips: ['working'] }));
  const screen = boardScreen(m);
  const ids = findAll(screen, (n) => n.tag === 'article').map((n) => n.props['data-card-id']);
  assert.deepEqual(ids, ['a']);
  assert.equal(byClass(screen, 'filterbar').length, 1);
  const table = tableScreen({ ...m, view: 'table', table: { sort: { by: 'key', dir: 'asc' } } });
  assert.equal(findAll(table, (n) => n.tag === 'tr' && n.props['data-card-id']).length, 1);
  assert.match(textOf(table), /1 of 4 cards/);
  assert.equal(byClass(boardScreen({ ...m, view: 'dashboard' }, null), 'filterbar').length, 0);
  assert.equal(byClass(column('todo', [], m), 'column-empty').length, 1);
});
