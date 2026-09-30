// The Buddy main window: a native sidebar plus one content area. The board
// pages are the hub's own web app, loaded from the hub's origin in a sandboxed
// view (so same-origin, CSRF and WS origin checks work unchanged and the web is
// never forked); the sidebar and placeholder pages are local files.
//
// main.js wires it: `const buddy = createBuddyWindow({...}); buddy.open()`.
'use strict';

const path = require('node:path');
const http = require('node:http'); // privacy-flow: local-board-hub
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { BaseWindow, WebContentsView, ipcMain, session, shell, utilityProcess, app, nativeTheme, net } = require('electron');
const { PAGES, GROUPS, pageById, hubPageUrl, navDecision, pageForHubUrl } = require('./pages');
const { createHubSupervisor } = require('./hub-process');
const { createWorkspaceStore, normalizeHubUrl, accessTeamFromLocation, partitionFor: teamPartition } = require('./workspaces');

const SIDEBAR_W = 216;
const DIR = __dirname;
const LOCAL_PAGES = new Set(['sidebar.html', 'info.html'].map((f) => pathToFileURL(path.join(DIR, f)).href));
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

function createBuddyWindow({ openWindow = () => {}, onClosed = () => {}, log = (...a) => console.log('[buddy-window]', ...a), isDev = !app.isPackaged } = {}) {
  const store = createWorkspaceStore(path.join(app.getPath('userData'), 'buddy-workspaces.json'));
  const getTeamHub = () => { const w = store.active(); return w.kind === 'team' ? w : null; };
  let win = null;
  let sidebar = null;
  let content = null; // the view currently attached on the right
  let hubView = null;
  let infoView = null;
  let selected = 'board';
  let hubStatus = { state: 'stopped' };
  let hubInfo = null; // {url, origin, accessTeam, partition, team}
  let viewError = null; // the hub is fine but its page failed to load
  let hubLoading = null;

  // Local hub, started lazily the first time a board page opens.
  const mode = process.env.BUDDY_BOARD_AUTH === 'dev' && isDev ? 'dev' : 'local';
  const localUrl = () => (hubInfo && !hubInfo.team ? hubInfo.url : null);
  const supervisor = createHubSupervisor({
    fork: (entry, args, opts) => utilityProcess.fork(entry, args, opts),
    hubEntry: path.join(app.getAppPath(), 'board', 'hub', 'server.js'),
    dataDir: path.join(app.getPath('userData'), mode === 'dev' ? 'board-dev' : 'board'),
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
      workspaces: store.list().map(({ id, name, kind }) => ({ id, name, kind })),
      active: store.active().id,
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

  // Local pages load our two files only; nothing navigates them anywhere else.
  function lockLocal(view) {
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; }); // privacy-flow: open-link-in-browser
    const guard = (e, url) => { if (!isLocalPage(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } }; // privacy-flow: open-link-in-browser
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
  }

  // ── hub view ────────────────────────────────────────────────────────────

  async function resolveHub() {
    const team = getTeamHub();
    if (team?.url) {
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
    wc.setWindowOpenHandler(({ url }) => { if (decide(url) === 'external') shell.openExternal(url); return { action: 'deny' }; }); // privacy-flow: open-link-in-browser
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

  async function showHubPage(page) {
    if (!win || !page) return;
    const myGen = gen;
    if (!hubInfo) {
      if (hubStatus.state !== 'ready') showInfo(page);
      if (!hubLoading) { const p = resolveHub().finally(() => { if (hubLoading === p) hubLoading = null; }); hubLoading = p; }
      try {
        const h = await hubLoading;
        if (myGen !== gen) return selected === page.id ? showHubPage(page) : undefined;
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
    const url = hubPageUrl(hubInfo.url, page);
    const cur = view.webContents.getURL();
    if (!cur || !cur.startsWith(hubInfo.origin) || pageForHubUrl(cur) !== page.id) {
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
    selected = id;
    pushState();
    if (page.kind === 'hub') showHubPage(page);
    else showInfo(page);
  }

  const fromSidebar = (e) => sidebar && e.sender === sidebar.webContents && isLocalPage(e.senderFrame?.url ?? '');
  const fromInfo = (e) => infoView && e.sender === infoView.webContents && isLocalPage(e.senderFrame?.url ?? '');

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

  function switchWorkspace(id) {
    if (!store.setActive(id)) return;
    forgetHub();
    select('board');
  }

  function showConnect(extra = {}) {
    if (!win) return;
    selected = 'connect';
    pushState();
    showInfo({ id: 'connect', title: 'Connect to a team hub', kind: 'connect', blurb: 'Your team’s Buddy board, right here in the app. You sign in once with your work email.' }, extra);
  }

  async function onConnect(e, arg) {
    if (!fromInfo(e)) return { ok: false, error: 'not allowed' };
    return connectTo(arg);
  }

  async function connectTo(arg) {
    let origin;
    try { origin = normalizeHubUrl(arg?.url); } catch (err) { return { ok: false, error: err.message }; }
    const probe = await probeHub(origin, teamPartition(origin));
    if (!probe.ok) return probe;
    const name = String(arg?.name ?? '').trim() || new URL(origin).host;
    const ws = store.add({ url: origin, name, accessTeam: probe.accessTeam });
    log('connected team hub', { host: new URL(origin).host, access: !!probe.accessTeam });
    forgetHub();
    select('board');
    return { ok: true, id: ws.id };
  }

  async function onSignOut(e, id) {
    if (!fromSidebar(e)) return;
    const ws = store.get(id);
    if (!ws || ws.kind !== 'team') return;
    // Signing out = forgetting this hub's cookies and storage; the next visit signs in again.
    await session.fromPartition(teamPartition(ws.url)).clearStorageData().catch(() => {});
    store.remove(id);
    forgetHub();
    select('board');
  }

  ipcMain.on('buddy:workspace', (e, id) => {
    if (!fromSidebar(e) || typeof id !== 'string') return;
    if (id === 'connect') showConnect(); else switchWorkspace(id);
  });
  ipcMain.handle('buddy:connect', onConnect);
  ipcMain.on('buddy:signout', onSignOut);
  ipcMain.on('buddy:select', onSelect);
  ipcMain.on('buddy:retry', onRetry);
  ipcMain.handle('buddy:pages', (e) => (fromSidebar(e) ? { pages: PAGES, groups: GROUPS } : null));

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
      for (const v of [sidebar, infoView, hubView]) dispose(v, null);
      win = null; sidebar = null; content = null; hubView = null; infoView = null;
      onClosed();
    });
    layout();
    select(pageId ?? selected);
  }

  return {
    open,
    isOpen: () => !!win,
    select,
    async stop() {
      const url = localUrl();
      await supervisor.stop({ final: true });
      // The secret dies with this hub; don't leave it in the cookie store.
      if (url) await session.fromPartition(partitionFor()).cookies.remove(url, 'board_local').catch(() => {});
    },
    status: () => ({ selected, hub: hubStatus, viewError, workspace: store.active().id, url: hubView?.webContents.getURL() ?? null }),
    // Dev only (main.js gates it on !app.isPackaged): the connect form's path without the form.
    devConnect: (url, name) => connectTo({ url, name }),
    // Dev hook: capture what's on screen.
    async capture() {
      if (!win) return null;
      const [side, main] = await Promise.all([sidebar.webContents.capturePage(), content?.webContents.capturePage()]);
      return { sidebar: side, content: main ?? null };
    },
  };
}

module.exports = { createBuddyWindow, SIDEBAR_W };
