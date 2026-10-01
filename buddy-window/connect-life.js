// The connect window's lifetime and its sign-out generation, kept apart from
// Electron so tests can drive them with fake timers, windows and sessions.
'use strict';

// As long as the bind cookie and the hub's state last: after that the sign-in can't finish anyway.
const CONNECT_LIFETIME_MS = 10 * 60 * 1000;

function createConnectLife({ setTimer = setTimeout, clearTimer = clearTimeout, lifetimeMs = CONNECT_LIFETIME_MS } = {}) {
  const armed = new WeakSet();
  // Bumped on sign-out, account or hub switch, and around every partition clear.
  let generation = 0;
  const clearing = new Map(); // partition → clears in flight
  const isClearing = (p) => (clearing.get(p) ?? 0) > 0;
  return {
    bump() { generation += 1; },
    /** Run fn, a clear of `partition`: no bind cookie is set while it runs, and one set across it is refused. */
    async clearing(partition, fn) {
      generation += 1;
      clearing.set(partition, (clearing.get(partition) ?? 0) + 1);
      try { return await fn(); } finally {
        const n = clearing.get(partition) - 1;
        if (n > 0) clearing.set(partition, n); else clearing.delete(partition);
        generation += 1;
      }
    },
    /**
     * Set the bind cookie in `ses` (the connect partition). true only when no
     * sign-out, switch or clear happened while it was set; otherwise the
     * cookie is removed again and the window must not open.
     */
    async setBindCookie(ses, partition, cookie) {
      if (isClearing(partition)) return false;
      const g = generation;
      await ses.cookies.set(cookie); // privacy-flow: integration-connect
      if (g === generation && !isClearing(partition)) return true;
      await ses.cookies.remove(cookie.url, cookie.name).catch(() => {}); // privacy-flow: integration-connect
      return false;
    },
    /** Close `win` lifetimeMs after this call, once per window; onExpire runs just before the close. */
    arm(win, onExpire) {
      if (armed.has(win)) return;
      armed.add(win);
      const t = setTimer(() => {
        if (win.isDestroyed()) return;
        onExpire();
        win.close();
      }, lifetimeMs);
      win.once('closed', () => clearTimer(t));
    },
  };
}

module.exports = { createConnectLife, CONNECT_LIFETIME_MS };
