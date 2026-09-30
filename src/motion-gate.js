// Why a window's motion is paused. Several things can each mean nobody can
// see it (hidden, minimised, screen locked, displays asleep, and later
// menu-bar-only mode); any one pauses it, and it resumes only once every
// reason has cleared — so an unlock can't restart a widget that's still
// hidden. onChange fires on the edges only, never for a repeat.
function createMotionGate(onChange = () => {}) {
  const reasons = new Set();
  return {
    set(reason, on) {
      const was = reasons.size > 0;
      if (on) reasons.add(reason); else reasons.delete(reason);
      const now = reasons.size > 0;
      if (now !== was) onChange(now, [...reasons]);
      return now;
    },
    get paused() { return reasons.size > 0; },
    get reasons() { return [...reasons]; },
  };
}

module.exports = { createMotionGate };
