const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Fast = require('../hooks/fast-hook.js');
const HookSocket = require('../src/hook-socket.js');
const { runForwarded } = require('../src/hook-inprocess.js');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const HOST = os.hostname().split('.')[0];
// unix socket paths are short-limited: keep the data folder directly under /tmp
const tmpRoot = () => fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'pxf-'));
const payload = (o = {}) => JSON.stringify({ session_id: 's1', cwd: '/proj', tool_name: 'Bash', tool_input: { command: 'ls' }, ...o });

test('only frequent non-blocking events are forwarded; AskUserQuestion and session edges are not', () => {
  for (const s of ['tool-use', 'tool-done', 'prompt-submit', 'stop', 'subagent-start']) assert.equal(Fast.eligible(s, { tool_name: 'Bash' }), true, s);
  for (const s of ['session-start', 'session-end', 'permission-request', 'elicitation', 'compact']) assert.equal(Fast.eligible(s, {}), false, s);
  assert.equal(Fast.eligible('tool-use', { tool_name: 'AskUserQuestion' }), false);
});

test('the endpoint is a unix socket in the data folder, or a per-folder named pipe on Windows', () => {
  assert.equal(Fast.pipePath('/home/u/.claude-traffic-light', 'linux'), '/home/u/.claude-traffic-light/hook.sock');
  const a = Fast.pipePath('C:\\Users\\a\\.claude-traffic-light', 'win32');
  assert.match(a, /^\\\\\.\\pipe\\plexiform-hook-[0-9a-f]{16}$/);
  assert.notEqual(a, Fast.pipePath('C:\\Users\\b\\.claude-traffic-light', 'win32'));
  assert.equal(a, Fast.pipePath('c:\\users\\a\\.claude-traffic-light', 'win32'), 'case-insensitive like the filesystem');
});

test('readEndpoint reads a valid file and rejects missing, malformed or short-token ones', () => {
  const root = tmpRoot();
  assert.equal(Fast.readEndpoint(root), null);
  fs.writeFileSync(path.join(root, Fast.ENDPOINT_FILE), JSON.stringify({ v: 1, path: '/x', token: 'a'.repeat(64) }));
  assert.deepEqual(Fast.readEndpoint(root), { path: '/x', token: 'a'.repeat(64) });
  fs.writeFileSync(path.join(root, Fast.ENDPOINT_FILE), JSON.stringify({ v: 1, path: '/x', token: 'short' }));
  assert.equal(Fast.readEndpoint(root), null);
  fs.writeFileSync(path.join(root, Fast.ENDPOINT_FILE), '{nope');
  assert.equal(Fast.readEndpoint(root), null);
});

test('build forwards only the environment the hook looks at', () => {
  const m = Fast.build({ signal: 'tool-use', payload: '{}', env: { TMUX: '/t', TERM_PROGRAM: 'x', AWS_SECRET_ACCESS_KEY: 'nope', ANTHROPIC_API_KEY: 'nope' }, ppid: 5, cwd: '/c', token: 't' });
  assert.deepEqual(m.env, { TMUX: '/t', TERM_PROGRAM: 'x' });
  assert.equal(JSON.stringify(m).includes('nope'), false);
});

test('forward settles false on a missing socket, a refusal and a silent server', async () => {
  assert.equal(await Fast.forward({ v: 1 }, { path: '/tmp/pxf-nothing-here.sock' }, { timeoutMs: 200 }), false);
  const { EventEmitter } = require('events');
  const silent = { connect: () => Object.assign(new EventEmitter(), { setEncoding() {}, write() {}, destroy() {} }) };
  const t0 = Date.now();
  assert.equal(await Fast.forward({ v: 1 }, { path: 'x' }, { timeoutMs: 60, net: silent }), false);
  assert.ok(Date.now() - t0 < 500, 'gives up at the timeout');
});

async function serve(handle) {
  const root = tmpRoot();
  const calls = [];
  const srv = HookSocket.create({ rootDir: root, handle: (m) => { calls.push(m); return handle(m); } });
  assert.equal(await srv.start(), true);
  return { root, srv, calls, endpoint: Fast.readEndpoint(root) };
}

test('socket server: token required, endpoint file private, stop removes it', async () => {
  const { root, srv, calls, endpoint } = await serve(() => true);
  try {
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(root, Fast.ENDPOINT_FILE)).mode & 0o777, 0o600);
      assert.equal(fs.statSync(srv.path).mode & 0o777, 0o600);
    }
    assert.equal(await Fast.forward(Fast.build({ signal: 'tool-use', payload: payload(), env: {}, ppid: 1, cwd: '/', token: endpoint.token }), endpoint), true);
    assert.equal(await Fast.forward(Fast.build({ signal: 'tool-use', payload: payload(), env: {}, ppid: 1, cwd: '/', token: 'f'.repeat(64) }), endpoint), false);
    assert.equal(calls.length, 1, 'a wrong token never reaches the handler');
  } finally { srv.stop(); }
  assert.equal(fs.existsSync(path.join(root, Fast.ENDPOINT_FILE)), false);
  assert.equal(await Fast.forward({ v: 1 }, endpoint, { timeoutMs: 200 }), false);
});

test('socket server: a handler that declines or throws answers not-handled', async () => {
  let mode = 'no';
  const { srv, endpoint } = await serve(() => { if (mode === 'throw') throw new Error('boom'); return false; });
  try {
    const msg = Fast.build({ signal: 'tool-use', payload: payload(), env: {}, ppid: 1, cwd: '/', token: endpoint.token });
    assert.equal(await Fast.forward(msg, endpoint), false);
    mode = 'throw';
    assert.equal(await Fast.forward(msg, endpoint), false);
  } finally { srv.stop(); }
});

