// A stand-in for the updater service, for dev and visual-test runs only: it
// serves one fixture state over the same IPC contract and answers every
// command with { ok: true, stub: true } instead of doing anything. No network.
'use strict';
const fs = require('fs');
const path = require('path');

const FIXTURES = ['updater-states.json'].map((f) => path.join(__dirname, '..', 'test', 'fixtures', f));

// Who may send which updater command (the real service's sender allowlist): the
// About & Updates page everything, including a forced install; the widget only
// get-state and an unforced install; anything else nothing.
const PAGE_CHANNELS = ['get-state', 'check', 'download', 'install', 'set-channel', 'set-auto-download', 'revert'];
function allowed(from, name, arg) {
  if (from === 'page') return PAGE_CHANNELS.includes(name);
  if (from === 'widget') return name === 'get-state' || (name === 'install' && !!arg && (arg.when === 'idle' || arg.when === 'now') && !arg.force);
  return false;
}
function senderKind(e) {
  let file = '';
  try { file = new URL(e.senderFrame && e.senderFrame.url).pathname.split('/').pop(); } catch { /* no frame */ }
  return file === 'updates.html' ? 'page' : file === 'index.html' ? 'widget' : null;
}

function create(key = 'idle-up-to-date') {
  const states = Object.assign({}, ...FIXTURES.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).states));
  let state = states[key] || states['idle-up-to-date'];
  const listeners = new Set();
  const calls = [];
  const cmd = (name) => (arg) => { calls.push({ name, arg }); console.log(`[updater-stub] ${name} ${JSON.stringify(arg ?? null)}`); return { ok: true, stub: true, name, arg }; };
  return {
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { state = next; for (const fn of listeners) fn(state); },
    calls,
    check: cmd('check'),
    download: cmd('download'),
    // CLAUDE_BUDDY_UPDATER_STUB_DEFER: the service answers "busy" to an unforced install-now
    install: (arg) => (process.env.CLAUDE_BUDDY_UPDATER_STUB_DEFER && arg && arg.when === 'now' && !arg.force
      ? (calls.push({ name: 'install', arg }), console.log(`[updater-stub] install ${JSON.stringify(arg)}`), { ok: false, error: 'busy', deferred: true })
      : cmd('install')(arg)),
    setChannel: cmd('setChannel'),
    setAutoDownload: cmd('setAutoDownload'),
    revert: cmd('revert'),
  };
}

// The IPC surface src/updater/index.js register() gives the real service.
function register(ipcMain, service) {
  const windows = new Set();
  service.subscribe((s) => { for (const wc of windows) { if (wc.isDestroyed()) windows.delete(wc); else wc.send('updater:state', s); } });
  const handle = (name, fn) => ipcMain.handle(`updater:${name}`, (e, arg) => {
    if (!allowed(senderKind(e), name, arg)) return { ok: false, error: 'forbidden' };
    return fn(e, arg);
  });
  handle('get-state', (e) => { windows.add(e.sender); return service.getState(); });
  handle('check', () => service.check());
  handle('download', () => service.download());
  handle('install', (_e, o) => service.install(o));
  handle('set-channel', (_e, ch) => service.setChannel(ch));
  handle('set-auto-download', (_e, on) => service.setAutoDownload(on));
  handle('revert', () => service.revert());
}

module.exports = { create, register, allowed };
