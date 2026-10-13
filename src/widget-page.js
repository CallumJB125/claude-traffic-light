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

/** The config keys this page may change, checked; anything else is dropped. → partial or null. */
function cleanPatch(v, current = {}) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const k of BOOLS) if (typeof v[k] === 'boolean') out[k] = v[k];
  if (CHIP_SIZES.includes(v.agentChipSize)) out.agentChipSize = v.agentChipSize;
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

  utilityHandle('widget-page:open', allowed, (_e, id) => { if (PAGES.includes(id)) ctx.openPage(id); return null; });

  return { state };
}

module.exports = { register, cleanPatch, cornerPoint, nearestCorner, configView, CORNERS, PAGES, MARGIN };
