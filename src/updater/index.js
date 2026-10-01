// The updater in the app: picks the platform back-end, starts the service,
// and speaks the IPC contract builder-2's UI is written against.
//   invoke  updater:get-state → UpdaterState (and subscribes that window)
//           updater:check | updater:download | updater:install({when, force}) |
//           updater:set-channel(ch) | updater:set-auto-download(on) |
//           updater:revert  → { ok, error? }
//   push    updater:state (UpdaterState) on every change, to every window
//           that has asked for the state
// Who may call what is decided per window (SENDER_POLICY): the main frame of
// the app's own updates.html gets everything; the widget (index.html) may
// read the state and install, but not force a restart; anything else,
// another page, a subframe or a web page, gets { ok: false, error: 'forbidden' }.
// main.js calls start() once; setRequired() is for the hub handshake.
const fs = require('fs');
const path = require('path');
const Brand = require('../../brand.js');
const Machine = require('../../hooks/session-machine.js');
const Rules = require('../../rules.js');
const V = require('./verify.js');
const MacSwap = require('./mac-swap.js');
const { createService } = require('./service.js');

const BUILD_DIR = path.join(__dirname, '..', '..', 'build');
// One file per channel, by exact name: no other key (a retired one included) is trusted.
const KEY_FILES = { stable: 'update-key.pub.pem', beta: 'update-key-beta.pub.pem' };
const FORBIDDEN = Object.freeze({ ok: false, error: 'forbidden' });

function loadShippedKeys(dir = BUILD_DIR) {
  const pems = {};
  for (const [ch, name] of Object.entries(KEY_FILES)) {
    try { pems[ch] = [fs.readFileSync(path.join(dir, name), 'utf8')]; } catch { pems[ch] = []; }
  }
  return V.loadKeyring(pems);
}

// When this build was made (CI writes build/release-floor.json): no manifest
// signed before it is accepted, even on a fresh install. null in dev.
function loadBuiltAt(dir = BUILD_DIR) {
  try {
    const { builtAt } = JSON.parse(fs.readFileSync(path.join(dir, 'release-floor.json'), 'utf8'));
    return typeof builtAt === 'string' && Number.isFinite(Date.parse(builtAt)) ? builtAt : null;
  } catch { return null; }
}

// Why installing now would interrupt the person, or null. "Busy" is a session
// mid-turn, one waiting on a permission or a limit, or any open ask.
function busyReason(state) {
  if ((state?.pending || []).length) return 'A permission request is waiting for you.';
  if ((state?.inputs || []).length) return 'A session is waiting for your answer.';
  for (const s of state?.sessions || []) {
    const sig = Machine.sessionSignal(s);
    const where = s.cwd ? ` in ${Rules.folderOf(s.cwd)}` : '';
    if (Machine.WAITING.has(sig)) return `A session${where} is waiting for you.`;
    if (sig && !Machine.TURN_END.has(sig) && sig !== 'session-end') return `A session${where} is working.`;
  }
  return null;
}

// Page (basename of the file:// main frame) → what it may call.
const SENDER_POLICY = {
  'updates.html': () => true,
  'index.html': (channel, args) => channel === 'updater:get-state'
    || (channel === 'updater:install' && ['now', 'idle'].includes(args[0]?.when) && !args[0]?.force),
};

function policyFor(e) {
  const frame = e?.senderFrame;
  const main = e?.sender?.mainFrame;
  if (!frame || !main) return null;
  // WebFrameMain objects are cached per frame, so the main frame is the same
  // object; the id comparison is for a wrapper made afresh.
  if (frame !== main && !(frame.parent === null && frame.frameTreeNodeId != null && frame.frameTreeNodeId === main.frameTreeNodeId)) return null;
  let url;
  try { url = new URL(frame.url); } catch { return null; }
  if (url.protocol !== 'file:') return null;
  let name;
  try { name = path.posix.basename(decodeURIComponent(url.pathname)); } catch { return null; }
  return Object.hasOwn(SENDER_POLICY, name) ? SENDER_POLICY[name] : null;
}

