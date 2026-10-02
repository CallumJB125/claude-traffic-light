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
  assert.equal(suggest('Refactor the auth module across the codebase', all).provider, 'codex');
  assert.equal(suggest('y'.repeat(1600), all).provider, 'codex');
  assert.equal(suggest('Refactor the auth module', all).cheaper, false, 'nothing cheaper was capable');
});

test('Router: unavailable providers are never suggested; with nothing capable it picks the most capable available', () => {
  assert.equal(suggest('hi', [P('gemini', 'Gemini', false)]), null);
  assert.equal(suggest('hi', []), null); assert.equal(suggest('hi', null), null);
  const s = suggest('debug this failing test', [P('local-x-1', 'Tiny'), P('claude', 'Claude Code')]);
  assert.equal(s.provider, 'claude'); assert.match(s.reason, /most capable option/);
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
