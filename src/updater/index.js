// The updater in the app: picks the platform back-end, starts the service,
// and speaks the IPC contract builder-2's UI is written against.
//   invoke  updater:get-state → UpdaterState (and subscribes that window)
//           updater:check | updater:download | updater:install({when}) |
//           updater:set-channel(ch) | updater:set-auto-download(on) |
//           updater:revert  → { ok, error? }
//   push    updater:state (UpdaterState) on every change, to every window
//           that has asked for the state
// main.js calls start() once; setRequired() is for the hub handshake.
const fs = require('fs');
const path = require('path');
const Brand = require('../../brand.js');
const Machine = require('../../hooks/session-machine.js');
const V = require('./verify.js');
const MacSwap = require('./mac-swap.js');
const { createService } = require('./service.js');

const KEY_DIR = path.join(__dirname, '..', '..', 'build');

function loadShippedKeys(dir = KEY_DIR) {
  const pems = fs.readdirSync(dir).filter((n) => /^update-key.*\.pub\.pem$/.test(n)).sort().map((n) => fs.readFileSync(path.join(dir, n), 'utf8'));
  return V.loadKeys(pems);
}

// Why installing now would interrupt the person, or null. "Busy" is a session
// mid-turn, one waiting on a permission or a limit, or any open ask.
function busyReason(state) {
  if ((state?.pending || []).length) return 'A permission request is waiting for you.';
  if ((state?.inputs || []).length) return 'A session is waiting for your answer.';
  for (const s of state?.sessions || []) {
    const sig = Machine.sessionSignal(s);
    const where = s.cwd ? ` in ${path.basename(s.cwd)}` : '';
    if (Machine.WAITING.has(sig)) return `A session${where} is waiting for you.`;
    if (sig && !Machine.TURN_END.has(sig) && sig !== 'session-end') return `A session${where} is working.`;
  }
  return null;
}

function register(ipcMain, service) {
  const windows = new Set();
  service.subscribe((state) => {
    for (const wc of windows) {
      if (wc.isDestroyed()) { windows.delete(wc); continue; }
      try { wc.send('updater:state', state); } catch { windows.delete(wc); }
    }
  });
  const command = (fn) => async (_e, ...args) => {
    try { return (await fn(...args)) || { ok: true }; } catch (err) { return { ok: false, error: String(err?.message || err) }; }
  };
  ipcMain.handle('updater:get-state', (e) => { windows.add(e.sender); return service.getState(); });
  ipcMain.handle('updater:check', command(() => service.check()));
  ipcMain.handle('updater:download', command(() => service.download()));
  ipcMain.handle('updater:install', command((o) => service.install({ when: o?.when, force: !!o?.force })));
  ipcMain.handle('updater:set-channel', command((ch) => service.setChannel(ch)));
  ipcMain.handle('updater:set-auto-download', command((on) => service.setAutoDownload(!!on)));
  ipcMain.handle('updater:revert', command(() => service.revert()));
}

function backendFor({ app, fetch, platform, env, userData }) {
  if (!app.isPackaged) return null;
  if (platform === 'win32' || (platform === 'linux' && env.APPIMAGE)) return require('./electron-updater.js').create({ platform }); // privacy-flow: auto-update
  if (platform === 'linux') return require('./deb.js').create({ fetch, userData, downloadsDir: app.getPath('downloads') });
  if (platform === 'darwin') return MacSwap.create({ fetch, userData, execPath: process.execPath, quit: () => app.quit() });
  return null;
}

let service = null;

/**
 * deps: { app, ipcMain, net (Electron), isBusy () → reason|null, argv? }
 * A dev run gets the IPC and manual checks but no back-end and no schedule.
 */
function start({ app, ipcMain, net, isBusy, argv = process.argv, platform = process.platform, env = process.env }) {
  const fetch = (url, init) => net.fetch(url, init); // privacy-flow: auto-update
  const userData = app.getPath('userData');
  service = createService({
    fetch,
    keys: loadShippedKeys(),
    feedBase: Brand.urls.updates,
    currentVersion: app.getVersion(),
    userData,
    backend: backendFor({ app, fetch, platform, env, userData }),
    isBusy,
    argv,
  });
  register(ipcMain, service);
  if (app.isPackaged) service.start();
  return service;
}

const setRequired = (minVersion, hubName) => service?.setRequired(minVersion, hubName);
const healthStatus = () => (service ? service.healthStatus() : { state: 'unknown', detail: 'not set up yet' });
const markLaunched = ({ app, argv = process.argv }) => MacSwap.markLaunched({ userData: app.getPath('userData'), argv });

module.exports = { start, setRequired, healthStatus, markLaunched, busyReason, register, loadShippedKeys };
