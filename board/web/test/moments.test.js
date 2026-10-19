import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharedViewsPanel, momentsPanel, shippedThisWeek, describeView } from '../js/moments.js';
import { byAttr, textOf } from '../js/h.js';
import { model, view } from './fixtures.js';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const DAY = 86_400_000;
const views = [{ id: 'v1', name: 'Needs me', values: { q: 'login', chips: 'needs-you' }, by: 'Ana' }];
const moments = [
  { id: 'm1', kind: 'ship', label: 'Checkout went live', note: 'Flagged to 10%', by: 'Ben', at: new Date(NOW - 2 * DAY).toISOString() },
  { id: 'm2', kind: 'decision', label: 'Postgres over Mongo', note: '', by: 'Ana', at: new Date(NOW - 20 * DAY).toISOString() },
  { id: 'm3', kind: 'ship', label: 'Old release', note: '', by: 'Ana', at: new Date(NOW - 10 * DAY).toISOString() },
];
const entries = [
  { view: view({ id: 'c-done', key: 'BDL-9', title: 'Fix login', column: 'done', state_age_ms: 3 * DAY, pr: { number: 42 } }) },
  { view: view({ id: 'c-old', key: 'BDL-2', title: 'Ancient', column: 'done', state_age_ms: 9 * DAY }) },
  { view: view({ id: 'c-open', key: 'BDL-3', title: 'Still open', column: 'in_progress', state_age_ms: DAY }) },
];

test('shared views: writers get a save form tied to active filters, every member can apply a view, text describes its filters', () => {
  const tree = sharedViewsPanel(model([], { view: 'board', board: { id: 'b', settings: { views } }, filtersActive: true }));
  assert.equal(byAttr(tree, 'data-action').filter((b) => b.props['data-action'] === 'view-apply').length, 1);
  assert.equal(byAttr(tree, 'data-form')[0].props['data-form'], 'view-save');
  assert.match(textOf(tree), /q: login · chips: needs-you/);
  assert.match(textOf(tree), /saved by Ana/);
  const idle = sharedViewsPanel(model([], { view: 'table', board: { id: 'b', settings: { views } }, filtersActive: false }));
  assert.ok(idle, 'the panel also shows on the table view');
  assert.equal(byAttr(idle, 'type').find((b) => b.props.type === 'submit').props.disabled, true, 'saving needs active filters');
  const ro = sharedViewsPanel(model([], { view: 'board', readOnly: true, board: { id: 'b', settings: { views } } }));
  assert.equal(byAttr(ro, 'data-form').length, 0);
  assert.equal(byAttr(ro, 'data-action').filter((b) => b.props['data-action'] === 'view-remove').length, 0);
  assert.equal(byAttr(ro, 'data-action').filter((b) => b.props['data-action'] === 'view-apply').length, 1, 'viewers can still apply');
  assert.equal(describeView({}), '');
});

test('moments: shipped this week mixes done cards and ship moments from the last 7 days, newest first; older or open work stays out', () => {
  const s = shippedThisWeek(entries, moments, NOW);
  assert.deepEqual(s.map((x) => x.label), ['Checkout went live', 'BDL-9 Fix login']);
  assert.equal(s[1].pr, 42);
  const tree = momentsPanel(model(entries, { view: 'board', board: { id: 'b', settings: { moments } } }), NOW);
  assert.match(textOf(tree), /2 shipped this week/);
  assert.match(textOf(tree), /Decision.*Postgres over Mongo/s);
  assert.equal(byAttr(tree, 'data-form')[0].props['data-form'], 'moment-mark');
  assert.equal(byAttr(tree, 'data-action').filter((b) => b.props['data-action'] === 'moment-remove').length, 3);
  assert.equal(momentsPanel(model([], { view: 'table', board: { id: 'b', settings: { moments } } })), null);
  assert.match(textOf(momentsPanel(model([], { view: 'board', board: { id: 'b', settings: {} } }), NOW)), /No moments yet/);
});
