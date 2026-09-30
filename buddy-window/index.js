// The Buddy main window: a native sidebar plus one content area. The board
// pages are the hub's own web app, loaded from the hub's origin in a sandboxed
// view (so same-origin, CSRF and WS origin checks work unchanged and the web is
// never forked); the sidebar and placeholder pages are local files.
//
// main.js wires it: `const buddy = createBuddyWindow({...}); buddy.open()`.
'use strict';

const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { BaseWindow, WebContentsView, ipcMain, session, shell, utilityProcess, app, nativeTheme } = require('electron');
const { PAGES, GROUPS, pageById, hubPageUrl, navDecision, pageForHubUrl } = require('./pages');
const { createHubSupervisor } = require('./hub-process');

const SIDEBAR_W = 216;
const DIR = __dirname;

function devLogin(url, secret, login = 'alice') {
  // Node http, not the view: we need the Set-Cookie header to copy it into the
  // view's partition, and the dev secret must never reach the page's JS.
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ github_login: login, request_id: crypto.randomUUID() });
    const u = new URL('/api/dev/login', url);
    const req = http.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'board-dev-secret': secret, 'content-length': Buffer.byteLength(body) } }, (res) => {
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

function createBuddyWindow({ openWindow = () => {}, onClosed = () => {}, getTeamHub = () => null, log = (...a) => console.log('[buddy-window]', ...a), isDev = !app.isPackaged } = {}) {
  let win = null;
  let sidebar = null;
  let content = null; // the view currently attached on the right
  let hubView = null;
  let infoView = null;
  let selected = 'board';
  let hubStatus = { state: 'stopped' };
  let hubInfo = null; // {url, origin, accessTeam, partition}

  // Local hub, started lazily the first time a board page opens.
  const mode = process.env.BUDDY_BOARD_AUTH === 'dev' && isDev ? 'dev' : 'local';
  const supervisor = createHubSupervisor({
    fork: (entry, args, opts) => utilityProcess.fork(entry, args, opts),
    hubEntry: path.join(app.getAppPath(), 'board', 'hub', 'server.js'),
    dataDir: path.join(app.getPath('userData'), mode === 'dev' ? 'board-dev' : 'board'),
    mode,
    isPackaged: !isDev,
    log: (...a) => log('[hub]', ...a),
    onStatus: (s) => { hubStatus = s; pushState(); if (s.state !== 'ready' && isHubPage(selected)) showInfo(pageById(selected)); },
  });

  const isHubPage = (id) => pageById(id)?.kind === 'hub';

  function layout() {
    if (!win) return;
    const { width, height } = win.getContentBounds();
    sidebar?.setBounds({ x: 0, y: 0, width: SIDEBAR_W, height });
    content?.setBounds({ x: SIDEBAR_W, y: 0, width: Math.max(0, width - SIDEBAR_W), height });
  }

  function attach(view) {
    if (content === view) return;
    if (content) win.contentView.removeChildView(content);
    content = view;
    if (view) win.contentView.addChildView(view);
    layout();
  }

  function pushState() {
    if (!sidebar || sidebar.webContents.isDestroyed()) return;
    sidebar.webContents.send('buddy:state', {
      selected,
      hub: { state: hubStatus.state, error: hubStatus.error ?? null, mode: hubInfo ? (hubInfo.team ? 'team' : mode) : (getTeamHub() ? 'team' : mode) },
    });
  }

  // ── info page (soon / loading / error) ──────────────────────────────────

  function showInfo(page, extra = {}) {
    if (!infoView) {
      infoView = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(DIR, 'info-preload.js') } });
      lockLocal(infoView);
    }
    const hub = isHubPage(page.id);
    const query = {
      title: page.title,
      kind: hub ? (hubStatus.state === 'failed' ? 'error' : 'loading') : page.kind,
      blurb: hub ? (hubStatus.state === 'failed' ? (hubStatus.error ?? 'The board could not start.') : 'Starting the board…') : (page.blurb ?? ''),
      ...extra,
    };
    infoView.webContents.loadFile(path.join(DIR, 'info.html'), { query });
    attach(infoView);
  }

  // Local pages load app files only; nothing navigates them anywhere else.
  function lockLocal(view) {
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    wc.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  }

  // ── hub view ────────────────────────────────────────────────────────────

  async function resolveHub() {
    const team = getTeamHub();
    if (team?.url) {
      const origin = new URL(team.url).origin;
      return { url: team.url, origin, accessTeam: team.accessTeam ?? null, partition: `persist:board-${new URL(team.url).host}`, team: true };
    }
    const info = await supervisor.ensure();
    const partition = mode === 'dev' ? 'persist:board-dev' : 'persist:board-local';
    const ses = session.fromPartition(partition);
    if (info.localSecret) {
      await ses.cookies.set({ url: info.url, name: 'board_local', value: info.localSecret, httpOnly: true, sameSite: 'strict', path: '/' });
    } else if (info.devSecret) {
      const value = await devLogin(info.url, info.devSecret);
      await ses.cookies.set({ url: info.url, name: 'board_dev', value, httpOnly: true, sameSite: 'strict', path: '/' });
    }
    return { url: info.url, origin: new URL(info.url).origin, accessTeam: null, partition, team: false };
  }

  function makeHubView(h) {
    const ses = session.fromPartition(h.partition);
    // The board needs no camera, mic, geolocation or notifications from the OS.
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    const view = new WebContentsView({
      webPreferences: { partition: h.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true },
    });
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1a1f' : '#eceaf0');
    const wc = view.webContents;
    const decide = (url) => navDecision(url, { hubOrigin: h.origin, accessTeam: h.accessTeam });
    wc.setWindowOpenHandler(({ url }) => { if (decide(url) === 'external') shell.openExternal(url); return { action: 'deny' }; });
    const guard = (e, url) => {
      const d = decide(url);
      if (d === 'allow') return;
      e.preventDefault();
      if (d === 'external') shell.openExternal(url);
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    // The web's own view switcher changes ?view= in place; keep the sidebar in step.
    wc.on('did-navigate-in-page', (_e, url) => { if (isHubPage(selected)) { selected = pageForHubUrl(url); pushState(); } });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3) return; // -3: aborted by our own navigation
      log('hub page failed to load', { code, desc, url });
      hubStatus = { state: 'failed', error: `Could not load the board (${desc}).` };
      showInfo(pageById(selected));
      pushState();
    });
    wc.on('render-process-gone', (_e, d) => { log('hub page crashed', d.reason); hubView = null; if (isHubPage(selected)) select(selected); });
    return view;
  }

  let hubLoading = null;
  async function showHubPage(page) {
    if (!hubInfo) {
      if (!hubLoading) hubLoading = resolveHub().finally(() => { hubLoading = null; });
      if (hubStatus.state !== 'ready') showInfo(page);
      try { hubInfo = await hubLoading; } catch (e) {
        log('board unavailable', e.message);
        hubStatus = { state: 'failed', error: e.message };
        if (selected === page.id) showInfo(page);
        pushState();
        return;
      }
    }
    if (selected !== page.id) return;
    if (!hubView) hubView = makeHubView(hubInfo);
    const url = hubPageUrl(hubInfo.url, page);
    const cur = hubView.webContents.getURL();
    if (!cur || pageForHubUrl(cur) !== page.id || !cur.startsWith(hubInfo.origin)) await hubView.webContents.loadURL(url).catch(() => {});
    if (selected === page.id) attach(hubView);
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

  function onSelect(e, id) {
    if (!sidebar || e.sender !== sidebar.webContents) return;
    if (typeof id !== 'string' || !pageById(id)) return;
    select(id);
  }

  function onRetry(e) {
    if (!sidebar || (e.sender !== sidebar.webContents && e.sender !== infoView?.webContents)) return;
    hubInfo = null;
    hubView = null;
    supervisor.retry().catch(() => {});
    select(isHubPage(selected) ? selected : 'board');
  }

  ipcMain.on('buddy:select', onSelect);
  ipcMain.on('buddy:retry', onRetry);
  ipcMain.handle('buddy:pages', (e) => (sidebar && e.sender === sidebar.webContents ? { pages: PAGES, groups: GROUPS } : null));

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
    sidebar.webContents.loadFile(path.join(DIR, 'sidebar.html'));
    sidebar.webContents.once('did-finish-load', () => { pushState(); win?.show(); });
    win.on('resize', layout);
    win.on('closed', () => {
      win = null; sidebar = null; content = null; hubView = null; infoView = null;
      onClosed();
      // The hub keeps running while the app runs: reopening is instant and the
      // runner (later) talks to it. It stops with the app (stop()).
    });
    layout();
    select(pageId ?? selected);
  }

  return {
    open,
    isOpen: () => !!win,
    select,
    stop: () => supervisor.stop(),
    status: () => ({ selected, hub: hubStatus }),
    // Dev/test hooks: capture what's on screen.
    async capture() {
      if (!win) return null;
      const [side, main] = await Promise.all([sidebar.webContents.capturePage(), content?.webContents.capturePage()]);
      return { sidebar: side, content: main ?? null };
    },
    get webContents() { return { sidebar: sidebar?.webContents ?? null, content: content?.webContents ?? null }; },
  };
}

module.exports = { createBuddyWindow, SIDEBAR_W };
