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
const { BaseWindow, BrowserWindow, WebContentsView, ipcMain, session, shell, utilityProcess, app, nativeTheme, net, safeStorage } = require('electron');
const { PAGES, GROUPS, pageById, hubPageUrl, navDecision, openDecision, isConnectCallback, pageForHubUrl, orgOfUrl } = require('./pages');
const { createHubSupervisor } = require('./hub-process');
const { createWorkspaceStore, normalizeHubUrl, accessTeamFromLocation, partitionFor: teamPartition, hostOf } = require('./workspaces');
const { createAccountClient, parseInvite, routeInvite, maskEmail, bearerScope } = require('./accounts');
const { createDeviceController, defaultDeviceName } = require('./device');

const SIDEBAR_W = 216;
const DIR = __dirname;
const LOCAL_PAGES = new Set(['sidebar.html', 'info.html', 'account.html'].map((f) => pathToFileURL(path.join(DIR, f)).href));
// Account-page screens the page itself may ask for; the rest are reached
// only through main's own flow (e.g. `confirm` after an invite link).
const PAGE_SCREENS = new Set(['hub', 'email', 'create-team', 'join', 'team', 'thismac', 'account', 'invites']);
const fileKey = (origin) => hostOf(origin).replace(/[^a-z0-9.-]/gi, '_');
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
function hardenSession(ses) {
  if (hardened.has(ses)) return;
  hardened.add(ses);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
}

function dispose(view, win) {
  if (!view) return;
  try { win?.contentView.removeChildView(view); } catch { /* not attached */ }
  // A detached WebContentsView keeps its page (and its sockets) alive until closed.
  try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch { /* already gone */ }
}

/**
 * Is `origin` a Buddy team hub, and where does it send people to sign in?
 * Asks from the hub's own partition without following redirects: a hub behind
 * Cloudflare Access answers 302 to <team>.cloudflareaccess.com (or 200 when
 * this app is already signed in); a bare hub answers /api/health itself.
 */
function probeHub(origin, partition) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const req = net.request({ url: `${origin}/api/health`, session: session.fromPartition(partition), redirect: 'manual', useSessionCookies: true });
    const timer = setTimeout(() => { try { req.abort(); } catch { /* done */ } finish({ ok: false, error: 'The hub did not answer in 10 seconds.' }); }, 10_000);
    req.on('redirect', (_status, _method, location) => {
      try { req.abort(); } catch { /* done */ }
      const team = accessTeamFromLocation(location);
      finish(team ? { ok: true, accessTeam: team, signedIn: false } : { ok: false, error: 'That address redirects somewhere that isn’t a Buddy sign-in.' });
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d) => { if (body.length < 4096) body += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (res.statusCode === 200 && j.ok && j.protocol) return finish({ ok: true, accessTeam: null, signedIn: true, auth: j.auth });
        } catch { /* not JSON */ }
        finish({ ok: false, error: 'That address answered, but it isn’t a Buddy team hub.' });
      });
    });
    req.on('error', (e) => finish({ ok: false, error: `Couldn’t reach it (${e.message}).` }));
    req.end();
  });
}

