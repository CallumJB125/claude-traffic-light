'use strict';
// Preferences → "Install Ghostty Dock…". Ghostty Dock is Andrew Baker's
// third-party app with no license, so Plexiform neither downloads nor runs its
// installer: after a native confirmation it opens Terminal on a one-use script
// that shows the upstream one-liner and waits for Return. The user's Terminal
// runs it, not Plexiform. The command and the repo link are fixed constants;
// nothing from config, the environment or IPC reaches them.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const REPO_URL = 'https://github.com/andrewbakercloudscale/ghossty-dock';
const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/andrewbakercloudscale/ghossty-dock/main/get.sh | bash';
const POLL_MS = 5000;
const WATCH_MS = 10 * 60 * 1000;
const INSTALLED_MESSAGE = 'Ghostty Dock is installed — clicks now go to its exact tab. Sessions already running elsewhere stay where they are.';
const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

// What Preferences and Health offer: an install button only where upstream
// supports it (Apple silicon Macs) and only when the app isn't there yet; a
// "Check again" when it is installed but not trusted, with the reason.
function offer(dock, { platform = process.platform, arch = process.arch, mode = 'auto' } = {}) {
  if (platform !== 'darwin' || mode === 'off' || !dock) return { show: null, reason: '' };
  if (dock.trusted && dock.installed) return { show: null, reason: 'ready' };
  if (!dock.installed && !dock.trusted) return arch === 'arm64' ? { show: 'install', reason: 'Not installed' } : { show: null, reason: 'Ghostty Dock needs an Apple silicon Mac' };
  return { show: 'recheck', reason: dock.reason || 'not ready' };
}

