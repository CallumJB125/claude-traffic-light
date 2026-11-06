'use strict';
// Plexiform Terminal detection (plan-agent-terminal §R2.5, with §R3.11's
// states, reasons and codes). detect() finds the app, reads its Info.plist and
// checks that a keeper socket answers. resolveOpenIn is the whole §R2.4
// decision table with Revision 3's changes.
// Node built-ins only: test/surface-boundary.test.js pins what this may require.
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net'); // privacy-flow: terminal-detect
const path = require('node:path');
const { execFile } = require('node:child_process');

const STATES = Object.freeze(['ready', 'not-installed', 'unverified', 'keeper-down', 'keeper-outdated', 'incompatible', 'unsupported-platform']);
const REASONS = Object.freeze({
  'not-installed': Object.freeze(['search-failed']),
  unverified: Object.freeze(['unsigned-release', 'signature', 'keeper-signature', 'socket-mode', 'socket-owner', 'keeper-build', 'peer-count']),
  'keeper-down': Object.freeze(['restart-cap']),
  incompatible: Object.freeze(['keeper-major', 'terminal-protocols', 'client-outdated']),
});
// The handoff result codes, 13 (§R3.11 replaces LAUNCH_UNCONFIRMED with TERMINAL_DIDNT_START).
const RESULT_CODES = Object.freeze(['OK', 'NOT_INSTALLED', 'UNVERIFIED', 'KEEPER_DOWN', 'INCOMPATIBLE', 'SPAWN_REFUSED', 'TERMINAL_DIDNT_START',
  'CANT_OPEN', 'HANDBACK_WHILE_RUNNING', 'SESSION_BUSY', 'CONFLICT', 'DECLINED', 'UNSUPPORTED_PLATFORM']);
const SPAWN_REFUSED_REASONS = Object.freeze(['unsigned-cli', 'shape', 'cwd-gone', 'not-found', 'session-locked']);
const PLEXIFORM = 'Plexiform Terminal';
const OPEN_IN = Object.freeze(['auto', 'plexiform', 'Terminal', 'iTerm', 'Ghostty', 'Ghostty Dock']);
const USUAL = Object.freeze(['Terminal', 'iTerm', 'Ghostty', 'Ghostty Dock']);
const DEFAULTS = Object.freeze({ openIn: 'auto', openInChosen: false, usual: 'Terminal' });

// config.terminal as saved (or absent) → the §R2.4 keys with their defaults.
// PR 0s writes none of them; T5 adds the setting and saves them.
function normalizeTerminalConfig(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    openIn: OPEN_IN.includes(c.openIn) ? c.openIn : DEFAULTS.openIn,
    openInChosen: c.openInChosen === true,
    usual: USUAL.includes(c.usual) ? c.usual : DEFAULTS.usual,
  };
}

const CODE_OF = Object.freeze({ unverified: 'UNVERIFIED', 'keeper-down': 'KEEPER_DOWN', incompatible: 'INCOMPATIBLE', 'not-installed': 'NOT_INSTALLED' });

// → { app, quiet, code, offerGet }. app is where the chat opens, or null when
// nothing opens until the person picks (code says why, in R11's words).
function resolveOpenIn(config, presence, { platform = process.platform } = {}) {
  const c = normalizeTerminalConfig(config);
  if (platform !== 'darwin') return { app: null, quiet: false, code: 'UNSUPPORTED_PLATFORM', offerGet: false };
  if (c.openIn !== 'auto' && c.openIn !== 'plexiform') return { app: c.openIn, quiet: false, code: null, offerGet: false };
  const state = STATES.includes(presence?.state) ? presence.state : 'not-installed';
  const auto = c.openIn === 'auto';
  if (state === 'ready' || state === 'keeper-outdated') return { app: PLEXIFORM, quiet: false, code: null, offerGet: false };
  if (state === 'unsupported-platform') return { app: null, quiet: false, code: 'UNSUPPORTED_PLATFORM', offerGet: false };
  // Under auto, a Terminal that isn't there (or a build without the feature) falls back quietly.
  if (auto && state === 'not-installed') return { app: c.usual, quiet: true, code: null, offerGet: true };
  if (auto && state === 'unverified' && presence?.reason === 'unsigned-release') return { app: c.usual, quiet: true, code: null, offerGet: false };
  // An explicit choice is never dropped quietly, and a failed check never falls back quietly.
  return { app: null, quiet: false, code: CODE_OF[state], offerGet: false };
}

