const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { ENV_KEYS, captureTerminal } = require('../hooks/terminal-id.js');
const Focus = require('../src/focus/index.js');
const Ids = require('../src/focus/ids.js');
const ITerm = require('../src/focus/iterm.js');
const TerminalApp = require('../src/focus/terminal-app.js');
const Ghostty = require('../src/focus/ghostty.js');
const Kitty = require('../src/focus/kitty.js');
const WezTerm = require('../src/focus/wezterm.js');
const Tmux = require('../src/focus/tmux.js');
const VSCode = require('../src/focus/vscode.js');
const { createExplainer } = require('../src/focus/permission.js');
const { createJumper, isRemote } = require('../src/focus/jump.js');

const SET_STATUS = path.join(__dirname, '..', 'hooks', 'set-status.js');
const HOST = os.hostname().split('.')[0];
const UUID = '2F6D0C1A-9B3E-4D5F-8A7B-1C2D3E4F5A6B';

// ── Recording ───────────────────────────────────────────────────────────────

test('only the allow-listed terminal variables are recorded; secrets and unused ids never are', () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-ant-secret', GITHUB_TOKEN: 'ghp_secret', AWS_SECRET_ACCESS_KEY: 'aws', PATH: '/usr/bin', HOME: '/Users/x',
    TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0', ITERM_SESSION_ID: `w0t1p0:${UUID}`,
    KITTY_WINDOW_ID: '3', KITTY_LISTEN_ON: 'unix:/tmp/kitty-1', WEZTERM_PANE: '7', TMUX: '/tmp/tmux-501/default,99,0', TMUX_PANE: '%4',
    VSCODE_PID: '123', VSCODE_IPC_HOOK_CLI: '/tmp/vscode-ipc.sock', VSCODE_GIT_ASKPASS_MAIN: '/x', GHOSTTY_RESOURCES_DIR: '/y',
  };
  const t = captureTerminal({ env, pid: 1234, cwd: '/Users/me/proj', run: () => 'ttys003\n', platform: 'darwin' });
  assert.deepEqual(Object.keys(t.env).sort(), [...ENV_KEYS].sort());
  assert.deepEqual(Object.keys(t).sort(), ['cwd', 'env', 'tty']);
  assert.ok(!JSON.stringify(t).includes('secret'));
  assert.ok(!JSON.stringify(t).includes('VSCODE'));
  assert.equal(t.tty, '/dev/ttys003');
  assert.equal(t.cwd, '/Users/me/proj');
});

test('the allow-list is exactly the keys some adapter reads', () => {
  assert.deepEqual(ENV_KEYS, ['TERM_PROGRAM', 'ITERM_SESSION_ID', 'KITTY_WINDOW_ID', 'KITTY_LISTEN_ON', 'WEZTERM_PANE', 'TMUX', 'TMUX_PANE']);
});

test('recorded values with newlines, NULs or silly lengths are dropped', () => {
  const t = captureTerminal({ env: { TERM_PROGRAM: 'a\nb', TMUX_PANE: 'x'.repeat(301), WEZTERM_PANE: 'a\0', KITTY_WINDOW_ID: 5 }, pid: null, cwd: 'relative', run: () => '' });
  assert.deepEqual(t.env, {});
  assert.equal(t.cwd, null);
});

test('no controlling tty, a failing ps, or no pid all record tty as null without throwing', () => {
  assert.equal(captureTerminal({ env: {}, pid: 10, run: () => '??', platform: 'darwin' }).tty, null);
  assert.equal(captureTerminal({ env: {}, pid: 10, run: () => { throw new Error('ETIMEDOUT'); }, platform: 'darwin' }).tty, null);
  let called = false;
  assert.equal(captureTerminal({ env: {}, pid: 0, run: () => { called = true; }, platform: 'darwin' }).tty, null);
  assert.equal(called, false);
  assert.equal(captureTerminal({ env: {}, pid: 10, run: () => 'pts/3', platform: 'linux' }).tty, '/dev/pts/3');
  assert.equal(captureTerminal({ env: {}, pid: 10, run: () => 'ttys1; rm -rf ~', platform: 'darwin' }).tty, null);
});

function hookEnv(home, extra = {}) {
  const env = { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_TRAFFIC_LIGHT_ASK_MS: '0', ...extra };
  for (const k of ENV_KEYS) if (!(k in extra)) delete env[k];
  return env;
}
const runHook = (home, signal, extra, payload = {}) => spawnSync('node', [SET_STATUS, signal], { env: hookEnv(home, extra), input: JSON.stringify({ session_id: 'jump', cwd: '/tmp', ...payload }) });
const sessionFile = (home) => path.join(home, 'sessions', `${HOST}-jump.json`);
const readSession = (home) => JSON.parse(fs.readFileSync(sessionFile(home), 'utf8'));
const withHome = (fn) => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-jump-')); try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); } };
// The hook skips a repeat of the same signal inside a second.
const pastDedupe = () => { const until = Date.now() + 1100; while (Date.now() < until) { /* spin */ } };