function confirmDialog() {
  return {
    type: 'question',
    buttons: ['Open Terminal to install', 'View on GitHub', 'Cancel'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
    message: 'Install Ghostty Dock?',
    detail: [
      'Ghostty Dock is a third-party app by Andrew Baker. It has no license and is not part of Plexiform.',
      "Plexiform will open Terminal and show Andrew's own installer command. Nothing runs until you press Return there. The installer downloads the latest Ghostty Dock release from GitHub into ~/Applications and ~/.local.",
      'On macOS 13 or 14, install jq first (brew install jq).',
      `The command: ${INSTALL_COMMAND}`,
    ].join('\n\n'),
  };
}

// Same pattern as src/tasks-terminal.js: a mkdir claim so a second open of
// the file does nothing, and the folder removes itself when the shell exits.
function scriptBody(file, dir) {
  const claim = path.join(dir, 'started');
  const say = (line) => `print -r -- ${quote(line)}`;
  return ['#!/bin/zsh',
    `/bin/mkdir ${quote(claim)} 2>/dev/null || exit 0`,
    `/bin/rm -f ${quote(file)}`,
    `trap ${quote(`/bin/rm -rf ${quote(dir)}`)} EXIT`,
    say('Plexiform opened this window to install Ghostty Dock, a third-party app by Andrew Baker (not part of Plexiform).'),
    say(`See ${REPO_URL}`),
    say('On macOS 13 or 14, install jq first: brew install jq'),
    say(''),
    say('This will run:'),
    say(`  ${INSTALL_COMMAND}`),
    say(''),
    say('Press Return or type y to install; anything else cancels.'),
    // Typing "no" and Return must not install: only an empty line or y/Y says yes.
    'IFS= read -r reply || exit 1',
    `[[ -z $reply || $reply == [yY] ]] || { ${say('Cancelled: nothing was installed.')}; exit 1; }`,
    INSTALL_COMMAND,
    'result=$?',
    say(''),
    'if [ $result -eq 0 ]; then print -r -- \'Done. You can close this window; Plexiform will notice Ghostty Dock by itself.\'; else print -r -- "The installer stopped with code $result."; fi',
    'exit $result', ''].join('\n');
}

function writeScript({ tempDir = os.tmpdir(), f = fs } = {}) {
  const dir = f.mkdtempSync(path.join(tempDir, 'plexiform-terminal-'));
  f.chmodSync(dir, 0o700);
  const file = path.join(dir, 'continue.command');
  f.writeFileSync(file, scriptBody(file, dir), { mode: 0o700, flag: 'wx' });
  return { file, dir, cleanup: () => { try { f.rmSync(dir, { recursive: true, force: true }); } catch { /* temp residue */ } } };
}

// Terminal.app, never Ghostty Dock (which isn't installed yet).
const openInTerminal = (file) => new Promise((resolve, reject) => {
  execFile('/usr/bin/open', ['-a', 'Terminal', file], { timeout: 10000 }, (err) => (err ? reject(err) : resolve())); // privacy-flow: ghostty-dock-install
});

async function launch({ open = openInTerminal, tempDir, f } = {}) {
  const s = writeScript({ tempDir, f });
  try { await open(s.file); return { ok: true }; } catch (err) { s.cleanup(); return { ok: false, error: `Could not open Terminal: ${err.message}` }; }
}

// The fixed repo page, in the user's browser.
const openRepo = (shell) => shell.openExternal(REPO_URL); // privacy-flow: ghostty-dock-install

// After the Terminal opens: look again every 5 s for up to 10 min, and stop
// once Ghostty Dock is installed and trusted. One watcher at a time.
function createWatcher({ detect, invalidate, onInstalled, onGiveUp = () => {}, active = () => true, every = POLL_MS, upTo = WATCH_MS, setTimer = setInterval, clearTimer = clearInterval, now = Date.now }) {
  let timer = null;
  let until = 0;
  const stop = () => { if (timer) clearTimer(timer); timer = null; };
  // A timer callback in the main process: nothing it calls may throw out of it.
  const tick = () => {
    try {
      if (!active()) { stop(); return; }
      invalidate();
      const d = detect();
      if (d && d.installed && d.trusted) { stop(); onInstalled(d); return; }
      if (now() >= until) { stop(); onGiveUp(d); }
    } catch { stop(); }
  };
  return {
    start() { until = now() + upTo; if (!timer) timer = setTimer(tick, every); },
    stop,
    running: () => !!timer,
    tick,
  };
}

const ACTIONS = Object.freeze(['status', 'install', 'recheck', 'github']);

// `dock` is src/ghostty-dock.js; `confirm(opts)` shows the native dialog and
// answers the button index. Every action takes only its name.
function createController({ dock, getMode, confirm, shell, notify = () => {}, changed = () => {}, platform = process.platform, arch = process.arch, launchScript = launch, watcherOpts = {} }) {
  const status = () => ({ ...offer(dock.detect(), { platform, arch, mode: getMode() }), watching: watcher.running(), repo: REPO_URL });
  const watcher = createWatcher({
    detect: () => dock.detect(),
    invalidate: () => dock.invalidate(),
    onInstalled: () => { notify(INSTALLED_MESSAGE); changed({ ...status(), message: INSTALLED_MESSAGE }); },
    onGiveUp: () => changed(status()),
    active: () => getMode() !== 'off',
    ...watcherOpts,
  });
  async function act(action) {
    if (!ACTIONS.includes(action)) return { error: 'unknown action' };
    if (action === 'status') return status();
    if (action === 'github') { await openRepo(shell); return status(); }
    if (action === 'recheck') { dock.invalidate(); const s = status(); changed(s); return s; }
    const before = status();
    if (before.show !== 'install') return { ...before, error: before.reason === 'ready' ? 'Ghostty Dock is already installed.' : `Not offered here: ${before.reason || 'Ghostty Dock is turned off'}.` };
    const choice = await confirm(confirmDialog());
    if (choice === 1) { await openRepo(shell); return { ...status(), opened: 'github' }; }
    if (choice !== 0) return { ...status(), cancelled: true };
    const r = await launchScript();
    if (!r.ok) return { ...status(), error: r.error };
    watcher.start();
    return { ...status(), launched: true };
  }
  return { act, status, watcher };
}

// One IPC channel; the renderer sends only an action name.
function register({ utilityHandle, allowed, controller }) {
  utilityHandle('ghostty-dock-install', allowed, (e, action) => controller.act(typeof action === 'string' ? action : ''));
}

module.exports = { ACTIONS, createController, register, REPO_URL, INSTALL_COMMAND, INSTALLED_MESSAGE, POLL_MS, WATCH_MS, offer, confirmDialog, scriptBody, writeScript, launch, openRepo, createWatcher };
