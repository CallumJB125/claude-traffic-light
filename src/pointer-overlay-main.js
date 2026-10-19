// The pointing overlay for screen-aware voice: one transparent, click-through,
// never-focused window per display that has a point on it. The cursor flies
// from the widget to each point with its label, then back; every window is
// closed by MAX_MS whatever the page does. Reduced motion: it appears at the
// point, no flight.
const MAX_MS = 6000;

const inside = (p, b) => p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;

function create({ BrowserWindow, screen, htmlPath, preloadPath, reducedMotion = () => false, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
  let wins = [];
  let timer = null;

  function close() {
    clearTimer(timer);
    timer = null;
    const old = wins;
    wins = [];
    for (const w of old) { try { if (!w.isDestroyed()) w.destroy(); } catch { /* gone */ } }
  }

  // from: the widget's centre, global points; points: [{x, y, label}] global.
  function show({ from, points }) {
    close();
    const list = (Array.isArray(points) ? points : []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)).slice(0, 3);
    if (!list.length) return 0;
    const reduced = !!reducedMotion();
    const byDisplay = new Map();
    for (const p of list) {
      const d = screen.getDisplayNearestPoint({ x: p.x, y: p.y });
      if (!byDisplay.has(d.id)) byDisplay.set(d.id, { display: d, points: [] });
      byDisplay.get(d.id).points.push(p);
    }
    for (const { display, points: pts } of byDisplay.values()) {
      const b = display.bounds;
      const w = new BrowserWindow({
        ...b, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
        focusable: false, alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, show: false,
        webPreferences: { spellcheck: false, preload: preloadPath, contextIsolation: true, sandbox: true, backgroundThrottling: false },
      });
      w.setIgnoreMouseEvents(true);
      w.setAlwaysOnTop(true, 'screen-saver', 1);
      if (w.setVisibleOnAllWorkspaces) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      const local = (p) => ({ x: p.x - b.x, y: p.y - b.y });
      const plan = {
        reduced, ms: MAX_MS - 400,
        from: from && inside(from, b) ? local(from) : null,
        points: pts.map((p) => ({ ...local(p), label: String(p.label || '').slice(0, 40) })),
      };
      w.webContents.once('did-finish-load', () => { if (!w.isDestroyed()) { w.showInactive(); w.webContents.send('pointer:play', plan); } });
      w.loadFile(htmlPath);
      wins.push(w);
    }
    timer = setTimer(close, MAX_MS);
    log(`[voice] pointing at ${list.length} place${list.length === 1 ? '' : 's'}`);
    return wins.length;
  }

  return { show, close, get open() { return wins.length; } };
}

module.exports = { create, MAX_MS };
