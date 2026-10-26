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
    for (const r of seen.settings.permissions.deny) assert.ok(deny.includes(r), 'the settings file and the argv deny the same /proc rules');
    assert.ok(seen.settings.permissions.deny.includes('Read(//proc/**)') && seen.settings.permissions.deny.includes('Read(/proc/**)'));
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

// The rule from the /proc lab (dogfood-lab/fixtures/proc-environ-read.md): a child with a file tool never has the key
// in its launch env and denies /proc; a child with --tools '' may have the key in env.
test('every Claude site: tool set against where the key lives (lab proc-environ-read)', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { carry } = await carryOf(GW_SETTINGS);
  const envHasKey = (env) => Object.values(env).some((v) => v === KEY);
  // no tools: env is allowed
  const e = spawner({ out: 'WHAT: hi\nRATING: safe\nANSWER: Allow' });
  await ExplainAi.createRunner({ bin: '/x/claude', spawn: e.spawn, env: { HOME: '/fx/home', PATH: '/bin' }, carry }).ask('p');
  const d = spawner({ out: '- ok' });
  await DiffReview.review({ diff: 'diff --git a/a b/a\n-1\n+2\n', settings: { enabled: true, model: 'haiku' }, entitled: true, bin: '/x/claude', spawn: d.spawn, env: { HOME: '/fx/home', PATH: '/bin' }, carry });
  const h = spawner({ out: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{}', total_cost_usd: 0 }) });
  await HatchAi.describe({ params: { name: 'Otter', description: 'a sleepy otter', shape: 'animal' }, bin: '/fake/claude', consented: () => true, askConsent: async () => true, env: { HOME: '/fx/home', PATH: '/bin' }, spawn: h.spawn, carry });
  const ro = spawner(); const roCalls = [];
  const readOnly = createClaudeCodeSession({ bin: '/x/claude', env: { HOME: '/fx/home' }, carry, spawn: (b, a, o) => { roCalls.push({ args: a, opts: o }); return child(); } });
  await readOnly.open({ cwd: '/tmp' }); readOnly.stop(); void ro;
  for (const c of [e.calls[0], d.calls[0], h.calls[0], roCalls[0]]) {
    assert.equal(at(c.args, '--tools'), '', 'no tools');
    assert.ok(envHasKey(c.opts.env), 'the key may ride the env of a child with no tools');
  }
  // file tools: the key is never in the launch env, and /proc is denied
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-root-')), keyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'site-keys-'));
  try {
    const chatCalls = [];
    const writable = createClaudeCodeSession({ bin: '/x/claude', env: { HOME: '/fx/home' }, carry, safeRoot: root, keyRoot, spawn: (b, a, o) => { chatCalls.push({ args: a, opts: o }); return child(); } });
    await writable.open({ cwd: root }); writable.stop();
    const screenCalls = [];
    const fsFake = { mkdtempSync: (p) => fs.mkdtempSync(p), writeFileSync: fs.writeFileSync, realpathSync: fs.realpathSync, rmSync: fs.rmSync };
    const ask = VoiceHelper.askClaude({ spawn: (b, a, o) => { screenCalls.push({ args: a, opts: o }); return child({ out: 'Click Wi-Fi.' }); }, fs: fsFake, tmpdir: os.tmpdir(), keyRoot, args: VoiceScreen.claudeArgs('/tmp/x/screen.png'), env: { HOME: '/fx/home' }, prompt: 'q', carry });
    assert.equal(await ask.promise, 'Click Wi-Fi.');
    for (const c of [chatCalls[0], screenCalls[0]]) {
      assert.notEqual(at(c.args, '--tools'), '', 'has a file tool');
      assert.ok(!envHasKey(c.opts.env) && !('ANTHROPIC_AUTH_TOKEN' in c.opts.env), 'the key is not in the launch env');
      assert.ok(!JSON.stringify(c.args).includes(KEY));
      const deny = c.args.slice(c.args.indexOf('--disallowedTools') + 1);
      assert.ok(deny.includes('Read(//proc/**)') && deny.includes('Read(/proc/**)'), '/proc denied');
      assert.ok(c.args.includes('--settings'), 'the key comes through a settings file');
    }
    assert.deepEqual(fs.readdirSync(keyRoot), [], 'every key dir is gone after the run');
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(keyRoot, { recursive: true, force: true }); }
});

test('the key dirs of a child with file tools live under the app data dir and a start sweeps leftovers (review 4)', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const Carry = require('../src/claude-carry.js');
  const { ownedAdapters } = require('../src/interaction-main.js');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-'));
  try {
    const root = Carry.ensureKeyRoot(path.join(userData, 'run'));
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    for (const n of ['chat-aaa', 'voice-key-bbb', 'chat-999999991-x']) { fs.mkdirSync(path.join(root, n)); fs.writeFileSync(path.join(root, n, 'api.key'), KEY); }
    fs.mkdirSync(path.join(root, 'other'));
    assert.equal(Carry.sweepKeyDirs(root, { alive: () => false }), 3);
    assert.deepEqual(fs.readdirSync(root), ['other']);
    assert.equal(Carry.sweepKeyDirs(path.join(userData, 'nope')), 0);
    // a writable chat made by the owned adapters puts its key dir under the root it was given
    const { carry } = await carryOf(GW_SETTINGS);
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    let dir;
    const session = createClaudeCodeSession({ bin: '/x/claude', env: { HOME: '/fx/home' }, carry, safeRoot: project, keyRoot: root, spawn: (b, a) => { dir = path.dirname(a[a.indexOf('--settings') + 1]); return child(); } });
    await session.open({ cwd: project });
    assert.ok(path.basename(dir).startsWith(`chat-${process.pid}-`) && path.dirname(dir) === root, dir);
    session.stop();
    fs.rmSync(project, { recursive: true, force: true });
    assert.equal(typeof ownedAdapters, 'function');
  } finally { fs.rmSync(userData, { recursive: true, force: true }); }
});

