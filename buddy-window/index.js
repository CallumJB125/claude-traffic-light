// The Buddy main window: a native sidebar plus one content area. The board
// pages are the hub's own web app, loaded from the hub's origin in a sandboxed
// view (so same-origin, CSRF and WS origin checks work unchanged and the web is
// never forked); the sidebar, placeholder and account pages are local files.
//
// Team hubs use Buddy accounts (email + code). The per-hub device token stays
// in main, sealed with safeStorage; the board view gets it only as an
// Authorization header that main adds to requests for that hub's exact origin.
//
// main.js wires it: `const buddy = createBuddyWindow({...}); buddy.open()`.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http'); // privacy-flow: local-board-hub
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { BaseWindow, BrowserWindow, WebContentsView, ipcMain, session, shell, utilityProcess, app, nativeTheme, net, safeStorage, dialog } = require('electron'); // privacy-flow: team-hub-account
const { PAGES, GROUPS, pageById, hubPageUrl, fragmentOk, navDecision, openDecision, connectDecision, connectNavOk, bindCookie, appUserAgent, isConnectCallback, pageForHubUrl, orgOfUrl } = require('./pages');
const { createHubSupervisor } = require('./hub-process');
const { createWorkspaceStore, normalizeHubUrl, normalizeLinkHub, accessTeamFromLocation, partitionFor: teamPartition, integrationPartitionFor, hubKey, hostOf } = require('./workspaces');
const { createAccountClient, pinnedTransport, bearerScope, bearerHeaders } = require('./accounts');
const { createDeviceController, defaultDeviceName } = require('./device');
const { createAccountFlow, clearHubSessions, ACCT_ARGS } = require('./account-flow');
const { createConnectLife } = require('./connect-life');
const BRAND = require('./brand');
const { clientArtifactTarget, clientExportTarget, saveClientArtifact, saveClientExport } = require('./client-download');
const { createWorkCapture } = require('../src/work-capture');
const { createMyDayBroker } = require('../src/my-day-broker');

const SIDEBAR_W = 216;
const DIR = __dirname;
const LOCAL_PAGES = new Set([
  ...['sidebar.html', 'info.html', 'account.html'].map((f) => pathToFileURL(path.join(DIR, f)).href),
  ...PAGES.filter((p) => p.file).map((p) => pathToFileURL(path.join(DIR, '..', p.file)).href),
]);
const fileKey = hubKey;
const isLocalPage = (url) => { try { const u = new URL(url); u.search = ''; u.hash = ''; return LOCAL_PAGES.has(u.href); } catch { return false; } };

function devLogin(url, secret, login = 'alice') {
  // Node http, not the view: we need the Set-Cookie header to copy it into the
  // view's partition, and the dev secret must never reach the page's JS.
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ github_login: login, request_id: crypto.randomUUID() });
    const u = new URL('/api/dev/login', url);
    const req = http.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'board-dev-secret': secret, 'content-length': Buffer.byteLength(body) } }, (res) => { // privacy-flow: local-board-hub
      res.resume();
      if (res.statusCode !== 200) return reject(new Error(`dev login failed (${res.statusCode})`));
      const set = [].concat(res.headers['set-cookie'] ?? []).map((c) => String(c).split(';')[0]).find((c) => c.startsWith('board_dev='));
      if (!set) return reject(new Error('dev login set no cookie'));
      resolve(set.slice('board_dev='.length));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Once per partition: the board needs no OS permissions, devices or downloads.
const hardened = new Set();
const clientDownloads = new WeakMap();
function hardenSession(ses) {
  if (hardened.has(ses)) return;
  hardened.add(ses);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (e, item, wc) => {
    e.preventDefault();
    clientDownloads.get(ses)?.(item.getURL(), wc, item.hasUserGesture());
  });
}

function dispose(view, win) {
  if (!view) return;
  try { win?.contentView.removeChildView(view); } catch { /* not attached */ }
  // A detached WebContentsView keeps its page (and its sockets) alive until closed.
  try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch { /* already gone */ }
}

/**
 * Is `origin` a team hub, and where does it send people to sign in?
 * Asks from the hub's own partition without following redirects: a hub behind
 * Cloudflare Access answers 302 to <team>.cloudflareaccess.com (or 200 when
 * this app is already signed in); a bare hub answers /api/health itself.
 */
// One in-memory partition (no `persist:`) for every probe, emptied first: probes share no
// cookies, and a session per probe would stay alive for the life of the app.
const PROBE_PARTITION = 'board-probe';
async function probeHub(origin, partition) {
  await session.fromPartition(partition).clearStorageData();
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const req = net.request({ url: `${origin}/api/health`, session: session.fromPartition(partition), redirect: 'manual', useSessionCookies: true }); // privacy-flow: team-hub-account
    const timer = setTimeout(() => { try { req.abort(); } catch { /* done */ } finish({ ok: false, error: 'The hub did not answer in 10 seconds.' }); }, 10_000);
    req.on('redirect', (_status, _method, location) => {
      try { req.abort(); } catch { /* done */ }
      const team = accessTeamFromLocation(location);
      finish(team ? { ok: true, accessTeam: team, signedIn: false } : { ok: false, error: BRAND.COPY.notASignIn });
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d) => { if (body.length < 4096) body += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (res.statusCode === 200 && j.ok && j.protocol) return finish({ ok: true, accessTeam: null, signedIn: true, auth: j.auth });
        } catch { /* not JSON */ }
        finish({ ok: false, error: BRAND.COPY.notAHub });
      });
    });
    req.on('error', (e) => finish({ ok: false, error: `Couldn’t reach it (${e.message}).` }));
    req.end();
  });
}

