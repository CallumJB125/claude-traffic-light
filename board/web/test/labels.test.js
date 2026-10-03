// Label colours and archive in the web (D91, D94): pure helpers, render
// tests for the card face, drawer, filter bar and table, and the CSS tokens
// (classes only, AA in both themes). Covers, the label manager and the
// multi-select bar were removed from the UI; their APIs remain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { byAttr, byClass, findAll, hasClass, textOf } from '../js/h.js';
import { displayFace } from '../js/view.js';
import { LABEL_COLORS, colorMap, labelColor, labelClass, coverClass, canArchive, managerRows } from '../js/labels.js';
import { card } from '../js/render-board.js';
import { drawer } from '../js/render-drawer.js';
import { filterBar } from '../js/render-filters.js';
import { tableScreen } from '../js/render-table.js';
import { DEFAULT_SORT } from '../js/table.js';
import { emptyFilters, filterOptions } from '../js/filters.js';
import { view, model, MEMBERS } from './fixtures.js';

// WCAG 2.x contrast (as in themes.test.js; importing that file would run its tests here too).
const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const entry = (v) => ({ view: v, elapsed_ms: 0, face: displayFace(v) });
const REGISTRY = [{ id: 'l1', name: 'Bug', color: 'red', description: null }, { id: 'l2', name: 'ui', color: 'teal', description: null }];
const colors = colorMap(REGISTRY);
const todo = (extra = {}) => view({ run_state: 'todo', column: 'todo', run: null, live: null, budget: null, ...extra });
const archivedView = (extra = {}) => todo({ archived: { at_age_ms: 3_600_000, by_name: 'Bob' }, ...extra });
const noInlineStyle = (tree) => findAll(tree, (n) => (hasClass(n, 'label') || /cover|ldot/.test(n.props.class ?? '')) && n.props.style != null);

test('helpers: registry colours match names ignoring case, beat the hub\'s as-of-send colours, and never reach policy or via labels', () => {
  assert.equal(LABEL_COLORS.length, 10);
  assert.equal(labelColor('BUG', 0, null, colors), 'red');
  assert.equal(labelColor('later', 0, null, colors), null);
  const v = { label_colors: ['blue', 'pink'] };
  assert.equal(labelColor('x', 1, v, null), 'pink', 'no registry yet: the CardView colour');
  assert.equal(labelColor('bug', 0, v, colors), 'red', 'the live registry wins');
  assert.equal(labelColor('bug', 0, { label_colors: ['magenta'] }, null), null, 'unknown tokens are dropped');
  assert.equal(labelColor('never_auto', 0, { label_colors: ['red'] }, new Map([['never_auto', 'red']])), null);
  assert.equal(labelColor('via:github', 0, { label_colors: ['red'] }, null), null);
  assert.equal(labelClass('Bug', 'red'), 'label label-c-red');
  assert.equal(labelClass('later', null), 'label');
  assert.equal(labelClass('plan-approval', null), 'label is-policy');
  assert.equal(coverClass('teal'), ' has-cover cover-teal');
  assert.equal(coverClass('magenta'), '');
  assert.equal(coverClass(null), '');
  assert.deepEqual(['todo', 'done', 'failed', 'running', 'queued', 'in_review'].map((s) => canArchive({ run_state: s })), [true, true, true, false, false, false]);
  assert.equal(canArchive({ run_state: 'todo', archived: { at_age_ms: 1 } }), false);
  assert.deepEqual(managerRows(REGISTRY, ['bug', 'later', 'Later', 'never_auto', 'via:github', 'ui']).map((r) => [r.name, r.color, r.registered]),
    [['Bug', 'red', true], ['ui', 'teal', true], ['later', null, false]]);
});

test('card face: label chips coloured by class, no cover strip (covers are gone), never an inline style', () => {
  const v = todo({ labels: ['bug', 'later', 'never_auto', 'via:github'], cover: 'purple' });
  const m = model([entry(v)], { labelColors: colors });
  const c = card(entry(v), m);
  assert.equal(hasClass(c, 'has-cover') || hasClass(c, 'cover-purple'), false);
  const labels = byClass(c, 'card-labels')[0];
  assert.deepEqual(labels.children.map((n) => [textOf(n), n.props.class]), [['bug', 'label label-c-red'], ['later', 'label'], ['never_auto', 'label is-policy']]);
  assert.equal(byClass(c, 'via-integration').length, 1, 'via stays a badge');
  assert.deepEqual(noInlineStyle(c), []);
});

test('card face: an archived card is muted, says so, only offers Restore and cannot be dragged; viewers get no button', () => {
  const v = archivedView({ labels: ['ui'] });
  const c = card(entry(v), model([entry(v)], { labelColors: colors }));
  assert.ok(hasClass(c, 'is-archived'));
  assert.equal(c.props['data-draggable'], null);
  assert.equal(byClass(c, 'archived-badge').length, 1);
  assert.match(byClass(c, 'archived-badge')[0].props.title, /Bob/);
  assert.deepEqual(byAttr(c, 'data-action').map((n) => n.props['data-action']).filter((a) => a !== 'open'), ['restore']);
  const ro = card(entry(v), model([entry(v)], { readOnly: true }));
  assert.equal(byAttr(ro, 'data-action', 'restore').length, 0);
  assert.equal(hasClass(card(entry(todo()), model([])), 'is-archived'), false);
});

