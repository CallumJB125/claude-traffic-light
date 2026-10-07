'use strict';

// The Usage optimiser page: Claude Burst's own dashboard in a dedicated view
// under Plexiform's native top bar. Burst's admin page refuses to be framed
// (X-Frame-Options DENY), so it is a top-level WebContentsView in its own
// session partition, with no preload and no app APIs, loaded only after
// Burst's version+pid handshake says `present`, and locked to Burst's exact
// origin. All Electron pieces are injected so the whole lifecycle runs under
// test with fakes.

const Embed = require('../src/burst-embed');

const BAR_H = 48; // the native top bar (optimiser.html) above the dashboard
const PARTITION = 'persist:burst-dashboard';
const POLL_MS = 5000;
const TABS = Object.freeze(['dashboard', 'route', 'requests', 'tools']);
const FILTER = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };

function createOptimiser({
  newView, harden, dispose, openExternal, burst, win, isContent, isSelected, bounds, sendState, navChanged,
  platform = process.platform, injector = null, background = () => {}, setTimer = setInterval, clearTimer = clearInterval,
}) {
  let view = null;
  let origin = null;
  let pid = null;
  let last = null; // the page state main last sent
  let nav = [];
  let active = null;
  let tab = 'dashboard'; // the native tab strip: the embedded dashboard is only shown on 'dashboard'
  let sig = '';
  let gen = 0;
  let failures = 0;
  let skipNav = false;
  let timer = null;

  const wcOf = () => (view && !view.webContents.isDestroyed() ? view.webContents : null);
  const external = (url) => { if (/^https:/.test(url)) openExternal(url); }; // privacy-flow: burst-dashboard-links

  function snapshot() {
    const b = burst();
    return b ? b.snapshot() : { d: { kind: platform === 'darwin' ? 'unreachable' : 'unsupported' }, url: null };
  }
  const signature = ({ d }) => `${d.kind}|${d.state ? d.state.version : ''}|${d.pid ?? ''}`;

  function drop() {
    const v = view;
    view = null; origin = null; pid = null; failures = 0; skipNav = false; active = null;
    if (nav.length) { nav = []; navChanged(); }
    if (v) dispose(v);
  }

  async function readNav() {
    const wc = wcOf();
    if (!wc) return;
    try {
      const next = Embed.extractSubnav(await wc.executeJavaScript(Embed.NAV_SCRIPT));
      if (wc !== wcOf() || JSON.stringify(next) === JSON.stringify(nav)) return;
      nav = next;
      navChanged();
    } catch { /* the page is not ready; the next load asks again */ }
  }

  function make(o) {
    view = newView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, safeDialogs: true } });
    const wc = view.webContents;
    background(view);
    harden(wc.session);
    wc.session.webRequest.onBeforeRequest(FILTER, (d, cb) => cb({ cancel: !Embed.requestAllowed(d.url, origin) }));
    const guard = (e, url) => {
      const d = Embed.navDecision(url, origin);
      if (d === 'allow') return;
      e.preventDefault();
      if (d === 'external') external(url);
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('will-frame-navigate', guard);
    wc.setWindowOpenHandler(({ url }) => { if (Embed.openDecision(url, origin) === 'external') external(url); return { action: 'deny' }; });
    wc.on('did-start-navigation', (d) => {
      if (!d.isMainFrame || d.isSameDocument) return;
      if (skipNav) { skipNav = false; return; }
      refresh();
    });
    wc.on('did-finish-load', () => { failures = 0; readNav(); });
    wc.on('dom-ready', readNav);
    wc.on('did-fail-load', (_e, code, _desc, _url, isMain) => {
      if (!isMain || code === -3) return; // -3: aborted by our own navigation
      if (++failures > 1) {
        last = { ...Embed.pageState({ kind: 'unreachable' }, { platform }), detail: 'The dashboard did not load. Repair Burst, or try again.' };
        drop(); sendState(); sync();
      } else refresh({ reload: true });
    });
    wc.on('render-process-gone', () => { drop(); refresh(); });
    if (injector) injector.attach(wc);
    skipNav = true;
    wc.loadURL(`${o}/`).catch(() => {}); // privacy-flow: burst-dashboard
  }

  function ensure(o, p, reload) {
    const wc = wcOf();
    if (wc && origin === o && pid === p) { if (reload) wc.reload(); return; }
    drop();
    origin = o; pid = p;
    make(o);
  }

  function sync() {
    const w = win();
    const wc = wcOf();
    if (!w || !view || !wc) return;
    const show = !!last && last.mode === 'ready' && isContent() && tab === 'dashboard';
    const attached = w.contentView.children.includes(view);
    if (show && !attached) w.contentView.addChildView(view);
    if (!show && attached) w.contentView.removeChildView(view);
    if (show) layout();
  }

  function layout() {
    const w = win();
    if (!w || !view || !w.contentView.children.includes(view)) return;
    const b = bounds();
    view.setBounds({ x: b.x, y: BAR_H, width: b.width, height: Math.max(0, b.height - BAR_H) });
  }

  // The handshake result decides everything: only `present` loads the dashboard.
  function apply(snap, { reload = false } = {}) {
    let st = Embed.pageState(snap.d, { platform });
    let o = null;
    if (st.mode === 'ready') {
      try { o = new URL(snap.url).origin; } catch { /* no usable address */ }
      if (!o) st = Embed.pageState({ kind: 'unreachable' }, { platform });
    }
    last = st;
    sig = signature(snap);
    if (st.mode === 'ready') ensure(o, snap.d.pid, reload); else { tab = 'dashboard'; drop(); }
    sendState();
    sync();
  }

  async function refresh({ reload = false } = {}) {
    const mine = ++gen;
    const b = burst();
    if (b) await Promise.resolve(b.refresh(true)).catch(() => {});
    if (mine !== gen) return;
    apply(snapshot(), { reload });
  }

  async function tick() {
    if (!isSelected()) { stop(); return; }
    const b = burst();
    if (b) await Promise.resolve(b.refresh(false)).catch(() => {});
    const snap = snapshot();
    if (signature(snap) !== sig) apply(snap);
  }

  function stop() { if (timer !== null) { clearTimer(timer); timer = null; } }

  return {
    /** The page was selected: re-check trust now, then keep watching while it is shown. */
    open() {
      if (timer === null) { timer = setTimer(() => { tick().catch(() => {}); }, POLL_MS); if (timer && timer.unref) timer.unref(); }
      return refresh();
    },
    refresh, sync, layout, drop, stop, tick,
    state: () => last,
    nav: () => nav.slice(),
    active: () => active,
    hasView: () => !!view,
    section(id) {
      const wc = wcOf();
      const js = Embed.sectionScript(id);
      if (!wc || !js || !nav.some((n) => n.id === id)) return false;
      active = id;
      if (tab !== 'dashboard') { tab = 'dashboard'; sync(); sendState(); }
      wc.executeJavaScript(js).catch(() => {});
      navChanged();
      return true;
    },
    async act(kind) {
      if (typeof kind === 'string' && kind.startsWith('tab:')) {
        const t = kind.slice(4);
        if (!TABS.includes(t) || !last || last.mode !== 'ready') return { ok: false };
        tab = t; sync(); sendState();
        return { ok: true };
      }
      if (!Embed.PAGE_ACTIONS.includes(kind)) return { ok: false, error: 'Unknown action.' };
      const b = burst();
      if (!b) return { ok: false, error: 'Burst is not available.' };
      return b.act(kind);
    },
    async openBrowser() {
      const b = burst();
      return b ? b.act('open-browser') : { ok: false };
    },
    tab: () => tab,
    payload: () => (last ? { ...last, canBrowser: last.mode === 'ready', tab } : { mode: 'loading', headline: 'Usage optimiser', detail: '', chip: null, actions: [], docs: false }),
  };
}

module.exports = { createOptimiser, BAR_H, PARTITION };
