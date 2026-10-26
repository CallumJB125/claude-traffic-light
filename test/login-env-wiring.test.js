'use strict';
// PR 2b (C2/N1): the login-shell values main reads reach the Claude carry in the Tasks helper and the team runner
// over parentPort only, never argv, env or logs; a timeout or failure leaves the app env in charge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createLoginEnvStore, LOGIN_ENV_MESSAGE } = require('../board/shared/login-env-store.cjs');
const { createLoginEnvHub, loginEnvMessage, CARRY_NAMES } = require('../src/login-env-hub.js');
const { createClaudeCarry, productionCarry } = require('../board/shared/claude-carry.cjs');
const { sweepKeyDirs, pidStartedAt } = require('../src/claude-carry.js');
const { createTasksSupervisor, tasksEnv } = require('../src/tasks-process.js');

const URL = 'https://shell-gw.example/v1';
const SECRET = 'sk-shell-LOGINSECRET000000000000000000000000';
const values = { ANTHROPIC_BASE_URL: URL, ANTHROPIC_AUTH_TOKEN: SECRET };

test('the store takes only well-formed string values, replaces them on each message, and answers only the names asked for', async () => {
  const store = createLoginEnvStore({ waitMs: 20 });
  assert.equal(store.accept({ type: 'something.else' }), false);
  assert.deepEqual(await store.loginShellEnv({ names: CARRY_NAMES }), {}, 'nothing until main sends');
  assert.equal(store.accept({ type: LOGIN_ENV_MESSAGE, values: { ...values, 'bad name': 'x', N: 5, BIG: 'x'.repeat(9000), ARR: ['a'], OTHER: 'y' } }), true);
  assert.deepEqual(await store.loginShellEnv({ names: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'N', 'BIG', 'ARR'] }), values);
  assert.deepEqual(await store.loginShellEnv({ names: ['ANTHROPIC_BASE_URL'] }), { ANTHROPIC_BASE_URL: URL }, 'only what was asked');
  assert.equal(store.accept({ type: LOGIN_ENV_MESSAGE, values: 'junk' }), true);
  assert.deepEqual(await store.loginShellEnv({ names: CARRY_NAMES }), {}, 'a malformed message clears, never throws');
});

test('values reach the carry in a helper: the store feeds createClaudeCarry({loginShellEnv}) and a gateway only in the login shell is carried', async () => {
  const store = createLoginEnvStore({ waitMs: 20 });
  const carry = createClaudeCarry({
    env: {}, home: '/fx/home', platform: 'linux', loginShellEnv: store.loginShellEnv,
    readFile: (f) => (f === '/fx/home/.claude/settings.json' ? '{"model":"x"}' : null), readDir: () => null,
    probe: async () => true, credentialsExist: () => true,
  });
  const before = await carry.prepare({ mode: 'notool' });
  assert.equal(before.childEnv?.ANTHROPIC_BASE_URL, undefined, 'before main has sent anything the app env decides');
  store.accept(loginEnvMessage(values));
  const after = await carry.prepare({ mode: 'notool' });
  assert.equal(after.childEnv.ANTHROPIC_BASE_URL, URL);
  assert.equal(after.childEnv.ANTHROPIC_AUTH_TOKEN, SECRET);
  // the run settings of a shell-bearing run get the routing, never the token
  const run = await carry.prepare({ mode: 'bash', keyFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'le-')), 'api.key') });
  assert.equal(run.settingsEnv.ANTHROPIC_BASE_URL, URL);
  assert.ok(!JSON.stringify({ s: run.settingsEnv, c: run.cliEnv, d: run.disallowed }).includes(SECRET));
  run.release();
});

