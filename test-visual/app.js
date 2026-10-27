// Hermetic launcher for the visual specs. Every launch gets its own temp
// data dir, signal port and Electron userData, so it can neither read nor
// write ~/.claude-traffic-light and cannot collide with a running install's
// single-instance lock.
const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const FIXED_CONFIG = {
  // 'auto' holds motion on battery (c54dd6e8); a baseline must not depend on the power cable.
  lowPower: 'off',
  roam: false,
  randomEvents: false,
  seasonal: false,
  showTasks: false,
  showAgents: false,
  // The one-time Team hint grows the idle widget; only team-entry.spec turns it on.
  hints: { teamSeen: true },
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// Variables that point back into the real home whatever HOME is set to.
const HOME_POINTERS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'ZDOTDIR'];
const homeEnv = (userHome, base = process.env) => ({
  ...Object.fromEntries(Object.entries(base).filter(([k]) => !HOME_POINTERS.includes(k))),
  HOME: userHome,
  USERPROFILE: userHome,
  // A bare `claude` (voice helper, tool probes) finds the fakes below before any real install.
  PATH: [path.join(userHome, '.local', 'bin'), base.PATH].filter(Boolean).join(path.delimiter),
});

// Fake provider CLIs. The finders look below $HOME first (findClaudeBin, findCodexBin, findGeminiBin, findAcpBin),
// and ai-tools probes PATH, so a fake at each HOME-relative spot means no spec can start a real provider. Each fake
// appends {name, argv, cwd} (and stdin chunks) to the marker file, answers --version, then runs the repo's own wire
// fixture where one exists, else exits 0.
const FAKE_FIXTURES = {
  claude: path.join(ROOT, 'test', 'fixtures', 'fake-claude-stream.js'),
  codex: path.join(ROOT, 'test', 'fixtures', 'fake-codex-app-server.js'),
  gemini: path.join(ROOT, 'test', 'fixtures', 'fake-gemini-acp.js'),
};
// These speak ACP over stdio like gemini --acp (src/acp-agents.js).
const ACP_NAMES = ['cursor-agent', 'agent', 'copilot', 'opencode', 'hermes'];
const FAKE_PROVIDER_PATHS = {
  claude: ['.local/bin/claude', '.claude/local/claude'], codex: ['.local/bin/codex'], gemini: ['.local/bin/gemini'],
  'cursor-agent': ['.local/bin/cursor-agent'], agent: ['.local/bin/agent'], copilot: ['.local/bin/copilot'],
  opencode: ['.local/bin/opencode', '.opencode/bin/opencode'], hermes: ['.local/bin/hermes'], goose: ['.local/bin/goose'], aider: ['.local/bin/aider'],
};
const fakeProviderMark = (userHome) => path.join(userHome, 'fake-providers.log');
function installFakeProviders(userHome) {
  const mark = fakeProviderMark(userHome);
  for (const [name, rels] of Object.entries(FAKE_PROVIDER_PATHS)) {
    const fixture = FAKE_FIXTURES[name] || (ACP_NAMES.includes(name) ? FAKE_FIXTURES.gemini : null);
    const body = [
      `#!${process.execPath}`,
      "'use strict';",
      "const fs = require('node:fs');",
      `const note = (o) => { try { fs.appendFileSync(${JSON.stringify(mark)}, JSON.stringify({ name: ${JSON.stringify(name)}, ...o }) + '\\n'); } catch { /* best effort */ } };`,
      'const argv = process.argv.slice(2);',
      "note({ argv, cwd: process.cwd() });",
      "if (argv.includes('--version')) { process.stdout.write('9.9.9 (fake)\\n'); process.exit(0); }",
      fixture ? `process.stdin.on('data', (c) => note({ stdin: String(c) }));\nrequire(${JSON.stringify(fixture)});` : 'process.exit(0);',
      '',
    ].join('\n');
    for (const rel of rels) {
      const file = path.join(userHome, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, { mode: 0o755 });
    }
  }
}
const fakeProviderCalls = (userHome) => {
  try { return fs.readFileSync(fakeProviderMark(userHome), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

// homeFiles seeds files below the app's own HOME (.claude.json, .claude/settings.json), as files does for the data dir.
async function launchApp({ extraArgs = [], config = {}, files = {}, homeFiles = {}, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbuddy-visual-home-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cbuddy-visual-ud-'));
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  // Backups go outside the data dir, so they get a temp home too.
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'cbuddy-visual-bk-'));
  // Spend (F1) reads transcripts from here instead of ~/.claude/projects, so
  // a real runaway on this machine can't leak into a baseline.
  const projects = path.join(home, 'projects');
  fs.mkdirSync(projects);
  // The app's own HOME: hook state (~/.claude, ~/.codex), the setup checklist and the Help window read it, so
  // a baseline must not depend on which AI tools this machine has. An empty one, per launch.
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cbuddy-visual-user-'));
  installFakeProviders(userHome);
  for (const [name, content] of Object.entries(homeFiles)) {
    fs.mkdirSync(path.dirname(path.join(userHome, name)), { recursive: true });
    fs.writeFileSync(path.join(userHome, name), content);
  }
  // Pre-mark the first-run help so it never pops up unasked.
  fs.writeFileSync(path.join(home, '.help-shown'), '2000-01-01T00:00:00.000Z');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...FIXED_CONFIG, ...config }));
  for (const [name, content] of Object.entries(files)) {
    // a name may be a path below the data dir (usage/daily/2026-09.json)
    fs.mkdirSync(path.dirname(path.join(home, name)), { recursive: true });
    fs.writeFileSync(path.join(home, name), content);
  }
  fs.writeFileSync(path.join(home, 'window-bounds.json'), JSON.stringify({ x: 200, y: 200, width: 200, height: 200 }));
  const port = await freePort();
  const remotePort = await freePort();
  // `--demo visual` is an unrecognised demo name: it flags the run as a dev
  // run (no hook installs, no login item, no background pollers) without
  // overriding CLAUDE_TRAFFIC_LIGHT_HOME/PORT.
  const app = await electron.launch({
    args: [ROOT, `--user-data-dir=${userData}`, '--demo', 'visual', ...extraArgs],
    env: {
      ...homeEnv(userHome),
      CLAUDE_TRAFFIC_LIGHT_HOME: home,
      CLAUDE_TRAFFIC_LIGHT_PORT: String(port),
      CLAUDE_TRAFFIC_LIGHT_REMOTE_PORT: String(remotePort),
      CLAUDE_TRAFFIC_LIGHT_PROJECTS: projects,
      CLAUDE_TRAFFIC_LIGHT_BACKUPS: backups,
      CLAUDE_TRAFFIC_LIGHT_BURST_HOME: home,
      // A dev run's profile is os.tmpdir()/plexiform-dev-<pid> (main.js), and Tasks puts
      // per-run sockets at <profile>/tasks/run/<id>/ipc.sock. Under macOS's /var/folders
      // temp dir that is 103 or 104 bytes depending on the pid; AF_UNIX allows 103.
      ...(process.platform === 'darwin' ? { TMPDIR: '/tmp' } : {}),
      // No voice helper, built or not: Settings shows the same Voice block on every machine.
      PLEXIFORM_VOICE_HELPER_PATH: path.join(home, 'no-voice-helper', 'buddy-listen'),
      ...env,
    },
  });
  // Pin the main window (a BaseWindow holding the sidebar and page views) to a whole-pixel
  // origin on the primary display, so embedded pages lay out the same every run.
  await app.evaluate(({ BaseWindow, BrowserWindow, screen }) => {
    const pinned = new WeakSet();
    setInterval(() => {
      for (const w of BaseWindow.getAllWindows()) {
        if (pinned.has(w) || w.isDestroyed() || w instanceof BrowserWindow) continue;
        pinned.add(w);
        const wa = screen.getPrimaryDisplay().workArea;
        w.setBounds({ x: Math.round(wa.x), y: Math.round(wa.y), width: 1320, height: 860 });
      }
    }, 50);
  });
  const cleanup = async () => {
    try { await app.close(); } catch { /* already gone */ }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(backups, { recursive: true, force: true });
    fs.rmSync(userHome, { recursive: true, force: true });
  };
  return { app, home, userHome, port, remotePort, projects, backups, cleanup };
}