test('SessionStart records the terminal and its folder; later events keep it and never re-read it', () => withHome((home) => {
  assert.equal(runHook(home, 'session-start', { ITERM_SESSION_ID: `w0t0p0:${UUID}`, TERM_PROGRAM: 'iTerm.app', SUPER_SECRET_TOKEN: 'hunter2' }, { cwd: '/Users/me/start' }).status, 0);
  const raw = fs.readFileSync(sessionFile(home), 'utf8');
  assert.ok(!raw.includes('hunter2'));
  assert.equal(JSON.parse(raw).terminal.env.ITERM_SESSION_ID, `w0t0p0:${UUID}`);
  assert.equal(JSON.parse(raw).terminal.cwd, '/Users/me/start');
  assert.equal(runHook(home, 'tool-use', { ITERM_SESSION_ID: 'w9t9p9:changed', TERM_PROGRAM: 'iTerm.app' }, { cwd: '/Users/me/elsewhere' }).status, 0);
  const after = readSession(home);
  assert.equal(after.signal, 'tool-use');
  assert.equal(after.terminal.env.ITERM_SESSION_ID, `w0t0p0:${UUID}`);
  assert.equal(after.terminal.cwd, '/Users/me/start');
}));

test('events other than SessionStart record no terminal', () => withHome((home) => {
  assert.equal(runHook(home, 'tool-use', { ITERM_SESSION_ID: `w0t0p0:${UUID}` }).status, 0);
  assert.equal(readSession(home).terminal, undefined);
}));

test('a resume in another tab and app replaces the recorded tab and host', () => withHome((home) => {
  runHook(home, 'session-start', { ITERM_SESSION_ID: `w0t0p0:${UUID}`, __CFBundleIdentifier: 'com.googlecode.iterm2' });
  assert.equal(readSession(home).hostApp, 'iTerm2');
  pastDedupe();
  runHook(home, 'session-start', { WEZTERM_PANE: '9', __CFBundleIdentifier: 'com.github.wez.wezterm' });
  const s = readSession(home);
  assert.equal(s.hostApp, 'WezTerm');
  assert.deepEqual(s.terminal.env, { WEZTERM_PANE: '9' });
}));

test('the permission-request write keeps the recorded terminal', () => withHome((home) => {
  runHook(home, 'session-start', { WEZTERM_PANE: '4' });
  assert.equal(runHook(home, 'permission-request', {}, { tool_name: 'Bash', tool_input: { command: 'ls' } }).status, 0);
  assert.equal(readSession(home).terminal.env.WEZTERM_PANE, '4');
}));

