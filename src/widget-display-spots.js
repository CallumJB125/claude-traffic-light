'use strict';
// QoL2b: the widget remembers where it sat on each display, and goes back there when that display returns.
// Pure helpers plus a small keeper main.js drives with Electron's `screen` events. No Electron here: `screen` is
// Electron's screen module or a fake with getAllDisplays, getDisplayMatching and getPrimaryDisplay.
//
// The file stays readable by older builds: its top level is still the last {x, y, width, height}, with
// `v: 2` and `spots` beside it, so a build from before this reads it exactly as it read the v1 file.
const WidgetPlacement = require('./widget-placement.js');

const MAX_SPOTS = 8;
const SETTLE_MS = 1000;
const num = (v) => Number.isFinite(v);
const rect = (b) => (b && typeof b === 'object' && ['x', 'y', 'width', 'height'].every((k) => num(b[k])) && b.width > 0 && b.height > 0
  ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null);
const cleanLabel = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : '');

// A display's keys. The id can change across reconnects and reboots, so the label (with the size) is a fallback,
// used only when exactly one saved spot carries it (two identical monitors share a label).
function keyOf(display) {
  if (!display || typeof display !== 'object') return null;
  const size = display.size && num(display.size.width) ? display.size : display.bounds;
  if (!size || !num(size.width) || !num(size.height)) return null;
  const wh = `${Math.round(size.width)}x${Math.round(size.height)}`;
  const label = cleanLabel(display.label);
  return { id: num(display.id) || typeof display.id === 'string' ? `${display.id}|${wh}` : null, label: label ? `${label}|${wh}` : null };
}

const spotsOf = (file) => (file && Array.isArray(file.spots) ? file.spots : [])
  .filter((s) => s && typeof s === 'object' && rect(s.bounds) && (typeof s.id === 'string' || typeof s.label === 'string'))
  .slice(0, 64);

// The next file after saving `bounds` on `display`: the last bounds at the top level, and that display's spot.
// `connected`: the ids (keyOf().id) of the displays connected now. A spot with this display's label under an id
// that isn't connected is this display under its old id (ids change across reconnects), so it is replaced, not
// kept beside: otherwise the next id change would find two spots with the label and use neither. Two identical
// monitors connected together keep a spot each.
function remember(file, display, bounds, at = Date.now(), connected = null) {
  const b = rect(bounds);
  if (!b) return file;
  const k = keyOf(display);
  const stale = (s) => !!k && !!k.label && s.label === k.label && connected instanceof Set && !connected.has(s.id);
  const others = spotsOf(file).filter((s) => !(k && k.id && s.id === k.id) && !stale(s));
  const spots = k ? [...others, { id: k.id, label: k.label, bounds: b, at }] : others;
  spots.sort((p, q) => (num(p.at) ? p.at : 0) - (num(q.at) ? q.at : 0));
  return { ...b, v: 2, spots: spots.slice(-MAX_SPOTS) };
}

// The saved spot for `display`: its id first, else its label when exactly one saved spot has it.
function spotFor(file, display) {
  const k = keyOf(display);
  if (!k) return null;
  const spots = spotsOf(file);
  const hit = k.id && spots.find((s) => s.id === k.id);
  if (hit) return rect(hit.bounds);
  const byLabel = k.label ? spots.filter((s) => s.label === k.label) : [];
  return byLabel.length === 1 ? rect(byLabel[0].bounds) : null;
}

const sameDisplay = (a, b) => !!a && !!b && ((a.id && a.id === b.id) || (a.label && a.label === b.label));

/**
 * The keeper. deps:
 *   screen; read() → the saved file or null; write(file); bounds() → the widget's base bounds or null;
 *   move({x, y}) → moves the widget (our own move); commit() → main's saveBounds (its own guards, then save());
 *   busy() → a glide, roam, garden run or strip change is under way; main() → the main window's bounds or null;
 *   now(); setTimer(fn, ms) / clearTimer(t).
 * → { save(bounds), seen(bounds), moveEvent(), settling(), displayRemoved(display), displayAdded(display), metricsChanged() }
 *
 * macOS moves the widget itself when a display goes, sometimes before Electron reports the change. So a `move` is
 * saved only once it has stood for SETTLE_MS with no display change, and any display change cancels a pending one
 * and opens a settle window in which moves (ours included) are neither saved nor counted as the person's.
 */
function createKeeper({ screen, read, write, bounds, move, commit, busy = () => false, main = () => null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let settleUntil = 0;
  let pending = null;
  let lastDisplay = null; // the display the widget was last saved on
  let rehomedFrom = null; // the display it was moved off, waiting for it to come back
  let movedSince = false;
  const settling = () => now() < settleUntil;
  const cancel = () => { if (pending) { clearTimer(pending); pending = null; } };
  const settle = () => { cancel(); settleUntil = now() + SETTLE_MS; };
  const fileNow = () => { try { return read(); } catch { return null; } };
  const visible = (b) => WidgetPlacement.visibleOrDefault(screen, b, null) === b;
  const place = (b) => { const t = WidgetPlacement.visibleOrDefault(screen, b, main()); move({ x: t.x, y: t.y }); };

  function save(b) {
    const r = rect(b);
    if (!r || settling()) return false;
    const display = screen.getDisplayMatching(r);
    lastDisplay = keyOf(display);
    const connected = new Set(screen.getAllDisplays().map((d) => keyOf(d)?.id).filter(Boolean));
    write(remember(fileNow(), display, r, now(), connected));
    return true;
  }

  // Where the widget starts (before its first save), so a removal of that display is recognised.
  function seen(b) { const r = rect(b); if (r) lastDisplay = keyOf(screen.getDisplayMatching(r)); }

  // A window `move`: the person's, once it has stood for SETTLE_MS with no display change in between.
  function moveEvent() {
    if (settling()) return;
    cancel();
    pending = setTimer(() => { pending = null; if (settling()) return; movedSince = true; commit(); }, SETTLE_MS);
  }

  function displayRemoved(display) {
    settle();
    const gone = keyOf(display);
    const b = rect(bounds());
    if (!b || busy()) return;
    // Off the display it was on (even when macOS already slid it somewhere visible), or off every display.
    if (!(sameDisplay(gone, lastDisplay) || !visible(b))) return;
    const onto = screen.getDisplayMatching(b);
    const spot = spotFor(fileNow(), onto);
    place(spot ? { ...spot, width: b.width, height: b.height } : b);
    rehomedFrom = gone;
    movedSince = false;
    lastDisplay = keyOf(onto);
  }

  function displayAdded(display) {
    settle();
    const back = keyOf(display);
    if (!rehomedFrom || movedSince || busy() || !sameDisplay(back, rehomedFrom)) return;
    const spot = spotFor(fileNow(), display);
    const b = rect(bounds());
    if (!spot || !b) return;
    place({ ...spot, width: b.width, height: b.height });
    rehomedFrom = null;
    lastDisplay = back;
  }

  return { save, seen, moveEvent, settling, displayRemoved, displayAdded, metricsChanged: settle, state: () => ({ lastDisplay, rehomedFrom, movedSince, pending: !!pending }) };
}

module.exports = { keyOf, remember, spotFor, createKeeper, MAX_SPOTS, SETTLE_MS };