function seed(root, over = {}) {
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  const file = path.join(root, 'sessions', `${HOST}-s1.json`);
  fs.writeFileSync(file, JSON.stringify({ sessionId: 's1', host: HOST, hostApp: 'Terminal', claudePid: 4321, cwd: '/proj', signal: 'idle-nudge', updatedAt: new Date(Date.now() - 60000).toISOString(), ...over }));
  return file;
}
const msgFor = (o = {}) => ({ v: 1, signal: 'tool-use', payload: payload(), env: {}, ppid: 4321, cwd: '/proj', ...o });

test('in-process run writes the same session update a spawned hook would', () => {
  const root = tmpRoot();
  const file = seed(root);
  assert.equal(runForwarded({ hooksDir: HOOKS_DIR, rootDir: root, msg: msgFor() }), true);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.signal, 'tool-use');
  assert.equal(s.tool, 'Bash');
  assert.equal(s.claudePid, 4321);
  assert.equal(s.hostApp, 'Terminal');
});

test('in-process run declines whatever would need a process lookup', () => {
  const root = tmpRoot();
  const run = (msg, extra = {}) => runForwarded({ hooksDir: HOOKS_DIR, rootDir: root, msg, ...extra });
  assert.equal(run(msgFor()), false, 'no session on record yet');
  seed(root);
  assert.equal(run(msgFor({ ppid: 999 })), false, 'parent is not the recorded Claude pid');
  assert.equal(run(msgFor({ signal: 'session-start' })), false);
  assert.equal(run(msgFor({ payload: payload({ tool_name: 'AskUserQuestion' }) })), false);
  assert.equal(run(msgFor({ payload: 'not json' })), false);
  assert.equal(run(msgFor({ payload: payload({ session_id: undefined }) })), false);
  seed(root, { hostApp: undefined });
  assert.equal(run(msgFor()), false, 'host app not yet known');
  seed(root, { claudePid: undefined });
  assert.equal(run(msgFor()), false, 'pid not yet known');
});

test('Windows: the recorded pid only has to be alive (the parent there is a short-lived cmd.exe)', () => {
  const root = tmpRoot();
  seed(root);
  const run = (isAlive, ppid) => runForwarded({ hooksDir: HOOKS_DIR, rootDir: root, msg: msgFor({ ppid }), platform: 'win32', isAlive });
  assert.equal(run(() => false, 777), false, 'a dead Claude pid goes to the full path');
  assert.equal(run((pid) => pid === 4321, 777), true, 'alive pid, different cmd.exe parent');
});

function runHook(root, signal, stdin) {
  return spawnSync(process.execPath, [path.join(HOOKS_DIR, 'set-status.js'), signal], { input: stdin, env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: root, CLAUDE_TRAFFIC_LIGHT_ASK_MS: '0' }, encoding: 'utf8', timeout: 15000 });
}
const runHookAsync = (root, signal, stdin) => new Promise((resolve) => {
  const p = require('child_process').spawn(process.execPath, [path.join(HOOKS_DIR, 'set-status.js'), signal], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: root, CLAUDE_TRAFFIC_LIGHT_ASK_MS: '0' } });
  p.on('close', (code) => resolve(code));
  p.stdin.end(stdin);
});

test('end to end: with the app listening the app writes the session; otherwise the hook does', { skip: process.platform === 'win32' }, async () => {
  const root = tmpRoot();
  // Flag off / app not running: no endpoint file, the hook writes it itself.
  assert.equal(runHook(root, 'tool-use', payload()).status, 0);
  const file = path.join(root, 'sessions', `${HOST}-s1.json`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).signal, 'tool-use');
  fs.rmSync(file);

  // App listening and able to take it: the app's handler ran, not the hook's own code.
  seed(root, { claudePid: process.pid });
  const { srv, calls } = await (async () => {
    const calls = [];
    const srv = HookSocket.create({ rootDir: root, handle: (m) => { calls.push(m.signal); return runForwarded({ hooksDir: HOOKS_DIR, rootDir: root, msg: m }); } });
    await srv.start();
    return { srv, calls };
  })();
  try {
    assert.equal(await runHookAsync(root, 'tool-done', payload()), 0);
    assert.deepEqual(calls, ['tool-done']);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).signal, 'tool-done');
  } finally { srv.stop(); }
});

test('end to end: an app that declines, or has gone away, never loses the event', { skip: process.platform === 'win32' }, async () => {
  const root = tmpRoot();
  const file = path.join(root, 'sessions', `${HOST}-s1.json`);
  const srv = HookSocket.create({ rootDir: root, handle: () => false });
  await srv.start();
  try {
    assert.equal(await runHookAsync(root, 'tool-use', payload()), 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).signal, 'tool-use', 'declined: the hook wrote it');
  } finally { srv.stop(); }
  fs.rmSync(file);
  // A stale endpoint file left by a crashed app: connect fails fast, fallback.
  fs.writeFileSync(path.join(root, Fast.ENDPOINT_FILE), JSON.stringify({ v: 1, path: path.join(root, 'hook.sock'), token: 'a'.repeat(64) }));
  const t0 = Date.now();
  assert.equal(await runHookAsync(root, 'tool-done', payload()), 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).signal, 'tool-done');
  assert.ok(Date.now() - t0 < 5000);
});
