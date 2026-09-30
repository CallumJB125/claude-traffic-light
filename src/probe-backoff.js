// How long to wait before probing again, for a probe that keeps failing the
// same way. The roam probe (should Claude run to the terminal's Dock icon?)
// costs three or four osascript spawns; with no Dock icon to find it used to
// fail identically every 20 s for as long as a session waited. Each repeat of
// the same failure doubles the wait, up to `max`; a success, a different
// failure or a new situation (`key`) starts again at `base`. Failures that
// `steady` accepts (the terminal simply being in front, which must be
// noticed the moment it isn't) never back off.
function createProbeBackoff({ base, max, steady = () => false }) {
  let gap = base;
  let lastWhy = null;
  let lastKey = null;
  const reset = () => { gap = base; lastWhy = null; };
  return {
    get gap() { return gap; },
    // The situation the probe is about; a change means old failures no
    // longer say anything about the next probe.
    setKey(key) {
      if (key !== lastKey) { lastKey = key; reset(); }
    },
    record(result) {
      if (!result || result.ok || steady(result.why)) { reset(); return gap; }
      gap = result.why === lastWhy ? Math.min(max, gap * 2) : base;
      lastWhy = result.why;
      return gap;
    },
    reset,
  };
}

module.exports = { createProbeBackoff };
