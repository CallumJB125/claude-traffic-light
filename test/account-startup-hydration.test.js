'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createAccountVault } = require('../buddy-window/account-vault');
const { createSecureStorage } = require('../buddy-window/secure-storage');
const { createWorkspaceStore, hubKey, teamWsId } = require('../buddy-window/workspaces');
const { pageById } = require('../buddy-window/pages');
const { testTempDir } = require('./helpers/tmp');

const source = fs.readFileSync(path.join(__dirname, '..', 'buddy-window/index.js'), 'utf8');
function block(from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `missing source boundary: ${from}`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `missing source boundary: ${to}`);
  return source.slice(start, end);
}
const vaultBlock = block('  const credentialStorage = createSecureStorage(safeStorage);', '  const clients =');
const restoreBlock = block('  function resumeRestored(origin) {', '  // ── hub view');
const selectBlock = block('  function select(id) {', '  const fromSidebar =');
const switchBlock = block('  function switchWorkspace(id, { show = true } = {}) {', '  async function onSignOut');
const resumeMethod = block('    resumeDevices() {', '    /** Subscribe to validated runner events');
const stopMethod = block('    async stop() {', '    status: () =>');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const FIRST = 'https://first-hub.example';
const SECOND = 'https://second-hub.example';
const recordFor = origin => ({ hub: origin, token: `synthetic-${hubKey(origin)}`, device_id: 'fixture-device', user: { id: `user-${hubKey(origin)}` } });
const teamsFor = origin => [{ id: 'fixture-team', name: origin === FIRST ? 'First team' : 'Second team', role: 'owner' }];

function fixture(t, { origins = [FIRST], selected = 'home', ready = true, refreshGate = null } = {}) {
  const userData = testTempDir('plexiform-startup-hydration-', t);
  const accountDir = path.join(userData, 'buddy-accounts');
  fs.mkdirSync(accountDir);
  const workspaceFile = path.join(userData, 'buddy-workspaces.json');
  const initial = createWorkspaceStore(workspaceFile);
  const nativeGates = new Map(origins.map(origin => [origin, deferred()]));
  for (const origin of origins) {
    initial.addHub(origin);
    initial.setTeams(origin, { teams: teamsFor(origin) });
    fs.writeFileSync(path.join(accountDir, `${hubKey(origin)}.bin`), Buffer.from(`sealed:${JSON.stringify(recordFor(origin))}`), { mode: 0o600 });
  }
  initial.activateTeam(origins.at(-1), 'fixture-team');

  const readiness = deferred(), reads = [], nativeCalls = [], refreshes = [], resumes = [], navigations = [], pushes = [], accountMessages = [], stops = [];
  let appReady = ready, readyWaits = 0, processCreates = 0, processCloses = 0, api;
  const safeStorage = {
    isEncryptionAvailable() { nativeCalls.push('sync-available'); throw Error('synchronous native storage is forbidden'); },
    encryptString() { nativeCalls.push('sync-encrypt'); throw Error('synchronous native storage is forbidden'); },
    decryptString() { nativeCalls.push('sync-decrypt'); throw Error('synchronous native storage is forbidden'); },
    isAsyncEncryptionAvailable: async () => { nativeCalls.push('async-available'); return true; },
    encryptStringAsync: async () => { nativeCalls.push('async-encrypt'); throw Error('startup must never rewrite credentials'); },
    decryptStringAsync: bytes => {
      const record = JSON.parse(bytes.toString().slice('sealed:'.length));
      nativeCalls.push(['async-decrypt', record.hub]);
      return nativeGates.get(record.hub).promise;
    },
  };
  const context = {
    Buffer, Map, Set, Promise, process: { platform: 'darwin' }, path, userData, ACCOUNTS_DIR: accountDir,
    allowOrigins: [], fileKey: hubKey, safeStorage,
    app: { isPackaged: true, isReady: () => appReady, whenReady: () => { readyWaits += 1; return readiness.promise; } },
    createSecureStorage: storage => createSecureStorage(storage, 'darwin'),
    createAccountStorageProcess: () => {
      processCreates += 1;
      // Exercise the index selection/retirement of the isolated transport
      // while native promises remain deterministic synthetic test gates.
      return { ...createSecureStorage(safeStorage, 'darwin'), close() {
        processCloses += 1;
        stops.push('crypto-process');
      } };
    },
    createAccountVault: options => createAccountVault({ ...options, io: { ...fs,
      readFileSync: (...args) => { reads.push(args[0]); return fs.readFileSync(...args); },
    } }),
    createWorkspaceStore,
    selected, setupLocalGeneration: 0, win: {}, hubInfo: null, viewError: null,
    accountView: { webContents: { isDestroyed: () => false, send: (...args) => accountMessages.push(args) } },
    pageById, isHubPage: id => pageById(id)?.kind === 'hub',
    pushState: () => pushes.push({ selected: context.selected, workspace: api.store.activeId() }),
    forgetHub: () => navigations.push({ kind: 'forget', workspace: api.store.activeId() }),
    showHubPage: async page => navigations.push({ kind: 'hub', page: page.id, workspace: api.store.activeId() }),
    showLocal: page => navigations.push({ kind: 'local', page: page.id, workspace: api.store.activeId() }),
    showInfo: page => navigations.push({ kind: 'info', page: page.id }),
    connectLife: { bump() {} }, optimiser: { open() {} }, openWindow() {}, log() {},
    localUrl: () => null,
    workCapture: { stop: async () => { stops.push('capture'); } },
    supervisor: { stop: async () => { stops.push('supervisor'); } },
    flow: {
      async refreshAccount(origin) {
        const marker = api.vault(origin).load();
        refreshes.push({ origin, userId: marker?.user?.id });
        if (refreshGate) await refreshGate.promise;
        // Model the flow's account-owner guard without a network request.
        if (api.vault(origin).load() !== marker) return { ok: false };
        const account = { ok: true, user: marker?.user, teams: teamsFor(origin) };
        api.store.setTeams(origin, account);
        return account;
      },
      resumeDevices: origin => resumes.push(origin),
      stopDevices: async () => { stops.push('devices'); },
      leftAccountPages() {},
    },
  };
  vm.createContext(context);
  vm.runInContext(`${vaultBlock}\n${restoreBlock}\n${selectBlock}\n${switchBlock}\nconst controller = {\n${resumeMethod}\n${stopMethod}\n};\nthis.api = {vault, signedIn, tokenFor, userOf, store, controller, select, switchWorkspace};`, context);
  api = context.api;
  t.after(() => { if (!processCloses) return api.controller.stop(); });
  return { api, context, nativeCalls, reads, refreshes, resumes, navigations, pushes, accountMessages, stops,
    readyWaits: () => readyWaits,
    processCreates: () => processCreates, processCloses: () => processCloses,
    ready() { appReady = true; readiness.resolve(); },
    async restore(origin) {
      nativeGates.get(origin).resolve({ result: JSON.stringify(recordFor(origin)), shouldReEncrypt: false });
      await api.vault(origin).retry();
      await turn();
    },
  };
}

