const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

const SET_STATUS = path.join(__dirname, '..', 'hooks', 'set-status.js');
const HOST = os.hostname().split('.')[0];
const UUID = '2F6D0C1A-9B3E-4D5F-8A7B-1C2D3E4F5A6B';

// ── Recording ───────────────────────────────────────────────────────────────

test('only the allow-listed terminal variables are recorded; secrets never are', () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-ant-secret', GITHUB_TOKEN: 'ghp_secret', AWS_SECRET_ACCESS_KEY: 'aws', PATH: '/usr/bin', HOME: '/Users/x',
    TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0', ITERM_SESSION_ID: `w0t1p0:${UUID}`,
    KITTY_WINDOW_ID: '3', KITTY_LISTEN_ON: 'unix:/tmp/kitty-1', WEZTERM_PANE: '7', TMUX: '/tmp/tmux-501/default,99,0', TMUX_PANE: '%4',
    VSCODE_PID: '123', VSCODE_IPC_HOOK_CLI: '/tmp/vscode-ipc.sock', VSCODE_GIT_ASKPASS_MAIN: '/x', GHOSTTY_RESOURCES_DIR: '/y',
  };
  const t = captureTerminal({ env, pid: 1234, run: () => 'ttys003 555\n', platform: 'darwin' });
  assert.deepEqual(Object.keys(t.env).sort(), [...ENV_KEYS].sort());
  assert.ok(!JSON.stringify(t).includes('secret'));
  assert.equal(t.tty, '/dev/ttys003');
  assert.equal(t.shellPid, 555);
});

