// Inline quick-add: title parsing, the optimistic card, and the row it renders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byClass, byAttr, textOf, findAll } from '../js/h.js';
import { displayFace } from '../js/view.js';
import { card, column, boardScreen } from '../js/render-board.js';
import { parseTitles, needsConfirm, pendingCard, CONFIRM_OVER, MAX_TITLE } from '../js/quickadd.js';
import { model } from './fixtures.js';

const entry = (v) => ({ view: v, elapsed_ms: 0, face: displayFace(v) });

test('parseTitles: one per non-empty line, bullets and numbering stripped, length capped', () => {
  assert.deepEqual(parseTitles('Fix login'), ['Fix login']);
  assert.deepEqual(parseTitles('  a  \r\n\r\n- b\n* c\n• d\n1. e\n2) f\n'), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(parseTitles('   \n  '), []);
  assert.deepEqual(parseTitles(null), []);
  assert.equal(parseTitles('x'.repeat(500))[0].length, MAX_TITLE);
  assert.deepEqual(parseTitles('-not a bullet'), ['-not a bullet'], 'a dash without a space is part of the title');
});

test('needsConfirm: more than five pasted lines asks first', () => {
  assert.equal(CONFIRM_OVER, 5);
  assert.equal(needsConfirm(parseTitles('1\n2\n3\n4\n5')), false);
  assert.equal(needsConfirm(parseTitles('1\n2\n3\n4\n5\n6')), true);
});

test('pendingCard: a human-owned To do card that renders, and can\'t be opened, dragged or acted on', () => {
  const v = pendingCard('Write the docs', 7, { prefix: 'BDL', memberId: 'm-alice' });
  assert.equal(v.id, 'pending-7');
  assert.equal(v.key, 'BDL-…');
  assert.equal(v.column, 'todo');
  assert.equal(v.run_state, 'todo');
  const n = card(entry(v), model([]));
  assert.match(n.props.class, /is-pending/);
  assert.equal(n.props['aria-busy'], 'true');
  assert.equal(n.props['data-draggable'], null);
  const open = byClass(n, 'card-open')[0];
  assert.equal(open.props.disabled, true);
  assert.equal(open.props['data-action'], null);
  assert.equal(byClass(n, 'card-actions').length, 0, 'no Give to Claude before the hub has the card');
  assert.match(textOf(n), /Write the docs/);
});

test('pendingCard without a board prefix still has a key', () => {
  assert.equal(pendingCard('t', 1).key, '…');
});

const todo = (m) => column('todo', [], m);

test('To do ends with "+ Add a card"; the other columns do not', () => {
  const m = model([]);
  assert.match(textOf(byAttr(todo(m), 'data-action', 'quick-add')[0]), /Add a card/);
  assert.equal(byAttr(column('done', [], m), 'data-action', 'quick-add').length, 0);
});

test('read-only viewers get no add row', () => {
  const m = model([], { readOnly: true });
  assert.equal(byAttr(todo(m), 'data-action', 'quick-add').length, 0);
  assert.equal(findAll(boardScreen(m), (n) => n.props['data-input'] === 'quickadd').length, 0);
});

test('open: a title field, add/cancel buttons and the key hints; no confirm row', () => {
  const col = todo(model([], { quickAdd: { open: true, seed: '', confirm: null } }));
  const field = byAttr(col, 'data-input', 'quickadd')[0];
  assert.equal(field.tag, 'textarea');
  assert.equal(field.props['aria-label'], 'New card title');
  assert.equal(byAttr(col, 'data-action', 'quick-add-submit').length, 1);
  assert.equal(byAttr(col, 'data-action', 'quick-add-cancel').length, 1);
  assert.match(textOf(col), /Shift\+Enter keeps adding/);
  assert.equal(byClass(col, 'quickadd-confirm').length, 0);
  assert.equal(byAttr(col, 'data-action', 'quick-add').length, 0, 'the closed row is replaced');
});

test('a failed add hands the text back through the field value', () => {
  const col = todo(model([], { quickAdd: { open: true, seed: 'Fix login', confirm: null } }));
  assert.equal(byAttr(col, 'data-input', 'quickadd')[0].props.value, 'Fix login');
});

test('a big paste asks before creating, with the count', () => {
  const titles = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const col = todo(model([], { quickAdd: { open: true, seed: '', confirm: titles } }));
  const row = byClass(col, 'quickadd-confirm')[0];
  assert.match(textOf(row), /Create 7 cards from those lines\?/);
  assert.match(textOf(byAttr(row, 'data-action', 'quick-add-confirm')[0]), /^Create 7$/);
  assert.equal(byAttr(row, 'data-action', 'quick-add-decline').length, 1);
});
