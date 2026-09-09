// Working out WHICH app to knock on, kept free of Electron so it can be
// tested directly.
//
// The bug this exists to prevent: a macOS process name is not an app's display
// name. Ghostty's process is `ghostty`, its Dock item is `Ghostty`; VS Code's
// process is `Code`. Matching those case-sensitively meant the roamer never
// recognised Ghostty was running, so it never knocked at all.

const APP_ALIASES = {
  Ghostty: ['ghostty'],
  iTerm2: ['iTerm2', 'iTerm'],
  Terminal: ['Terminal'],
  Warp: ['Warp', 'stable'],
  'Visual Studio Code': ['Code', 'Electron'],
  'Visual Studio Code - Insiders': ['Code - Insiders'],
  'Code - OSS': ['Code - OSS'],
  Cursor: ['Cursor'],
  Windsurf: ['Windsurf'],
  kitty: ['kitty'],
  WezTerm: ['wezterm-gui', 'WezTerm'],
  Alacritty: ['Alacritty', 'alacritty'],
  Hyper: ['Hyper'],
};

function matchesRunning(appName, running) {
  if (!appName || !Array.isArray(running)) return false;
  const lower = running.map((n) => String(n).toLowerCase());
  const wanted = [appName, ...(APP_ALIASES[appName] || [])].map((n) => n.toLowerCase());
  return wanted.some((w) => lower.includes(w));
}

// The session that needs you knows which app it is running in, because the
// hook recorded it. Sessions actually waiting on the user win; only if nothing
// recorded a host at all do we fall back to "whatever terminal is running".
function pickTerminal(sessions, running, isWaiting, fallbackOrder = []) {
  if (!Array.isArray(running) || !running.length) return null;
  const list = Array.isArray(sessions) ? sessions : [];
  const wanting = list.filter((s) => isWaiting(s.signal));
  for (const s of [...wanting, ...list]) {
    if (s.hostApp && matchesRunning(s.hostApp, running)) return s.hostApp;
  }
  const known = [...fallbackOrder, ...Object.keys(APP_ALIASES)];
  return known.find((t) => matchesRunning(t, running)) || null;
}

// A Dock icon can be reported off every display: auto-hidden Docks park their
// icons below the screen, and an icon can belong to a second display. Pull the
// rect back onto a real work area so the knock is somewhere visible.
function clampRectToDisplays(rect, displays) {
  if (!displays || !displays.length) return { ...rect, hidden: true, display: null };
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const inside = displays.find((d) => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width
    && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height);
  const target = inside || displays.reduce((best, d) => {
    const dx = Math.max(d.bounds.x - cx, 0, cx - (d.bounds.x + d.bounds.width));
    const dy = Math.max(d.bounds.y - cy, 0, cy - (d.bounds.y + d.bounds.height));
    const dist = Math.hypot(dx, dy);
    return !best || dist < best.dist ? { d, dist } : best;
  }, null).d;
  const wa = target.workArea;
  const hidden = !inside || cy > wa.y + wa.height || cy < wa.y || cx < wa.x || cx > wa.x + wa.width;
  return {
    ...rect,
    hidden,
    x: Math.max(wa.x, Math.min(wa.x + wa.width - rect.w, rect.x)),
    y: Math.max(wa.y, Math.min(wa.y + wa.height - rect.h, rect.y)),
    display: target,
  };
}

module.exports = { APP_ALIASES, matchesRunning, pickTerminal, clampRectToDisplays };