test('the allow-list is exactly the terminal-locating keys', () => {
  assert.deepEqual(ENV_KEYS, ['TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'ITERM_SESSION_ID', 'KITTY_WINDOW_ID', 'KITTY_LISTEN_ON', 'WEZTERM_PANE', 'TMUX', 'TMUX_PANE', 'VSCODE_PID', 'VSCODE_IPC_HOOK_CLI']);
});

test('recorded values with newlines, NULs or silly lengths are dropped', () => {
  const t = captureTerminal({ env: { TERM_PROGRAM: 'a\nb', TMUX_PANE: 'x'.repeat(301), WEZTERM_PANE: 'a\0', KITTY_WINDOW_ID: 5 }, pid: null, run: () => '' });
  assert.deepEqual(t.env, {});
});

test('no controlling tty, a failing ps, or no pid all record tty as null without throwing', () => {
  assert.equal(captureTerminal({ env: {}, pid: 10, run: () => '?? 1', platform: 'darwin' }).tty, null);
  assert.equal(captureTerminal({ env: {}, pid: 10, run: () => { throw new Error('ETIMEDOUT'); }, platform: 'darwin' }).tty, null);
  let called = false;
  assert.equal(captureTerminal({ env: {}, pid: 0, run: () => { called = true; }, platform: 'darwin' }).tty, null);
  assert.equal(called, false);
  assert.equal(captureTerminal({ env: {}, pid: 10, run: () => 'pts/3 2', platform: 'linux' }).tty, '/dev/pts/3');
  assert.equal(captureTerminal({ env: {}, pid: 10, run: () => 'ttys1; rm -rf ~ 2', platform: 'darwin' }).tty, null);
});

function hookEnv(home, extra = {}) {
  const env = { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, ...extra };
  for (const k of ENV_KEYS) if (!(k in extra)) delete env[k];
  return env;
}
const runHook = (home, signal, extra) => spawnSync('node', [SET_STATUS, signal], { env: hookEnv(home, extra), input: JSON.stringify({ session_id: 'jump', cwd: '/tmp' }) });
const sessionFile = (home) => path.join(home, 'sessions', `${HOST}-jump.json`);

test('SessionStart records the terminal; later events keep it and never re-read it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-jump-'));
  try {
    assert.equal(runHook(home, 'session-start', { ITERM_SESSION_ID: `w0t0p0:${UUID}`, TERM_PROGRAM: 'iTerm.app', SUPER_SECRET_TOKEN: 'hunter2' }).status, 0);
    const raw = fs.readFileSync(sessionFile(home), 'utf8');
    assert.ok(!raw.includes('hunter2'));
    assert.equal(JSON.parse(raw).terminal.env.ITERM_SESSION_ID, `w0t0p0:${UUID}`);
    assert.equal(runHook(home, 'tool-use', { ITERM_SESSION_ID: 'w9t9p9:changed', TERM_PROGRAM: 'iTerm.app' }).status, 0);
    const after = JSON.parse(fs.readFileSync(sessionFile(home), 'utf8'));
    assert.equal(after.signal, 'tool-use');
    assert.equal(after.terminal.env.ITERM_SESSION_ID, `w0t0p0:${UUID}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('events other than SessionStart record no terminal', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-jump-'));
  try {
    assert.equal(runHook(home, 'tool-use', { ITERM_SESSION_ID: `w0t0p0:${UUID}` }).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(sessionFile(home), 'utf8')).terminal, undefined);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

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
    assert.equal(JSON.parse(fs.readFileSync(sessionFile(home), 'utf8')).terminal.env.WEZTERM_PANE, '12');
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
const ctxOf = (over = {}) => ({ platform: 'darwin', which: (bins) => bins[0], isDir: () => true, ...over });
const sess = (env = {}, extra = {}) => ({ host: HOST, cwd: '/Users/me/proj', terminal: { env, tty: null }, ...extra });

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

test('Ghostty: focuses the one terminal in the session folder, passed as argv', async () => {
  const s = sess({}, { hostApp: 'Ghostty', cwd: '/Users/me/my "quoted" proj' });
  const { calls, exec } = fakeExec();
  assert.ok(Ghostty.canHandle(s, ctxOf()));
  assert.equal((await Ghostty.focus(s, { exec })).ok, true);
  assert.deepEqual(calls[0].args, ['-e', Ghostty.SCRIPT, '/Users/me/my "quoted" proj']);
  const { exec: exec2 } = fakeExec(() => ({ ok: true, stdout: 'matches: 2' }));
  assert.deepEqual(await Ghostty.focus(s, { exec: exec2 }), { ok: false, reason: 'matches: 2' });
  for (const bad of ['relative/dir', '/a/../b', '/a\nb', '-n', '']) assert.equal(Ghostty.canHandle({ ...s, cwd: bad }, ctxOf()), false, bad);
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
  for (const bad of [...INJECTIONS, 'tcp:evil.example:80', 'unix:/tmp/../etc/k', 'unix:relative', 'unix:/tmp/k;x', 'unix:@abstract']) {
    assert.equal(Kitty.canHandle(sess({ KITTY_WINDOW_ID: '1', KITTY_LISTEN_ON: bad }), ctxOf()), false, bad);
  }
  assert.ok(Kitty.canHandle(sess({ KITTY_WINDOW_ID: '1', KITTY_LISTEN_ON: 'tcp:127.0.0.1:5000' }), ctxOf()));
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

test('tmux: points the client at the pane on the session\'s own socket, then focuses the outer tab by tty', async () => {
  const s = sess({ TMUX: '/private/tmp/tmux-501/default,812,0', TMUX_PANE: '%5' }, { hostApp: 'iTerm2' });
  const { calls, exec } = fakeExec((file, args) => {
    if (args.includes('display-message')) return { ok: true, stdout: '$2\n' };
    if (args.includes('list-clients')) return { ok: true, stdout: '/dev/ttys009\t$1\t100\n/dev/ttys003\t$0\t50\n' };
    return { ok: true, stdout: 'ok' };
  });
  const r = await Focus.focusSession(s, { exec, which: (bins) => bins[0], platform: 'darwin', isDir: () => true });
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
  assert.deepEqual(osa.args, ['-e', ITerm.SCRIPT, '', '/dev/ttys009'], 'outer tab by tty, not the stale ITERM_SESSION_ID');
});

test('tmux: hostile panes, sockets and client ttys are refused', () => {
  for (const bad of [...INJECTIONS, '5', '%5 ', '%-1']) assert.equal(Tmux.canHandle(sess({ TMUX: '/tmp/t,1,0', TMUX_PANE: bad }), ctxOf()), false, bad);
  for (const bad of [...INJECTIONS, 'relative,1,0', '/tmp/../x,1,0', '/tmp/a b,1,0', '/tmp/$(x),1,0']) assert.equal(Tmux.canHandle(sess({ TMUX: bad, TMUX_PANE: '%1' }), ctxOf()), false, bad);
  assert.equal(Tmux.pickClient('/dev/ttys1"; x\t$1\t9\n/dev/ttys2\t$1\t1', '$1').tty, '/dev/ttys2');
  assert.equal(Tmux.pickClient('garbage', '$1'), null);
});

test('tmux: pane selected but no outer tab found still reports a miss, so the app is activated', async () => {
  const s = sess({ TMUX: '/tmp/t,1,0', TMUX_PANE: '%1' }, { hostApp: 'Alacritty' });
  const { exec } = fakeExec((file, args) => (args.includes('display-message') ? { ok: true, stdout: '$0' } : args.includes('list-clients') ? { ok: true, stdout: '/dev/ttys1\t$0\t1' } : { ok: true }));
  const r = await Focus.focusSession(s, { exec, which: (b) => b[0], platform: 'darwin' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tmux pane selected/);
});

test('VS Code: opens the folder in its window; no terminal selection; untrusted app names and folders refused', async () => {
  const s = sess({ TERM_PROGRAM: 'vscode' }, { hostApp: 'Cursor' });
  const { calls, exec } = fakeExec();
  assert.ok(VSCode.canHandle(s, ctxOf()));
  const r = await VSCode.focus(s, { exec });
  assert.equal(r.ok, true);
  assert.equal(r.exact, false);
  assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [['/usr/bin/open', '-a', 'Cursor', '/Users/me/proj']]);
  assert.equal(VSCode.canHandle({ ...s, hostApp: 'Calculator' }, ctxOf()), false);
  assert.equal(VSCode.canHandle({ ...s, cwd: '-a' }, ctxOf()), false);
  assert.equal(VSCode.canHandle(s, ctxOf({ isDir: () => false })), false, 'a folder that no longer exists');
});

test('no adapter shells out on another platform', () => {
  const s = sess({ ITERM_SESSION_ID: `w0t0p0:${UUID}`, TERM_PROGRAM: 'iTerm.app' });
  for (const a of [ITerm, TerminalApp, Ghostty, VSCode]) assert.equal(a.canHandle(s, ctxOf({ platform: 'win32' })), false, a.id);
});

// ── Fallback ────────────────────────────────────────────────────────────────

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

test('a refused Automation permission comes back as denied, with the adapter\'s reason', async () => {
  const s = sess({ ITERM_SESSION_ID: `w0t0p0:${UUID}`, TERM_PROGRAM: 'iTerm.app' });
  const { exec } = fakeExec(() => ({ ok: false, stderr: 'execution error: Not authorized to send Apple events to iTerm2. (-1743)' }));
  const r = await Focus.focusSession(s, { exec, platform: 'darwin' });
  assert.equal(r.denied, 'automation');
  assert.equal(r.needs.app, 'iTerm2');
});

test('the default runner reports a missing binary as a miss', async () => {
  const r = await Focus.exec('/nonexistent/terminal-cli', ['x']);
  assert.equal(r.ok, false);
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
  assert.equal(calls[1].opts, undefined);
});

test('adapters that need no permission never trigger an explanation', async () => {
  const notes = [];
  const ex = createExplainer({ load: () => { throw new Error('no file'); }, save: () => {}, notify: (n) => notes.push(n), openSettings: () => {} });
  const { exec } = fakeExec();
  await Focus.focusSession(sess({ WEZTERM_PANE: '1', TERM_PROGRAM: 'WezTerm' }), { exec, which: (b) => b[0], platform: 'darwin', onNeeds: (n) => ex.onNeeds(n) });
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

test('no adapter ever sends keystrokes', () => {
  const dir = path.join(__dirname, '..', 'src', 'focus');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/keystroke|key code|System Events|send-keys|send-text|input text|send key/i.test(src), f);
  }
});
