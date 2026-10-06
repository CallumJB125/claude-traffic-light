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

module.exports = { windowAnimStepMs, createPointDedupe, MAC_STEP_MS, COARSE_STEP_MS };