test('the SessionStart write waits for the session lock', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-jump-'));
  try {
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    const lock = `${sessionFile(home)}.lock`;
    fs.writeFileSync(lock, 'someone-else');
    const child = spawn('node', [SET_STATUS, 'session-start'], { env: hookEnv(home, { WEZTERM_PANE: '12' }), stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(JSON.stringify({ session_id: 'jump', cwd: '/tmp' }));
    const exited = new Promise((resolve) => child.on('exit', resolve));
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(fs.existsSync(sessionFile(home)), false, 'wrote while the lock was held');
    fs.rmSync(lock);
    assert.equal(await exited, 0);
    assert.equal(readSession(home).terminal.env.WEZTERM_PANE, '12');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the hook exits 0 when recording cannot possibly work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-jump-'));
  const notADir = path.join(dir, 'file');
  fs.writeFileSync(notADir, 'x');
  try {
    assert.equal(runHook(notADir, 'session-start', { TMUX_PANE: '%1', TMUX: 'x'.repeat(5000) }).status, 0);
    assert.equal(spawnSync('node', [SET_STATUS, 'session-start'], { env: hookEnv(dir, { KITTY_WINDOW_ID: '1\n2' }), input: 'not json' }).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Adapters: command construction and id validation ───────────────────────

// A fake runner: records every call and answers from `answers(file, args)`.
function fakeExec(answers = () => ({ ok: true, stdout: 'ok' })) {
  const calls = [];
  const exec = async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: '', stderr: '', ...answers(file, args) }; };
  return { calls, exec };
}
const ctxOf = (over = {}) => ({ platform: 'darwin', which: (bins) => bins[0], isDir: () => true, tmuxServerOk: () => true, ...over });
const sess = (env = {}, extra = {}) => ({ host: HOST, cwd: '/Users/me/proj', terminal: { env, tty: null, cwd: '/Users/me/proj' }, ...extra });

// Payloads a hostile session file might carry.
const INJECTIONS = [
  '"; do shell script "touch /tmp/pwned"; "',
  '$(touch /tmp/pwned)',
  '`touch /tmp/pwned`',
  '1; touch /tmp/pwned',
  '1 && open -a Calculator',
  '--help',
  '1\n2',
  '../../etc/passwd',
];

test('iTerm2: osascript argv carries the session uuid and tty; the script source is fixed', async () => {
  const s = sess({ ITERM_SESSION_ID: `w0t2p1:${UUID}` }, { hostApp: 'iTerm2' });
  s.terminal.tty = '/dev/ttys004';
  const { calls, exec } = fakeExec();
  assert.ok(ITerm.canHandle(s, ctxOf()));
  assert.deepEqual(await ITerm.focus(s, { exec }), { ok: true, exact: true });
  assert.deepEqual(calls, [{ file: '/usr/bin/osascript', args: ['-e', ITerm.SCRIPT, UUID, '/dev/ttys004'], opts: undefined }]);
  assert.ok(!ITerm.SCRIPT.includes(UUID));
  assert.ok(ITerm.SCRIPT.includes('is not running'), 'must not launch iTerm2');
});

test('iTerm2: a malformed or hostile session id is never passed on', () => {
  for (const bad of [...INJECTIONS, `w0t0p0:${UUID}"`, UUID, `w0t0p0:${UUID}\n`]) {
    const s = sess({ ITERM_SESSION_ID: bad }, { hostApp: 'iTerm2' });
    assert.equal(Ids.itermUuid(s), null, bad);
    assert.equal(ITerm.canHandle(s, ctxOf()), false, bad);
  }
});

test('Terminal.app: selects by tty; anything but /dev/ttysNNN is refused', async () => {
  const s = sess({ TERM_PROGRAM: 'Apple_Terminal' });
  s.terminal.tty = '/dev/ttys012';
  const { calls, exec } = fakeExec();
  assert.ok(TerminalApp.canHandle(s, ctxOf()));
  await TerminalApp.focus(s, { exec });
  assert.deepEqual(calls[0].args, ['-e', TerminalApp.SCRIPT, '/dev/ttys012']);
  for (const bad of [...INJECTIONS, '/dev/ttys012"', '/dev/ttys1 ', '/dev/disk0', '/dev/../dev/ttys1']) {
    s.terminal.tty = bad;
    assert.equal(TerminalApp.canHandle(s, ctxOf()), false, bad);
  }
});

test('Ghostty: focuses the one terminal in the folder the session started in, passed as argv', async () => {
  const s = sess({}, { hostApp: 'Ghostty', cwd: '/Users/me/drifted' });
  s.terminal.cwd = '/Users/me/my "quoted" proj';
  const { calls, exec } = fakeExec();
  assert.ok(Ghostty.canHandle(s, ctxOf()));
  assert.equal((await Ghostty.focus(s, { exec })).ok, true);
  assert.deepEqual(calls[0].args, ['-e', Ghostty.SCRIPT, '/Users/me/my "quoted" proj']);
  const { exec: exec2 } = fakeExec(() => ({ ok: true, stdout: 'matches: 2' }));
  assert.deepEqual(await Ghostty.focus(s, { exec: exec2 }), { ok: false, reason: 'matches: 2' });
  for (const bad of ['relative/dir', '/a/../b', '/a\nb', '-n', '', null]) {
    assert.equal(Ghostty.canHandle({ ...s, terminal: { ...s.terminal, cwd: bad } }, ctxOf()), false, String(bad));
  }
});

test('kitty: kitten @ focus-window by id over KITTY_LISTEN_ON, then raise the app', async () => {
  const s = sess({ KITTY_WINDOW_ID: '42', KITTY_LISTEN_ON: 'unix:/tmp/kitty-501' }, { hostApp: 'kitty' });
  const { calls, exec } = fakeExec();
  const ctx = ctxOf({ exec });
  assert.ok(Kitty.canHandle(s, ctx));
  assert.equal((await Kitty.focus(s, ctx)).ok, true);
  assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [
    [Kitty.BINS[0], '@', '--to', 'unix:/tmp/kitty-501', 'focus-window', '--match', 'id:42'],
    ['/usr/bin/open', '-a', 'kitty'],
  ]);
});

test('kitty: hostile window ids and listen addresses are refused', () => {
  for (const bad of [...INJECTIONS, '0', '-1', '42 ', 'id:42']) {
    assert.equal(Kitty.canHandle(sess({ KITTY_WINDOW_ID: bad, KITTY_LISTEN_ON: 'unix:/tmp/k' }), ctxOf()), false, bad);
  }
  for (const bad of [...INJECTIONS, 'tcp:evil.example:80', 'tcp:127.0.0.1:65536', 'tcp:127.0.0.1:99999', 'unix:/tmp/../etc/k', 'unix:relative', 'unix:/tmp/k;x', 'unix:@abstract']) {
    assert.equal(Kitty.canHandle(sess({ KITTY_WINDOW_ID: '1', KITTY_LISTEN_ON: bad }), ctxOf()), false, bad);
  }
  assert.ok(Kitty.canHandle(sess({ KITTY_WINDOW_ID: '1', KITTY_LISTEN_ON: 'tcp:127.0.0.1:65535' }), ctxOf()));
  assert.equal(Kitty.canHandle(sess({ KITTY_WINDOW_ID: '1', KITTY_LISTEN_ON: 'unix:/tmp/k' }), ctxOf({ which: () => null })), false, 'no kitten installed');
});

test('kitty variables leaked into another app (VS Code launched from kitty) do not route to kitty', () => {
  assert.equal(Kitty.canHandle(sess({ KITTY_WINDOW_ID: '1', KITTY_LISTEN_ON: 'unix:/tmp/k' }, { hostApp: 'Visual Studio Code' }), ctxOf()), false);
});

test('WezTerm: wezterm cli activate-pane by WEZTERM_PANE; hostile pane ids refused', async () => {
  const s = sess({ WEZTERM_PANE: '7', TERM_PROGRAM: 'WezTerm' });
  const { calls, exec } = fakeExec();
  const ctx = ctxOf({ exec });
  assert.ok(WezTerm.canHandle(s, ctx));
  await WezTerm.focus(s, ctx);
  assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [
    [WezTerm.BINS[0], 'cli', 'activate-pane', '--pane-id', '7'],
    ['/usr/bin/open', '-a', 'WezTerm'],
  ]);
  for (const bad of [...INJECTIONS, '7 ', '-7', '0x7']) assert.equal(WezTerm.canHandle(sess({ WEZTERM_PANE: bad, TERM_PROGRAM: 'WezTerm' }), ctx), false, bad);
});

test('binary discovery includes Nix profiles', () => {
  for (const a of [Kitty, WezTerm, Tmux]) {
    assert.ok(a.BINS.some((b) => b.includes('/.nix-profile/bin/')), a.id);
    assert.ok(a.BINS.some((b) => b.startsWith('/run/current-system/sw/bin/')), a.id);
  }
});

const TMUX_ENV = { TMUX: '/private/tmp/tmux-501/default,812,0', TMUX_PANE: '%5' };
const tmuxAnswers = (clients = '/dev/ttys009\t$1\t100\n/dev/ttys003\t$0\t50\n') => (file, args) => {
  if (args.includes('display-message')) return { ok: true, stdout: '$2\n' };
  if (args.includes('list-clients')) return { ok: true, stdout: clients };
  return { ok: true, stdout: 'ok' };
};

test('tmux: points the client at the pane on the session\'s own socket, then focuses the outer tab by tty', async () => {
  const s = sess(TMUX_ENV, { hostApp: 'iTerm2' });
  const { calls, exec } = fakeExec(tmuxAnswers());
  const r = await Focus.focusSession(s, ctxOf({ exec }));
  assert.equal(r.ok, true);
  assert.equal(r.adapter, 'tmux+iterm');
  const tmux = calls.filter((c) => c.file === Tmux.BINS[0]).map((c) => c.args);
  const sock = ['-S', '/private/tmp/tmux-501/default'];
  assert.deepEqual(tmux, [
    [...sock, 'display-message', '-p', '-t', '%5', '#{session_id}'],
    [...sock, 'list-clients', '-F', '#{client_tty}\t#{session_id}\t#{client_activity}'],
    [...sock, 'switch-client', '-c', '/dev/ttys009', '-t', '%5'],
    [...sock, 'select-window', '-t', '%5'],
    [...sock, 'select-pane', '-t', '%5'],
  ]);
  const osa = calls.find((c) => c.file === '/usr/bin/osascript');
  assert.deepEqual(osa.args, ['-e', ITerm.SCRIPT, '', '/dev/ttys009']);
});

test('tmux: stale outer ids inherited by the pane are never used, and a miss is not reported as exact', async () => {
  const s = sess({ ...TMUX_ENV, ITERM_SESSION_ID: `w0t0p0:${UUID}`, KITTY_WINDOW_ID: '3', KITTY_LISTEN_ON: 'unix:/tmp/k', WEZTERM_PANE: '2' }, { hostApp: 'iTerm2' });
  assert.equal(Ids.itermUuid(s), null);
  assert.equal(Ids.kittyWindow(s), null);
  assert.equal(Ids.weztermPane(s), null);
  // Outer tab not found: iTerm answers "no match".
  const { calls, exec } = fakeExec((file, args) => (file === '/usr/bin/osascript' ? { ok: true, stdout: 'no match' } : tmuxAnswers()(file, args)));
  const r = await Focus.focusSession(s, ctxOf({ exec }));
  assert.equal(r.ok, false);
  assert.ok(!calls.some((c) => c.args.some((a) => String(a).includes(UUID))), 'the stale UUID reached a command');
  // tmux unreachable (canHandle false): the chain stops, nothing else runs.
  const quiet = fakeExec();
  const r2 = await Focus.focusSession(s, ctxOf({ exec: quiet.exec, tmuxServerOk: () => false }));
  assert.equal(r2.ok, false);
  assert.equal(quiet.calls.length, 0);
});

test('tmux: with no recorded host, the outer tab is looked up by tty in iTerm2 then Terminal.app', async () => {
  const s = sess(TMUX_ENV);
  const { calls, exec } = fakeExec((file, args) => {
    if (file === '/usr/bin/osascript') return { ok: true, stdout: args[1] === ITerm.SCRIPT ? 'not-running' : 'ok' };
    return tmuxAnswers()(file, args);
  });
  const r = await Focus.focusSession(s, ctxOf({ exec }));
  assert.equal(r.ok, true);
  assert.equal(r.adapter, 'tmux+terminal-app');
  const osa = calls.filter((c) => c.file === '/usr/bin/osascript').map((c) => c.args.slice(1));
  assert.deepEqual(osa, [[ITerm.SCRIPT, '', '/dev/ttys009'], [TerminalApp.SCRIPT, '/dev/ttys009']]);
  // Outside that lookup, a session with no host is not handed to iTerm by tty alone.
  const bare = sess({});
  bare.terminal.tty = '/dev/ttys1';
  assert.equal(ITerm.canHandle(bare, ctxOf()), false);
});

test('tmux: hostile panes, sockets, server pids and client ttys are refused', () => {
  for (const bad of [...INJECTIONS, '5', '%5 ', '%-1']) assert.equal(Tmux.canHandle(sess({ TMUX: '/tmp/t,1,0', TMUX_PANE: bad }), ctxOf()), false, bad);
  for (const bad of [...INJECTIONS, 'relative,1,0', '/tmp/../x,1,0', '/tmp/a b,1,0', '/tmp/$(x),1,0']) assert.equal(Tmux.canHandle(sess({ TMUX: bad, TMUX_PANE: '%1' }), ctxOf()), false, bad);
  let seen = null;
  Tmux.canHandle(sess({ TMUX: '/tmp/t,1;2,0', TMUX_PANE: '%1' }), ctxOf({ tmuxServerOk: (sock, pid) => { seen = pid; return true; } }));
  assert.equal(seen, null, 'a malformed server pid is not passed on');
  assert.equal(Tmux.pickClient('/dev/ttys1"; x\t$1\t9\n/dev/ttys2\t$1\t1', '$1').tty, '/dev/ttys2');
  assert.equal(Tmux.pickClient('garbage', '$1'), null);
});

test('tmux: the socket must be a socket we own, in a private directory, with a live server we own', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-tmux-'));
  fs.chmodSync(dir, 0o700);
  const sock = path.join(dir, 'default');
  const server = net.createServer().listen(sock);
  await new Promise((r) => server.once('listening', r));
  try {
    assert.equal(Focus.tmuxServerOk(sock, process.pid), true);
    assert.equal(Focus.tmuxServerOk(sock, null), false, 'no server pid');
    assert.equal(Focus.tmuxServerOk(sock, 1), false, 'launchd is not ours');
    assert.equal(Focus.tmuxServerOk(sock, 999999999), false, 'no such process');
    const plain = path.join(dir, 'plain');
    fs.writeFileSync(plain, '');
    assert.equal(Focus.tmuxServerOk(plain, process.pid), false, 'not a socket');
    fs.chmodSync(dir, 0o777);
    assert.equal(Focus.tmuxServerOk(sock, process.pid), false, 'world-writable directory');
    fs.chmodSync(dir, 0o770);
    assert.equal(Focus.tmuxServerOk(sock, process.pid), false, 'group-writable directory');
  } finally {
    server.close();
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tmux: pane selected but no outer tab found still reports a miss, so the app is activated', async () => {
  const s = sess({ TMUX: '/tmp/t,1,0', TMUX_PANE: '%1' }, { hostApp: 'Alacritty' });
  const { exec } = fakeExec((file, args) => (args.includes('display-message') ? { ok: true, stdout: '$0' } : args.includes('list-clients') ? { ok: true, stdout: '/dev/ttys1\t$0\t1' } : { ok: true }));
  const r = await Focus.focusSession(s, ctxOf({ exec }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /tmux pane selected/);
});

test('VS Code: opens the folder the session started in; with none, only activates the app', async () => {
  const s = sess({ TERM_PROGRAM: 'vscode' }, { hostApp: 'Cursor', cwd: '/Users/me/drifted' });
  const { calls, exec } = fakeExec();
  assert.ok(VSCode.canHandle(s, ctxOf()));
  const r = await VSCode.focus(s, ctxOf({ exec }));
  assert.equal(r.ok, true);
  assert.equal(r.exact, false);
  assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [['/usr/bin/open', '-a', 'Cursor', '/Users/me/proj']]);
  for (const t of [{ ...s.terminal, cwd: null }, { ...s.terminal, cwd: '-a' }]) {
    const run = fakeExec();
    await VSCode.focus({ ...s, terminal: t }, ctxOf({ exec: run.exec }));
    assert.deepEqual(run.calls[0].args, ['-a', 'Cursor'], String(t.cwd));
  }
  const gone = fakeExec();
  await VSCode.focus(s, ctxOf({ exec: gone.exec, isDir: () => false }));
  assert.deepEqual(gone.calls[0].args, ['-a', 'Cursor'], 'a folder that no longer exists');
  assert.equal(VSCode.canHandle({ ...s, hostApp: 'Calculator' }, ctxOf()), false);
});

test('no adapter shells out on another platform', () => {
  const s = sess({ ITERM_SESSION_ID: `w0t0p0:${UUID}`, TERM_PROGRAM: 'iTerm.app' });
  for (const a of [ITerm, TerminalApp, Ghostty, VSCode]) assert.equal(a.canHandle(s, ctxOf({ platform: 'win32' })), false, a.id);
});

// ── What may be run at all ──────────────────────────────────────────────────

test('no adapter source can send input to a terminal', () => {
  const dir = path.join(__dirname, '..', 'src', 'focus');
  const DENY = /keystroke|key code|System Events|send-?keys?|send-text|input text|write text|do script|paste-buffer|run-shell|respawn|new-window|spawn/i;
  for (const f of fs.readdirSync(dir)) assert.ok(!DENY.test(fs.readFileSync(path.join(dir, f), 'utf8')), f);
});

test('every command any adapter runs is on the focus-only allow-list', async () => {
  const calls = [];
  const exec = async (file, args) => {
    calls.push({ file, args });
    if (args.includes('display-message')) return { ok: true, stdout: '$2' };
    if (args.includes('list-clients')) return { ok: true, stdout: '/dev/ttys9\t$1\t1' };
    return { ok: true, stdout: 'no match' };
  };
  const tty = '/dev/ttys5';
  const sessions = [
    sess(TMUX_ENV, { hostApp: 'iTerm2' }),
    sess(TMUX_ENV),
    sess({ ITERM_SESSION_ID: `w0t0p0:${UUID}` }, { hostApp: 'iTerm2' }),
    { ...sess({}, { hostApp: 'Terminal' }), terminal: { env: {}, tty, cwd: '/x' } },
    sess({}, { hostApp: 'Ghostty' }),
    sess({ KITTY_WINDOW_ID: '1', KITTY_LISTEN_ON: 'unix:/tmp/k' }, { hostApp: 'kitty' }),
    sess({ WEZTERM_PANE: '1' }, { hostApp: 'WezTerm' }),
    sess({}, { hostApp: 'Visual Studio Code' }),
  ];
  for (const s of sessions) await Focus.focusSession(s, ctxOf({ exec }));
  const ran = new Set(calls.map((c) => c.file));
  for (const a of [Tmux, Kitty, WezTerm]) assert.ok(ran.has(a.BINS[0]), `${a.id} ran`);
  for (const { file, args } of calls) {
    if (file === Tmux.BINS[0]) {
      assert.deepEqual(args.slice(0, 2), ['-S', '/private/tmp/tmux-501/default']);
      assert.ok(['display-message', 'list-clients', 'switch-client', 'select-window', 'select-pane'].includes(args[2]), args[2]);
    } else if (file === Kitty.BINS[0]) {
      assert.equal(args[0], '@');
      assert.equal(args[3], 'focus-window');
    } else if (file === WezTerm.BINS[0]) {
      assert.deepEqual(args.slice(0, 2), ['cli', 'activate-pane']);
    } else if (file === '/usr/bin/open') {
      assert.equal(args[0], '-a');
    } else if (file === '/usr/bin/osascript') {
      assert.ok([ITerm.SCRIPT, TerminalApp.SCRIPT, Ghostty.SCRIPT].includes(args[1]));
    } else {
      assert.fail(`unexpected command ${file}`);
    }
  }
});

// ── Fallback and deadline ───────────────────────────────────────────────────

test('a failing, timing-out or throwing adapter is a miss, never an exception', async () => {
  const s = sess({ ITERM_SESSION_ID: `w0t0p0:${UUID}`, TERM_PROGRAM: 'iTerm.app' });
  const failing = fakeExec(() => ({ ok: false, stderr: 'killed: SIGKILL' }));
  assert.equal((await Focus.focusSession(s, { exec: failing.exec, platform: 'darwin' })).ok, false);
  const noMatch = fakeExec(() => ({ ok: true, stdout: 'no match' }));
  assert.deepEqual(await Focus.focusSession(s, { exec: noMatch.exec, platform: 'darwin' }), { adapter: 'iterm', reason: 'no match', ok: false, needs: ITerm.needs });
  const throwing = { id: 'boom', needs: null, canHandle: () => true, focus: () => { throw new Error('boom'); } };
  const r = await Focus.focusSession(s, { platform: 'darwin' }, [throwing]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'boom');
  assert.equal((await Focus.focusSession(sess({}), { platform: 'darwin' })).ok, false, 'nothing recorded');
  assert.equal((await Focus.focusSession(null)).ok, false);
});

test('one deadline covers the whole jump: each command gets what is left, and nothing runs after it', async () => {
  let now = 0;
  const calls = [];
  const slow = { id: 'slow', needs: null, canHandle: () => true, async focus(s, { exec }) { await exec('/a', []); now += 3000; await exec('/b', []); now += 2000; await exec('/c', []); return { ok: false, reason: 'miss' }; } };
  const never = { id: 'never', needs: null, canHandle: () => true, focus: () => assert.fail('ran after the deadline') };
  const exec = async (file, args, opts) => { calls.push({ file, timeout: opts.timeout }); return { ok: true }; };
  const r = await Focus.focusSession(sess({}), { exec, now: () => now, platform: 'darwin' }, [slow, never]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /deadline/);
  assert.deepEqual(calls, [{ file: '/a', timeout: Focus.EXEC_TIMEOUT_MS }, { file: '/b', timeout: Focus.JUMP_DEADLINE_MS - 3000 }]);
});

test('a refused Automation permission comes back as denied, with the adapter\'s reason', async () => {
  const s = sess({ ITERM_SESSION_ID: `w0t0p0:${UUID}`, TERM_PROGRAM: 'iTerm.app' });
  const { exec } = fakeExec(() => ({ ok: false, stderr: 'execution error: Not authorized to send Apple events to iTerm2. (-1743)' }));
  const r = await Focus.focusSession(s, { exec, platform: 'darwin' });
  assert.equal(r.denied, 'automation');
  assert.equal(r.needs.app, 'iTerm2');
});

test('the default runner reports a missing binary as a miss', async () => {
  assert.equal((await Focus.exec('/nonexistent/terminal-cli', ['x'])).ok, false);
});

// ── The click: jump or fall back ────────────────────────────────────────────

function jumperWith({ focusResult = { ok: false, reason: 'miss' }, platform = 'darwin' } = {}) {
  const log = { focus: [], activate: [], denied: [] };
  const jump = createJumper({
    localHost: HOST,
    platform,
    focus: async (s) => { log.focus.push(s); return typeof focusResult === 'function' ? focusResult(s) : focusResult; },
    activate: async (...args) => { log.activate.push(args); return { app: 'Terminal', exact: false }; },
    explainer: { onNeeds: () => null, onDenied: (n) => log.denied.push(n) },
  });
  return { jump, log };
}

test('a session with nothing recorded activates the app exactly as before', async () => {
  const { jump, log } = jumperWith();
  assert.deepEqual(await jump({ host: HOST, cwd: '/x' }, 'x', 'Ghostty'), { app: 'Terminal', exact: false });
  assert.equal(log.focus.length, 0);
  assert.deepEqual(log.activate, [['x', 'Ghostty']]);
  await jump(null, 'y');
  assert.deepEqual(log.activate[1], ['y', null]);
});

test('a remote session is never focused and never activates anything, whatever host it claims', async () => {
  const { jump, log } = jumperWith({ focusResult: { ok: true, adapter: 'iterm', exact: true } });
  const terminal = { env: { ITERM_SESSION_ID: `w0t0p0:${UUID}` }, tty: '/dev/ttys1' };
  for (const s of [{ remote: true, host: HOST, terminal }, { device: 'laptop', host: HOST, terminal }, { sessionId: 'remote:laptop:abc', host: HOST, terminal }]) {
    assert.equal(await jump(s, 'x', 'iTerm2'), null);
  }
  assert.equal(log.focus.length, 0);
  assert.equal(log.activate.length, 0);
  assert.equal(isRemote({ sessionId: 'abc', host: HOST }), false);
});

test('another host\'s session, or another platform, skips the adapters but still activates', async () => {
  const { jump, log } = jumperWith();
  await jump({ host: 'other-mac', terminal: { env: {} } }, 'x');
  const win = jumperWith({ platform: 'win32' });
  await win.jump({ host: HOST, terminal: { env: {} } }, 'x');
  assert.equal(log.focus.length + win.log.focus.length, 0);
  assert.equal(log.activate.length + win.log.activate.length, 2);
});

test('a hit reports the tab; a miss falls back to activating; a refusal is explained', async () => {
  const hit = jumperWith({ focusResult: { ok: true, adapter: 'tmux+iterm', exact: true } });
  assert.deepEqual(await hit.jump({ host: HOST, terminal: { env: {} } }, 'x'), { app: 'iTerm2', exact: true });
  assert.equal(hit.log.activate.length, 0);
  const miss = jumperWith();
  assert.deepEqual(await miss.jump({ host: HOST, terminal: { env: {} } }, 'x', 'kitty'), { app: 'Terminal', exact: false });
  assert.deepEqual(miss.log.activate, [['x', 'kitty']]);
  const denied = jumperWith({ focusResult: { ok: false, denied: 'automation', needs: ITerm.needs } });
  await denied.jump({ host: HOST, terminal: { env: {} } }, 'x');
  assert.deepEqual(denied.log.denied, [ITerm.needs]);
  assert.equal(denied.log.activate.length, 1);
});

test('the same target clicked twice shares the jump in flight; a later click runs again', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { jump, log } = jumperWith({ focusResult: () => gate.then(() => ({ ok: true, adapter: 'wezterm', exact: true })) });
  const s = { sessionId: 'A', host: HOST, terminal: { env: {} } };
  const a = jump(s, 'x');
  const b = jump({ ...s }, 'x');
  assert.equal(a, b);
  release();
  assert.deepEqual(await a, { app: 'WezTerm', exact: true });
  assert.equal(log.focus.length, 1);
  await jump(s, 'x');
  assert.equal(log.focus.length, 2);
});

test('a different target starts its own jump and supersedes the pending one, which reports nothing', async () => {
  const gates = {};
  const cancelSeen = {};
  const log = { activate: [] };
  const jump = createJumper({
    localHost: HOST,
    platform: 'darwin',
    focus: async (s, opts) => {
      await new Promise((r) => { gates[s.sessionId] = r; });
      cancelSeen[s.sessionId] = opts.isCancelled();
      return { ok: true, adapter: 'iterm', exact: true, app: `app-${s.sessionId}` };
    },
    activate: async (...args) => { log.activate.push(args); return { app: 'Terminal', exact: false }; },
    explainer: { onNeeds: () => null, onDenied: () => {} },
  });
  const A = { sessionId: 'A', host: HOST, terminal: { env: {} } };
  const B = { sessionId: 'B', host: HOST, terminal: { env: {} } };
  const pa = jump(A, 'a');
  const pb = jump(B, 'b');
  assert.notEqual(pa, pb);
  gates.B();
  assert.deepEqual(await pb, { app: 'app-B', exact: true });
  gates.A();
  assert.equal(await pa, null, 'the superseded jump must not report A as found');
  assert.equal(cancelSeen.A, true);
  assert.equal(cancelSeen.B, false);
  assert.equal(log.activate.length, 0, 'the superseded jump does not fall back either');
  // Without a session, the folder is the target.
  const f = jumperWith();
  const p1 = f.jump(null, 'one');
  const p2 = f.jump(null, 'two');
  assert.notEqual(p1, p2);
  assert.equal(f.jump(null, 'two'), p2);
  assert.equal(await p1, null);
  assert.deepEqual(await p2, { app: 'Terminal', exact: false });
  // 'one' had already activated before 'two' was clicked; only its report is dropped.
  assert.deepEqual(f.log.activate, [['one', null], ['two', null]]);
});

test('a superseded jump stops issuing commands mid-chain', async () => {
  let cancelled = false;
  const calls = [];
  const exec = async (file) => { calls.push(file); cancelled = true; return { ok: true, stdout: 'no match' }; };
  const s = sess(TMUX_ENV, { hostApp: 'iTerm2' });
  const r = await Focus.focusSession(s, ctxOf({ exec, isCancelled: () => cancelled }));
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1, 'only the command already under way ran');
});

