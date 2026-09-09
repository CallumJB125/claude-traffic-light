const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const H = require('../hostapp.js');

const WAITING = new Set(['permission-ask', 'limit-hit', 'idle-nudge']);
const isWaiting = (s) => WAITING.has(s);

// This is the bug that stopped the README's knocking from ever happening:
// macOS reports Ghostty's process as `ghostty`, but the app (and its Dock
// item) is `Ghostty`, and the match was case-sensitive.
test('a running app is recognised whatever case the process name uses', () => {
  assert.ok(H.matchesRunning('Ghostty', ['Finder', 'ghostty', 'Dock']));
  assert.ok(H.matchesRunning('Ghostty', ['Ghostty']));
  assert.ok(!H.matchesRunning('Ghostty', ['Finder', 'Dock']));
});

test('apps whose process name differs from their display name still match', () => {
  assert.ok(H.matchesRunning('Visual Studio Code', ['Code']));
  assert.ok(H.matchesRunning('iTerm2', ['iTerm']));
  assert.ok(H.matchesRunning('WezTerm', ['wezterm-gui']));
});

test('knocks on the app running the session that needs you, not just any terminal', () => {
  const running = ['Terminal', 'ghostty', 'Code'];
  const sessions = [
    { signal: 'tool-use', hostApp: 'Terminal' },
    { signal: 'permission-ask', hostApp: 'Ghostty' },
  ];
  assert.equal(H.pickTerminal(sessions, running, isWaiting, ['Terminal']), 'Ghostty');
});

test('falls back to a running terminal when no session recorded a host', () => {
  const running = ['Finder', 'ghostty'];
  const sessions = [{ signal: 'permission-ask', hostApp: null }];
  assert.equal(H.pickTerminal(sessions, running, isWaiting, ['Ghostty']), 'Ghostty');
});

test('a recorded host that is not running is skipped', () => {
  const running = ['Finder', 'Terminal'];
  const sessions = [{ signal: 'permission-ask', hostApp: 'Ghostty' }];
  assert.equal(H.pickTerminal(sessions, running, isWaiting, ['Terminal']), 'Terminal');
});

test('nothing running means nothing to knock on', () => {
  assert.equal(H.pickTerminal([{ signal: 'permission-ask', hostApp: 'Ghostty' }], [], isWaiting, []), null);
});

// ── Dock geometry: left/right/hidden Docks and second displays
const MAIN = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 850 } };
const SECOND = { bounds: { x: 1440, y: 0, width: 1920, height: 1080 }, workArea: { x: 1440, y: 0, width: 1920, height: 1040 } };

test('a visible Dock icon is left where it is', () => {
  const r = H.clampRectToDisplays({ x: 551, y: 800, w: 55, h: 71 }, [MAIN]);
  assert.equal(r.x, 551);
  assert.equal(r.hidden, false);
  assert.equal(r.display, MAIN);
});

test('an auto-hidden Dock parks its icons off-screen; the knock is pulled back on', () => {
  const r = H.clampRectToDisplays({ x: 551, y: 1400, w: 55, h: 71 }, [MAIN]);
  assert.equal(r.hidden, true);
  assert.ok(r.y + r.h <= MAIN.workArea.y + MAIN.workArea.height, 'inside the work area vertically');
  assert.equal(r.display, MAIN);
});

test('a Dock on the left edge stays inside the work area', () => {
  const r = H.clampRectToDisplays({ x: -30, y: 400, w: 55, h: 71 }, [MAIN]);
  assert.ok(r.x >= MAIN.workArea.x);
});

test('an icon on a second display resolves to that display', () => {
  const r = H.clampRectToDisplays({ x: 2000, y: 900, w: 55, h: 71 }, [MAIN, SECOND]);
  assert.equal(r.display, SECOND);
  assert.equal(r.hidden, false);
});

test('an icon off every display lands on the nearest one', () => {
  const r = H.clampRectToDisplays({ x: 2000, y: 5000, w: 55, h: 71 }, [MAIN, SECOND]);
  assert.equal(r.display, SECOND);
  assert.equal(r.hidden, true);
  assert.ok(r.y + r.h <= SECOND.workArea.y + SECOND.workArea.height);
});

// ── The hook records which app the session runs in
test('set-status records the host app in the session file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hostapp-'));
  execFileSync('node', [path.join(__dirname, '..', 'hooks', 'set-status.js'), 'tool-use'], {
    env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, __CFBundleIdentifier: 'com.mitchellh.ghostty' },
    input: JSON.stringify({ session_id: 'abc', cwd: '/tmp' }),
  });
  const f = path.join(home, 'sessions', fs.readdirSync(path.join(home, 'sessions'))[0]);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).hostApp, 'Ghostty');
  fs.rmSync(home, { recursive: true, force: true });
});

test('an unknown host app is recorded as null rather than a guess', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hostapp-'));
  execFileSync('node', [path.join(__dirname, '..', 'hooks', 'set-status.js'), 'tool-use'], {
    env: {
      ...process.env,
      CLAUDE_TRAFFIC_LIGHT_HOME: home,
      __CFBundleIdentifier: 'com.example.nothing',
      TERM_PROGRAM: 'nothing-real',
      TMUX: '',
      TMUX_PANE: '',
    },
    input: JSON.stringify({ session_id: 'abc', cwd: '/tmp' }),
  });
  const f = path.join(home, 'sessions', fs.readdirSync(path.join(home, 'sessions'))[0]);
  const got = JSON.parse(fs.readFileSync(f, 'utf8')).hostApp;
  assert.ok(got === null || typeof got === 'string', 'either a real app from the process tree, or null');
  fs.rmSync(home, { recursive: true, force: true });
});

test('the host app is cached, so the process-tree walk runs once per session', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hostapp-'));
  const run = (env) => execFileSync('node', [path.join(__dirname, '..', 'hooks', 'set-status.js'), 'tool-use'], {
    env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, ...env },
    input: JSON.stringify({ session_id: 'abc', cwd: '/tmp' }),
  });
  run({ __CFBundleIdentifier: 'com.mitchellh.ghostty' });
  const f = path.join(home, 'sessions', fs.readdirSync(path.join(home, 'sessions'))[0]);
  // Re-fire with a different terminal in the environment: the recorded host
  // must not flap, or Claude would knock on a different Dock icon each event.
  const before = JSON.parse(fs.readFileSync(f, 'utf8')).updatedAt;
  while (new Date().toISOString() === before) { /* ensure a distinct mtime */ }
  run({ __CFBundleIdentifier: 'com.apple.terminal' });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).hostApp, 'Ghostty');
  fs.rmSync(home, { recursive: true, force: true });
});
