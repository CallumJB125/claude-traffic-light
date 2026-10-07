'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { suggest, need, tierOf, DEFAULT_TABLE } = require('../src/session-router');

const P = (provider, label, available = true) => ({ provider, label, available });
const all = [P('codex', 'Codex'), P('claude', 'Claude Code'), P('gemini', 'Gemini CLI', false), P('local-ollama-abc', 'llama3 · Ollama')];

test('Router: short questions go to the free local model and say why', () => {
  const s = suggest('what is 2+2?', all);
  assert.equal(s.provider, 'local-ollama-abc'); assert.equal(s.tier, 'free'); assert.equal(s.cheaper, true);
  assert.match(s.reason, /short question.*cheapest available/);
  assert.doesNotMatch(s.reason, /\n/, 'one line');
});

test('Router: code/reasoning questions skip free and pick the cheap tier; big coding tasks need standard', () => {
  assert.equal(suggest('explain this regex: ^a+$', all).provider, 'claude');
  assert.equal(suggest('x'.repeat(600), all).provider, 'claude');
  assert.equal(suggest('Refactor the auth module across the codebase', all).provider, 'claude', 'Claude Code handles big coding tasks, so it is not rated below them');
  assert.equal(suggest('y'.repeat(1600), all).provider, 'claude');
  assert.equal(DEFAULT_TABLE.claude, 'standard');
  assert.equal(suggest('Refactor the auth module', all).cheaper, false, 'nothing cheaper was capable');
});

test('Router: unavailable providers are never suggested; with nothing capable it picks the most capable available', () => {
  assert.equal(suggest('hi', [P('gemini', 'Gemini', false)]), null);
  assert.equal(suggest('hi', []), null); assert.equal(suggest('hi', null), null);
  const s = suggest('debug this failing test', [P('local-x-1', 'Tiny'), P('gemini', 'Gemini CLI')]);
  assert.equal(s.provider, 'gemini'); assert.match(s.reason, /most capable option/);
  assert.equal(suggest('hi', all.filter((p) => p.provider !== 'local-ollama-abc')).provider, 'claude');
});

test('Router: tier table is configurable; unknown providers default to standard; deterministic ordering', () => {
  assert.equal(tierOf('local-anything', DEFAULT_TABLE), 'free');
  assert.equal(tierOf('newthing', DEFAULT_TABLE), 'standard');
  assert.equal(tierOf('__proto__', DEFAULT_TABLE), 'standard');
  assert.equal(suggest('hello', all, { table: { codex: 'free', claude: 'premium' } }).provider, 'codex', 'table wins; ties by label');
  assert.equal(tierOf('codex', { codex: 'bogus' }), 'standard');
  assert.deepEqual(need(''), need('   '));
  assert.equal(suggest('hello', [P('local-b', 'B'), P('local-a', 'A')]).provider, 'local-a');
});

const view = (over) => ({ kind: 'on', route: 'PRIMARY', chip: { tone: 'green', label: 'Primary' }, ...over });

test('Router: Burst limit pressure lowers Claude\'s rank without making it incapable', () => {
  const noLocal = all.filter((p) => p.provider !== 'local-ollama-abc');
  assert.equal(suggest('Refactor the auth module', noLocal).provider, 'claude');
  assert.equal(suggest('Refactor the auth module', noLocal, { burst: view() }).provider, 'claude', 'healthy Burst changes nothing');
  const near = view({ chip: { tone: 'amber', label: 'Limit near' } });
  const s = suggest('Refactor the auth module', noLocal, { burst: near });
  assert.equal(s.provider, 'codex'); assert.match(s.reason, /Claude is close to its limit/);
  assert.equal(suggest('Refactor the auth module', noLocal, { burst: view({ route: 'SECONDARY', chip: { tone: 'amber', label: 'Secondary until 14:00' } }) }).provider, 'codex');
  assert.equal(suggest('hi', [P('claude', 'Claude Code')], { burst: near }).provider, 'claude', 'still suggested when it is the only option');
  assert.equal(suggest('Refactor the auth module', noLocal, { burst: { kind: 'off', chip: { tone: 'grey', label: 'Burst off' } } }).provider, 'claude', 'Burst off is not pressure');
  assert.equal(suggest('Refactor the auth module', noLocal, { burst: null }).provider, 'claude');
});