test('R2-A: a sweep keeps the key dirs of a live process (a second instance, a dev run) and removes a dead one\'s', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const Carry = require('../src/claude-carry.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-'));
  try {
    const live = `${Carry.keyDirPrefix('chat', 4242)}abc`, voice = `${Carry.keyDirPrefix('voice-key', 4242)}abc`, dead = `${Carry.keyDirPrefix('chat', 777)}abc`;
    for (const n of [live, voice, dead, 'chat-old']) { fs.mkdirSync(path.join(root, n)); fs.writeFileSync(path.join(root, n, 'api.key'), KEY); }
    assert.equal(Carry.sweepKeyDirs(root, { alive: (pid) => pid === 4242 }), 2);
    assert.deepEqual(fs.readdirSync(root).sort(), [live, voice].sort(), 'live-pid dirs kept, the dead one\'s and a pid-less leftover removed');

  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('R2-A: the key root is a getter read at open time (after the dev profile is set), and main sweeps only after the single-instance lock', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-a-')), rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-b-')), project = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  try {
    let current = rootA;
    const { carry } = await carryOf(GW_SETTINGS);
    const dirs = [];
    const session = createClaudeCodeSession({ bin: '/x/claude', env: { HOME: '/fx/home' }, carry, safeRoot: project, keyRoot: () => current, spawn: (b, a) => { dirs.push(path.dirname(a[a.indexOf('--settings') + 1])); return child(); } });
    current = rootB;       // the dev profile was set after the session was built
    await session.open({ cwd: project }); session.stop();
    assert.equal(path.dirname(dirs[0]), rootB, 'resolved when used, not when built');
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /const claudeKeyRoot = \(\) =>/, 'a getter, not a value computed at load');
    const lock = src.indexOf('requestSingleInstanceLock()'), sweep = src.indexOf('sweepKeyDirs(');
    assert.ok(lock > 0 && sweep > lock, 'the sweep comes after the single-instance lock');
    assert.equal((src.match(/sweepKeyDirs\(/g) || []).length, 1, 'one sweep, guarded by gotLock');
    assert.match(src.slice(sweep - 120, sweep), /gotLock/);
  } finally { for (const d of [rootA, rootB, project]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('N2: a file-tool child with a carry but no key root fails closed: nothing spawns and nothing is written to /tmp', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { carry } = await carryOf(GW_SETTINGS);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const before = fs.readdirSync(os.tmpdir()).filter((n) => /^(chat|voice-key)-/.test(n));
  try {
    const s = createClaudeCodeSession({ bin: '/x/claude', env: { HOME: '/fx/home' }, carry, safeRoot: project, spawn: () => { throw new Error('must not start'); } });
    await assert.rejects(s.open({ cwd: project }), /no private folder/);
    let spawned = false;
    const ask = VoiceHelper.askClaude({ spawn: () => { spawned = true; return child(); }, fs: require('node:fs'), tmpdir: os.tmpdir(), args: VoiceScreen.claudeArgs('/tmp/x/screen.png'), env: { HOME: '/fx/home' }, prompt: 'q', carry });
    assert.equal(await ask.promise, null);
    assert.equal(spawned, false);
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => /^(chat|voice-key)-/.test(n)), before);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('a writable chat with no carry (plain login) still denies /proc to Read, Grep and Glob', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  try {
    const calls = [];
    const s = createClaudeCodeSession({ bin: '/x/claude', env: { HOME: '/fx/home' }, carry: null, safeRoot: project, spawn: (b, a, o) => { calls.push({ args: a, opts: o }); return child(); } });
    await s.open({ cwd: project }); s.stop();
    const deny = calls[0].args.slice(calls[0].args.indexOf('--disallowedTools') + 1);
    for (const r of ['Read(//proc/**)', 'Read(/proc/**)', 'Grep(//proc/**)', 'Glob(/proc/**)']) assert.ok(deny.includes(r), r);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
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
