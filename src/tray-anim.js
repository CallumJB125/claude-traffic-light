// The menu-bar icon only needs a 500 ms repaint clock while something on the
// lamp or the pose is animating; a still look is repainted on change instead.
const TRAY_ANIMATED = new Set(['pulse', 'strobe', 'breathe', 'flicker', 'chase', 'police', 'rainbow', 'sos']);
const TRAY_ANIMATED_POSES = new Set(['blink', 'nod', 'bounce', 'run', 'knock', 'spin', 'party']);

function trayLookAnimated(look) {
  return !!look && (TRAY_ANIMATED.has(look.lampFx) || TRAY_ANIMATED_POSES.has(look.pose));
}

// → 'start' | 'stop' | 'keep' for the repaint timer.
function trayTimerAction({ menuBarMode, look, running }) {
  const want = !!menuBarMode && trayLookAnimated(look);
  if (want && !running) return 'start';
  if (!want && running) return 'stop';
  return 'keep';
}

module.exports = { trayLookAnimated, trayTimerAction };
