'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWorkspaceStore, teamWsId, partitionFor: teamPartition } = require('../buddy-window/workspaces');
const { pageById, hubPageUrl, pageForHubUrl, orgOfUrl } = require('../buddy-window/pages');
const { testTempDir } = require('./helpers/tmp');

// Exercise the production routing and account-change handlers together. Only
// Electron views, native credentials and network/process boundaries are fake.
const source = fs.readFileSync(path.join(__dirname, '..', 'buddy-window/index.js'), 'utf8');
function block(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `missing source boundaries: ${from}, ${to}`);
  return source.slice(start, end);
}
const routeSource = [
  block('  function activeHubBinding() {', '  const clients ='),
  block('  function forgetHub() {', '  const partitionFor ='),
  block('  function resumeRestored(origin) {', '  // ── hub view'),
  block('  async function showClientPage(origin) {', '  async function resolveHub() {'),
  block('  async function resolveHub() {', '  // Key presses'),
  block('  async function showHubPage(page) {', '  // ── selection'),
  block('  function select(id, { fromSheet = false } = {}) {', '  const fromSidebar ='),
  block('  function switchWorkspace(id, { show = true } = {}) {', '  async function onSignOut'),
  block('  const fromHubView =', '  let selectedSessionKey ='),
].join('\n');
const HUB = 'https://fixture-hub.example';
const LOCAL = 'http://127.0.0.1:43123';
const TEAM_A = teamWsId(HUB, 'team-a'), TEAM_B = teamWsId(HUB, 'team-b');
const TEAMS = [{ id: 'team-a', name: 'Team A' }, { id: 'team-b', name: 'Team B' }];
const turn = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 4; i++) await turn(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, { restored = false, ensureGate = null, gateLoads = false, refreshGate = null } = {}) {
  const workspaceFile = path.join(testTempDir('plexiform-hub-routing-', t), 'workspaces.json');
  const seed = createWorkspaceStore(workspaceFile);
  seed.addHub(HUB);
  seed.setTeams(HUB, { teams: TEAMS });
  seed.activateTeam(HUB, 'team-a');
  let marker = restored ? { user: { id: 'synthetic-owner' } } : null;
  const store = createWorkspaceStore(workspaceFile, { signedIn: () => !!marker });
  const views = [], loads = [], attachments = [], pushes = [], bearerOrigins = [], cookies = [];
  const ctx = {
    URL, Promise, Set, store, selected: 'board', setupLocalGeneration: 0, tasksGeneration: 0, homeGeneration: 0,
    hubInfo: null, hubBinding: null, hubView: null, hubLoading: null, hubLoadingBinding: null,
    content: null, gen: 0, connectEpoch: 0, viewError: null, hubStatus: { state: 'ready' },
    win: {}, accountView: null, stopping: false, resumeRequested: false, resumedHubs: new Set(),
    pageById, pageOf: pageById, hubPageUrl, pageForHubUrl, orgOfUrl, teamPartition, // pageOf: the Settings panes (R8-1) exist only in the preview, off here
    partitionFor: () => 'persist:fixture-local',
    vault: () => ({ load: () => marker }), signedIn: () => !!marker, norm: origin => origin,
    getTeamHub: () => { const w = store.active(); return w.kind === 'local' ? null : w; },
    localUrl: () => ctx.hubInfo && !ctx.hubInfo.team ? ctx.hubInfo.url : null,
    connectLife: { bump() { ctx.connectEpoch++; } }, log() {}, openWindow() {}, optimiser: { open() {} },
    installBearer: origin => bearerOrigins.push(origin),
    session: { fromPartition: partition => ({ cookies: {
      set: async cookie => cookies.push({ partition, op: 'set', cookie }),
      remove: async (url, name) => cookies.push({ partition, op: 'remove', url, name }),
    } }) },
    supervisor: {
      ensure: () => ensureGate ? ensureGate.promise : Promise.resolve({ url: LOCAL, localSecret: 'synthetic' }),
      status: () => ({ url: LOCAL }),
    },
    isHubPage: id => { const p = pageById(id); return p?.kind === 'hub' && !(p.localScreen && !ctx.getTeamHub()); },
    showLocal: page => { ctx.content = { local: page.id }; },
    showInfo: page => { ctx.content = { info: page.id }; },
    pushState: () => pushes.push({ selected: ctx.selected, active: store.active().id }),
    attach: view => { attachments.push(view); ctx.content = view; },
    dispose: view => { view.disposed = true; },
    flow: {
      leftAccountPages() {}, resumeDevices() {}, recheckAccess: async () => {},
      show: screen => { ctx.selected = `flow:${screen}`; ctx.content = { account: screen }; },
      refreshAccount: async () => { if (refreshGate) await refreshGate.promise; return { ok: true }; },
    },
    makeHubView: info => {
      let currentURL = '';
      const view = { info: { ...info }, disposed: false, webContents: {
        getURL: () => currentURL,
        mainFrame: { url: '', origin: '' },
        loadURL(url) {
          const gate = deferred();
          loads.push({ view, url, gate });
          if (!gateLoads) gate.resolve();
          return gate.promise.then(() => {
            currentURL = url;
            view.webContents.mainFrame = { url, origin: new URL(url).origin };
          });
        },
      } };
      views.push(view);
      return view;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${routeSource}\nthis.api = { showHubPage, showClientPage, select, switchWorkspace, accountStorageChanged, fromHubView };`, ctx);
  return { ctx, api: ctx.api, store, views, loads, attachments, pushes, bearerOrigins, cookies,
    setMarker(next = { user: { id: 'synthetic-owner' } }) { marker = next; },
    restore: async () => { marker = { user: { id: 'synthetic-owner' } }; await ctx.api.accountStorageChanged(HUB, { reason: 'restored' }); await settle(); },
    event: view => ({ sender: view.webContents, senderFrame: view.webContents.mainFrame }),
    board: () => ctx.api.showHubPage(pageById('board')),
    resolveAs(info) { ctx.testResolvedHub = info; vm.runInContext('resolveHub = async () => testResolvedHub;', ctx); },
  };
}

for (const page of ['home', 'overview', 'sessions', 'team']) {
  test(`cached local Board is retired on restoration while ${page} remains selected`, async t => {
    const f = fixture(t);
    assert.equal(f.store.activeId(), TEAM_A);
    assert.equal(f.store.active().id, 'local');
    await f.board();
    const old = f.ctx.hubView;
    assert.equal(old.info.team, false);
    f.api.select(page);
    const selected = f.ctx.selected, content = f.ctx.content, attached = f.attachments.length;
    await f.restore();
    assert.equal(f.ctx.selected, selected);
    assert.equal(f.ctx.content, content);
    assert.equal(f.attachments.length, attached);
    assert.equal(old.disposed, true);
    assert.equal(f.ctx.hubInfo, null);
    f.api.select('board');
    await settle();
    assert.equal(f.ctx.hubInfo.origin, HUB);
    assert.equal(f.ctx.hubInfo.org, 'team-a');
    assert.equal(f.ctx.hubInfo.partition, teamPartition(HUB));
    assert.equal(f.ctx.content, f.ctx.hubView);
    assert.equal(new URL(f.loads.at(-1).url).searchParams.get('org'), 'team-a');
    assert.equal(f.api.fromHubView(f.event(old)), false);
  });
}

test('explicit My board selection survives account restoration and later Board navigation', async t => {
  const f = fixture(t);
  await f.board();
  f.api.switchWorkspace('local');
  await settle();
  f.api.select('home');
  const content = f.ctx.content;
  await f.restore();
  assert.equal(f.ctx.content, content);
  assert.equal(f.store.activeId(), 'local');
  f.api.select('board');
  await settle();
  assert.equal(f.ctx.hubInfo.team, false);
  assert.equal(f.ctx.hubInfo.origin, LOCAL);
  assert.equal(f.ctx.hubInfo.partition, 'persist:fixture-local');
});

test('late local resolve cannot restore a detached board after off-page account restoration', async t => {
  const ensureGate = deferred(), f = fixture(t, { ensureGate });
  const oldLoad = f.board();
  f.api.select('overview');
  const content = f.ctx.content;
  await f.restore();
  ensureGate.resolve({ url: LOCAL, localSecret: 'synthetic' });
  await oldLoad;
  assert.equal(f.ctx.selected, 'overview');
  assert.equal(f.ctx.content, content);
  assert.equal(f.ctx.hubInfo, null);
  assert.deepEqual(f.views, []);
  f.api.select('board');
  await settle();
  assert.equal(f.ctx.hubInfo.origin, HUB);
  assert.equal(f.ctx.content, f.ctx.hubView);
});

test('effective workspace change during resolve retries the selected Board even before the account event', async t => {
  const ensureGate = deferred(), f = fixture(t, { ensureGate });
  const loading = f.board();
  f.setMarker();
  ensureGate.resolve({ url: LOCAL, localSecret: 'synthetic' });
  await loading;
  assert.equal(f.ctx.hubInfo.origin, HUB);
  assert.equal(f.ctx.hubInfo.org, 'team-a');
  assert.equal(f.views.length, 1);
  assert.equal(f.views[0].info.team, true);
  assert.equal(f.ctx.content, f.ctx.hubView);
});

test('late local frame load cannot attach over Home after account restoration', async t => {
  const f = fixture(t, { gateLoads: true });
  const loading = f.board();
  await settle();
  const old = f.views[0];
  f.api.select('home');
  const content = f.ctx.content;
  await f.restore();
  f.loads[0].gate.resolve();
  await loading;
  assert.equal(old.disposed, true);
  assert.equal(f.ctx.content, content);
  assert.equal(f.ctx.selected, 'home');
  assert.equal(f.attachments.length, 0);
  assert.equal(f.api.fromHubView(f.event(old)), false);
});

test('same-origin team switch retires a pending old frame, its continuation and its IPC sender', async t => {
  const f = fixture(t, { restored: true, gateLoads: true });
  const loadingA = f.board();
  await settle();
  const old = f.views[0], oldEpoch = f.ctx.gen, connectEpoch = f.ctx.connectEpoch;
  // A real document can still be running while its next load promise waits.
  old.webContents.mainFrame = { origin: HUB, url: `${HUB}/?org=team-a` };
  assert.equal(f.api.fromHubView(f.event(old)), true);
  f.api.switchWorkspace(TEAM_B);
  assert.equal(old.disposed, true);
  assert.ok(f.ctx.gen > oldEpoch);
  assert.ok(f.ctx.connectEpoch > connectEpoch, 'the old integration window authority is also retired');
  assert.equal(f.api.fromHubView(f.event(old)), false);
  await settle();
  const current = f.ctx.hubView;
  assert.notEqual(current, old);
  assert.equal(current.info.org, 'team-b');
  assert.equal(current.info.partition, old.info.partition, 'hub authentication partition is preserved');
  f.loads[1].gate.resolve();
  await settle();
  assert.equal(f.ctx.content, current);
  f.loads[0].gate.resolve();
  await loadingA;
  assert.equal(f.ctx.content, current);
  assert.equal(f.attachments.includes(old), false);
  assert.equal(f.api.fromHubView(f.event(old)), false);
  assert.equal(f.api.fromHubView(f.event(current)), true);
});

test('an account replacement in the same team immediately revokes the old document and retires it off-page', async t => {
  const f = fixture(t, { restored: true });
  await f.board();
  const old = f.ctx.hubView;
  assert.equal(f.api.fromHubView(f.event(old)), true);
  f.api.select('sessions');
  const content = f.ctx.content;
  f.setMarker({ user: { id: 'different-synthetic-owner' } });
  assert.equal(f.api.fromHubView(f.event(old)), false, 'event delivery is not needed to revoke authority');
  await f.api.accountStorageChanged(HUB, { reason: 'saved' });
  assert.equal(old.disposed, true);
  assert.equal(f.ctx.content, content);
  assert.equal(f.ctx.selected, 'sessions');
  f.api.select('board');
  await settle();
  assert.notEqual(f.ctx.hubView, old);
  assert.equal(f.ctx.hubInfo.org, 'team-a');
  assert.equal(f.ctx.content, f.ctx.hubView);
});

test('account replacement while a frame loads cannot attach it without a delivered account event', async t => {
  const f = fixture(t, { restored: true, gateLoads: true });
  const loading = f.board();
  await settle();
  f.setMarker({ user: { id: 'replacement-synthetic-owner' } });
  f.loads[0].gate.resolve();
  await loading;
  assert.equal(f.attachments.length, 0);
  assert.equal(f.api.fromHubView(f.event(f.views[0])), false);
});

test('old local resolve rejection cannot overwrite the restored team board', async t => {
  const ensureGate = deferred(), f = fixture(t, { ensureGate });
  const loading = f.board();
  await f.restore();
  const current = f.ctx.hubView;
  assert.equal(current.info.org, 'team-a');
  ensureGate.reject(new Error('synthetic old local failure'));
  await loading;
  assert.equal(f.ctx.viewError, null);
  assert.equal(f.ctx.content, current);
  assert.equal(f.ctx.hubView, current);
});

test('switching workspace without navigation retires the old board and preserves Home', async t => {
  const f = fixture(t, { restored: true });
  await f.board();
  const old = f.ctx.hubView;
  f.api.select('home');
  const content = f.ctx.content;
  f.api.switchWorkspace(TEAM_B, { show: false });
  assert.equal(old.disposed, true);
  assert.equal(f.ctx.content, content);
  assert.equal(f.ctx.selected, 'home');
  assert.equal(f.store.active().id, TEAM_B);
  assert.equal(f.api.fromHubView(f.event(old)), false);
});

test('custom Access hub keeps its canonical origin, port and authentication partition', async t => {
  const f = fixture(t);
  const access = 'https://xn--bcher-kva.example:8443';
  f.store.addAccess({ url: access, name: 'Custom fixture', accessTeam: 'fixture-access' });
  await f.board();
  assert.equal(f.ctx.hubInfo.origin, access);
  assert.equal(f.ctx.hubInfo.url, access);
  assert.equal(f.ctx.hubInfo.partition, teamPartition(access));
  assert.equal(f.ctx.hubInfo.accessTeam, 'fixture-access');
  assert.equal(f.ctx.hubInfo.bearer, undefined);
  assert.equal(f.ctx.content, f.ctx.hubView);
  assert.equal(new URL(f.loads[0].url).origin, access);
});

for (const workspace of ['local', TEAM_A]) {
  test(`client portal is retired before ordinary Board navigation to ${workspace}`, async t => {
    const f = fixture(t, { restored: true });
    f.store.setActive(workspace);
    await f.api.showClientPage(HUB);
    const old = f.ctx.hubView;
    assert.equal(f.ctx.content, old);
    assert.equal(old.info.client, true);
    f.api.select('board');
    await settle();
    assert.equal(old.disposed, true);
    assert.notEqual(f.ctx.hubView, old);
    assert.equal(f.ctx.hubInfo.client, undefined);
    assert.equal(f.ctx.hubInfo.origin, workspace === 'local' ? LOCAL : HUB);
    assert.equal(f.ctx.hubInfo.org ?? null, workspace === 'local' ? null : 'team-a');
    assert.equal(f.ctx.content, f.ctx.hubView);
    assert.equal(f.api.fromHubView(f.event(old)), false);
  });
}

test('a still-current but mismatched resolved hub offers Retry without adopting a frame', async t => {
  const f = fixture(t, { restored: true });
  f.resolveAs({ url: LOCAL, origin: LOCAL, team: false, partition: 'persist:fixture-local' });
  await f.board();
  assert.equal(f.ctx.hubInfo, null);
  assert.equal(f.ctx.hubView, null);
  assert.equal(f.attachments.length, 0);
  assert.match(f.ctx.viewError, /selected workspace could not be resolved/);
  assert.equal(f.ctx.content.info, 'board');
});

for (const page of ['board', 'integrations']) {
  test(`membership removal during account refresh reroutes the current ${page} page`, async t => {
    const refreshGate = deferred(), f = fixture(t, { refreshGate });
    await f.board();
    f.api.select('home');
    const restoration = f.restore();
    await settle();
    f.api.select(page);
    await settle();
    const removed = f.ctx.hubView;
    assert.equal(f.ctx.content, removed);
    assert.equal(removed.info.org, 'team-a');
    f.store.setTeams(HUB, { teams: [] });
    refreshGate.resolve();
    await restoration;
    assert.equal(removed.disposed, true);
    assert.equal(f.store.active().id, 'local');
    if (page === 'board') {
      assert.equal(f.ctx.selected, 'board');
      assert.equal(f.ctx.hubInfo.team, false);
      assert.equal(f.ctx.content, f.ctx.hubView);
      assert.equal(f.ctx.hubInfo.origin, LOCAL);
    } else {
      assert.equal(f.ctx.selected, 'flow:integrations');
      assert.equal(f.ctx.content.account, 'integrations');
    }
    assert.equal(f.api.fromHubView(f.event(removed)), false);
  });
}
