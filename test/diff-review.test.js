const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const DiffReview = require('../src/diff-review');

function fakeSpawn({ reply = '- Looks fine.\n', code = 0 } = {}) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough();
    let input = '';
    child.stdin.on('data', (d) => { input += d; });
    child.stdin.on('finish', () => { calls[calls.length - 1].input = input; child.stdout.end(reply); setImmediate(() => child.emit('close', code)); });
    child.kill = () => {};
    calls.push({ bin, args, opts });
    return child;
  };
  return { spawn, calls };
}
const DIFF = 'diff --git a/a.txt b/a.txt\n-one\n+two\n';

test('off by default, and nothing runs while off', async () => {
  assert.equal(DiffReview.DEFAULTS.enabled, false);
  assert.equal(DiffReview.normalize({}).enabled, false);
  const f = fakeSpawn();
  assert.deepEqual(await DiffReview.review({ diff: DIFF, settings: undefined, entitled: true, bin: '/x/claude', spawn: f.spawn }), { ok: false, reason: 'off' });
  assert.equal(f.calls.length, 0);
});

test('needs the checkpoints.review entitlement', async () => {
  const f = fakeSpawn();
  assert.deepEqual(await DiffReview.review({ diff: DIFF, settings: { enabled: true }, entitled: false, bin: '/x/claude', spawn: f.spawn }), { ok: false, reason: 'not-entitled' });
  assert.equal(f.calls.length, 0);
});

test('every run is capped by --max-budget-usd, with no tools, and the diff goes on stdin', async () => {
  const f = fakeSpawn();
  const r = await DiffReview.review({ diff: DIFF, settings: { enabled: true, model: 'sonnet', maxBudgetUsd: 0.1 }, entitled: true, bin: '/x/claude', spawn: f.spawn, env: { HOME: '/h', PATH: '/p', ANTHROPIC_API_KEY: 'secret' } });
  assert.deepEqual(r, { ok: true, text: '- Looks fine.' });
  const { args, input, opts } = f.calls[0];
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.1');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.ok(args.includes('--no-session-persistence') && args.includes('--strict-mcp-config'));
  assert.ok(!args.some((a) => a.includes('+two')), 'diff not in argv');
  assert.ok(input.includes(DIFF));
  assert.equal(opts.env.ANTHROPIC_API_KEY, undefined, 'minimal environment');
  assert.ok(!opts.cwd.includes('a.txt'));
});

test('the budget is always set and never above the cap; unknown models fall back', () => {
  for (const [given, want] of [[undefined, '0.05'], [0, '0.05'], [-1, '0.05'], ['x', '0.05'], [Infinity, '0.05'], [0.2, '0.2'], [5, String(DiffReview.MAX_BUDGET)]]) {
    const args = DiffReview.buildArgs({ model: 'haiku', maxBudgetUsd: given });
    assert.equal(args[args.indexOf('--max-budget-usd') + 1], want, String(given));
  }
  const args = DiffReview.buildArgs({ model: 'rm -rf', maxBudgetUsd: 0.05 });
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
});

test('a failing CLI, a missing CLI and an empty diff are reported, never thrown', async () => {
  const on = { enabled: true };
  assert.deepEqual(await DiffReview.review({ diff: DIFF, settings: on, entitled: true, bin: null }), { ok: false, reason: 'no-cli' });
  assert.deepEqual(await DiffReview.review({ diff: '  ', settings: on, entitled: true, bin: '/x', spawn: fakeSpawn().spawn }), { ok: false, reason: 'empty' });
  assert.deepEqual(await DiffReview.review({ diff: DIFF, settings: on, entitled: true, bin: '/x', spawn: fakeSpawn({ code: 1 }).spawn }), { ok: false, reason: 'failed' });
  assert.deepEqual(await DiffReview.review({ diff: DIFF, settings: on, entitled: true, bin: '/x', spawn: () => { throw new Error('boom'); } }), { ok: false, reason: 'failed' });
});