// ── Asking for Automation, only when an adapter needs it ────────────────────

test('the first run of an adapter that needs Automation explains why, once, and waits longer', async () => {
  const notes = [];
  let saved = null;
  const ex = createExplainer({ load: () => [], save: (l) => { saved = l; }, notify: (n) => notes.push(n), openSettings: () => {} });
  const s = sess({ ITERM_SESSION_ID: `w0t0p0:${UUID}`, TERM_PROGRAM: 'iTerm.app' });
  const { calls, exec } = fakeExec();
  await Focus.focusSession(s, { exec, platform: 'darwin', onNeeds: (n) => ex.onNeeds(n) });
  await Focus.focusSession(s, { exec, platform: 'darwin', onNeeds: (n) => ex.onNeeds(n) });
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /control iTerm2/);
  assert.match(notes[0].body, /exact iTerm2 tab/);
  assert.deepEqual(saved, ['iTerm2']);
  assert.equal(calls[0].opts.timeout, Focus.PROMPT_TIMEOUT_MS);
  assert.ok(calls[1].opts.timeout <= Focus.EXEC_TIMEOUT_MS);
});

test('adapters that need no permission never trigger an explanation', async () => {
  const notes = [];
  const ex = createExplainer({ load: () => { throw new Error('no file'); }, save: () => {}, notify: (n) => notes.push(n), openSettings: () => {} });
  const { exec } = fakeExec();
  await Focus.focusSession(sess({ WEZTERM_PANE: '1', TERM_PROGRAM: 'WezTerm' }), ctxOf({ exec, onNeeds: (n) => ex.onNeeds(n) }));
  assert.equal(notes.length, 0);
  assert.equal(ex.onNeeds(null), null);
});

test('an app explained on an earlier launch is not explained again; a refusal is explained once per run with a way to fix it', () => {
  const notes = [];
  let opened = 0;
  const ex = createExplainer({ load: () => ['iTerm2'], save: () => {}, notify: (n) => notes.push(n), openSettings: () => { opened += 1; } });
  assert.equal(ex.onNeeds(ITerm.needs), null);
  ex.onDenied(ITerm.needs);
  ex.onDenied(ITerm.needs);
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /Automation/);
  notes[0].onClick();
  assert.equal(opened, 1);
});
