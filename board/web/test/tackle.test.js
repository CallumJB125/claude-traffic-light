import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tackleChoices } from '../js/tackle.js';

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
