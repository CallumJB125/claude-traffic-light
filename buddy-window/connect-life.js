// The connect window's lifetime, kept apart from Electron so tests can drive
// it with fake timers and fake windows.
'use strict';

// As long as the bind cookie and the hub's state last: after that the sign-in can't finish anyway.
const CONNECT_LIFETIME_MS = 10 * 60 * 1000;

function createConnectLife({ setTimer = setTimeout, clearTimer = clearTimeout, lifetimeMs = CONNECT_LIFETIME_MS } = {}) {
  const armed = new WeakSet();
  return {
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