test('startup cache reads wait for app readiness and refresh a hydrated identity only once without synchronous native calls', async t => {
  const f = fixture(t, { ready: false });
  for (let i = 0; i < 3; i++) {
    assert.equal(f.api.signedIn(FIRST), false);
    assert.equal(f.api.userOf(FIRST), null);
    assert.equal(f.api.tokenFor(FIRST), null);
  }
  await turn();
  assert.equal(f.readyWaits(), 1);
  assert.equal(f.processCreates(), 1);
  assert.equal(f.processCloses(), 0);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.nativeCalls, []);
  assert.deepEqual(f.refreshes, []);
  f.ready();
  await turn();
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.nativeCalls, ['async-available', ['async-decrypt', FIRST]]);
  assert.equal(f.api.signedIn(FIRST), false);
  await f.restore(FIRST);
  assert.equal(f.api.signedIn(FIRST), true);
  assert.deepEqual(f.refreshes, [{ origin: FIRST, userId: recordFor(FIRST).user.id }]);
  assert.equal(f.accountMessages.length, 1);
  for (let i = 0; i < 3; i++) { f.api.signedIn(FIRST); f.api.userOf(FIRST); f.api.store.list(); }
  await turn();
  assert.equal(f.refreshes.length, 1);
  assert.equal(f.reads.length, 1);
  assert.equal(f.nativeCalls.some(value => typeof value === 'string' && value.startsWith('sync-')), false);
});

test('restoring the remembered team leaves the selected Home page unchanged', async t => {
  const f = fixture(t);
  const remembered = teamWsId(FIRST, 'fixture-team');
  assert.equal(f.api.store.activeId(), remembered);
  assert.equal(f.api.store.active().id, 'local');
  await f.restore(FIRST);
  assert.equal(f.api.store.active().id, remembered);
  assert.equal(f.context.selected, 'home');
  assert.deepEqual(f.navigations, []);
  assert.deepEqual(f.resumes, [], 'ordinary account restoration does not opt into runner startup');
});

