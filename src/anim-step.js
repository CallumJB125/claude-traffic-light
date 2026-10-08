// Main-process window animation (tween, glide) moves a window with
// setBounds/setPosition on a timer. On macOS that is cheap at ~60 Hz; on
// Windows every call is a DWM relayout, so the step is coarser there (both
// animations are time-based, so a longer step only drops intermediate frames).
const MAC_STEP_MS = 16;
const COARSE_STEP_MS = 33;

function windowAnimStepMs(platform = process.platform) {
  return platform === 'darwin' ? MAC_STEP_MS : COARSE_STEP_MS;
}

// A step that lands on the pixel the window is already at needs no native call.
function createPointDedupe() {
  let lx = null;
  let ly = null;
  return (x, y) => {
    if (x === lx && y === ly) return false;
    lx = x; ly = y;
    return true;
  };
}

// The cursor poll runs fast only while the eyes are following or settling
// back (the cursor moved within holdMs); at rest it is a 1 s heartbeat that
// notices the next movement.
const EYE_IDLE_POLL_MS = 1000;
function eyePollMs({ now, movedAt, holdMs, fastMs, idleMs = EYE_IDLE_POLL_MS }) {
  return movedAt && now - movedAt < holdMs ? fastMs : Math.max(fastMs, idleMs);
}

module.exports = { eyePollMs, EYE_IDLE_POLL_MS, windowAnimStepMs, createPointDedupe, MAC_STEP_MS, COARSE_STEP_MS };
