'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Adapters = require('../adapters/index.js');
const Generic = require('../src/ai-tools-generic.js');
const { register, parseDestination } = require('../src/ai-tools-main.js');

const HOOKS = path.join(__dirname, '..', 'hooks');
const generic = Adapters.get('generic');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-generic-'));

test('the generic adapter turns start, stop and exit into working, done and failed, and nothing else', () => {
  const base = { tool: 'aider', session: 'aider-1-2', cwd: '/work/app', pid: 4242 };
  const [start] = generic.normalize('start', base);
  assert.deepEqual([start.signal, start.sessionId, start.cwd, start.tool, start.pid], ['prompt-submit', 'aider-1-2', '/work/app', 'aider', 4242]);
  assert.equal(generic.normalize('exit', { ...base, code: 0 })[0].signal, 'stop');
  assert.equal(generic.normalize('exit', { ...base, code: 2 })[0].signal, 'turn-failed');
  assert.equal(generic.normalize('stop', base)[0].signal, 'stop');
  assert.deepEqual(generic.normalize('permission-ask', base), []);
  assert.deepEqual(generic.normalize('start', null).map((e) => e.signal), ['prompt-submit']);
  const hostile = generic.normalize('start', { tool: 'a;rm -rf', session: '../x', cwd: 'a\nb', pid: -5 })[0];
  assert.deepEqual([hostile.tool, hostile.sessionId, hostile.cwd, hostile.pid], [null, null, null, null]);
});

test('the generic adapter claims no more than it delivers and stays out of the install/uninstall walk', () => {
  assert.equal(generic.capabilities.answer, false);
  assert.equal(generic.capabilities.blocked, false);
  assert.equal(generic.install, undefined);
  assert.ok(!Adapters.list().some((a) => a.id === 'generic'));
  assert.equal(Adapters.get('generic'), generic);
});

test('plexiform-run: start shows the tool working, exit shows done or failed, and the exit code passes through', { skip: process.platform === 'win32' }, () => {
  const h = tmp(), data = path.join(h, 'data');
  const runtime = Adapters.Runtime.make({ execPath: null, hooksDir: HOOKS, dataDir: data });
  const r = Generic.installRunner({ home: h, runtime });
  assert.equal(r.ok, true, JSON.stringify(r));
  const env = { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: data, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` };
  const sessions = () => fs.readdirSync(path.join(data, 'sessions')).map((f) => JSON.parse(fs.readFileSync(path.join(data, 'sessions', f), 'utf8')));

  // While the tool runs, the session reads as working.
  const probe = path.join(h, 'probe.sh');
  fs.writeFileSync(probe, `#!/bin/sh\nls "${path.join(data, 'sessions')}" > "${path.join(h, 'during.txt')}"\ncat "${path.join(data, 'sessions')}"/* > "${path.join(h, 'during.json')}"\nexit 0\n`, { mode: 0o755 });
  let res = spawnSync(r.file, [probe], { env, cwd: h });
  assert.equal(res.status, 0, String(res.stderr));
  const during = JSON.parse(fs.readFileSync(path.join(h, 'during.json'), 'utf8'));
  assert.deepEqual([during.source, during.signal, during.tool], ['generic', 'prompt-submit', 'probe.sh']);
  assert.match(during.sessionId, /^probe\.sh-\d+-\d+$/);
  assert.equal(fs.realpathSync(during.cwd), fs.realpathSync(h));
  let [done] = sessions();
  assert.equal(done.signal, 'stop');

  fs.rmSync(path.join(data, 'sessions'), { recursive: true });
  const fail = path.join(h, 'fail.sh');
  fs.writeFileSync(fail, '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  res = spawnSync(r.file, [fail], { env, cwd: h });
  assert.equal(res.status, 7);
  [done] = sessions();
  assert.equal(done.signal, 'turn-failed');
  assert.equal(spawnSync(r.file, [], { env }).status, 64);
});

test('the runner script is regenerated for a new app path, never over a foreign file, and flags a stale copy', () => {
  const h = tmp();
  const a = Adapters.Runtime.make({ execPath: null, hooksDir: '/a/hooks', dataDir: path.join(h, 'd') });
  const b = Adapters.Runtime.make({ execPath: null, hooksDir: '/b/hooks', dataDir: path.join(h, 'd') });
  assert.equal(Generic.installRunner({ home: h, runtime: a }).ok, true);
  assert.equal(Generic.status({ home: h, runtime: a }).ok, true);
  const stale = Generic.status({ home: h, runtime: b });
  assert.equal(stale.ok, false);
  assert.match(stale.problem, /older or different/);
  assert.equal(Generic.installRunner({ home: h, runtime: b }).ok, true);
  assert.match(fs.readFileSync(Generic.runnerFile(h), 'utf8'), /\/b\/hooks\/emit\.js/);
  assert.match(Generic.status({ home: h, runtime: a, platform: 'win32' }).problem, /macOS or Linux/);
  assert.equal(Generic.keyOf('/usr/bin/aider --x'), 'aider');
  assert.equal(Generic.keyOf('  '), '');
});

test('POST /hook/generic style events land through the shared adapter route', () => {
  const SessionState = require('../hooks/session-state.js');
  const dir = tmp();
  const [e] = generic.normalize('start', { tool: 'amp', session: 'amp-9-1', cwd: '/w' });
  SessionState.applyAdapterEvent(dir, { host: 'h', source: 'generic', event: e, fallbackSession: 'default', waitMs: 100 });
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
  assert.match(file, /^h-generic-amp-9-1\.json$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).signal, 'prompt-submit');
});

test('IPC answers only the owning page, validates ids, and keeps focus requests single-use', async () => {
  const handlers = new Map(), calls = [];
  const tools = new Proxy({}, { get: (_t, name) => (...a) => { calls.push([name, ...a]); return name === 'installUrl' ? 'https://example.test/x' : { ok: true }; } });
  const opened = [], copied = [];
  const ipc = register({ ipcMain: { handle: (n, f) => handlers.set(n, f) }, fromPage: (e) => e.ok === true, shell: { openExternal: (u) => opened.push(u) }, clipboard: { writeText: (t) => copied.push(t) }, tools });
  const call = (n, e, ...a) => handlers.get(n)(e, ...a);
  assert.equal(await call('aitools:scan', { ok: false }), null);
  assert.deepEqual(await call('aitools:connect', { ok: true }, '../../etc'), { ok: false, error: 'Unknown tool.' });
  assert.deepEqual(await call('aitools:connect', { ok: true }, 'codex'), { ok: true });
  assert.equal(await call('aitools:open-install', { ok: true }, 'nope'), false);
  assert.equal(await call('aitools:open-install', { ok: true }, 'codex'), true);
  assert.deepEqual(opened, ['https://example.test/x']);
  assert.equal(await call('aitools:copy', { ok: true }, 'plexiform-run aider'), true);
  assert.equal(await call('aitools:copy', { ok: true }, 'a\nb'), false);
  assert.deepEqual(await call('aitools:add-custom', { ok: true }, 5, 'x'), { ok: false, error: 'Enter a name and the command you run.' });
  ipc.setFocus('codex');
  assert.equal(await call('aitools:focus', { ok: true }), 'codex');
  assert.equal(await call('aitools:focus', { ok: true }), null);
  assert.deepEqual(parseDestination('aitools:all'), { focus: 'all' });
  assert.deepEqual(parseDestination('aitools:codex'), { focus: 'codex' });
  assert.deepEqual(parseDestination('aitools'), { focus: null });
  assert.deepEqual(parseDestination('aitools:bogus'), { focus: null });
  assert.equal(parseDestination('settings'), null);
});
