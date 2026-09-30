// When to probe again, for a probe that keeps failing the same way. The roam
// probe (should Claude run to the terminal's Dock icon?) costs three or four
// osascript spawns; with no Dock icon to find it used to fail identically
// every 20 s for as long as a session waited.
//
// A failure is "the same" when its reason and its situation (which terminal,
// whether it runs, is in front, has a Dock icon) match the last one; each
// repeat doubles the wait up to `max`, or a per-reason cap. A success, any
// other failure, a new set of waiting sessions (`setKey`) or a sign the world
// changed (`wake`: an app launched or came to the front) starts again at
// `base`. Failures `steady` accepts — the terminal simply being in front,
// which must be noticed the moment it isn't — never back off.
function createProbeBackoff({ base, max, caps = {}, steady = () => false }) {
  let gap = base;
  let last = null;
  let key = null;
  let lastProbe = -Infinity;
  const reset = () => { gap = base; last = null; };
  const identity = (r) => `${r.why}|${JSON.stringify(r.situation || null)}`;
  return {
    get gap() { return gap; },
    setKey(k) { if (k !== key) { key = k; reset(); } },
    due(now) { return now - lastProbe >= gap; },
    probed(result, now) {
      lastProbe = now;
      if (!result || result.ok || steady(result.why)) { reset(); return gap; }
      const id = identity(result);
      const cap = Math.min(max, caps[result.why] ?? max);
      gap = id === last ? Math.min(cap, gap * 2) : Math.min(cap, base);
      last = id;
      return gap;
    },
    wake: reset,
    reset,
  };
}

module.exports = { createProbeBackoff };