test('productionCarry hands loginShellEnv to the carry; both entries pass their store to it', () => {
  const was = globalThis.__plexiformNoRealCli;
  delete globalThis.__plexiformNoRealCli;
  try {
    const seen = [];
    const c = productionCarry({ loginShellEnv: async (a) => { seen.push(a); return {}; }, home: '/fx/none', readFile: () => null, readDir: () => null });
    assert.ok(c && typeof c.prepare === 'function');
  } finally { globalThis.__plexiformNoRealCli = was; }
  for (const f of ['board/runner/app-entry.js', 'board/tasks-engine/utility-entry.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(src, /loginShellEnv: loginEnv\.loginShellEnv/, f);
    assert.match(src, /acceptLoginEnv\(/, f);
    assert.ok(!/process\.env\.[A-Z_]*LOGIN/.test(src), 'nothing is read from env');
  }
});

test('the hub reads in the background, publishes only on change, and a failure or timeout leaves no values and no secret in the log', async () => {
  const logs = [];
  let result = { ok: true, env: { ...values }, reason: null };
  let reads = 0;
  const hub = createLoginEnvHub({ read: async () => { reads++; return result; }, log: (m) => logs.push(m), setTimer: (fn) => { hub.fire = fn; return { unref() {} }; }, clearTimer() {} });
  const got = [];
  hub.subscribe((v) => got.push({ ...v }));
  assert.equal(hub.values(), null, 'not read yet is null, not empty');
  await hub.refresh();
  assert.deepEqual(got, [values]);
  await hub.refresh();
  assert.equal(got.length, 1, 'unchanged: nothing re-sent');
  assert.deepEqual(await hub.read({ names: ['ANTHROPIC_BASE_URL'] }), { ANTHROPIC_BASE_URL: URL });
  result = { ok: false, env: {}, reason: 'timeout' };
  await hub.refresh();
  assert.deepEqual(hub.values(), {}, 'a timeout falls back to the app env');
  assert.deepEqual(got.at(-1), {});
  assert.deepEqual(logs, ['login shell env unavailable (timeout)']);
  assert.ok(!JSON.stringify(logs).includes(SECRET) && !JSON.stringify(logs).includes(URL));
  const throwing = createLoginEnvHub({ read: async () => { throw new Error(`boom ${SECRET}`); }, log: (m) => logs.push(m) });
  await throwing.refresh();
  assert.deepEqual(throwing.values(), {});
  assert.ok(!JSON.stringify(logs).includes(SECRET), 'a thrown error is never logged');
  assert.ok(reads >= 3);
});

test('invalidate() drops the reader cache, re-reads once after the debounce, and re-sends the changed values', async () => {
  let invalidated = 0;
  let env = { ANTHROPIC_BASE_URL: 'https://a.example' };
  let fire = null;
  const hub = createLoginEnvHub({ read: async () => ({ ok: true, env: { ...env } }), invalidate: () => { invalidated++; }, setTimer: (fn) => { fire = fn; return { unref() {} }; }, clearTimer() {} });
  const got = [];
  hub.subscribe((v) => got.push({ ...v }));
  await hub.refresh();
  env = { ANTHROPIC_BASE_URL: 'https://b.example' };
  hub.invalidate(); hub.invalidate();
  assert.equal(invalidated, 2);
  fire(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(got.map((v) => v.ANTHROPIC_BASE_URL), ['https://a.example', 'https://b.example']);
});

class Child extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.pid = 987655; this.messages = []; }
  postMessage(m) { this.messages.push(m); if (m?.type === 'tasks.shutdown') queueMicrotask(() => this.emit('exit', 0)); }
  kill() { queueMicrotask(() => this.emit('exit', 0)); }
}

test('the Tasks helper gets the values over parentPort at fork and at readiness, and again on change; never argv or env', async () => {
  const dataDir = path.join(os.tmpdir(), 'tasks-helper-le');
  const forks = [];
  const c = new Child();
  const s = createTasksSupervisor({ fork: (entry, args, opts) => { forks.push({ entry, args, opts }); return c; }, entry: path.join(dataDir, 'entry.js'), dataDir, loginEnv: () => values, readyTimeoutMs: 500 });
  const p = s.ensure();
  c.emit('message', { type: 'tasks.listening', socket: path.join(dataDir, 'tasks.sock'), epoch: '00000000-0000-4000-8000-000000000002' });
  await p;
  const loginMsgs = c.messages.filter((m) => m.type === LOGIN_ENV_MESSAGE);
  assert.equal(loginMsgs.length, 2);
  assert.deepEqual(loginMsgs[0].values, values);
  s.sendLoginEnv({ ANTHROPIC_BASE_URL: 'https://b.example' });
  assert.deepEqual(c.messages.at(-1).values, { ANTHROPIC_BASE_URL: 'https://b.example' });
  assert.deepEqual(forks[0].args, []);
  assert.ok(!JSON.stringify(forks[0]).includes(SECRET) && !JSON.stringify(forks[0]).includes(URL), 'not in argv or the fork env');
  assert.ok(!JSON.stringify(tasksEnv(dataDir, { ...process.env, ...values })).includes(SECRET));
  await s.stop({ final: true });
});

test('a helper with no login values (failure or timeout upstream) is sent nothing and keeps the app env', async () => {
  const c = new Child();
  const s = createTasksSupervisor({ fork: () => c, entry: '/x/e.js', dataDir: '/x', loginEnv: () => null, readyTimeoutMs: 200 });
  const p = s.ensure();
  c.emit('message', { type: 'tasks.listening', socket: '/x/tasks.sock', epoch: '00000000-0000-4000-8000-000000000003' });
  await p;
  assert.equal(c.messages.filter((m) => m.type === LOGIN_ENV_MESSAGE).length, 0);
  await s.stop({ final: true });
});

test('optional hardening: a key dir whose pid is alive but older than that process (pid reuse) is swept; a newer one is kept', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-'));
  try {
    const old = 'chat-4242-old', fresh = 'voice-key-4242-new';
    for (const n of [old, fresh]) { fs.mkdirSync(path.join(root, n)); }
    const past = new Date(Date.now() - 3600_000);
    fs.utimesSync(path.join(root, old), past, past);
    const n = sweepKeyDirs(root, { alive: () => true, startedAt: () => Date.now() - 60_000 });
    assert.equal(n, 1);
    assert.deepEqual(fs.readdirSync(root), [fresh]);
    assert.equal(sweepKeyDirs(root, { alive: () => true, startedAt: () => null }), 0, 'unknown start time keeps it');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('review 1: pidStartedAt works unmocked (macOS and Linux ps) and is close to this process\'s real start', () => {
  const started = pidStartedAt(process.pid);
  assert.ok(started !== null, 'ps -o etime= is understood here');
  const expected = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(started - expected) < 3000, `${started - expected} ms off`);
  assert.equal(pidStartedAt(2 ** 22 + 12345), null, 'no such pid: unknown');
});

test('review 2: the OAuth token value never leaves the hub; only its presence (1) is stored, published and posted', async () => {
  const token = 'sk-ant-oat01-REALTOKEN000000000000000000000000';
  const hub = createLoginEnvHub({ read: async () => ({ ok: true, env: { ...values, CLAUDE_CODE_OAUTH_TOKEN: token } }) });
  const posted = [];
  hub.subscribe((v) => posted.push(loginEnvMessage(v)));
  await hub.refresh();
  assert.equal(hub.values().CLAUDE_CODE_OAUTH_TOKEN, '1');
  assert.ok(!JSON.stringify(posted).includes(token) && !JSON.stringify(await hub.read({ names: CARRY_NAMES })).includes(token));
  const empty = createLoginEnvHub({ read: async () => ({ ok: true, env: { CLAUDE_CODE_OAUTH_TOKEN: '' } }) });
  await empty.refresh();
  assert.deepEqual(empty.values(), {}, 'an empty token is no token');
});

test('review 3: a spawn in the first window waits for the login-shell read and gets the gateway; a read that never lands falls back to the app env', async () => {
  // main side: hub.read awaits the first refresh
  let release;
  const hub = createLoginEnvHub({ read: () => new Promise((r) => { release = () => r({ ok: true, env: { ...values } }); }) });
  const p = hub.read({ names: ['ANTHROPIC_BASE_URL'] });
  const r = hub.refresh();
  setTimeout(() => release(), 50);
  assert.deepEqual(await p, { ANTHROPIC_BASE_URL: URL });
  await r;
  const never = createLoginEnvHub({ read: () => new Promise(() => {}), firstReadWaitMs: 30 });
  assert.deepEqual(await never.read({ names: ['ANTHROPIC_BASE_URL'] }), {}, 'bounded wait, then the app env');
  assert.deepEqual(never.values(), {});
  // helper side: the carry prepares before the message, which arrives 100 ms later
  const store = createLoginEnvStore({ waitMs: 2000 });
  const carry = createClaudeCarry({ env: {}, home: '/fx/home', platform: 'linux', loginShellEnv: store.loginShellEnv, readFile: () => null, readDir: () => null, probe: async () => true, credentialsExist: () => true });
  setTimeout(() => store.accept(loginEnvMessage(values)), 100);
  const t0 = Date.now();
  const out = await carry.prepare({ mode: 'notool' });
  assert.equal(out.childEnv.ANTHROPIC_BASE_URL, URL);
  assert.ok(Date.now() - t0 < 1500);
  // and a store that is never told gives up after its wait, once
  const quiet = createLoginEnvStore({ waitMs: 30 });
  assert.deepEqual(await quiet.loginShellEnv({ names: CARRY_NAMES }), {});
});

test('review 5: focus refreshes are at most one a minute; invalidate is not limited', async () => {
  let t = 1_000_000, reads = 0;
  const hub = createLoginEnvHub({ read: async () => { reads++; return { ok: false, reason: 'spawn_failed' }; }, now: () => t, setTimer: () => ({ unref() {} }), clearTimer() {} });
  await hub.focus(); await hub.focus(); await hub.focus();
  assert.equal(reads, 1);
  t += 61_000;
  await hub.focus();
  assert.equal(reads, 2);
});
