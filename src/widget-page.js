'use strict';
// The Widget page (widget-page.html): a live preview of the floating widget,
// show or hide it, its size and corner, and the extras it shows. It keeps no
// state of its own: it reads and writes the same config keys as Preferences >
// Widget and moves or resizes the widget's own window. Nothing leaves this computer.

const WidgetStrip = require('./widget-strip.js');

const BOOLS = ['showWidget', 'menuBarMode', 'showTasks', 'showAgents', 'agentRoster', 'paceTooltip'];
const KINDS = ['subagent', 'teammate', 'ralph'];
const CHIP_SIZES = ['small', 'normal', 'large'];
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const PAGES = ['lights', 'settings'];
const MARGIN = 24;
const SNAPS = ['corners', 'edges', 'off'];
const SIZES = ['normal', 'compact', 'dot'];
const SNAP_THRESHOLD = 48;
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_PROJECTS = 40;
const MODIFIERS = ['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta'];
const NAMED_KEYS = ['Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'Plus'];
const KEY = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|[`~!@#$%^&*()\-=\[\]\\;',./])$/i;
const keyName = (k) => (KEY.test(k) ? k.toUpperCase() : NAMED_KEYS.find((n) => n.toLowerCase() === k.toLowerCase()) || null);

/** An Electron accelerator with at least one modifier and exactly one key, or null. Empty means off. */
function cleanAccelerator(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 60) return null;
  const parts = s.split('+');
  const key = parts.pop();
  const name = key ? keyName(key) : null;
  if (!parts.length || !name) return null;
  const mods = parts.map((p) => MODIFIERS.find((m) => m.toLowerCase() === p.toLowerCase()));
  if (mods.some((m) => !m) || new Set(mods).size !== mods.length) return null;
  return [...mods, name].join('+');
}

/** A project's key for its accent: the last folder of its cwd. */
const projectKey = (cwd) => String(cwd || '').replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';

/** The accent colour for a session's cwd from {basename: '#hex'}, or null. */
function projectAccent(cwd, map) {
  const k = projectKey(cwd);
  if (!k || !map || typeof map !== 'object' || !Object.prototype.hasOwnProperty.call(map, k)) return null;
  return typeof map[k] === 'string' && HEX.test(map[k]) ? map[k].toLowerCase() : null;
}

const savedColours = (m) => Object.fromEntries(Object.entries(m && typeof m === 'object' && !Array.isArray(m) ? m : {})
  .filter(([k, c]) => projectKey(k) === k && typeof c === 'string' && HEX.test(c)).map(([k, c]) => [k, c.toLowerCase()]));

/** Merges a colour patch into the saved map: '#hex' sets, null removes, anything else is dropped. */
function cleanColours(v, current = {}) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = savedColours(current);
  let any = false;
  for (const [k, c] of Object.entries(v)) {
    if (typeof k !== 'string' || !k || k.length > 120 || projectKey(k) !== k) continue;
    if (c === null) { if (k in out) { delete out[k]; any = true; } continue; }
    if (typeof c === 'string' && HEX.test(c)) { out[k] = c.toLowerCase(); any = true; }
  }
  if (!any || Object.keys(out).length > MAX_PROJECTS) return null;
  return out;
}

/**
 * Where a widget dropped at `base` settles with snapping to any edge: each
 * axis within `threshold` of an edge (inset by `margin`) moves onto it, so it
 * slides along an edge and lands in a corner when near two. → {x, y, edge}.
 */
function snapPoint(base, workArea, { margin = MARGIN, threshold = SNAP_THRESHOLD } = {}) {
  const left = workArea.x + margin;
  const right = workArea.x + workArea.width - base.width - margin;
  const top = workArea.y + margin;
  const bottom = workArea.y + workArea.height - base.height - margin;
  let x = base.x, y = base.y;
  const edges = [];
  // Dropped past an edge counts as on it.
  const dl = Math.max(0, base.x - left), dr = Math.max(0, right - base.x);
  if (Math.min(dl, dr) <= threshold) { x = dl <= dr ? left : right; edges.push(dl <= dr ? 'left' : 'right'); }
  const dt = Math.max(0, base.y - top), db = Math.max(0, bottom - base.y);
  if (Math.min(dt, db) <= threshold) { y = dt <= db ? top : bottom; edges.unshift(dt <= db ? 'top' : 'bottom'); }
  // Snapped onto an edge: keep it on screen along that edge too.
  if (edges.length) {
    x = Math.min(Math.max(x, left), Math.max(left, right));
    y = Math.min(Math.max(y, top), Math.max(top, bottom));
  }
  return { x: Math.round(x), y: Math.round(y), edge: edges.length ? edges.join('-') : null };
}

/** The config keys this page may change, checked; anything else is dropped. → partial or null. */
function cleanPatch(v, current = {}) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const k of BOOLS) if (typeof v[k] === 'boolean') out[k] = v[k];
  if (CHIP_SIZES.includes(v.agentChipSize)) out.agentChipSize = v.agentChipSize;
  if (SNAPS.includes(v.widgetSnap)) out.widgetSnap = v.widgetSnap;
  if (SIZES.includes(v.widgetSize)) out.widgetSize = v.widgetSize;
  if (v.widgetShortcut === '') out.widgetShortcut = '';
  else if (cleanAccelerator(v.widgetShortcut)) out.widgetShortcut = cleanAccelerator(v.widgetShortcut);
  // The task box's shortcut (O4): off unless the person sets one; '' turns it off again.
  if (v.composeShortcut === '') out.composeShortcut = '';
  else if (cleanAccelerator(v.composeShortcut)) out.composeShortcut = cleanAccelerator(v.composeShortcut);
  if ('projectColours' in v) { const c = cleanColours(v.projectColours, current.projectColours); if (c) out.projectColours = c; }
  if (v.agentKinds && typeof v.agentKinds === 'object' && !Array.isArray(v.agentKinds)) {
    const kinds = { ...(current.agentKinds || {}) };
    let any = false;
    for (const k of KINDS) if (typeof v.agentKinds[k] === 'boolean') { kinds[k] = v.agentKinds[k]; any = true; }
    // Preferences shows one box for both background-worker kinds; keep them together.
    if (typeof v.agentKinds.ralph === 'boolean') kinds.ultrawork = v.agentKinds.ralph;
    if (any) out.agentKinds = kinds;
  }
  return Object.keys(out).length ? out : null;
}

/** Where the widget's own rect goes for a corner of its display's work area. */
function cornerPoint(base, workArea, corner, margin = MARGIN) {
  const left = workArea.x + margin;
  const right = workArea.x + workArea.width - base.width - margin;
  const top = workArea.y + margin;
  const bottom = workArea.y + workArea.height - base.height - margin;
  return { x: Math.round(corner.endsWith('left') ? left : right), y: Math.round(corner.startsWith('top') ? top : bottom) };
}

/** The nearest corner of the work area to the rect's centre, for the page's position picker. */
function nearestCorner(base, workArea) {
  const cx = base.x + base.width / 2;
  const cy = base.y + base.height / 2;
  return `${cy < workArea.y + workArea.height / 2 ? 'top' : 'bottom'}-${cx < workArea.x + workArea.width / 2 ? 'left' : 'right'}`;
}

function configView(c) {
  const kinds = c.agentKinds || {};
  return {
    showWidget: c.showWidget !== false, menuBarMode: !!c.menuBarMode, showTasks: c.showTasks !== false, showAgents: c.showAgents !== false,
    agentRoster: c.agentRoster !== false, paceTooltip: c.paceTooltip !== false,
    agentChipSize: CHIP_SIZES.includes(c.agentChipSize) ? c.agentChipSize : 'normal',
    agentKinds: { subagent: kinds.subagent !== false, teammate: kinds.teammate !== false, ralph: kinds.ralph !== false || kinds.ultrawork !== false },
    widgetSnap: SNAPS.includes(c.widgetSnap) ? c.widgetSnap : 'corners',
    widgetSize: SIZES.includes(c.widgetSize) ? c.widgetSize : 'normal',
    widgetShortcut: cleanAccelerator(c.widgetShortcut) || '',
    composeShortcut: cleanAccelerator(c.composeShortcut) || '',
    projectColours: savedColours(c.projectColours),
  };
}

/**
 * ctx: { utilityHandle, allowed(e), loadConfig, commitConfig(partial), widget() (BrowserWindow|null),
 *        strip() (the applied WidgetStrip), ensureWidget(), resizeBy(factor), busy(), stopGlide(), saveBounds(),
 *        screen, limits: {minWidth, maxWidth}, openPage(id), platform }
 */
function register(ctx) {
  const { utilityHandle, allowed } = ctx;
  const live = () => { const w = ctx.widget(); return w && !w.isDestroyed() ? w : null; };

  function state() {
    const w = live();
    const s = ctx.strip();
    const base = w ? WidgetStrip.baseOf(w.getBounds(), s) : null;
    const wa = base ? ctx.screen.getDisplayMatching(w.getBounds()).workArea : null;
    return {
      config: configView(ctx.loadConfig()),
      visible: !!(w && w.isVisible()),
      width: base ? base.width : null,
      corner: base ? nearestCorner(base, wa) : null,
      limits: { minWidth: ctx.limits.minWidth, maxWidth: ctx.limits.maxWidth },
      // A bubble, budget note or recap hangs under Claude: moving or resizing waits for it.
      held: WidgetStrip.blocksTravel(s) || !!ctx.busy(),
      platform: ctx.platform,
      compose: ctx.composeShortcut ? ctx.composeShortcut() : null,
    };
  }

  utilityHandle('widget-page:state', allowed, () => state());

  // A still of the widget as it is on screen right now; null while it is hidden.
  utilityHandle('widget-page:preview', allowed, async () => {
    const w = live();
    if (!w || !w.isVisible()) return null;
    try {
      const img = await w.webContents.capturePage();
      return img.isEmpty() ? null : img.toDataURL();
    } catch { return null; }
  });

  utilityHandle('widget-page:set', allowed, (_e, v) => {
    const patch = cleanPatch(v, ctx.loadConfig());
    if (!patch) return { ok: false, error: 'Nothing to change.' };
    try { ctx.commitConfig(patch); } catch (err) { return { ok: false, error: `Could not save: ${err.message}` }; }
    if (patch.showWidget === true) ctx.ensureWidget();
    return { ok: true, state: state() };
  });

  utilityHandle('widget-page:size', allowed, (_e, width) => {
    const w = live();
    const s = state();
    if (!w || s.width === null) return { ok: false, error: 'Show the widget first.', state: s };
    if (s.held) return { ok: false, error: 'The widget is showing something under Claude; try again when it is gone.', state: s };
    const n = Number(width);
    if (!Number.isFinite(n)) return { ok: false, error: 'Bad size.', state: s };
    const target = Math.min(ctx.limits.maxWidth, Math.max(ctx.limits.minWidth, Math.round(n)));
    ctx.resizeBy(target / s.width);
    return { ok: true, state: state() };
  });

  utilityHandle('widget-page:move', allowed, (_e, corner) => {
    const w = live();
    const s = state();
    if (!CORNERS.includes(corner)) return { ok: false, error: 'Bad corner.', state: s };
    if (!w) return { ok: false, error: 'Show the widget first.', state: s };
    if (s.held) return { ok: false, error: 'The widget is busy right now; try again in a moment.', state: s };
    ctx.stopGlide();
    const cur = w.getBounds();
    const st = ctx.strip();
    const base = WidgetStrip.baseOf(cur, st);
    const p = cornerPoint(base, ctx.screen.getDisplayMatching(cur).workArea, corner);
    w.setPosition(p.x - st.dx, p.y - st.dy);
    ctx.saveBounds();
    return { ok: true, state: state() };
  });

  utilityHandle('widget-page:open', allowed, (e, id) => { if (PAGES.includes(id)) ctx.openPage(id, e); return null; });

  return { state };
}

module.exports = { register, cleanPatch, cornerPoint, nearestCorner, configView, snapPoint, projectAccent, projectKey, cleanColours, cleanAccelerator, CORNERS, PAGES, MARGIN, SNAPS, SIZES, SNAP_THRESHOLD };