// POST /signal needs the per-install token the app writes beside its port file.
async function signal({ port, home }, body) {
  const token = fs.readFileSync(path.join(home, 'token'), 'utf8');
  const res = await fetch(`http://127.0.0.1:${port}/signal`, { method: 'POST', headers: { 'x-buddy-token': token }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`signal ${JSON.stringify(body)} -> ${res.status}`);
}

async function status(port) {
  return (await fetch(`http://127.0.0.1:${port}/status`)).json();
}

async function windowByFile(app, file, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const w = app.windows().find((p) => p.url().split('?')[0].endsWith(file));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no window for ${file}`);
}

// Utilities are pages inside the main window now: open it (Help is the
// widget's route in), pick `id` in the sidebar and return the embedded page.
// `view` tells apart the lights.html pages (usage is view=mix, stats view=stats).
async function embedded(app, id, file, { view = null, timeout = 15000 } = {}) {
  if (!app.windows().some((p) => p.url().split('?')[0].endsWith('/sidebar.html'))) {
    const widget = await windowByFile(app, 'index.html');
    await widget.evaluate(() => window.trafficLight.openHelp());
  }
  const sidebar = await windowByFile(app, 'sidebar.html');
  await sidebar.waitForFunction(() => !!window.buddy);
  await sidebar.evaluate((x) => window.buddy.select(x), id);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const w = app.windows().find((p) => {
      try { const u = new URL(p.url()); return u.pathname.endsWith(`/${file}`) && (!view || u.searchParams.get('view') === view); } catch { return false; }
    });
    if (w) { await w.waitForLoadState('load'); return w; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no embedded ${file} for ${id}`);
}

// Preferences shows one pane at a time (General by default).
async function openSettingsPane(settings, id) {
  await settings.locator(`#section-nav button[data-go="${id}"]`).click();
  await settings.locator(`.pane[data-section="${id}"]`).waitFor({ state: 'visible' });
}

// An embedded page can sit at a fractional offset, so an element shot comes out
// 1px taller or shorter run to run. Nudge the element onto whole pixels first.
async function snapToPixels(locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((el) => {
    el.style.transform = '';
    const r = el.getBoundingClientRect();
    el.style.transform = `translate(${Math.round(r.left) - r.left}px, ${Math.round(r.top) - r.top}px)`;
  });
  return locator;
}

// Tasks effects are accepted only from the focused owner window (src/tasks-main.js);
// when another app is frontmost (a busy desktop) the harness has to bring it forward.
async function focusMainWindow(app) {
  await app.evaluate(({ app: a, BaseWindow, BrowserWindow }) => {
    a.focus({ steal: true });
    for (const w of BaseWindow.getAllWindows()) if (!w.isDestroyed() && !(w instanceof BrowserWindow) && w.isVisible()) w.focus();
  });
}

module.exports = {
  HOME_POINTERS, homeEnv, installFakeProviders, fakeProviderCalls, FAKE_PROVIDER_PATHS, focusMainWindow, launchApp, signal, status, windowByFile, embedded, openSettingsPane, snapToPixels };