function createBuddyWindow({ openWindow = () => {}, onLocalPage = () => {}, onClosed = () => {}, log = (...a) => console.log('[buddy-window]', ...a), isDev = !app.isPackaged, devAccountsHub = null, captureEnabled = true } = {}) {
  // The dev-only mock accounts hub runs on loopback; that one exact origin is
  // the only non-https hub ever accepted.
  const allowOrigins = devAccountsHub && isDev ? [devAccountsHub] : [];
  const norm = (u) => normalizeHubUrl(u, { allowOrigins });
  const normLink = (u) => normalizeLinkHub(u, { allowOrigins });
  const userData = app.getPath('userData');
  const ACCOUNTS_DIR = path.join(userData, 'buddy-accounts');
  const DEVICES_DIR = path.join(userData, 'buddy-devices');

  // ── sealed per-hub device token ────────────────────────────────────────
  const vaults = new Map();
  function vault(origin) {
    let v = vaults.get(origin);
    if (v) return v;
    const file = path.join(ACCOUNTS_DIR, `${fileKey(origin)}.bin`);
    let cache; // undefined until first read; the board view asks per request
    v = {
      load() {
        if (cache !== undefined) return cache;
        cache = null;
        try { if (fs.existsSync(file)) cache = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))); } catch (e) { log('account sign-in unreadable; treated as signed out', e.message); }
        if (cache && cache.hub !== origin) cache = null;
        return cache;
      },
      save(obj) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
        fs.mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(obj)), { mode: 0o600 });
        fs.renameSync(tmp, file);
        cache = obj;
      },
      clear() { cache = null; fs.rmSync(file, { force: true }); },
    };
    vaults.set(origin, v);
    return v;
  }
  const signedIn = (origin) => !!vault(origin).load();
  const tokenFor = (origin) => vault(origin).load()?.token ?? null;
  const userOf = (origin) => vault(origin).load()?.user ?? null;

  const store = createWorkspaceStore(path.join(userData, 'buddy-workspaces.json'), { allowOrigins, signedIn });
  const getTeamHub = () => { const w = store.active(); return w.kind === 'local' ? null : w; };

  const clients = new Map();
  function clientFor(origin) {
    let c = clients.get(origin);
    if (!c) {
      c = createAccountClient({ origin, store: vault(origin), pin: (o) => pinnedTransport(o), onSignedOut: () => { flow.signedOutOf(origin, { tell: true }).catch((e) => log('sign-out cleanup failed', e.message)); } });
      clients.set(origin, c);
    }
    return c;
  }
  let win = null;
  let sidebar = null;
  let content = null; // the view currently attached on the right
  let hubView = null;
  let infoView = null;
  let accountView = null;
  let accountLoad = Promise.resolve();
  let accountLoadGeneration = 0;
  const localViews = new Map(); // page id → its own view, kept so a page keeps its state
  const setupIdentityListeners=new Set();let setupIdentityMarkers=[];
  let setupSourcesGeneration=0,setupLocalGeneration=0,setupCurrentSources=[],setupModalTicket=null;
  let selected = 'board';
  let hubStatus = { state: 'stopped' };
  let hubInfo = null; // {url, origin, accessTeam, partition, team, bearer, org}
  let viewError = null; // the hub is fine but its page failed to load
  let hubLoading = null;

  // Local hub, started lazily the first time a board page opens.
  const mode = process.env.BUDDY_BOARD_AUTH === 'dev' && isDev ? 'dev' : 'local';
  const localUrl = () => (hubInfo && !hubInfo.team ? hubInfo.url : null);
  // Before anything that can call forgetHub.
  const connectLife = createConnectLife();
  const supervisor = createHubSupervisor({
    fork: (entry, args, opts) => utilityProcess.fork(entry, args, opts), // privacy-flow: local-board-hub
    hubEntry: path.join(app.getAppPath(), 'board', 'hub', 'server.js'),
    dataDir: path.join(userData, mode === 'dev' ? 'board-dev' : 'board'),
    mode,
    isPackaged: !isDev,
    log: (...a) => log('[hub]', ...a),
    onStatus,
  });

  const workCapture = createWorkCapture({
    file: path.join(userData, 'work-capture.json'), host: os.hostname().split('.')[0],
    ownedRoots: [path.join(userData, 'runner'), path.join(userData, 'tasks'), path.join(userData, 'plexiform-tasks')],
    log: (message) => log('[work-capture]', message),
    onChange() { if (flow.acct.screen === 'thismac' && accountView && !accountView.webContents.isDestroyed()) accountView.webContents.send('buddy:acct:changed'); },
    async getRoutes() {
      const hubs = store.hubs().filter(signedIn);
      const routes = []; let complete = hubs.length <= 8;
      await Promise.all(hubs.slice(0, 8).map(async (hub) => {
        const user = userOf(hub)?.id;
        const response = await clientFor(hub).captureRoutes();
        if (!response.ok || !user || user !== userOf(hub)?.id || !response.complete || response.truncated || !Array.isArray(response.routes) || response.routes.length > 200) { complete = false; return; }
        for (const route of response.routes.slice(0, 200)) {
          if (!route || !['owner','admin','member','viewer'].includes(route.role) || !['team_id','board_id','repo_id'].every(k => /^[A-Za-z0-9_.:-]{1,100}$/.test(route[k] ?? '')) || typeof route.canonical_url !== 'string' || route.canonical_url.length > 300) { complete = false; continue; }
          routes.push({ ...route, hub, user_id: user, share_summaries: store.sharesSummaries(hub),
            team_name: route.team_name ?? store.list().find(w => w.kind === 'team' && w.teamId === route.team_id && w.hub === hub)?.name ?? 'Team' });
        }
      }));
      return { routes, complete };
    },
    sendLocal: (body) => supervisor.captureWork(body),
    async sendTeam(destination, body) {
      if (!signedIn(destination.hub) || userOf(destination.hub)?.id !== destination.user_id) return { ok: false };
      const report = { ...body }; if (!store.sharesSummaries(destination.hub)) delete report.summary;
      const result = await clientFor(destination.hub).captureWork(destination.team_id, destination.board_id, report);
      return userOf(destination.hub)?.id === destination.user_id ? result : { ok: false };
    },
  });

  async function setupSources() {
    const generation=++setupSourcesGeneration;setupCurrentSources=[];
    const rows=[];rows.partial=store.hubs().length>8;
    for(const origin of store.hubs().slice(0,8)) {
      const marker=vault(origin).load(), userId=marker?.user?.id,deviceId=marker?.device_id;
      const current=()=>generation===setupSourcesGeneration && store.hubs().includes(origin) && vault(origin).load()===marker && userOf(origin)?.id===userId && marker?.device_id===deviceId;
      if(typeof userId!=='string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(userId)) continue;
      let me;try{me=await clientFor(origin).me();}catch{rows.partial=true;continue;}
      if(!current() || !me?.ok || me.user?.id!==userId || !Array.isArray(me.teams) || me.teams.length>200) {rows.partial=true;continue;}
      if(me.teams.length>32) rows.partial=true;
      for(const team of me.teams.slice(0,32)) {
        if(!team||typeof team!=='object') {rows.partial=true;continue;}
        if(![team.id,team.member_id].every(id=>typeof id==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(id)) || !['owner','admin','member','viewer'].includes(team.role)) continue;
        rows.push({name:`${String(team.name??'Team').slice(0,80)} · ${hostOf(origin)}`,userId,deviceId,teamId:team.id,memberId:team.member_id,role:team.role,machine:{emails:typeof me.user.email==='string'?[me.user.email]:[]},current,call:(op,args)=>current()?clientFor(origin).setups(op,team.id,args,userId,team.member_id):Promise.resolve({ok:false})});
      }
    }
    if(generation===setupSourcesGeneration)setupCurrentSources=rows;
    return rows;
  }

  const myDayBroker = createMyDayBroker({
    async sources() {
      const sources = store.hubs().map(origin => {
        const marker = vault(origin).load(), userId = marker?.user?.id;
        const knownUser = typeof userId === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(userId);
        const current = () => store.hubs().includes(origin) && vault(origin).load() === marker && userOf(origin)?.id === userId;
        return { name: hostOf(origin), userId, current, read: () => marker && knownUser ? clientFor(origin).myDay() : Promise.resolve({ ok: false }),
          async open(row, fresh) {
            // Team is looked up from the current server-verified membership, not a renderer argument.
            const target = store.list().find(w => w.kind === 'team' && w.hub === origin && w.teamId === row.team_id);
            if (!target || !fresh()) return false;
            switchWorkspace(target.id, { show: false }); selected = 'board'; flow.leftAccountPages();
            await showHubPage(pageById('board'));
            if (!fresh() || !hubView || hubInfo?.origin !== origin || hubInfo.org !== target.teamId) return false;
            const url = new URL(hubPageUrl(origin, pageById('board'), { org: target.teamId }));
            url.searchParams.set('board', row.board_id); url.hash = `card=${encodeURIComponent(row.card?.id ?? row.card_id)}`;
            await hubView.webContents.loadURL(url.href); // privacy-flow: team-hub-account
            pushState(); return fresh();
          } };
      });
      const launch = await supervisor.ensure().catch(() => null);
      const localCurrent = () => !launch || supervisor.launchCurrent(launch);
      sources.unshift({ name: 'My board (this Mac)', current: localCurrent, read: () => launch ? supervisor.myDay() : Promise.resolve({ ok: false }),
        async open(row, fresh) {
          if (!fresh()) return false;
          switchWorkspace('local', { show: false }); selected = 'board'; flow.leftAccountPages();
          await showHubPage(pageById('board'));
          if (!fresh() || !hubView || hubInfo?.team || hubInfo?.url !== launch.url) return false;
          const url = new URL(hubPageUrl(launch.url, pageById('board')));
          url.searchParams.set('board', row.board_id); url.hash = `card=${encodeURIComponent(row.card?.id ?? row.card_id)}`;
          await hubView.webContents.loadURL(url.href); // privacy-flow: local-board-hub
          pushState(); return fresh();
        } });
      return sources;
    },
  });

  // A page with a localScreen is the account page's explainer while the local board is active, not a hub page.
  const isHubPage = (id) => { const p = pageById(id); return p?.kind === 'hub' && !(p.localScreen && !getTeamHub()); };

  function onStatus(s) {
    hubStatus = s;
    // The embedded hub only drives the page while the local workspace is active.
    if (getTeamHub()) { pushState(); return; }
    // A restarted hub has a new port and a new secret: the old page, its
    // socket and its cookie are all dead. Forget them and load afresh.
    if (hubInfo && !hubInfo.team && (s.state !== 'ready' || s.url !== hubInfo.url)) forgetHub();
    pushState();
    if (!win || !isHubPage(selected)) return;
    // During a first load showHubPage is already awaiting this start.
    if (s.state === 'ready') { if (!hubLoading) showHubPage(pageById(selected)); } else showInfo(pageById(selected));
  }

  // Bumped whenever the hub the page should show changes (workspace switch,
  // restart): a load that finishes for an older generation is dropped.
  let gen = 0;

  function forgetHub() {
    gen += 1;
    connectLife.bump();
    hubLoading = null; // a resolve for the old hub must not be awaited by the new one
    const old = localUrl();
    hubInfo = null;
    viewError = null;
    if (hubView) { if (content === hubView) content = null; dispose(hubView, win); hubView = null; }
    if (old) session.fromPartition(partitionFor()).cookies.remove(old, 'board_local').catch(() => {}); // privacy-flow: local-board-hub
  }

  const partitionFor = () => (mode === 'dev' ? 'persist:board-dev' : 'persist:board-local');

  function layout() {
    if (!win) return;
    const { width, height } = win.getContentBounds();
    sidebar?.setBounds({ x: 0, y: 0, width: SIDEBAR_W, height });
    content?.setBounds({ x: SIDEBAR_W, y: 0, width: Math.max(0, width - SIDEBAR_W), height });
  }

  function attach(view) {
    if (!win || content === view) return;
    if (content) win.contentView.removeChildView(content);
    content = view;
    if (view) win.contentView.addChildView(view);
    layout();
  }

  function pushState() {
    const markers=store.hubs().map(origin=>[origin,vault(origin).load()]);
    if(markers.length!==setupIdentityMarkers.length || markers.some((value,index)=>value[0]!==setupIdentityMarkers[index]?.[0]||value[1]!==setupIdentityMarkers[index]?.[1])) {
      setupSourcesGeneration++;setupCurrentSources=[];
      setupIdentityMarkers=markers;
      for(const listener of setupIdentityListeners) listener();
      const page=localViews.get('setups')?.webContents;if(page&&!page.isDestroyed())page.send('setups:changed');
    }
    const myDayPage = localViews.get('myday')?.webContents;
    if (myDayPage && !myDayPage.isDestroyed()) myDayPage.send('myday:changed');
    if (!sidebar || sidebar.webContents.isDestroyed()) return;
    const team = getTeamHub();
    sidebar.webContents.send('buddy:state', {
      selected,
      workspaces: store.list().map(({ id, name, kind, group }) => ({ id, name, kind, group: group ?? null })),
      active: store.active().id,
      signedIn: store.hubs().some(signedIn),
      runners: flow.runningTeams(),
      hub: team
        ? { state: viewError ? 'failed' : 'ready', error: viewError, mode: 'team', name: team.name }
        : { state: viewError ? 'failed' : hubStatus.state, error: viewError ?? hubStatus.error ?? null, mode },
    });
  }

  // ── info page (soon / loading / error) ──────────────────────────────────

  function showInfo(page, extra = {}) {
    if (!win || !page) return;
    if (!infoView) {
      infoView = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(DIR, 'info-preload.js') } });
      lockLocal(infoView);
    }
    const hub = isHubPage(page.id);
    const team = getTeamHub();
    const failed = viewError || (!team && hubStatus.state === 'failed');
    const query = {
      title: page.title,
      kind: hub ? (failed ? 'error' : 'loading') : page.kind,
      blurb: hub ? (failed ? (viewError ?? hubStatus.error ?? 'The board could not start.') : team ? `Opening ${team.name}…` : BRAND.COPY.startingBoard) : (page.blurb ?? ''),
      brand: BRAND.NAME,
      ...extra,
    };
    infoView.webContents.loadFile(path.join(DIR, 'info.html'), { query }).catch(() => {});
    attach(infoView);
  }

  function showLocal(page) {
    if (!win || !page) return;
    let v = localViews.get(page.id);
    if (v && v.webContents.isDestroyed()) { localViews.delete(page.id); v = null; } // a crashed renderer is rebuilt, not re-attached
    if (!v) {
      v = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(DIR, '..', page.preload) } });
      v.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1a1f' : '#eceaf0');
      lockLocal(v);
      localViews.set(page.id, v);
      v.webContents.on('did-finish-load', () => onLocalPage(page, v.webContents));
      v.webContents.loadFile(path.join(DIR, '..', page.file), { query: page.query || {} }).catch(() => {});
    }
    attach(v);
  }

  // Local pages load our own files only; nothing navigates them anywhere else.
  function lockLocal(view) {
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; }); // privacy-flow: open-link-in-browser
    const guard = (e, url) => { if (!isLocalPage(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } }; // privacy-flow: open-link-in-browser
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
  }

  // ── account pages ──────────────────────────────────────────────────────

  // Draws the account page for a screen the flow picked; the flow owns which.
  function showScreen(screen) {
    const page = PAGES.find((p) => p.screen === screen || p.localScreen === screen);
    selected = page ? page.id : `flow:${screen}`;
    if (!win) return;
    pushState();
    if (!accountView) {
      accountView = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(DIR, 'account-preload.js') } });
      accountView.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1a1f' : '#eceaf0');
      lockLocal(accountView);
    }
    // Flow changes can arrive while the initial account navigation is still
    // loading. Serialize loads and skip superseded screens so an earlier
    // navigation cannot leave its URL/renderer behind the current flow.
    const view = accountView, generation = ++accountLoadGeneration;
    accountLoad = accountLoad.catch(() => {}).then(async () => {
      if (!win || view !== accountView || generation !== accountLoadGeneration || view.webContents.isDestroyed()) return;
      await view.webContents.loadFile(path.join(DIR, 'account.html'), { query: { screen } });
    }).catch((e) => log('account page load failed', e.message));
    attach(accountView);
  }

  // ── this Mac as a runner, per team ──────────────────────────────────────

  const deviceFile = (origin, teamId) => path.join(DEVICES_DIR, `${fileKey(origin)}-${teamId}.bin`);
  // Runner events (a run that reached its budget) go to main's subscribers only, already validated.
  const runnerListeners = new Set();
  const emitRunnerEvent = (ev) => { for (const cb of [...runnerListeners]) { try { cb(ev); } catch { /* a subscriber's error is its own */ } } };
  function makeDevice(ws, { onStatus }) {
    const key = `${fileKey(ws.hub)}-${ws.teamId}`;
    fs.mkdirSync(DEVICES_DIR, { recursive: true, mode: 0o700 });
    return createDeviceController({
      account: clientFor(ws.hub), teamId: ws.teamId,
      credsFile: deviceFile(ws.hub, ws.teamId),
      seal: (str) => safeStorage.encryptString(str), unseal: (b) => safeStorage.decryptString(b),
      canSeal: () => safeStorage.isEncryptionAvailable(),
      fork: (entry, args, opts) => utilityProcess.fork(entry, args, opts), // privacy-flow: team-hub-runner
      runnerEntry: path.join(app.getAppPath(), 'board', 'runner', 'app-entry.js'),
      dataDir: path.join(userData, 'runner', key),
      log: (...a) => log('[runner]', ...a),
      onStatus,
      onEvent: emitRunnerEvent,
    });
  }
  // A hub's sealed runner tokens, except those of the teams in `keep`.
  function discardDeviceFiles(origin, { keep = [] } = {}) {
    const prefix = `${fileKey(origin)}-`;
    const kept = new Set(keep.map((t) => `${prefix}${t}.bin`));
    let names = [];
    try { names = fs.readdirSync(DEVICES_DIR); } catch { return; }
    for (const n of names) if (n.startsWith(prefix) && n.endsWith('.bin') && !kept.has(n)) fs.rmSync(path.join(DEVICES_DIR, n), { force: true });
  }

  // The team hub's storage after sign-out; its live page and connect window close first.
  async function hubSignedOut(origin) {
    if (hubInfo?.origin === origin) forgetHub();
    if (connectWin && !connectWin.isDestroyed() && connectWin.hubOrigin === origin) connectWin.close();
    await connectLife.clearing(integrationPartitionFor(origin), () => clearHubSessions(origin, (p) => session.fromPartition(p)));
  }

  // Dev only: the walk stands in for the system browser (main.js gates it on !app.isPackaged).
  let devBrowser = null;
  const flow = createAccountFlow({
    store, clientFor, signedIn, userOf, normHub: norm, normLink,
    // The provider's sign-in page, in the system browser: Google refuses embedded views.
    openBrowser: (url) => (devBrowser ? devBrowser(url) : shell.openExternal(url)), // privacy-flow: team-hub-account
    oauthAllowOrigins: allowOrigins,
    // A throwaway, in-memory session: a signed-in partition would answer 200
    // and hide the Access team we must pin.
    probe: (origin) => probeHub(origin, PROBE_PARTITION),
    makeDevice, hasDeviceFile: (ws) => fs.existsSync(deviceFile(ws.hub, ws.teamId)), discardDeviceFiles,
    deviceInfo: () => ({ deviceName: defaultDeviceName(os.userInfo().username, os.hostname()), platform: `${process.platform}-${process.arch}` }),
    log,
    ui: {
      show: showScreen,
      openClients: (origin) => showClientPage(origin),
      select: (id) => select(id),
      switchWorkspace: (id, opts) => switchWorkspace(id, opts),
      pushState: () => pushState(),
      forgetHub: () => forgetHub(),
      hubSignedOut,
      isOpen: () => !!win,
      onHubPage: () => isHubPage(selected),
      // Only a mailto: the flow built itself from an invite it minted; nothing a page passed.
      openMail: (url) => { if (typeof url === 'string' && url.startsWith('mailto:')) shell.openExternal(url); }, // privacy-flow: open-link-in-browser
      devicesChanged: () => {
        pushState();
        if (flow.acct.screen === 'thismac' && content === accountView) accountView?.webContents.send('buddy:acct:changed');
      },
    },
  });

  // ── hub view ────────────────────────────────────────────────────────────

  // Once per hub partition: the device token rides as a header on requests to
  // that hub's exact origin (and its WebSocket), so the page never holds it.
  const bearerSessions = new Set();
  function installBearer(origin) {
    const partition = teamPartition(origin);
    if (bearerSessions.has(partition)) return;
    bearerSessions.add(partition);
    const ses = session.fromPartition(partition);
    const scope = bearerScope(origin);
    // Every URL, not just the hub's: a redirect off the hub must lose our header here.
    ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (d, cb) => cb({ requestHeaders: bearerHeaders(d.requestHeaders, d.url, { scope, token: tokenFor(origin) }) })); // privacy-flow: team-hub-account
    // A 401 from the hub (the board web re-checks after its socket closes
    // 4401 on session.revoked): ask the hub once whether we're signed out.
    ses.webRequest.onCompleted({ urls: scope.urls }, (d) => { if (d.statusCode === 401 && scope.matches(d.url)) flow.checkSignedIn(origin); });
  }

  // A guest's client portal uses the already authenticated hub partition.
  // It has no ordinary workspace, runner, preload or renderer-held token.
  async function showClientPage(origin) {
    if (!win || norm(origin) !== origin || !signedIn(origin)) throw new Error('client hub is not signed in');
    forgetHub();
    const current = gen;
    flow.leftAccountPages();
    selected = 'flow:clients';
    installBearer(origin);
    const h = { url: origin, origin, accessTeam: null, partition: teamPartition(origin), team: true, bearer: true, client: true, org: null };
    hubInfo = h;
    const view = makeHubView(h);
    hubView = view;
    await view.webContents.loadURL(`${origin}/clients`); // privacy-flow: team-hub-account
    if (current !== gen || !win || selected !== 'flow:clients' || view !== hubView || !signedIn(origin)) return;
    attach(view);
    pushState();
  }

  async function resolveHub() {
    const team = getTeamHub();
    if (team?.kind === 'team') {
      if (!signedIn(team.hub)) throw new Error('signed out');
      installBearer(team.hub);
      return { url: team.hub, origin: team.hub, accessTeam: null, partition: teamPartition(team.hub), team: true, bearer: true, org: team.teamId };
    }
    if (team?.kind === 'access') {
      const origin = new URL(team.url).origin;
      return { url: team.url, origin, accessTeam: team.accessTeam ?? null, partition: teamPartition(team.url), team: true };
    }
    const info = await supervisor.ensure();
    const partition = partitionFor();
    const ses = session.fromPartition(partition);
    // Set before the first load: in local mode the hub gates everything,
    // /api/health and static files included, on this cookie.
    if (info.localSecret) {
      await ses.cookies.set({ url: info.url, name: 'board_local', value: info.localSecret, httpOnly: true, sameSite: 'strict', path: '/' }); // privacy-flow: local-board-hub
    } else if (info.devSecret) {
      const value = await devLogin(info.url, info.devSecret); // privacy-flow: local-board-hub
      await ses.cookies.set({ url: info.url, name: 'board_dev', value, httpOnly: true, sameSite: 'strict', path: '/' }); // privacy-flow: local-board-hub
    }
    return { url: info.url, origin: new URL(info.url).origin, accessTeam: null, partition, team: false };
  }

  // Key presses and clicks on the hub page: a connect window opens only right after one.
  const GESTURES = new Set(['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'gestureTap', 'touchStart']);

  function makeHubView(h) {
    const hubSes = session.fromPartition(h.partition);
    hardenSession(hubSes);
    // The board web names a connect window with the bind only when it sees this token.
    hubSes.setUserAgent(appUserAgent(hubSes.getUserAgent(), app.getVersion()));
    const view = new WebContentsView({
      webPreferences: { partition: h.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: true },
    });
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1a1f' : '#eceaf0');
    const wc = view.webContents;
    if (h.client) clientDownloads.set(hubSes, (url, sender, gesture) => {
      const current = () => !!win && view === hubView && content === view && hubInfo?.client && hubInfo.origin === h.origin && signedIn(h.origin);
      if (!gesture || sender !== wc || !current()) return;
      const save = clientArtifactTarget(url, h.origin) ? saveClientArtifact : clientExportTarget(url, h.origin) ? saveClientExport : null;
      if (!save) return;
      save({ url, origin: h.origin, tokenFor, current, choose: (opts) => dialog.showSaveDialog(opts) }).then((r) => {
        if (r.signedOut) flow.checkSignedIn(h.origin).catch(() => {});
      }).catch((e) => log('client deliverable save failed', e.message));
    });
    const decide = (url) => navDecision(url, { hubOrigin: h.origin, accessTeam: h.accessTeam });
    let gestureAt = 0;
    wc.on('input-event', (_e, ev) => { if (GESTURES.has(ev.type)) gestureAt = Date.now(); });
    wc.setWindowOpenHandler(({ url, frameName, referrer, postBody }) => {
      const d = openDecision({ url, frameName }, { hubOrigin: h.origin, accessTeam: h.accessTeam });
      if (d === 'connect') {
        // A form POST (GitHub's App manifest) is judged here too; only its fixed reason is ever logged.
        const c = connectDecision({ url, frameName, referrer: referrer?.url ?? '', postBody, pageUrl: wc.getURL(), hubOrigin: h.origin, signedIn: !!h.bearer && signedIn(h.origin) && hubInfo?.origin === h.origin, gestureAt });
        // One click, one window: a second open needs a second gesture.
        gestureAt = 0;
        if (c.ok) openConnect(url, h, c).catch((e) => log('connect window failed', e.message));
        else log('connect window refused', c.reason);
      } else if (d === 'external') shell.openExternal(url); // privacy-flow: open-link-in-browser
      return { action: 'deny' };
    });
    const guard = (e, url) => {
      const d = decide(url);
      if (d === 'allow') return;
      e.preventDefault();
      if (d === 'external') shell.openExternal(url); // privacy-flow: open-link-in-browser
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('will-frame-navigate', (e) => { if (!e.isMainFrame && decide(e.url) !== 'allow') e.preventDefault(); });
    wc.on('will-attach-webview', (e) => e.preventDefault());
    // The web's own view switcher changes ?view= in place; keep the sidebar in step.
    wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain && isHubPage(selected) && view === hubView) { selected = pageForHubUrl(url); pushState(); } });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3 || view !== hubView) return; // -3: aborted by our own navigation
      log('hub page failed to load', { code, desc });
      // The page failed, not necessarily the hub: a retry reloads the page.
      viewError = `Could not load the board (${desc}).`;
      if (isHubPage(selected)) showInfo(pageById(selected));
      pushState();
    });
    wc.on('render-process-gone', (_e, d) => {
      if (view !== hubView) return;
      log('hub page crashed', d.reason);
      if (content === hubView) content = null;
      dispose(hubView, win);
      hubView = null;
      if (win && isHubPage(selected)) select(selected);
    });
    return view;
  }

  // The Integrations page's provider sign-in (GitHub, Slack…), in an app
  // window on its own per-hub partition: never the hub's, so the bearer
  // header can't reach a provider, and the provider's cookies stay out of the
  // board and go when that hub signs out.
  // A fresh BrowserWindow, never the page's own window.open: it has no opener
  // and an empty window.name, so the bind in the name never reaches the provider.
  let connectWin = null;
  let connectOpening = false;
  async function openConnect(url, h, { provider, bind, post = null }) {
    // One at a time: swapping windows would let the old one's close handler remove the new bind cookie.
    if (connectWin && !connectWin.isDestroyed()) { connectWin.focus(); log('connect window refused', 'already open'); return; }
    if (connectOpening) return;
    connectOpening = true;
    let ses, cookie, current;
    try {
      ses = session.fromPartition(integrationPartitionFor(h.origin));
      hardenSession(ses);
      cookie = bindCookie(h.origin, provider, bind);
      // A sign-out or switch while the cookie was being set: it is removed again and nothing opens.
      current = await connectLife.setBindCookie(ses, integrationPartitionFor(h.origin), cookie);
    } finally { connectOpening = false; }
    if (!current) { log('connect window refused', 'signed out or switched while opening'); return; }
    const authorizeHost = new URL(post?.url ?? url).host;
    const w = new BrowserWindow({
      width: 560, height: 720, title: BRAND.CONNECT_TITLE, autoHideMenuBar: true, backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1a1f' : '#ffffff',
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
    });
    w.hubOrigin = h.origin;
    connectWin = w;
    let expired = false;
    connectLife.arm(w, () => { expired = true; log('connect window closed: 10 minutes passed'); });
    const wc = w.webContents;
    // The first page must be the authorize host the hub named; later hops are the provider's own.
    let first = true;
    wc.on('did-start-navigation', (d) => {
      if (!d.isMainFrame || !first) return;
      first = false;
      let host = null;
      try { host = new URL(d.url).host; } catch { /* refused below */ }
      if (host !== authorizeHost) { log('connect window closed: first page not the authorize host'); wc.stop(); w.close(); }
    });
    // A provider page could otherwise open any address in the system browser, unasked.
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Provider logins hop between public https hosts freely; the callback is on the hub.
    const guard = (e, u) => { if (!connectNavOk(u, w.hubOrigin)) e.preventDefault(); };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('will-attach-webview', (e) => e.preventDefault());
    // The title names the site on screen, so a person can see who is asking for their password.
    w.on('page-title-updated', (e) => e.preventDefault());
    wc.on('did-navigate', (_e, u) => { try { if (!w.isDestroyed()) w.setTitle(`${BRAND.CONNECT_TITLE} · ${new URL(u).host}`); } catch { /* not a URL */ } });
    let closing = false;
    wc.on('did-finish-load', () => {
      if (closing || !isConnectCallback(wc.getURL(), w.hubOrigin)) return;
      closing = true;
      // Long enough to read "Connected" (or the error) on the callback page.
      setTimeout(() => {
        if (!w.isDestroyed()) w.close();
        if (selected === 'integrations' && hubInfo?.origin === w.hubOrigin && hubView && !hubView.webContents.isDestroyed()) {
          hubView.webContents.loadURL(hubPageUrl(hubInfo.url, pageById('integrations'), { org: hubInfo.org })).catch(() => {}); // privacy-flow: team-hub-account
        }
      }, 1500);
    });
    w.on('closed', () => {
      if (connectWin === w) connectWin = null;
      // The hub's callback clears it too; a window closed early must not leave it behind.
      ses.cookies.remove(cookie.url, cookie.name).catch(() => {}); // privacy-flow: integration-connect
      // A sign-in left open that long is abandoned: drop what the provider stored too.
      if (expired) connectLife.clearing(integrationPartitionFor(w.hubOrigin), () => ses.clearStorageData()).catch(() => {});
    });
    // The manifest POST is this window's first and only POST from us: connectDecision rebuilt its URL and body.
    (post ? w.loadURL(post.url, { postData: post.postData, extraHeaders: post.extraHeaders }) : w.loadURL(url)).catch(() => {}); // privacy-flow: integration-connect
  }

  async function showHubPage(page) {
    if (!win || !page) return;
    const myGen = gen;
    if (!hubInfo) {
      if (hubStatus.state !== 'ready' || getTeamHub()) showInfo(page);
      if (!hubLoading) { const p = resolveHub().finally(() => { if (hubLoading === p) hubLoading = null; }); hubLoading = p; }
      try {
        const h = await hubLoading;
        if (myGen !== gen) return undefined; // the newer caller (switch/connect) owns the load
        // A hub that restarted while we set its cookie has a new URL: start
        // over against the new one rather than adopt a dead one. (hubLoading
        // is already cleared here; the crash budget bounds the loop.)
        if (!h.team && supervisor.status().url !== h.url) return showHubPage(page);
        if (!hubInfo) hubInfo = h;
      } catch (e) {
        log('board unavailable', e.message);
        // The hub may be fine (e.g. the cookie could not be set): offer Retry.
        if (hubStatus.state === 'ready') viewError = `Could not open the board (${e.message}).`;
        if (win && selected === page.id) showInfo(page);
        pushState();
        return;
      }
    }
    if (!win || selected !== page.id || !hubInfo) return;
    if (!hubView) hubView = makeHubView(hubInfo);
    const view = hubView;
    const url = hubPageUrl(hubInfo.url, page, { org: hubInfo.org });
    const cur = view.webContents.getURL();
    if (!cur || !cur.startsWith(hubInfo.origin) || pageForHubUrl(cur) !== page.id || (orgOfUrl(cur) ?? null) !== (hubInfo.org ?? null)) {
      viewError = null;
      await view.webContents.loadURL(url).catch(() => {}); // privacy-flow: team-hub-account
    }
    if (win && selected === page.id && view === hubView && !viewError) attach(view);
  }

  // ── selection ───────────────────────────────────────────────────────────

  function select(id) {
    const page = pageById(id);
    if (!page) return;
    if (page.kind === 'window') { openWindow(page.window); return; }
    setupLocalGeneration++;
    if (page.localScreen && !getTeamHub()) { flow.show(page.localScreen); return; }
    if (page.kind === 'local' && page.screen) { flow.show(page.screen); return; }
    flow.leftAccountPages();
    if (page.kind === 'hub' && hubInfo?.client) forgetHub();
    selected = id;
    pushState();
    if (page.kind === 'hub') showHubPage(page);
    else if (page.kind === 'local' && page.file) showLocal(page);
    else showInfo(page);
  }

  const fromSidebar = (e) => sidebar && e.sender === sidebar.webContents && isLocalPage(e.senderFrame?.url ?? '');
  const fromInfo = (e) => infoView && e.sender === infoView.webContents && isLocalPage(e.senderFrame?.url ?? '');
  const fromAccount = (e) => accountView && e.sender === accountView.webContents && isLocalPage(e.senderFrame?.url ?? '');

  function onSelect(e, id) {
    if (!fromSidebar(e)) return;
    if (typeof id !== 'string' || !pageById(id)) return;
    select(id);
  }

  function onRetry(e) {
    if (!fromSidebar(e) && !fromInfo(e)) return;
    if (viewError) {
      // Page-level failure: reload the page; the hub is left alone.
      viewError = null;
      if (hubView) { if (content === hubView) content = null; dispose(hubView, win); hubView = null; }
      select(isHubPage(selected) ? selected : 'board');
      return;
    }
    if (hubStatus.state !== 'failed') return;
    forgetHub();
    supervisor.retry().catch(() => {});
  }

  // ── workspaces ──────────────────────────────────────────────────────────

  function switchWorkspace(id, { show = true } = {}) {
    const prev = store.active();
    if (!id || !store.setActive(id)) return;
    connectLife.bump();
    const next = store.active();
    // Another team on the same hub is the same page with a different ?org=.
    if (hubInfo?.bearer && prev.kind === 'team' && next.kind === 'team' && prev.hub === next.hub) { hubInfo.org = next.teamId; viewError = null; } else forgetHub();
    if (show) select('board'); else pushState();
  }

  async function onSignOut(e, id) {
    if (!fromSidebar(e)) return;
    const ws = store.get(id);
    if (!ws || ws.kind !== 'access') return;
    // Signing out = forgetting this hub's cookies and storage; the next visit signs in again.
    forgetHub(); // close the live page first so it can't write anything back
    const ses = session.fromPartition(teamPartition(ws.url));
    await Promise.allSettled([ses.clearStorageData(), ses.clearCache(), ses.clearAuthCache()]);
    store.removeAccess(id);
    select('board');
  }

  // The three account flows are not pages: open('signin') (tray, Settings, the widget) must start
  // the flow the same way the sidebar's workspace switcher does, not just show the window.
  const FLOW_IDS = ['signin', 'join', 'create-team'];
  const goTo = (id) => (FLOW_IDS.includes(id) ? flow.startFlow(id) : select(id));

  ipcMain.on('buddy:workspace', (e, id) => {
    if (!fromSidebar(e) || typeof id !== 'string') return;
    if (FLOW_IDS.includes(id)) flow.startFlow(id); else switchWorkspace(id);
  });
  ipcMain.on('buddy:signout', onSignOut);
  ipcMain.on('buddy:select', onSelect);
  ipcMain.on('buddy:retry', onRetry);
  ipcMain.handle('buddy:pages', (e) => (fromSidebar(e) ? { pages: PAGES, groups: GROUPS, brand: { name: BRAND.NAME, hubText: BRAND.HUB_TEXT } } : null));
  for (const [op, fn] of Object.entries(flow.ACCT)) {
    ipcMain.handle(`buddy:acct:${op}`, async (e, ...args) => {
      if (!fromAccount(e)) return { ok: false, error: 'Not allowed.' };
      const types = ACCT_ARGS[op];
      if (args.length !== types.length || args.some((a, i) => typeof a !== types[i] || (typeof a === 'string' && a.length > 2048))) return { ok: false, error: 'Not allowed.' };
      try {
        const result = await fn(...args);
        return op === 'state' && result?.screen === 'thismac' ? { ...result, workCapture: { enabled: captureEnabled && workCapture.enabled(), notice: workCapture.notice(), tasks: workCapture.snapshot().slice(-100), choices: workCapture.choices() } } : result;
      } catch (err) { log('account action failed', op, err.message); return { ok: false, error: 'Something went wrong. Try again.' }; }
    });
  }
  ipcMain.handle('buddy:acct:captureEnabled', (e, on) => {
    if (!fromAccount(e) || typeof on !== 'boolean' || !captureEnabled) return { ok: false, error: 'Not allowed.' };
    return workCapture.setEnabled(on) ? { ok: true } : { ok: false, error: workCapture.notice() || 'Could not save automatic card settings.' };
  });
  ipcMain.handle('buddy:acct:captureDefault', async (e, repo, key) => {
    if (!fromAccount(e) || typeof repo !== 'string' || typeof key !== 'string' || !captureEnabled) return { ok: false, error: 'Not allowed.' };
    try { return await workCapture.choose(repo, key) ? { ok: true } : { ok: false, error: 'That board is no longer available. Try again.' }; }
    catch { return { ok: false, error: 'Could not check your team boards. Try again.' }; }
  });

  /**
   * Open a hub page with a URL fragment the page reads itself (the feedback sender hands its saved,
   * scrubbed report over this way: no new IPC or preload into the hub view). Hub pages only, the
   * fragment shape is checked, the URL is always the current team hub's own origin, and without a
   * team hub nothing opens at all. A fragment-only change fires `hashchange` in the page.
   */
  async function openWithFragment(pageId, fragment) {
    const page = pageById(pageId);
    if (!page || page.kind !== 'hub' || !fragmentOk(fragment)) return { ok: false, why: 'invalid' };
    if (!getTeamHub()) return { ok: false, why: 'no-team' };
    open(pageId);
    await showHubPage(page);
    if (!win || selected !== page.id || !hubInfo || !hubView || !hubInfo.team) return { ok: false, why: 'unavailable' };
    const view = hubView;
    const url = hubPageUrl(hubInfo.url, page, { org: hubInfo.org, fragment });
    if (new URL(url).origin !== hubInfo.origin) return { ok: false, why: 'unavailable' };
    await view.webContents.loadURL(url).catch(() => {}); // privacy-flow: team-hub-account
    if (win && view === hubView && !viewError) attach(view);
    return { ok: true };
  }

  function open(pageId = null) {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (pageId) goTo(pageId);
      return;
    }
    win = new BaseWindow({
      width: 1320, height: 860, minWidth: 760, minHeight: 520,
      title: BRAND.WINDOW_TITLE,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 16, y: 18 },
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1a1f' : '#eceaf0',
      show: false,
    });
    sidebar = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(DIR, 'sidebar-preload.js') } });
    lockLocal(sidebar);
    win.contentView.addChildView(sidebar);
    sidebar.webContents.loadFile(path.join(DIR, 'sidebar.html')).catch(() => {});
    sidebar.webContents.once('did-finish-load', () => { pushState(); win?.show(); });
    win.on('resize', layout);
    win.on('blur',()=>{if(!setupModalTicket)setupLocalGeneration++;});
    win.on('closed', () => {
      setupLocalGeneration++;
      // Close every page: detached views otherwise keep running (and the board
      // page keeps its socket). The hub keeps running while the app runs, so
      // reopening is instant; it stops with the app.
      for (const v of [sidebar, infoView, hubView, accountView, ...localViews.values()]) dispose(v, null);
      localViews.clear();
      win = null; sidebar = null; content = null; hubView = null; infoView = null; accountView = null;
      onClosed();
    });
    layout();
    if (!pageId && selected.startsWith('flow:')) showScreen(selected.slice(5)); else goTo(pageId ?? selected);
    // Keep each signed-in hub's team list current (added to a team elsewhere).
    for (const h of store.hubs()) if (signedIn(h)) flow.refreshAccount(h).catch(() => {});
  }

  return {
    open,
    myDay: () => myDayBroker.snapshot(),
    setupSources,
    // Main-only identities. No renderer receives a sealed marker or window.
    setupsActorCurrent(actor) {
      return !!actor && setupCurrentSources.some(s=>s.current() && s.userId===actor.account && s.teamId===actor.team && s.memberId===actor.member && s.deviceId===actor.device);
    },
    setupsContext() {
      const v=localViews.get('setups'),wc=v?.webContents;
      if(!win || win.isDestroyed() || !wc || wc.isDestroyed() || selected!=='setups' || content!==v || !win.isVisible() || win.isMinimized())return null;
      const expected=pathToFileURL(path.join(DIR,'..','setups.html')).href;
      if(wc.getURL()!==expected || wc.mainFrame?.url!==expected || wc.isLoading())return null;
      return {window:win,contents:wc,generation:setupLocalGeneration,foreground:win.isFocused()};
    },
    async setupsConfirm(show) {
      const before=this.setupsContext();
      if(typeof show!=='function' || !before?.foreground || setupModalTicket)return null;
      const ticket={window:before.window,contents:before.contents,generation:before.generation};setupModalTicket=ticket;
      try {
        const answer=await show(before.window);
        const after=this.setupsContext();
        if(setupModalTicket!==ticket || !after?.foreground || after.window!==ticket.window || after.contents!==ticket.contents || after.generation!==ticket.generation)return null;
        return answer;
      }finally{if(setupModalTicket===ticket)setupModalTicket=null;}
    },
    onSetupsIdentityChange(listener) {if(typeof listener!=='function')return ()=>{};setupIdentityListeners.add(listener);return ()=>setupIdentityListeners.delete(listener);},
    openMyDayCard: handle => myDayBroker.open(handle),
    // Account client stays in main. The broker checks the sealed grant's
    // owner on every request and never sends this object to a renderer.
    nativeBoardContext(workspaceId) {
      const workspace = store.get(workspaceId);
      if (!workspace || workspace.kind !== 'team' || !signedIn(workspace.hub)) return null;
      const userId = userOf(workspace.hub)?.id;
      return typeof userId === 'string' && userId ? { workspace, userId, client: clientFor(workspace.hub) } : null;
    },
    nativeBoardWorkspaces: () => store.list().filter((w) => w.kind === 'team').map((w) => ({ id: w.id, name: w.name })),
    openWithFragment,
    isOpen: () => !!win,
    isVisible: () => !!win && !win.isDestroyed() && win.isVisible(),
    select,
    openInvite: (link) => flow.openInvite(link),
    /** App start: runners the member left on come back without opening the window. */
    resumeDevices: () => flow.resumeDevices(),
    /** Subscribe to validated runner events (`run.budget_reached`); returns the unsubscribe function. */
    onRunnerEvent(cb) { if (typeof cb !== 'function') return () => {}; runnerListeners.add(cb); return () => runnerListeners.delete(cb); },
    /** The widget's live sessions changed: hubs sharing presence get the new list. */
    sessionsChanged(sessions) { flow.sessionsChanged(sessions); if (captureEnabled) void workCapture.observe(sessions); },
    async stop() {
      const url = localUrl();
      await workCapture.stop();
      await Promise.all([supervisor.stop({ final: true }), flow.stopDevices()]);
      // The secret dies with this hub; don't leave it in the cookie store.
      if (url) await session.fromPartition(partitionFor()).cookies.remove(url, 'board_local').catch(() => {}); // privacy-flow: local-board-hub
    },
    status: () => ({ selected, hub: hubStatus, viewError, workspace: store.active().id, screen: flow.acct.screen, url: content === hubView ? (hubView?.webContents.getURL() ?? null) : null }),
    // Dev only (main.js gates it on !app.isPackaged): the hub-address step without the form.
    devConnect: (url) => flow.ACCT.hub(url),
    // Dev only: the sidebar's "Join with an invite…" / "Sign in…" menu items.
    devStartFlow: (which) => flow.startFlow(which),
    // Dev only: take the system browser's part in a provider sign-in.
    devBrowser: (fn) => { devBrowser = fn; },
    // Dev only: drive the account page as a person would (fills and clicks in the page).
    devPage: (js) => (content === accountView && accountView ? accountView.webContents.executeJavaScript(js) : Promise.resolve(null)),
    // A local page's webContents, for main's sender checks (null if not open).
    pageWebContents: (id) => localViews.get(id)?.webContents ?? null,
    // Fixed page ids from main only; queued callbacks never jump to a replacement renderer.
    sendToPage(id, channel, ...args) {
      const wc = localViews.get(id)?.webContents;
      if (!wc || wc.isDestroyed()) return false;
      const send = () => { if (!wc.isDestroyed() && localViews.get(id)?.webContents === wc) wc.send(channel, ...args); };
      if (wc.isLoading()) wc.once('did-finish-load', send); else send();
      return true;
    },
    // Dev hook: capture what's on screen.
    async capture() {
      if (!win) return null;
      const [side, main] = await Promise.all([sidebar.webContents.capturePage(), content?.webContents.capturePage()]);
      return { sidebar: side, content: main ?? null };
    },
  };
}

module.exports = { createBuddyWindow, SIDEBAR_W };