const allowed = (e, channel, args) => !!policyFor(e)?.(channel, args);

function register(ipcMain, service) {
  const windows = new Set();
  service.subscribe((state) => {
    for (const wc of windows) {
      if (wc.isDestroyed()) { windows.delete(wc); continue; }
      try { wc.send('updater:state', state); } catch { windows.delete(wc); }
    }
  });
  const command = (channel, fn) => async (e, ...args) => {
    if (!allowed(e, channel, args)) return FORBIDDEN;
    try { return (await fn(...args)) || { ok: true }; } catch (err) { return { ok: false, error: String(err?.message || err) }; }
  };
  ipcMain.handle('updater:get-state', (e) => {
    if (!allowed(e, 'updater:get-state', [])) return FORBIDDEN;
    windows.add(e.sender);
    return service.getState();
  });
  ipcMain.handle('updater:check', command('updater:check', () => service.check({ user: true })));
  ipcMain.handle('updater:download', command('updater:download', () => service.download()));
  ipcMain.handle('updater:install', command('updater:install', (o) => service.install({ when: o?.when, force: !!o?.force })));
  ipcMain.handle('updater:set-channel', command('updater:set-channel', (ch) => service.setChannel(ch)));
  ipcMain.handle('updater:set-auto-download', command('updater:set-auto-download', (on) => service.setAutoDownload(!!on)));
  ipcMain.handle('updater:revert', command('updater:revert', () => service.revert()));
}

function backendFor({ app, fetch, platform, env, userData, dev }) {
  if (dev || !app.isPackaged) return null;
  if (platform === 'win32' || (platform === 'linux' && env.APPIMAGE)) return require('./electron-updater.js').create({ platform }); // privacy-flow: auto-update
  if (platform === 'linux') return require('./deb.js').create({ fetch, userData, downloadsDir: app.getPath('downloads') });
  if (platform === 'darwin') return MacSwap.create({ fetch, userData, execPath: process.execPath, quit: () => app.quit() });
  return null;
}

let service = null;
let launch = { updatedFrom: null, updateFailed: false };

/**
 * deps: { app, ipcMain, net (Electron), isBusy () → reason|null, dev?, argv? }
 * A dev or unpackaged run gets the IPC and manual checks, but no back-end
 * (it must never swap node_modules' Electron.app) and no schedule.
 */
function start({ app, ipcMain, net, isBusy, dev = false, argv = process.argv, platform = process.platform, env = process.env }) {
  const fetch = (url, init) => net.fetch(url, init); // privacy-flow: auto-update
  const userData = app.getPath('userData');
  // Fails closed: a channel with no key refuses every manifest as unsigned.
  let keyring = { stable: [], beta: [] };
  try { keyring = loadShippedKeys(); } catch (err) { console.warn('[updater] update keys:', err.message); }
  launch = MacSwap.readLaunch({ userData, argv });
  service = createService({
    fetch,
    keyring,
    builtAt: loadBuiltAt(),
    feedBase: Brand.urls.updates,
    currentVersion: app.getVersion(),
    userData,
    backend: backendFor({ app, fetch, platform, env, userData, dev }),
    isBusy,
    updatedFrom: launch.updatedFrom,
    updateFailed: launch.updateFailed,
  });
  register(ipcMain, service);
  if (!dev && app.isPackaged) service.start();
  return service;
}

const setRequired = (minVersion, hubName) => service?.setRequired(minVersion, hubName);
const healthStatus = () => (service ? service.healthStatus() : { state: 'unknown', detail: 'not set up yet' });
const markLaunched = ({ app }) => MacSwap.markLaunched({ userData: app.getPath('userData'), updatedFrom: launch.updatedFrom });

module.exports = { start, setRequired, healthStatus, markLaunched, busyReason, register, loadShippedKeys, loadBuiltAt, policyFor, KEY_FILES };