function createBuddyWindow({ openWindow = () => {}, onClosed = () => {}, log = (...a) => console.log('[buddy-window]', ...a), isDev = !app.isPackaged, devAccountsHub = null } = {}) {
  // The dev-only mock accounts hub runs on loopback; that one exact origin is
  // the only non-https hub ever accepted.
  const allowOrigins = devAccountsHub && isDev ? [devAccountsHub] : [];
  const norm = (u) => normalizeHubUrl(u, { allowOrigins });
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

  const store = createWorkspaceStore(path.join(userData, 'buddy-workspaces.json'), { allowOrigins, signedIn });
  const getTeamHub = () => { const w = store.active(); return w.kind === 'local' ? null : w; };

  const clients = new Map();
  function clientFor(origin) {
    let c = clients.get(origin);
    if (!c) {
      c = createAccountClient({ origin, store: vault(origin), onSignedOut: () => signedOutOf(origin, { tell: true }) });
      clients.set(origin, c);
    }
    return c;
  }
  const accounts = new Map(); // origin → last GET /api/account (teams, pending_invites)
  async function refreshAccount(origin) {
    const r = await clientFor(origin).me();
    if (r.ok) { accounts.set(origin, r); store.setTeams(origin, r); pushState(); }
    return r;
  }

  let win = null;
  let sidebar = null;
  let content = null; // the view currently attached on the right
  let hubView = null;
  let infoView = null;
  let accountView = null;
  let selected = 'board';
  let hubStatus = { state: 'stopped' };
  let hubInfo = null; // {url, origin, accessTeam, partition, team, bearer, org}
  let viewError = null; // the hub is fine but its page failed to load
  let hubLoading = null;

  // The account flow in progress: which hub it is about, a note for the
  // next screen, and an invite waiting on sign-in. Memory only.
  const acct = { screen: null, hub: null, notice: null, deleting: false };
  let pendingInvite = null; // {hub|null, token}
  // A hub named by an invite link must be confirmed by the member before any
  // email goes to it; a hub they typed themselves counts as confirmed.
  let trustedHub = null;

  // Local hub, started lazily the first time a board page opens.
  const mode = process.env.BUDDY_BOARD_AUTH === 'dev' && isDev ? 'dev' : 'local';
  const localUrl = () => (hubInfo && !hubInfo.team ? hubInfo.url : null);
  const supervisor = createHubSupervisor({
    fork: (entry, args, opts) => utilityProcess.fork(entry, args, opts),
    hubEntry: path.join(app.getAppPath(), 'board', 'hub', 'server.js'),
    dataDir: path.join(userData, mode === 'dev' ? 'board-dev' : 'board'),
    mode,
    isPackaged: !isDev,
    log: (...a) => log('[hub]', ...a),
    onStatus,
  });

  const isHubPage = (id) => pageById(id)?.kind === 'hub';

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
    hubLoading = null; // a resolve for the old hub must not be awaited by the new one
    const old = localUrl();
    hubInfo = null;
    viewError = null;
    if (hubView) { if (content === hubView) content = null; dispose(hubView, win); hubView = null; }
    if (old) session.fromPartition(partitionFor()).cookies.remove(old, 'board_local').catch(() => {});
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
    if (!sidebar || sidebar.webContents.isDestroyed()) return;
    const team = getTeamHub();
    sidebar.webContents.send('buddy:state', {
      selected,
      workspaces: store.list().map(({ id, name, kind, group }) => ({ id, name, kind, group: group ?? null })),
      active: store.active().id,
      signedIn: store.hubs().some(signedIn),
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
      blurb: hub ? (failed ? (viewError ?? hubStatus.error ?? 'The board could not start.') : team ? `Opening ${team.name}…` : 'Starting the board…') : (page.blurb ?? ''),
      ...extra,
    };
    infoView.webContents.loadFile(path.join(DIR, 'info.html'), { query }).catch(() => {});
    attach(infoView);
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

  function showAccount(screen, { notice = null } = {}) {
    if (!win) { acct.screen = screen; acct.notice = notice; selected = `flow:${screen}`; return; }
    acct.screen = screen;
    acct.notice = notice;
    const page = PAGES.find((p) => p.screen === screen);
    selected = page ? page.id : `flow:${screen}`;
    pushState();
    if (!accountView) {
      accountView = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(DIR, 'account-preload.js') } });
      accountView.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1a1f' : '#eceaf0');
      lockLocal(accountView);
    }
    accountView.webContents.loadFile(path.join(DIR, 'account.html'), { query: { screen } }).catch(() => {});
    attach(accountView);
  }

  // A signed-out hub loses its teams from the switcher; its token is gone.
  function signedOutOf(origin, { tell = false } = {}) {
    const wasActive = store.active().hub === origin;
    accounts.delete(origin);
    store.forgetTeams(origin);
    if (hubInfo?.origin === origin) forgetHub();
    pushState();
    if (tell && wasActive && win) { acct.hub = origin; showAccount('email', { notice: 'You’ve been signed out. Sign in again to open your team.' }); } else if (wasActive && win && isHubPage(selected)) select('board');
  }

  // After any sign-in: an invite waiting on it, else invites addressed to
  // this email, else the team board, else "create a team".
  async function afterSignIn(origin) {
    store.addHub(origin);
    trustedHub = null;
    const r = await refreshAccount(origin);
    if (pendingInvite && (pendingInvite.hub ?? origin) === origin) { pendingInvite.hub = origin; showAccount('join'); return; }
    if (r.ok && r.pending_invites?.length) { acct.hub = origin; showAccount('invites'); return; }
    const first = store.list().find((w) => w.kind === 'team' && w.hub === origin);
    if (first) { switchWorkspace(first.id); return; }
    acct.hub = origin;
    showAccount('create-team');
  }

  function routePending() {
    const r = routeInvite(pendingInvite, { knownHubs: store.hubs(), signedIn, lastHub: store.lastHub() });
    if (r.action === 'need-hub') { acct.hub = null; showAccount('hub'); return r; }
    pendingInvite.hub = r.hub;
    acct.hub = r.hub;
    if (r.action === 'confirm') showAccount('confirm');
    else if (r.action === 'signin') { trustedHub = r.hub; showAccount('email'); } else showAccount('join');
    return r;
  }

  /** A deep link or universal link. Anything that isn't a valid invite is dropped without a word. */
  function openInvite(link) {
    const inv = parseInvite(link, { normalizeHub: norm });
    if (!inv) { log('ignored a link that is not a valid invite'); return false; }
    pendingInvite = inv;
    routePending();
    return true;
  }

  const activeTeam = () => { const w = store.active(); return w.kind === 'team' ? w : null; };
  // A bare host reads back as https; anything else (the dev mock) needs its scheme.
  const prefill = (origin) => (!origin ? '' : origin.startsWith('https://') ? hostOf(origin) : origin);
  const hubByHost = (host) => store.hubs().find((h) => hostOf(h) === host) ?? null;

  // ── this Mac as a runner, per team ──────────────────────────────────────

  const devices = new Map(); // workspace id → controller
  let lastSessions = [];
  function deviceFor(ws) {
    let d = devices.get(ws.id);
    if (d) return d;
    const key = `${fileKey(ws.hub)}-${ws.teamId}`;
    fs.mkdirSync(DEVICES_DIR, { recursive: true, mode: 0o700 });
    d = createDeviceController({
      account: clientFor(ws.hub), teamId: ws.teamId,
      credsFile: path.join(DEVICES_DIR, `${key}.bin`),
      seal: (str) => safeStorage.encryptString(str), unseal: (b) => safeStorage.decryptString(b),
      fork: (entry, args, opts) => utilityProcess.fork(entry, args, opts),
      runnerEntry: path.join(app.getAppPath(), 'board', 'runner', 'app-entry.js'),
      dataDir: path.join(userData, 'runner', key),
      log: (...a) => log('[runner]', ...a),
      onStatus: () => { if (acct.screen === 'thismac' && content === accountView) accountView?.webContents.send('buddy:acct:changed'); },
    });
    d.setPresence(store.sharesPresence(ws.hub), lastSessions);
    devices.set(ws.id, d);
    return d;
  }
  const deviceFileExists = (ws) => fs.existsSync(path.join(DEVICES_DIR, `${fileKey(ws.hub)}-${ws.teamId}.bin`));

  // ── account page actions (IPC) ─────────────────────────────────────────

  async function screenState() {
    const screen = acct.screen;
    const base = { ok: true, screen, notice: acct.notice, host: acct.hub ? hostOf(acct.hub) : null, lastHub: prefill(store.lastHub()), signedInHubs: store.hubs().filter(signedIn).map(hostOf) };
    acct.notice = null;
    if (screen === 'hub') return { ...base, forInvite: !!pendingInvite };
    if (screen === 'email') return { ...base, forInvite: !!pendingInvite, email: acct.hub ? (vault(acct.hub).load()?.user?.email ?? '') : '' };
    if (screen === 'code') return { ...base, email: acct.hub ? clientFor(acct.hub).pendingEmail() : null };
    if (screen === 'create-team') {
      const hub = acct.hub && signedIn(acct.hub) ? acct.hub : (activeTeam()?.hub ?? store.hubs().find(signedIn) ?? null);
      acct.hub = hub;
      return { ...base, host: hub ? hostOf(hub) : null };
    }
    if (screen === 'invites') return { ...base, invites: (accounts.get(acct.hub)?.pending_invites ?? []).map((i) => ({ id: String(i.id), team: String(i.team_name ?? ''), inviter: String(i.inviter_name ?? ''), role: String(i.role ?? '') })) };
    if (screen === 'join') {
      if (!pendingInvite?.hub) return { ...base, invite: null };
      const pv = await clientFor(pendingInvite.hub).previewInvite(pendingInvite.token);
      if (!pv.ok) { pendingInvite = null; return { ...base, invite: null, error: pv.error }; }
      const email = vault(pendingInvite.hub).load()?.user?.email ?? null;
      return { ...base, host: hostOf(pendingInvite.hub), email, invite: { team: String(pv.team_name ?? ''), inviter: String(pv.inviter_name ?? ''), role: String(pv.role ?? '') } };
    }
    if (screen === 'team') {
      const ws = activeTeam();
      if (!ws) return { ...base, team: null, hasTeams: store.list().some((w) => w.kind === 'team') };
      const c = clientFor(ws.hub);
      const m = await c.listMembers(ws.teamId);
      const canManage = ['owner', 'admin'].includes(ws.role);
      const inv = canManage ? await c.listInvites(ws.teamId) : { ok: true, invites: [] };
      const members = (m.members ?? []).map((x) => ({ id: String(x.id), name: String(x.display_name ?? ''), email: String(x.email ?? ''), role: String(x.role), you: !!x.you }));
      return { ...base, host: hostOf(ws.hub), team: { name: ws.name, role: ws.role }, canManage, isOwner: ws.role === 'owner', members, invites: (inv.invites ?? []).map((i) => ({ id: String(i.id), email: String(i.email), role: String(i.role), expires: String(i.expires_at ?? '') })), error: m.ok ? (inv.ok ? null : inv.error) : m.error };
    }
    if (screen === 'account') {
      return { ...base, deleting: acct.deleting ? hostOf(acct.hub) : null, accounts: store.hubs().filter(signedIn).map((h) => { const u = vault(h).load()?.user ?? {}; return { host: hostOf(h), name: String(u.display_name ?? ''), email: String(u.email ?? '') }; }) };
    }
    if (screen === 'thismac') {
      const hubs = store.hubs().filter(signedIn).map((h) => ({
        host: hostOf(h),
        share: store.sharesPresence(h),
        teams: store.list().filter((w) => w.kind === 'team' && w.hub === h).map((w) => {
          const st = devices.has(w.id) || deviceFileExists(w) ? deviceFor(w).status() : { enrolled: false, enabled: false, runner: { state: 'off' }, parked: 0 };
          return { id: w.id, name: w.name, role: w.role, enabled: st.enabled, enrolled: st.enrolled, state: st.runner.state, detail: st.runner.detail, parked: st.parked };
        }),
      }));
      return { ...base, hubs };
    }
    if (screen === 'confirm') return base;
    return base;
  }

  const inviteGone = (r) => /^INVITE_/.test(r.code ?? '');

  const ACCT = {
    state: () => screenState(),
    go(screen) {
      if (!PAGE_SCREENS.has(screen)) return { ok: false };
      if (screen === 'hub' || screen === 'email') acct.deleting = false;
      if (screen === 'join' && !pendingInvite) acct.hub = null;
      showAccount(screen);
      return { ok: true };
    },
    async hub(input) {
      let origin;
      try { origin = norm(input); } catch (e) { return { ok: false, error: e.message }; }
      // An invite without a hub, and a hub we have never used: confirm it first.
      if (pendingInvite && !store.knows(origin)) { pendingInvite.hub = origin; acct.hub = origin; showAccount('confirm'); return { ok: true }; }
      return connectHub(origin);
    },
    async confirm(yes) {
      if (!yes || !acct.hub) { pendingInvite = null; acct.hub = null; select('board'); return { ok: true }; }
      trustedHub = acct.hub;
      if (pendingInvite) pendingInvite.hub = acct.hub;
      showAccount(signedIn(acct.hub) ? 'join' : 'email');
      return { ok: true };
    },
    async email(email) {
      const origin = acct.hub;
      if (!origin || (trustedHub !== origin && !store.knows(origin))) return { ok: false, error: 'Start again: enter the team hub address.' };
      const r = await clientFor(origin).startEmail(email);
      if (!r.ok) return r;
      showAccount('code');
      return { ok: true };
    },
    async code(code) {
      const origin = acct.hub;
      if (!origin) return { ok: false, error: 'Start again: enter the team hub address.' };
      const r = await clientFor(origin).verifyCode(code, { deviceName: defaultDeviceName(os.userInfo().username, os.hostname()), platform: process.platform });
      if (!r.ok) return r;
      log('signed in to team hub', { host: hostOf(origin) });
      await afterSignIn(origin);
      return { ok: true };
    },
    async resend() {
      const c = acct.hub && clientFor(acct.hub);
      const email = c?.pendingEmail();
      if (!email) return { ok: false, error: 'Start again: enter your email.' };
      const r = await c.startEmail(email);
      return r.ok ? { ok: true, notice: `We sent a new code to ${email}.` } : r;
    },
    async createTeam(name) {
      const origin = acct.hub;
      if (!origin || !signedIn(origin)) return { ok: false, error: 'Sign in to a team hub first.' };
      const r = await clientFor(origin).createTeam(name);
      if (!r.ok) return r;
      await refreshAccount(origin);
      switchWorkspace(store.list().find((w) => w.kind === 'team' && w.hub === origin && w.teamId === r.team.id)?.id, { show: false });
      showAccount('team', { notice: `${r.team.name} is ready. Invite your team.` });
      return { ok: true };
    },
    async invite(email, role) {
      const ws = activeTeam();
      if (!ws) return { ok: false, error: 'Pick a team first.' };
      const r = await clientFor(ws.hub).invite(ws.teamId, email, role);
      return r.ok ? { ok: true, notice: `Invite sent to ${r.invite?.email ?? email}.` } : r;
    },
    async resendInvite(id) {
      const ws = activeTeam();
      if (!ws) return { ok: false, error: 'Pick a team first.' };
      const c = clientFor(ws.hub);
      const list = await c.listInvites(ws.teamId);
      const inv = list.invites?.find((i) => String(i.id) === id);
      if (!inv) return { ok: false, error: 'That invite is gone.' };
      const r = await c.invite(ws.teamId, inv.email, inv.role);
      return r.ok ? { ok: true, notice: `Sent again to ${inv.email}.` } : r;
    },
    async revokeInvite(id) {
      const ws = activeTeam();
      return ws ? clientFor(ws.hub).revokeInvite(ws.teamId, id) : { ok: false, error: 'Pick a team first.' };
    },
    async setRole(memberId, role) {
      const ws = activeTeam();
      if (!ws) return { ok: false, error: 'Pick a team first.' };
      const r = await clientFor(ws.hub).setRole(ws.teamId, memberId, role);
      if (r.ok) await refreshAccount(ws.hub);
      return r;
    },
    async removeMember(memberId) {
      const ws = activeTeam();
      if (!ws) return { ok: false, error: 'Pick a team first.' };
      const r = await clientFor(ws.hub).removeMember(ws.teamId, memberId);
      if (r.ok) await refreshAccount(ws.hub);
      return r;
    },
    async joinCode(code) {
      const inv = parseInvite(code, { normalizeHub: norm });
      if (!inv) return { ok: false, error: 'That doesn’t look like an invite. Paste the whole link or code.' };
      pendingInvite = inv;
      routePending();
      return { ok: true };
    },
    async accept() {
      const inv = pendingInvite;
      if (!inv?.hub || !signedIn(inv.hub)) return { ok: false, error: 'Sign in first.' };
      const r = await clientFor(inv.hub).acceptInvite({ t: inv.token });
      return joined(inv.hub, r);
    },
    async acceptPending(id) {
      const origin = acct.hub;
      if (!origin || !signedIn(origin)) return { ok: false, error: 'Sign in first.' };
      return joined(origin, await clientFor(origin).acceptInvite({ inviteId: id }));
    },
    async switchAccount() {
      const origin = pendingInvite?.hub;
      if (!origin) return { ok: false };
      await clientFor(origin).signOut();
      signedOutOf(origin);
      trustedHub = origin;
      acct.hub = origin;
      showAccount('email');
      return { ok: true };
    },
    async skipInvites() {
      const origin = acct.hub;
      const first = origin && store.list().find((w) => w.kind === 'team' && w.hub === origin);
      if (first) switchWorkspace(first.id); else showAccount('create-team');
      return { ok: true };
    },
    async openTeam(wsId) {
      if (store.get(wsId)?.kind !== 'team') return { ok: false };
      pendingInvite = null;
      switchWorkspace(wsId);
      return { ok: true };
    },
    async signOut(host) {
      const origin = hubByHost(host);
      if (!origin) return { ok: false };
      for (const w of store.list()) if (w.kind === 'team' && w.hub === origin && devices.has(w.id)) await devices.get(w.id).remove();
      await clientFor(origin).signOut();
      signedOutOf(origin);
      showAccount('account', { notice: `Signed out of ${host}.` });
      return { ok: true };
    },
    async deleteStart(host) {
      const origin = hubByHost(host);
      if (!origin) return { ok: false };
      const r = await clientFor(origin).startStepUp();
      if (!r.ok) return r;
      acct.hub = origin;
      acct.deleting = true;
      return { ok: true, email: r.email };
    },
    async deleteConfirm(code) {
      const origin = acct.hub;
      if (!origin || !acct.deleting) return { ok: false, error: 'Ask for a new code first.' };
      const r = await clientFor(origin).deleteAccount(code);
      if (!r.ok) return r.code === 'LAST_OWNER' ? { ok: false, error: `You’re the only owner of ${r.detail?.team ?? 'a team'}. Make someone else an owner first.` } : r;
      acct.deleting = false;
      for (const w of [...devices.keys()]) if (w.startsWith(`team:${hostOf(origin)}:`)) { await devices.get(w).stop(); devices.delete(w); }
      signedOutOf(origin);
      showAccount('account', { notice: 'Your account was deleted.' });
      return { ok: true };
    },
    async cancelDelete() { acct.deleting = false; return { ok: true }; },
    async runner(wsId, on) {
      const ws = store.get(wsId);
      if (ws?.kind !== 'team') return { ok: false };
      const d = deviceFor(ws);
      if (on && !d.status().enrolled) return d.enroll({ name: defaultDeviceName(os.userInfo().username, os.hostname()) });
      return d.setEnabled(on);
    },
    async presence(host, on) {
      const origin = hubByHost(host);
      if (!origin || !store.setSharesPresence(origin, on)) return { ok: false };
      for (const [id, d] of devices) if (id.startsWith(`team:${hostOf(origin)}:`)) d.setPresence(on, lastSessions);
      return { ok: true };
    },
  };
  // Argument types per action; anything else is refused before it runs.
  const ACCT_ARGS = {
    state: [], go: ['string'], hub: ['string'], confirm: ['boolean'], email: ['string'], code: ['string'], resend: [], createTeam: ['string'],
    invite: ['string', 'string'], resendInvite: ['string'], revokeInvite: ['string'], setRole: ['string', 'string'], removeMember: ['string'],
    joinCode: ['string'], accept: [], acceptPending: ['string'], switchAccount: [], skipInvites: [], openTeam: ['string'], signOut: ['string'], deleteStart: ['string'],
    deleteConfirm: ['string'], cancelDelete: [], runner: ['string', 'boolean'], presence: ['string', 'boolean'],
  };

  async function joined(origin, r) {
    if (r.ok) {
      pendingInvite = null;
      await refreshAccount(origin);
      const ws = store.list().find((w) => w.kind === 'team' && w.hub === origin && w.teamId === String(r.team?.id));
      if (ws) switchWorkspace(ws.id); else select('board');
      return { ok: true };
    }
    if (r.code === 'WRONG_ACCOUNT') return { ok: false, wrongAccount: true, error: `This invite is for ${r.detail?.email_masked ?? maskEmail('')}. Switch account?` };
    if (r.code === 'ALREADY_MEMBER') {
      pendingInvite = null;
      await refreshAccount(origin);
      const ws = store.list().find((w) => w.kind === 'team' && w.hub === origin && w.teamId === String(r.detail?.team?.id));
      return { ok: false, alreadyIn: ws?.id ?? null, error: `You’re already in ${r.detail?.team?.name ?? 'this team'}.` };
    }
    if (inviteGone(r)) pendingInvite = null;
    return r;
  }

  /**
   * A hub the member typed: an accounts hub goes to email sign-in; one still
   * behind Access (the hidden fallback) becomes an Access workspace and signs
   * in inside the board view as before.
   */
  async function connectHub(origin) {
    // A throwaway, in-memory session: a signed-in partition would answer 200
    // and hide the Access team we must pin.
    const probe = await probeHub(origin, `board-probe-${crypto.randomUUID()}`);
    if (!probe.ok) return probe;
    if (probe.accessTeam || probe.auth === 'access') {
      store.addAccess({ url: origin, name: hostOf(origin), accessTeam: probe.accessTeam ?? null });
      log('connected team hub (access)', { host: hostOf(origin) });
      forgetHub();
      select('board');
      return { ok: true };
    }
    trustedHub = origin;
    acct.hub = origin;
    if (signedIn(origin)) { await afterSignIn(origin); return { ok: true }; }
    showAccount('email');
    return { ok: true };
  }

  // ── hub view ────────────────────────────────────────────────────────────

  // Once per hub partition: the device token rides as a header on requests to
  // that hub's exact origin (and its WebSocket), so the page never holds it.
  const bearerSessions = new Set();
  const unauthorized = new Map(); // origin → pending check
  function installBearer(origin) {
    const partition = teamPartition(origin);
    if (bearerSessions.has(partition)) return;
    bearerSessions.add(partition);
    const ses = session.fromPartition(partition);
    const scope = bearerScope(origin);
    ses.webRequest.onBeforeSendHeaders({ urls: scope.urls }, (d, cb) => {
      const headers = { ...d.requestHeaders };
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
      const tok = scope.matches(d.url) ? tokenFor(origin) : null;
      if (tok) headers.Authorization = `Bearer ${tok}`;
      cb({ requestHeaders: headers });
    });
    ses.webRequest.onCompleted({ urls: scope.urls }, (d) => {
      if (d.statusCode !== 401 || !scope.matches(d.url) || unauthorized.has(origin)) return;
      // Revoked elsewhere? Ask the hub once; the client wipes the token and
      // signedOutOf() shows sign-in if so.
      unauthorized.set(origin, clientFor(origin).me().finally(() => unauthorized.delete(origin)));
    });
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
      await ses.cookies.set({ url: info.url, name: 'board_local', value: info.localSecret, httpOnly: true, sameSite: 'strict', path: '/' });
    } else if (info.devSecret) {
      const value = await devLogin(info.url, info.devSecret);
      await ses.cookies.set({ url: info.url, name: 'board_dev', value, httpOnly: true, sameSite: 'strict', path: '/' });
    }
    return { url: info.url, origin: new URL(info.url).origin, accessTeam: null, partition, team: false };
  }

  function makeHubView(h) {
    hardenSession(session.fromPartition(h.partition));
    const view = new WebContentsView({
      webPreferences: { partition: h.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: true },
    });
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1a1f' : '#eceaf0');
    const wc = view.webContents;
    const decide = (url) => navDecision(url, { hubOrigin: h.origin, accessTeam: h.accessTeam });
    wc.setWindowOpenHandler(({ url, frameName }) => {
      const d = openDecision({ url, frameName }, { hubOrigin: h.origin, accessTeam: h.accessTeam });
      if (d === 'connect') openConnect(url, h);
      else if (d === 'external') shell.openExternal(url);
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
  // window on its own partition: never the hub's, so the bearer header can't
  // reach a provider, and the provider's cookies stay out of the board.
  let connectWin = null;
  function openConnect(url, h) {
    if (connectWin && !connectWin.isDestroyed()) { connectWin.loadURL(url).catch(() => {}); connectWin.focus(); return; }
    const ses = session.fromPartition('persist:integration-auth');
    hardenSession(ses);
    const w = new BrowserWindow({
      width: 560, height: 720, title: 'Connect', autoHideMenuBar: true, backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1a1f' : '#ffffff',
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
    });
    connectWin = w;
    const wc = w.webContents;
    wc.setWindowOpenHandler(({ url: u }) => { if (/^https:/.test(u)) shell.openExternal(u); return { action: 'deny' }; });
    // Provider logins hop between https hosts freely; the callback is on the hub.
    const ok = (u) => /^https:/.test(u) || isConnectCallback(u, h.origin);
    const guard = (e, u) => { if (!ok(u)) e.preventDefault(); };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('will-attach-webview', (e) => e.preventDefault());
    let closing = false;
    wc.on('did-finish-load', () => {
      if (closing || !isConnectCallback(wc.getURL(), h.origin)) return;
      closing = true;
      // Long enough to read "Connected" (or the error) on the callback page.
      setTimeout(() => {
        if (!w.isDestroyed()) w.close();
        if (selected === 'integrations' && hubInfo?.origin === h.origin && hubView && !hubView.webContents.isDestroyed()) {
          hubView.webContents.loadURL(hubPageUrl(hubInfo.url, pageById('integrations'), { org: hubInfo.org })).catch(() => {});
        }
      }, 1500);
    });
    w.on('closed', () => { if (connectWin === w) connectWin = null; });
    w.loadURL(url).catch(() => {});
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
      await view.webContents.loadURL(url).catch(() => {}); // privacy-flow: board-view
    }
    if (win && selected === page.id && view === hubView && !viewError) attach(view);
  }

  // ── selection ───────────────────────────────────────────────────────────

  function select(id) {
    const page = pageById(id);
    if (!page) return;
    if (page.kind === 'window') { openWindow(page.window); return; }
    if (page.kind === 'local') { showAccount(page.screen); return; }
    selected = id;
    pushState();
    if (page.kind === 'hub') showHubPage(page);
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

  const FLOWS = { signin: 'hub', join: 'join', 'create-team': 'create-team' };
  ipcMain.on('buddy:workspace', (e, id) => {
    if (!fromSidebar(e) || typeof id !== 'string') return;
    if (FLOWS[id]) {
      if (id === 'signin') { pendingInvite = null; acct.hub = null; }
      if (id === 'join') { pendingInvite = null; acct.hub = null; }
      showAccount(FLOWS[id]);
    } else switchWorkspace(id);
  });
  ipcMain.on('buddy:signout', onSignOut);
  ipcMain.on('buddy:select', onSelect);
  ipcMain.on('buddy:retry', onRetry);
  ipcMain.handle('buddy:pages', (e) => (fromSidebar(e) ? { pages: PAGES, groups: GROUPS } : null));
  for (const [op, fn] of Object.entries(ACCT)) {
    ipcMain.handle(`buddy:acct:${op}`, async (e, ...args) => {
      if (!fromAccount(e)) return { ok: false, error: 'Not allowed.' };
      const types = ACCT_ARGS[op];
      if (args.length !== types.length || args.some((a, i) => typeof a !== types[i] || (typeof a === 'string' && a.length > 2048))) return { ok: false, error: 'Not allowed.' };
      try { return await fn(...args); } catch (err) { log('account action failed', op, err.message); return { ok: false, error: 'Something went wrong. Try again.' }; }
    });
  }

  function open(pageId = null) {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (pageId) select(pageId);
      return;
    }
    win = new BaseWindow({
      width: 1320, height: 860, minWidth: 760, minHeight: 520,
      title: 'Claude Buddy',
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
    win.on('closed', () => {
      // Close every page: detached views otherwise keep running (and the board
      // page keeps its socket). The hub keeps running while the app runs, so
      // reopening is instant; it stops with the app.
      for (const v of [sidebar, infoView, hubView, accountView]) dispose(v, null);
      win = null; sidebar = null; content = null; hubView = null; infoView = null; accountView = null;
      onClosed();
    });
    layout();
    if (!pageId && selected.startsWith('flow:')) showAccount(selected.slice(5)); else select(pageId ?? selected);
    // Keep each signed-in hub's team list current (added to a team elsewhere).
    for (const h of store.hubs()) if (signedIn(h)) refreshAccount(h).catch(() => {});
  }

  return {
    open,
    isOpen: () => !!win,
    select,
    openInvite,
    /** App start: runners the member left on come back without opening the window. */
    resumeDevices() {
      for (const w of store.list()) if (w.kind === 'team' && deviceFileExists(w)) deviceFor(w).resume();
    },
    /** The widget's live sessions changed: hubs sharing presence get the new list. */
    sessionsChanged(sessions) {
      lastSessions = Array.isArray(sessions) ? sessions : [];
      for (const [id, d] of devices) { const ws = store.get(id); if (ws) d.setPresence(store.sharesPresence(ws.hub), lastSessions); }
    },
    async stop() {
      const url = localUrl();
      await Promise.all([supervisor.stop({ final: true }), ...[...devices.values()].map((d) => d.stop())]);
      // The secret dies with this hub; don't leave it in the cookie store.
      if (url) await session.fromPartition(partitionFor()).cookies.remove(url, 'board_local').catch(() => {});
    },
    status: () => ({ selected, hub: hubStatus, viewError, workspace: store.active().id, screen: acct.screen, url: content === hubView ? (hubView?.webContents.getURL() ?? null) : null }),
    // Dev only (main.js gates it on !app.isPackaged): the hub-address step without the form.
    devConnect: (url) => ACCT.hub(url),
    // Dev only: drive the account page as a person would (fills and clicks in the page).
    devPage: (js) => (content === accountView && accountView ? accountView.webContents.executeJavaScript(js) : Promise.resolve(null)),
    // Dev hook: capture what's on screen.
    async capture() {
      if (!win) return null;
      const [side, main] = await Promise.all([sidebar.webContents.capturePage(), content?.webContents.capturePage()]);
      return { sidebar: side, content: main ?? null };
    },
  };
}

module.exports = { createBuddyWindow, SIDEBAR_W };