test('an explicit switch to the local board while native restore waits remains local after hydration', async t => {
  const f = fixture(t);
  f.api.signedIn(FIRST);
  await turn();
  f.api.switchWorkspace('local');
  assert.equal(f.context.selected, 'board');
  assert.equal(f.api.store.activeId(), 'local');
  await f.restore(FIRST);
  assert.equal(f.context.selected, 'board');
  assert.equal(f.api.store.activeId(), 'local');
  assert.equal(f.api.store.active().id, 'local');
  assert.ok(f.navigations.filter(item => item.kind === 'hub').length > 0);
  assert.ok(f.navigations.every(item => !item.workspace || item.workspace === 'local'), 'late restoration never navigates back to the team');
});

test('choosing Home during the restored account refresh prevents late board navigation', async t => {
  const refreshGate = deferred();
  const f = fixture(t, { selected: 'board', refreshGate });
  await f.restore(FIRST);
  assert.equal(f.refreshes.length, 1);
  f.api.select('home');
  const navigationCount = f.navigations.length;
  refreshGate.resolve();
  await turn();
  assert.equal(f.context.selected, 'home');
  assert.equal(f.navigations.length, navigationCount);
  assert.equal(f.navigations.at(-1).page, 'home');
});

test('choosing the local workspace during the restored account refresh prevents a late team reload', async t => {
  const refreshGate = deferred();
  const f = fixture(t, { selected: 'board', refreshGate });
  await f.restore(FIRST);
  assert.equal(f.refreshes.length, 1);
  f.api.switchWorkspace('local');
  const navigationCount = f.navigations.length;
  refreshGate.resolve();
  await turn();
  assert.equal(f.context.selected, 'board');
  assert.equal(f.api.store.activeId(), 'local');
  assert.equal(f.navigations.length, navigationCount);
  assert.equal(f.navigations.at(-1).workspace, 'local');
});

test('runner restoration requires startup opt-in and resumes each hydrated origin at most once', async t => {
  const f = fixture(t, { origins: [FIRST, SECOND] });
  f.api.signedIn(FIRST);
  await f.restore(FIRST);
  assert.deepEqual(f.resumes, []);
  f.api.controller.resumeDevices();
  await turn();
  assert.deepEqual(f.resumes, [FIRST], 'only the ready origin resumes immediately');
  assert.equal(f.api.signedIn(SECOND), false);
  await f.restore(SECOND);
  assert.deepEqual(f.resumes, [FIRST, SECOND], 'the other origin resumes when its own credential arrives');
  f.api.controller.resumeDevices();
  f.api.controller.resumeDevices();
  await turn();
  assert.deepEqual(f.resumes, [FIRST, SECOND]);
  assert.deepEqual(f.refreshes.map(item => item.origin), [FIRST, SECOND]);
  assert.equal(f.context.selected, 'home');
});

test('stop completes while native authorization is pending and prevents late refresh, navigation and runner startup', async t => {
  const f = fixture(t, { selected: 'board' });
  f.api.controller.resumeDevices();
  await turn();
  assert.equal(f.api.vault(FIRST).state(), 'restoring');
  await f.api.controller.stop();
  assert.equal(f.api.vault(FIRST).state(), 'closed');
  const effects = [f.pushes.length, f.accountMessages.length, f.navigations.length];
  await f.restore(FIRST);
  assert.equal(f.api.signedIn(FIRST), false);
  assert.deepEqual(f.refreshes, []);
  assert.deepEqual(f.resumes, []);
  assert.deepEqual([f.pushes.length, f.accountMessages.length, f.navigations.length], effects);
  assert.equal(f.processCloses(), 1);
  assert.deepEqual(f.stops, ['crypto-process', 'capture', 'supervisor', 'devices'], 'isolated crypto is retired before other cleanup waits');
  f.api.controller.resumeDevices();
  assert.deepEqual(f.resumes, []);
});

test('stop during account refresh prevents the completed refresh from navigating or resuming devices', async t => {
  const refreshGate = deferred();
  const f = fixture(t, { selected: 'board', refreshGate });
  f.api.controller.resumeDevices();
  await f.restore(FIRST);
  assert.equal(f.refreshes.length, 1);
  await f.api.controller.stop();
  const effects = [f.pushes.length, f.accountMessages.length, f.navigations.length];
  refreshGate.resolve();
  await turn();
  assert.equal(f.api.signedIn(FIRST), false);
  assert.deepEqual(f.resumes, []);
  assert.deepEqual([f.pushes.length, f.accountMessages.length, f.navigations.length], effects);
});
