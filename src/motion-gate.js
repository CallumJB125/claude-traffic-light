// Why a window's motion is paused. Several things can each mean nobody can
// see it (hidden, minimised, screen locked, displays asleep; menu-bar-only
// mode, item 10, will call setMotionPaused('menu-bar', …)); any one pauses
// it, and it resumes only once every reason has cleared — so an unlock can't
// restart a widget that's still hidden. onChange fires on the edges only,
// never for a repeat.
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

// The lock and displays-off reasons that a missed unlock or wake notification
// has left standing: the system no longer reports itself locked and someone
// has touched it within the last minute.
const RECONCILED = ['locked', 'screens-asleep'];
function staleMachineReasons(reasons, idleState, idleSeconds, recentSeconds = 60) {
  if (idleState === 'locked' || !(idleSeconds < recentSeconds)) return [];
  return reasons.filter((r) => RECONCILED.includes(r));
}

module.exports = { createMotionGate, staleMachineReasons };
