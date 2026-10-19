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

// What the widget is being asked to show: every waiting request and input.
// A paused widget skips status pushes, but never a change to this — a stuck
// prompt must be answerable (and a gone one gone) the moment the widget is
// back, and main answers them while it's hidden or in menu-bar mode.
// Session-derived inputs keep one id per session (ask-<host>-<session>), so
// the key carries their time and a hash of what they say as well: a new
// question in the same session must reach a paused widget too.
function fingerprint(i) {
  const s = JSON.stringify([i.created_at ?? null, i.title ?? '', i.text ?? '', (i.options || []).map((o) => o && o.label), i.expires_at ?? null]);
  let h = 5381;
  for (let k = 0; k < s.length; k++) h = ((h * 33) ^ s.charCodeAt(k)) >>> 0;
  return h.toString(36);
}
function askKey(st) {
  const ids = [...(st?.pending || []).map((p) => `r:${p.id}`), ...(st?.inputs || []).map((i) => `i:${i.id}:${fingerprint(i)}`),
    // A row's work-scope badge (personal, counting…) changes without the input changing.
    ...(st?.sessions || []).filter((s) => s && s.scope && typeof s.scope.state === 'string').map((s) => `s:${s.sessionId}:${s.scope.state}`)];
  return ids.sort().join('|');
}
function statusPushWanted(paused, key, lastKey) {
  return !paused || key !== lastKey;
}

// backgroundThrottling is created off so a visible-but-occluded window keeps
// animating. While the gate holds (nobody can see the window) Chromium may
// throttle it again; it goes back off the moment the gate lifts.
function syncBackgroundThrottling(wc, paused) {
  try {
    if (wc && typeof wc.setBackgroundThrottling === 'function' && !(typeof wc.isDestroyed === 'function' && wc.isDestroyed())) wc.setBackgroundThrottling(!!paused);
  } catch { /* the page is gone */ }
}

module.exports = { syncBackgroundThrottling, createMotionGate, staleMachineReasons, askKey, statusPushWanted };
