// D31: a card an agent created carries a visible "agent-suggested" badge, so
// people see where it came from before they give it to Claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, byClass } from '../js/h.js';
import { displayFace } from '../js/view.js';
import { card } from '../js/render-board.js';
import { view, model } from './fixtures.js';

const entry = (v) => ({ view: v, elapsed_ms: 0, face: displayFace(v) });

test('agent-suggested cards show the badge; human-created cards do not', () => {
  const todo = { run_state: 'todo', run: null, live: null, column: 'todo' };
  const suggested = card(entry(view({ ...todo, agent_suggested: true, parent_card_id: 'c-0' })), model([]));
  const badge = byClass(suggested, 'agent-suggested');
  assert.equal(badge.length, 1);
  assert.equal(textOf(badge[0]), 'agent-suggested');
  assert.equal(byClass(card(entry(view(todo)), model([])), 'agent-suggested').length, 0);
});

test('a card an integration created shows a "via <provider>" badge instead of the raw label', () => {
  const todo = { run_state: 'todo', run: null, live: null, column: 'todo' };
  const v = card(entry(view({ ...todo, labels: ['bug', 'via:github'] })), model([]));
  const badge = byClass(v, 'via-integration');
  assert.equal(badge.length, 1);
  assert.equal(textOf(badge[0]), 'via github');
  assert.ok(!textOf(v).includes('via:github'));
  assert.equal(byClass(card(entry(view({ ...todo, labels: ['bug'] })), model([])), 'via-integration').length, 0);
});
