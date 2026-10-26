// The no-tool Claude children (owned chat, explain, Hatch, diff review, voice, voice-screen) carry the user's
// own provider and auth (lab T3): routing and the key in the child env, the person's small model for a `haiku`
// default, the isolation flags unchanged, and no settings file or key file at all (nothing for a tool to read).
// Fake CLIs only; the carry reads an in-memory file system.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const ExplainAi = require('../src/explain-ai.js');
const HatchAi = require('../src/hatch-ai.js');
const DiffReview = require('../src/diff-review.js');
const { createClaudeCodeSession } = require('../src/claude-code-session.js');
const VoiceHelper = require('../src/voice-helper.js');
const Voice = require('../src/voice.js');
const VoiceScreen = require('../src/voice-screen.js');
const VoiceCapture = require('../src/voice-capture-main.js');

const GATEWAY = 'https://gw.example/v1';
const SIGN_IN = 'your key helper needs you to sign in; run it once in a terminal';

async function carryOf(settings, opts = {}) {
  const { fixtureCarry, CFG, settingsFile } = await import('../board/shared/test-support/claude-carry-fixture.js');
  return fixtureCarry({ files: { [`${CFG}/settings.json`]: settingsFile(settings) }, ...opts });
}
const KEY = 'sk-ant-api03-FIXTUREKEY0000000000000000000000000000';
const GW_SETTINGS = { model: 'glm-5.3-flash', env: { ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_AUTH_TOKEN: KEY } };

function child({ out = 'ok', code = 0 } = {}) {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdinText = '';
  c.stdin = new PassThrough();
  c.stdin.on('data', (d) => { c.stdinText += d; });
  c.stdin.on('finish', () => setImmediate(() => { c.stdout.end(out); c.emit('close', code); }));
  c.kill = () => {};
  c.pid = 999999;
  return c;
}
function spawner(reply) {
  const calls = [];
  const spawn = (bin, args, opts) => { calls.push({ bin, args, opts }); return child(reply); };
  return { spawn, calls };
}
const at = (args, flag) => args[args.indexOf(flag) + 1];
function assertCarried({ args, opts }, { model }) {
  assert.equal(at(args, '--setting-sources'), '', 'isolation flag unchanged');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--settings') && !args.includes('--mcp-config'), 'no settings file: nothing on disk for a tool to read');
  assert.equal(at(args, '--model'), model);
  assert.equal(opts.env.ANTHROPIC_BASE_URL, GATEWAY);
  assert.equal(opts.env.ANTHROPIC_AUTH_TOKEN, KEY, 'a no-tool child takes the key in its env (plan C14)');
  assert.ok(!JSON.stringify(args).includes(KEY) && !JSON.stringify(args).includes('api.key'), 'never in argv, never a key file');
}

test('explain (L9): provider and key in the env, the gateway model for haiku, a failed preflight runs nothing', async () => {
  const { carry } = await carryOf(GW_SETTINGS);
  const f = spawner({ out: 'WHAT: hi\nRATING: safe\nANSWER: Allow' });
  const runner = ExplainAi.createRunner({ bin: '/x/claude', spawn: f.spawn, env: { HOME: '/fx/home', PATH: '/bin' }, carry });
  assert.equal((await runner.ask('the prompt')).ok, true);
  assertCarried(f.calls[0], { model: 'glm-5.3-flash' });
  const bad = await carryOf({ apiKeyHelper: 'sso' }, { commands: { sso: { ok: false, timedOut: true, reason: SIGN_IN } } });
  const g = spawner();
  assert.deepEqual(await ExplainAi.createRunner({ bin: '/x/claude', spawn: g.spawn, env: { HOME: '/fx/home' }, carry: bad.carry }).ask('x'), { ok: false, reason: 'failed' });
  assert.equal(g.calls.length, 0);
});

