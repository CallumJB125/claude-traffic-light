'use strict';
// Widget polish (Wave 1 lane C): edge snapping after a drag, the compact and
// dot sizes, a global shortcut that summons or hides the widget, per-project
// accent colours and "Quiet for 30 minutes". Everything reads and writes the
// existing config; nothing new is stored or sent anywhere.

const WidgetPage = require('./widget-page.js');
const WidgetStrip = require('./widget-strip.js');
const Quiet = require('./quiet.js');

// The window's own rect (without a bubble or recap strip) for each size.
// Dot is the lamp alone: 28 px plus the page's 12 px padding on each side.
const DOT_PX = 52;
const COMPACT_W = 64;
const RECENT_MAX = 12;

/**
 * deps: { ipcMain, globalShortcut, config() (loadConfig), commitConfig(partial), widgetWindow() (BrowserWindow|null),
 *         quiet (src/quiet.js), utilityHandle?, widgetAllowed(e), pageAllowed(e), sessions() ([{cwd}]),
 *         strip() (WidgetStrip), saveBounds(), stopGlide(), screen, sizing: {aspect, minWidth}, onConfigChange?(fn), now?, log? }
 */
function install(deps) {
  const { ipcMain, globalShortcut, config, widgetWindow } = deps;
  const Q = deps.quiet || Quiet;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const handle = deps.utilityHandle || ((ch, allowed, fn) => ipcMain.handle(ch, (e, ...a) => (allowed(e) ? fn(e, ...a) : null)));
  const live = () => { const w = widgetWindow(); return w && !w.isDestroyed() ? w : null; };
  const strip = () => (deps.strip ? deps.strip() : WidgetStrip.NONE);
  let shortcut = null;
  let shortcutTaken = null;
  let shortcutTried; // the accelerator last attempted, so a taken one is not retried on every poll
  let sizeApplied = null;

  function toggleWidget() {
    const w = live();
    if (!w) return false;
    if (w.isVisible()) { w.hide(); return 'hidden'; }
    w.show();
    if (typeof w.moveTop === 'function') w.moveTop();
    return 'shown';
  }

  function applyShortcut(c = config()) {
    const want = WidgetPage.cleanAccelerator(c.widgetShortcut);
    if (want === shortcutTried) return;
    shortcutTried = want;
    if (shortcut) { try { globalShortcut.unregister(shortcut); } catch { /* already gone */ } shortcut = null; }
    shortcutTaken = null;
    if (!want) return;
    let ok = false;
    try { ok = globalShortcut.register(want, toggleWidget); } catch { ok = false; }
    if (ok) shortcut = want;
    else { shortcutTaken = want; log(`[widget] ${want} could not be registered (taken or not allowed)`); }
  }

  // Resizes the window about its centre to the chosen size; normal keeps the
  // width it had, or the minimum when coming back from a smaller size.
  function applySize(c = config()) {
    const w = live();
    const size = WidgetPage.configView(c).widgetSize;
    if (!w || size === sizeApplied || WidgetStrip.blocksTravel(strip())) return;
    const { aspect, minWidth } = deps.sizing;
    const cur = w.getBounds();
    let width, height;
    if (size === 'dot') { width = DOT_PX; height = DOT_PX; w.setMinimumSize(DOT_PX, DOT_PX); w.setAspectRatio(1); }
    else if (size === 'compact') { width = COMPACT_W; height = Math.round(COMPACT_W / aspect); w.setMinimumSize(width, height); w.setAspectRatio(aspect); }
    else {
      w.setMinimumSize(minWidth, Math.round(minWidth / aspect));
      w.setAspectRatio(aspect);
      width = sizeApplied === null || sizeApplied === 'normal' ? Math.max(minWidth, cur.width) : Math.round(minWidth * 4 / 3);
      height = Math.round(width / aspect);
    }
    if (sizeApplied === null && size === 'normal') { sizeApplied = size; return; }
    sizeApplied = size;
    w.setBounds({ x: Math.round(cur.x + (cur.width - width) / 2), y: Math.round(cur.y + (cur.height - height) / 2), width, height });
    deps.saveBounds?.();
  }

  function view() {
    const c = config();
    const v = WidgetPage.configView(c);
    const t = now();
    return {
      snap: v.widgetSnap, size: v.widgetSize, colours: v.projectColours,
      quiet: Q.isQuiet(c, t), quietUntil: Q.timedQuiet(c, t) ? c.quietUntil : null,
      shortcut: shortcut || null, shortcutTaken,
    };
  }

  function snap() {
    const w = live();
    if (!w || WidgetPage.configView(config()).widgetSnap !== 'edges') return { ok: false };
    const st = strip();
    if (WidgetStrip.blocksTravel(st)) return { ok: false };
    deps.stopGlide?.();
    const cur = w.getBounds();
    const base = WidgetStrip.baseOf(cur, st);
    const p = WidgetPage.snapPoint(base, deps.screen.getDisplayMatching(cur).workArea);
    if (p.x !== base.x || p.y !== base.y) { w.setPosition(p.x - st.dx, p.y - st.dy); deps.saveBounds?.(); }
    return { ok: true, edge: p.edge };
  }

  function recentProjects() {
    const colours = WidgetPage.configView(config()).projectColours;
    const names = [];
    for (const s of (deps.sessions ? deps.sessions() : []) || []) {
      const k = WidgetPage.projectKey(s && s.cwd);
      if (k && !names.includes(k)) names.push(k);
    }
    for (const k of Object.keys(colours)) if (!names.includes(k)) names.push(k);
    return names.slice(0, RECENT_MAX).map((name) => ({ name, colour: colours[name] || null }));
  }

  function setQuiet(on) {
    deps.commitConfig({ quietUntil: on ? Q.quietFor(now()) : 0 });
  }

  // The widget menu's quiet item: "Quiet for 30 minutes" or, while it holds, "End quiet".
  function menuItems() {
    const c = config();
    const on = Q.timedQuiet(c, now());
    if (on) {
      const left = Math.max(1, Math.ceil((c.quietUntil - now()) / 60000));
      return [{ label: 'End quiet', sublabel: `${left} min left`, click: () => setQuiet(false) }];
    }
    return [{ label: `Quiet for ${Q.QUIET_FOR_MIN} minutes`, click: () => setQuiet(true) }];
  }

  const KEYS = ['widgetShortcut', 'widgetSize'];
  function configChanged(prev, next) {
    if (!KEYS.some((k) => JSON.stringify((prev || {})[k]) !== JSON.stringify((next || {})[k]))) return;
    applyShortcut(next);
    applySize(next);
  }

  // Global shortcuts need a ready app: the widget asking for its state is the first sure sign.
  handle('widget-polish:state', deps.widgetAllowed, () => { applyShortcut(); applySize(); return view(); });
  handle('widget-polish:snap', deps.widgetAllowed, () => snap());
  handle('widget:recent-projects', deps.pageAllowed, () => recentProjects());
  if (typeof deps.onConfigChange === 'function') deps.onConfigChange(configChanged);

  return { configChanged, menuItems, view, snap, recentProjects, toggleWidget, applyShortcut, applySize, setQuiet, get shortcut() { return shortcut; } };
}

module.exports = { install, DOT_PX, COMPACT_W, RECENT_MAX };
