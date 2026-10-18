import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinboardPanel } from '../js/pinboard.js';
import { byAttr, textOf } from '../js/h.js';
import { model } from './fixtures.js';

const pins = [{ id: 'p1', kind: 'command', label: 'Tests', value: 'npm test', by: 'Ana' }, { id: 'p2', kind: 'priority', label: 'Ship checkout', value: '', by: 'Ben' }, { id: 'p3', kind: 'link', label: 'Staging', value: 'https://staging.example.test', by: 'Ana' }];

test('pinboard: priorities first, links open safely, writers get a form and remove buttons', () => {
  const tree = pinboardPanel(model([], { view: 'board', board: { id: 'b', name: 'Bondly', settings: { pins } } }));
  const rows = byAttr(tree, 'data-pin').filter((n) => n.tag === 'li');
  assert.deepEqual(rows.map((r) => r.props['data-pin']), ['p2', 'p3', 'p1']);
  const link = byAttr(tree, 'href')[0];
  assert.equal(link.props.rel, 'noopener noreferrer');
  assert.ok(byAttr(tree, 'data-form').some((f) => f.props['data-form'] === 'pin-add'));
  assert.equal(byAttr(tree, 'data-action').filter((b) => b.props['data-action'] === 'pin-remove').length, 3);
  assert.match(textOf(tree), /pinned by Ana/);
});

test('pinboard: viewers see pins without a form; the panel is absent off the board view and on the local board', () => {
  const ro = pinboardPanel(model([], { view: 'board', readOnly: true, board: { id: 'b', settings: { pins } } }));
  assert.equal(byAttr(ro, 'data-form').length, 0);
  assert.equal(byAttr(ro, 'data-action').length, 0);
  assert.equal(pinboardPanel(model([], { view: 'table', board: { id: 'b', settings: { pins } } })), null);
  assert.equal(pinboardPanel(model([], { view: 'board', localCard: true, board: { id: 'b' } })), null);
  assert.match(textOf(pinboardPanel(model([], { view: 'board', board: { id: 'b', settings: {} } }))), /Nothing pinned yet/);
});