test('Hatch (L9): the sonnet model is not replaced (its alias resolves through the carried env); provider and key are carried', async () => {
  const { carry } = await carryOf(GW_SETTINGS);
  const f = spawner({ out: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{}', total_cost_usd: 0 }) });
  await HatchAi.describe({ params: { name: 'Otter', description: 'a sleepy otter', shape: 'animal' }, bin: '/fake/claude', consented: () => true, askConsent: async () => true, env: { HOME: '/fx/home', PATH: '/bin' }, spawn: f.spawn, carry });
  assertCarried(f.calls[0], { model: 'sonnet' });
});

test('diff review (L9): the haiku default follows the gateway; a chosen sonnet stays sonnet', async () => {
  const { carry } = await carryOf(GW_SETTINGS);
  for (const [model, want] of [['haiku', 'glm-5.3-flash'], ['sonnet', 'sonnet']]) {
    const f = spawner({ out: '- Looks fine.' });
    const r = await DiffReview.review({ diff: 'diff --git a/a b/a\n-1\n+2\n', settings: { enabled: true, model }, entitled: true, bin: '/x/claude', spawn: f.spawn, env: { HOME: '/fx/home', PATH: '/bin' }, carry });
    assert.equal(r.ok, true);
    assertCarried(f.calls[0], { model: want });
  }
});

test('owned Claude chat (L8): provider, key and model reach the child; a failed preflight rejects open() with the reason', async () => {
  const { carry } = await carryOf(GW_SETTINGS);
  const calls = [];
  const a = createClaudeCodeSession({ bin: '/x/claude', env: { HOME: '/fx/home', PATH: '/bin' }, carry, spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return child(); } });
  await a.open({ cwd: process.cwd().startsWith('/') ? '/tmp' : process.cwd() });
  assertCarried(calls[0], { model: 'glm-5.3-flash' });
  assert.equal(at(calls[0].args, '--permission-mode'), 'dontAsk');
  const bad = await carryOf({ apiKeyHelper: 'sso' }, { commands: { sso: { ok: false, timedOut: true, reason: SIGN_IN } } });
  const b = createClaudeCodeSession({ bin: '/x/claude', env: { HOME: '/fx/home' }, carry: bad.carry, spawn: () => { throw new Error('must not start'); } });
  await assert.rejects(b.open({ cwd: '/tmp' }), (e) => e.message === SIGN_IN);
});

test('writable owned chat (review 4): the key is a file in a private dir behind apiKeyHelper, never in the child env; the dir and /proc are denied; the dir goes at close', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-root-'));
  const keyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-keys-'));
  try {
    const { carry } = await carryOf(GW_SETTINGS);
    const calls = [];
    let seen;
    const spawn = (bin, args, opts) => {
      const settingsFile = args[args.indexOf('--settings') + 1];
      seen = { settingsFile, settings: JSON.parse(fs.readFileSync(settingsFile, 'utf8')), mode: fs.statSync(settingsFile).mode & 0o777, dir: path.dirname(settingsFile), keyMode: fs.statSync(path.join(path.dirname(settingsFile), 'api.key')).mode & 0o777 };
      calls.push({ args, opts });
      return child();
    };
    const session = createClaudeCodeSession({ bin: '/x/claude', env: { HOME: '/fx/home', PATH: '/bin' }, carry, spawn, safeRoot: root, keyRoot });
    await session.open({ cwd: root });
    const { args, opts } = calls[0];
    assert.equal(at(args, '--tools'), 'Read,Glob,Grep,Edit,Write');
    assert.equal(seen.settings.apiKeyHelper, `/bin/cat '${path.join(seen.dir, 'api.key')}'`);
    assert.equal(seen.settings.env.ANTHROPIC_BASE_URL, GATEWAY);
    assert.equal(seen.mode, 0o600); assert.equal(seen.keyMode, 0o600);
    assert.equal(fs.statSync(seen.dir).mode & 0o777, 0o700);
    assert.ok(seen.dir.startsWith(fs.realpathSync(keyRoot)) || seen.dir.startsWith(keyRoot), 'outside the project');
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in opts.env) && !('ANTHROPIC_API_KEY' in opts.env), 'no key in the child env');
    assert.ok(![JSON.stringify(args), JSON.stringify(opts.env), JSON.stringify(seen.settings)].some((x) => x.includes(KEY)));
    const deny = args.slice(args.indexOf('--disallowedTools') + 1);
    for (const r of ['Read(//proc/**)', 'Grep(//proc/**)', 'Glob(//proc/**)', 'Read(/proc/**)', `Read(/${seen.dir}/**)`, `Write(/${seen.dir}/**)`]) assert.ok(deny.includes(r), r);
    session.stop();
    assert.equal(fs.existsSync(seen.dir), false, 'key dir deleted at close');
    // a failed preflight leaves nothing behind
    const bad = await carryOf({ apiKeyHelper: 'sso' }, { commands: { sso: { ok: false, timedOut: true, reason: SIGN_IN } } });
    const s2 = createClaudeCodeSession({ bin: '/x/claude', env: { HOME: '/fx/home' }, carry: bad.carry, spawn: () => { throw new Error('must not start'); }, safeRoot: root, keyRoot });
    await assert.rejects(s2.open({ cwd: root }), (e) => e.message === SIGN_IN);
    assert.deepEqual(fs.readdirSync(keyRoot), [], 'no key dir left');
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(keyRoot, { recursive: true, force: true }); }
});

