// Low-power mode trims non-essential motion (confetti, idle pet loops, blinks,
// lamp glow). The preference is 'auto' | 'on' | 'off'; auto turns it on when
// running on battery or on Windows, where every animated frame costs DWM time.
const MODES = ['auto', 'on', 'off'];

function normalizeLowPowerMode(v) {
  if (v === true) return 'on';
  if (v === false) return 'off';
  return MODES.includes(v) ? v : 'auto';
}

function resolveLowPower({ mode, platform = process.platform, onBattery = false } = {}) {
  const m = normalizeLowPowerMode(mode);
  if (m === 'on') return true;
  if (m === 'off') return false;
  return platform === 'win32' || !!onBattery;
}

module.exports = { MODES, normalizeLowPowerMode, resolveLowPower };
