import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tackleChoices, tacklePreference, raisedBudget } from '../js/tackle.js';

test('a ready device makes its provider available while unsupported caps stay unavailable', () => {
  const choices = tackleChoices([{ ai: [{ id: 'codex', available: false, reason: 'signed_out', budget: 'none' }] }, { ai: [{ id: 'codex', available: true, reason: null, budget: 'none' }] }]);
  assert.equal(choices.find((a) => a.id === 'codex').available, true);
  assert.equal(choices.find((a) => a.id === 'codex').budget, 'none');
  assert.equal(choices.find((a) => a.id === 'claude').available, false);
});
test('offline selection can queue and signed-out online selection stays disabled', () => {
  assert.equal(tackleChoices().find((a) => a.id === 'codex').available, true);
  const codex = tackleChoices([{ ai: [{ id: 'codex', available: false, reason: 'signed_out', budget: 'none' }] }]).find((a) => a.id === 'codex');
  assert.equal(codex.available, false); assert.equal(codex.reason, 'signed_out');
});

test('the default tackle choice is Claude with a card budget', () => {
  assert.deepEqual(tacklePreference(null), { ai: 'claude', budget_mode: 'cap', budget_usd: 5 });
});
test('raisedBudget: +50% or +$5 over the larger of cap and spend, clamped to the board maximum', () => {
  const v = { budget: { cap_usd: 5, spent_usd: 5.1 } };
  assert.equal(raisedBudget(v, 'pct50'), 7.65);
  assert.equal(raisedBudget(v, 'usd5'), 10.1);
  assert.equal(raisedBudget(v, 'usd5', 8), 8);
  assert.equal(raisedBudget(v, 'usd5', 5.3), null);
  assert.equal(raisedBudget({ budget: { cap_usd: 1000, spent_usd: 1000 } }, 'usd5'), null);
});