test('voice free-form (L9b): voice-helper merges the carried env and swaps haiku; the voice env keeps the person\'s config dir and proxy', async () => {
  const { carry } = await carryOf(GW_SETTINGS);
  const calls = [];
  const fsFake = { mkdtempSync: (p) => `${p}AB`, rmSync() {} };
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return child({ out: 'Two sessions.' }); };
  const baseEnv = Voice.claudeEnv({ HOME: '/fx/home', PATH: '/bin', CLAUDE_CONFIG_DIR: '/fx/home/.claude', HTTPS_PROXY: 'http://p:1' });
  const ask = VoiceHelper.askClaude({ spawn, fs: fsFake, tmpdir: '/tmp', args: Voice.claudeArgs(), env: baseEnv, prompt: 'q', carry });
  assert.equal(await ask.promise, 'Two sessions.');
  assertCarried(calls[0], { model: 'glm-5.3-flash' });
  assert.equal(calls[0].opts.env.HTTPS_PROXY, 'http://p:1');
  assert.equal(calls[0].opts.env.HOME, '/fx/home');
  // Without a carry nothing changes: the exact env object and haiku.
  const plain = [];
  const ask2 = VoiceHelper.askClaude({ spawn: (c, a, o) => { plain.push({ a, o }); return child({ out: 'x' }); }, fs: fsFake, tmpdir: '/tmp', args: Voice.claudeArgs(), env: baseEnv, prompt: 'q' });
  await ask2.promise;
  assert.equal(plain[0].o.env, baseEnv);
  assert.equal(at(plain[0].a, '--model'), 'haiku');
});

test('voice-helper: a failed preflight spawns nothing and resolves null; cancel before the carry settles spawns nothing', async () => {
  const bad = await carryOf({ apiKeyHelper: 'sso' }, { commands: { sso: { ok: false, timedOut: true, reason: SIGN_IN } } });
  let spawned = 0;
  const spawn = () => { spawned++; return child(); };
  const fsFake = { mkdtempSync: (p) => `${p}AB`, rmSync() {} };
  assert.equal(await VoiceHelper.askClaude({ spawn, fs: fsFake, tmpdir: '/tmp', args: [], env: {}, prompt: 'q', carry: bad.carry }).promise, null);
  const ok = await carryOf(GW_SETTINGS);
  const run = VoiceHelper.askClaude({ spawn, fs: fsFake, tmpdir: '/tmp', args: [], env: {}, prompt: 'q', carry: ok.carry });
  run.cancel();
  assert.equal(await run.promise, null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawned, 0);
});

test('voice-screen (L9b): the screen question passes the carry to askClaude and keeps Read-on-one-file only', async () => {
  const { carry } = await carryOf(GW_SETTINGS);
  let seen;
  const cap = VoiceCapture.create({
    platform: 'darwin', systemPreferences: { getMediaAccessStatus: () => 'granted' },
    desktopCapturer: { getSources: async () => [{ display_id: '1', thumbnail: { isEmpty: () => false, toPNG: () => Buffer.from('png'), getSize: () => ({ width: 100, height: 50 }) } }] },
    screen: { getCursorScreenPoint: () => ({ x: 1, y: 1 }), getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 100, height: 50 }, size: { width: 100, height: 50 }, scaleFactor: 1 }) },
    fs: { mkdtempSync: (p) => `${p}AB`, realpathSync: (p) => p, chmodSync() {}, writeFileSync() {}, rmSync() {} }, path: require('node:path'), tmpdir: '/tmp', randomHex: () => 'ab',
    askClaude: (o) => { seen = o; return { promise: Promise.resolve('Click Wi-Fi.'), cancel() {} }; }, spawn: () => {}, env: { HOME: '/fx/home' }, carry,
  });
  const r = await cap.ask({ question: 'where is wifi?' });
  assert.ok(seen, `askClaude was reached (${JSON.stringify(r)})`);
  assert.equal(seen.carry, carry);
  assert.equal(at(seen.args, '--tools'), 'Read');
  assert.equal(at(seen.args, '--model'), 'haiku', 'the args keep the haiku default; askClaude swaps it');
  assert.equal(VoiceScreen.claudeArgs('/tmp/x/screen.png').includes('--settings'), false);
});

test('main-process wiring: only the app\'s own env carries; Burst is named only for its installed binary and default port', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const Carry = require('../src/claude-carry.js');
  assert.equal(Carry.carryFor({ HOME: '/fx/home' }), null, 'a fixture env carries nothing unless a carry is injected');
  assert.equal(Carry.carryFor(process.env), null, 'under the no-real-cli guard even the app env never reads the developer\'s Claude files');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plx-burst-'));
  try {
    assert.equal(await Carry.burstOwnsPort(7777, { home, platform: 'darwin' }), false, 'Burst not installed');
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'claude-burst'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(await Carry.burstOwnsPort(7777, { home, platform: 'darwin' }), true);
    assert.equal(await Carry.burstOwnsPort(4001, { home, platform: 'darwin' }), false, 'not Burst\'s port');
    assert.equal(await Carry.burstOwnsPort(7777, { home, platform: 'linux' }), false, 'Burst is macOS only');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
