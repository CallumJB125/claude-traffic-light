const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const HatchAi = require('../src/hatch-ai.js');
const Hatch = require('../characters/hatch.js');

const GOOD = JSON.stringify(Hatch.templateCharacter({ name: 'Otter', shape: 'animal', color: '#8f6bd6' }));
const envelope = (result, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.02, ...extra });

// A stand-in for child_process.spawn: replies[i] is what the i-th run prints (or 'hang').
function fakeSpawn(replies) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    const call = { bin, args, opts, stdin: '', child };
    calls.push(call);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    child.stdin = { on() {}, end(text) { call.stdin = text; if (reply === 'hang') return; setImmediate(() => { child.stdout.emit('data', reply.out); child.emit('close', reply.code ?? 0); }); } };
    return child;
  };
  return { spawn, calls };
}

const run = (over = {}) => HatchAi.describe({ params: { name: 'Otter', description: 'a sleepy otter who loves coffee', shape: 'animal' }, bin: '/fake/claude', consented: () => true, askConsent: async () => true, env: { HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'secret', AWS_SECRET: 'x' }, ...over });

test('hatch-ai: available only with the claude program; otherwise one honest line that names what to install', () => {
  assert.deepEqual(HatchAi.availability({ bin: '/opt/homebrew/bin/claude' }), { ai: true, tool: 'claude', label: 'Claude Code' });
  const none = HatchAi.availability({ bin: null, tools: [{ id: 'claude', installed: false }] });
  assert.equal(none.ai, false);
  assert.match(none.reason, /needs an AI: install Claude Code/);
  assert.doesNotMatch(none.reason, /\n/);
  const half = HatchAi.availability({ bin: null, tools: [{ id: 'claude', installed: true }] });
  assert.match(half.reason, /claude program was not found/);
});

test('hatch-ai: the consent dialog names the tool, says the description is sent, and defaults to Cancel', () => {
  const d = HatchAi.consentDialog();
  assert.equal(d.buttons[d.defaultId], 'Cancel');
  assert.equal(d.cancelId, 0);
  assert.equal(d.buttons[1], 'Send to Claude Code');
  assert.match(d.message, /Send your description to Claude Code\?/);
  assert.match(d.detail, /Your description[^.]*sent to it/);
  assert.match(d.detail, /Anthropic/);
  assert.match(d.detail, /no tools/);
  assert.match(d.detail, /asked this once/);
});

test('hatch-ai: without consent nothing runs; declining sends nothing', async () => {
  const f = fakeSpawn([{ out: envelope(GOOD) }]);
  let asked = 0;
  const r = await run({ consented: () => false, askConsent: async () => { asked += 1; return false; }, spawn: f.spawn });
  assert.equal(asked, 1);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(r, { ok: false, error: 'Not sent. Nothing left this computer.' });
});

test('hatch-ai: once consented, one bounded hidden run; the description goes on stdin, never in argv', async () => {
  const f = fakeSpawn([{ out: envelope(GOOD) }]);
  let asked = 0;
  const r = await run({ spawn: f.spawn, askConsent: async () => { asked += 1; return true; } });
  assert.equal(asked, 0);
  assert.equal(r.ok, true);
  assert.equal(r.character.name, 'Otter');
  assert.equal(r.params.description, 'a sleepy otter who loves coffee');
  assert.equal(f.calls.length, 1);
  const { args, opts, stdin } = f.calls[0];
  assert.equal(f.calls[0].bin, '/fake/claude');
  for (const flag of ['-p', '--no-session-persistence', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--max-budget-usd', '--system-prompt']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.25');
  assert.ok(!args.some((a) => a.includes('sleepy otter')), 'the description must not be in argv');
  assert.match(stdin, /sleepy otter/);
  assert.equal(opts.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(opts.env.AWS_SECRET, undefined);
  assert.equal(opts.env.HOME, '/h');
  assert.match(opts.cwd, /plexiform-hatch-/);
});

test('hatch-ai: a rejected reply is sent back with the reasons, and a fixed one is accepted', async () => {
  const f = fakeSpawn([{ out: envelope('no json here') }, { out: envelope(`\`\`\`json\n${GOOD}\n\`\`\``) }]);
  const r = await run({ spawn: f.spawn });
  assert.equal(r.ok, true);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].stdin, /last reply was rejected[\s\S]*no JSON object/);
});

test('hatch-ai: a character the validator rejects is never returned, and the error says so plainly', async () => {
  const bad = JSON.parse(GOOD);
  bad.sprite.body = '<script>alert(1)</script><image href="https://example.com/x.png" />';
  const f = fakeSpawn([{ out: envelope(JSON.stringify(bad)) }]);
  const r = await run({ spawn: f.spawn });
  assert.equal(r.ok, false);
  assert.equal(r.character, undefined);
  assert.equal(f.calls.length, HatchAi.MAX_ATTEMPTS);
  assert.match(r.error, /did not make a character that passed the checks, so nothing was kept\. Last problem: /);
});

test('hatch-ai: an error from the tool stops at once and is shown', async () => {
  const f = fakeSpawn([{ out: envelope('Not logged in · Please run /login', { is_error: true }), code: 1 }]);
  const r = await run({ spawn: f.spawn });
  assert.equal(f.calls.length, 1);
  assert.equal(r.ok, false);
  assert.match(r.error, /Not logged in/);
  const g = fakeSpawn([{ out: 'garbage', code: 2 }]);
  assert.match((await run({ spawn: g.spawn })).error, /stopped \(exit 2\)/);
});

test('hatch-ai: a run that hangs is killed at the time limit', async () => {
  const f = fakeSpawn(['hang']);
  const r = await run({ spawn: f.spawn, timeoutMs: 20 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].child.killed, true);
  assert.match(r.error, /took longer than/);
});

test('hatch-ai: the budget cap stops further tries', async () => {
  const f = fakeSpawn([{ out: envelope('nope', { total_cost_usd: 0.3 }) }]);
  const r = await run({ spawn: f.spawn });
  assert.equal(f.calls.length, 1);
  assert.match(r.error, /50-cent cap/);
});

test('hatch-ai: no description or no tool means nothing runs', async () => {
  const f = fakeSpawn([{ out: envelope(GOOD) }]);
  assert.equal((await run({ spawn: f.spawn, params: { description: '  <> ' } })).error, 'Write a short description first.');
  assert.match((await run({ spawn: f.spawn, bin: null })).error, /install Claude Code/);
  assert.equal(f.calls.length, 0);
});