const BUNDLE_ID = 'dev.plexiform.terminal';
const APP_NAME = `${PLEXIFORM}.app`;
// = native/keeper/Sources/main.swift defaultFolder + socketPath.
const keeperSocket = (home) => path.join(home, 'Library', 'Application Support', 'Plexiform', 'Keeper', 'sockets', 'k1-b1.sock');
const appCandidates = (home) => [path.join('/Applications', APP_NAME), path.join(home, 'Applications', APP_NAME)];

function plutilJson(file) {
  return new Promise((resolve) => {
    execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', file], { timeout: 2000, maxBuffer: 256 * 1024 }, (error, stdout) => { // privacy-flow: terminal-detect
      if (error) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

// Read-only: a socket this user owns that accepts a connection. Nothing is sent;
// the keeper authenticates its peers and simply drops this one.
function keeperAnswers(socketPath, { fsImpl = fs, connect = net.createConnection, timeoutMs = 500 } = {}) { // privacy-flow: terminal-detect
  let st;
  try { st = fsImpl.lstatSync(socketPath); } catch { return Promise.resolve(false); }
  if (!st.isSocket() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    const done = (ok) => { clearTimeout(timer); sock.destroy(); resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function findApp({ home, fsImpl, readPlist }) {
  for (const p of appCandidates(home)) {
    if (!fsImpl.existsSync(path.join(p, 'Contents', 'Info.plist'))) continue;
    const info = await readPlist(path.join(p, 'Contents', 'Info.plist'));
    if (!info || info.CFBundleIdentifier !== BUNDLE_ID) continue;
    const version = typeof info.CFBundleShortVersionString === 'string' ? info.CFBundleShortVersionString.slice(0, 40) : null;
    // A take-over arrives as a .command file opened with the app; only a Terminal that declares it gets one.
    const takeover = info.PlexiformTakeover === true;
    return { path: p, version, preview: info.PlexiformDevelopmentPreview === true, takeover };
  }
  return null;
}

// signed: this copy of Plexiform is a Developer ID build (package.json plexiformSignedMac).
// verify(appPath) → Promise<boolean>: the team-pinned codesign check of §R2.5 step 2;
// until PR 0d bakes in the team ID there is none, so a signed build never reports ready.
let cache = null;
async function detect({ fresh = false, now = Date.now, platform = process.platform, home = os.homedir(), signed = false,
  fs: fsImpl = fs, readPlist = plutilJson, keeper = keeperAnswers, verify = async () => false } = {}) {
  if (platform !== 'darwin') return { state: 'unsupported-platform', reason: null, app: null, keeper: null, checkedAt: now() };
  if (!fresh && cache && cache.home === home && now() - cache.value.checkedAt < 60000) return cache.value;
  const result = (state, reason, app, running) => {
    const value = { state, reason, app, keeper: running == null ? null : { running }, checkedAt: now() };
    cache = { home, value };
    return value;
  };
  let app;
  try { app = await findApp({ home, fsImpl, readPlist }); } catch { return result('not-installed', 'search-failed', null, null); }
  if (!app) return result('not-installed', null, null, null);
  const running = await keeper(keeperSocket(home)).catch(() => false);
  // An ad-hoc Plexiform or a development-preview Terminal: installed and openable, never handed a take-over (§R3.1).
  if (!signed || app.preview) return result('unverified', 'unsigned-release', app, running);
  if (!(await verify(app.path).catch(() => false))) return result('unverified', 'signature', app, running);
  if (!running) return result('keeper-down', null, app, running);
  if (!app.takeover) return result('incompatible', 'terminal-protocols', app, running);
  return result('ready', null, app, running);
}
async function reveal(sessionId) {
  void sessionId;
  return { ok: false, code: 'NOT_INSTALLED' };
}

module.exports = { STATES, REASONS, RESULT_CODES, SPAWN_REFUSED_REASONS, OPEN_IN, USUAL, DEFAULTS, PLEXIFORM, normalizeTerminalConfig, resolveOpenIn, detect, reveal };