function drawerModel(v, data = {}, extra = {}) {
  return model([entry(v)], { labelColors: colors, detail: { cardId: v.id, data: { card: v, feed: [], comments: [], asks: [], permission_requests: [], ...data }, elapsed_ms: 0, tab: 'comments' }, ...extra });
}

test('drawer: no cover picker, Archive for a card with no live run, coloured labels', () => {
  const v = todo({ cover: 'green', labels: ['Bug'] });
  const d = drawer(drawerModel(v));
  assert.equal(byAttr(d, 'data-action', 'set-cover').length, 0);
  assert.equal(byAttr(d, 'data-action', 'archive').length, 1);
  assert.equal(byAttr(d, 'data-action', 'restore').length, 0);
  assert.equal(byClass(d, 'label-c-red').length, 1);
  assert.deepEqual(noInlineStyle(d), []);
  const running = drawer(drawerModel(view({ labels: [] })));
  assert.equal(byAttr(running, 'data-action', 'archive').length, 0, 'a live run cannot be archived');
});

test('drawer: an archived card shows who archived it, Restore, and no cover picker, card actions or comment box', () => {
  const v = archivedView();
  const d = drawer(drawerModel(v));
  assert.match(textOf(byClass(d, 'archived-note')[0]), /Archived by Bob 1h ago\. Restore it/);
  assert.equal(byAttr(d, 'data-action', 'restore').length, 1);
  assert.equal(byAttr(d, 'data-action', 'archive').length, 0);
  assert.equal(byAttr(d, 'data-action', 'set-cover').length, 0);
  assert.equal(byAttr(d, 'data-action', 'give_to_claude').length, 0);
  assert.equal(byAttr(d, 'data-form', 'comment').length, 0);
});

test('filter bar: no label registry button, a "Show archived" toggle with its count, and label filters carry their colour dot and name', () => {
  const v = todo({ labels: ['bug', 'later'] });
  const entries = [entry(v)];
  const ctx = { viewerId: 'm-alice', members: MEMBERS, labelColors: colors };
  const opts = filterOptions(entries, ctx);
  assert.deepEqual(opts.labels, [{ label: 'bug', n: 1, color: 'red' }, { label: 'later', n: 1 }]);
  const mk = (over) => model(entries, { filters: { ...emptyFilters(), ...over.filters }, labelColors: colors, filterInfo: { total: 1, shown: 1, options: opts, archived: over.archived ?? null }, showArchived: over.showArchived ?? false });
  const off = filterBar(mk({ filters: { labels: ['bug'] } }));
  assert.equal(byAttr(off, 'data-action', 'labels-open').length, 0);
  assert.equal(byAttr(off, 'data-action', 'toggle-archived')[0].props['aria-pressed'], 'false');
  assert.equal(byClass(byAttr(off, 'data-action', 'filter-label-off')[0], 'ldot-red').length, 1);
  assert.match(textOf(findAll(off, (n) => n.tag === 'option' && n.props.value === 'later')[0]), /^later \(1\)$/);
  const on = filterBar(mk({ showArchived: true, archived: 3 }));
  const t = byAttr(on, 'data-action', 'toggle-archived')[0];
  assert.equal(t.props['aria-pressed'], 'true');
  assert.match(textOf(t), /Show archived\s*3/);
  assert.match(textOf(findAll(on, (n) => n.tag === 'option' && n.props.value === 'bug')[0]), /bug \(1\) · red/, 'the colour is in the text too');
});

test('table: archived rows are muted and badged; labels are coloured by class', () => {
  const rows = [entry(todo({ id: 'a', labels: ['bug'] })), entry(archivedView({ id: 'b', key: 'BDL-2' }))];
  const t = tableScreen(model(rows, { table: { sort: DEFAULT_SORT }, labelColors: colors }));
  const trs = findAll(t, (n) => n.tag === 'tr' && n.props['data-card-id']);
  assert.deepEqual(trs.map((r) => [r.props['data-card-id'], r.props.class]), [['a', null], ['b', 'is-archived']]);
  assert.equal(byClass(t, 'label-c-red').length, 1);
  assert.equal(byClass(t, 'archived-badge').length, 1);
});

test('CSS: every token has a label class and a cover class, AA ink on tint in both themes, and no colour reaches a style attribute', async () => {
  const css = await readFile(new URL('../app.css', import.meta.url), 'utf8');
  for (const c of LABEL_COLORS) {
    for (const sel of [`.label-c-${c}`, `.cover-${c}`, `.cover-swatch-${c}`, `.ldot-${c}`]) assert.ok(css.includes(sel), sel);
    const pair = (n) => css.match(new RegExp(`--lc-${c}-${n}:\\s*light-dark\\((#[0-9a-fA-F]{6}),\\s*(#[0-9a-fA-F]{6})\\)`));
    const bg = pair('bg');
    const ink = pair('ink');
    assert.ok(bg && ink, c);
    assert.ok(contrast(ink[1], bg[1]) >= 4.5, `${c} light ${contrast(ink[1], bg[1]).toFixed(2)}`);
    assert.ok(contrast(ink[2], bg[2]) >= 4.5, `${c} dark ${contrast(ink[2], bg[2]).toFixed(2)}`);
  }
});
