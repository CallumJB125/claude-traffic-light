// Post-run pricing for bus runs whose CLI reports no cost (Codex: tokens only at
// turn.completed, codex.js). A local list-price table, USD per million tokens;
// the result is cost_basis 'estimated' and, under a ChatGPT sign-in, notional.
const PER_MTOK = Object.freeze({
  'gpt-5-codex': { input: 1.25, output: 10 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'o4-mini': { input: 1.1, output: 4.4 },
});
const DEFAULT = PER_MTOK['gpt-5-codex'];

export function priceTokens({ model = null, inputTokens = 0, outputTokens = 0 } = {}) {
  const p = (model && PER_MTOK[model]) || DEFAULT;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  return Math.round((n(inputTokens) * p.input + n(outputTokens) * p.output) / 1e4) / 100;
}

/** A finished task's cost: native when the CLI reported one (Claude), else priced from tokens. */
export function runCost(task) {
  if (task.ai.id !== 'codex' && Number.isFinite(task.cost?.usd) && task.cost.usd > 0) return { cost_usd: task.cost.usd, cost_basis: 'native' };
  return { cost_usd: priceTokens({ model: task.ai.model, ...(task.tokens ?? {}) }), cost_basis: 'estimated' };
}
