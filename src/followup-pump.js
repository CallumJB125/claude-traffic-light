'use strict';
// Main-level pump for queued follow-ups: no window, Overview or focus needed, only a running Plexiform with a
// workspace. One pass at a time. After each pass, items of a hub account that is no longer the signed-in one are
// refused (sweepForeign), but only once the viewer has been the same on two consecutive passes, so an account
// switch, a restart or a token refresh never drops anything.
function createFollowupPump({ followups, resolve, scope, hub, ready = () => true, intervalMs = 1500, setInterval: setTimer = setInterval, clearInterval: clearTimer = clearInterval }) {
  let timer = null, running = false, stopped = false, last = null;
  const identity = () => {
    try { const h = hub(), v = h?.viewer?.(); return h && typeof h.origin === 'string' && v && typeof v.id === 'string' && v.id ? { h, origin: h.origin, viewer: v.id } : null; } catch { return null; }
  };
  async function pass() {
    if (running || stopped || !ready() || scope() === null) return;
    running = true;
    try {
      await followups.advance(resolve);
      const now = identity();
      const stable = now && last && last.h === now.h && last.origin === now.origin && last.viewer === now.viewer && identity()?.viewer === now.viewer;
      last = now;
      if (stable && !stopped) await followups.sweepForeign({ origin: now.origin, viewer: now.viewer, current: () => identity()?.viewer === now.viewer && identity()?.h === now.h });
    } catch { /* the next pass retries; nothing here carries message text */ } finally { running = false; }
  }
  return {
    start() { if (timer || stopped) return; timer = setTimer(() => { void pass(); }, intervalMs); timer.unref?.(); },
    stop() { stopped = true; if (timer) { clearTimer(timer); timer = null; } },
    pass,
  };
}

module.exports = { createFollowupPump };
