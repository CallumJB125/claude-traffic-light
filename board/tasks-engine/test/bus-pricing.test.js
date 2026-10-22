// Post-run pricing for Codex bus runs (tokens only, no CLI cost): estimated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { priceTokens, runCost } from '../bus/pricing.js';

test('tokens are priced from the local table; unknown models use the default; Claude cost is native', () => {
  assert.equal(priceTokens({ inputTokens: 1_000_000, outputTokens: 0 }), 1.25);
  assert.equal(priceTokens({ model: 'gpt-5-mini', inputTokens: 1_000_000, outputTokens: 1_000_000 }), 2.25);
  assert.equal(priceTokens({ model: 'nope', inputTokens: -5, outputTokens: NaN }), 0);
  assert.deepEqual(runCost({ ai: { id: 'codex', model: null }, cost: { usd: 0 }, tokens: { inputTokens: 10, outputTokens: 5 } }), { cost_usd: 0, cost_basis: 'estimated' });
  assert.deepEqual(runCost({ ai: { id: 'codex', model: null }, cost: { usd: 0 }, tokens: { inputTokens: 400_000, outputTokens: 100_000 } }), { cost_usd: 1.5, cost_basis: 'estimated' });
  assert.deepEqual(runCost({ ai: { id: 'claude', model: null }, cost: { usd: 0.42 } }), { cost_usd: 0.42, cost_basis: 'native' });
});
