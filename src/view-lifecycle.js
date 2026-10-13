// Which page views of the Buddy window stay alive. Every WebContentsView is its
// own renderer process (~90 MB), so only the current page and the one before it
// are kept; older hidden pages are destroyed at once, the previous one after it
// has been hidden for idleMs, or at once when the machine is constrained. A
// destroyed page is recreated the next time it is shown. Pure: the view
// factory, timers and the constrained/protected checks are injected.
'use strict';

function createViewLifecycle({
  destroy,
  isProtected = () => false,
  isConstrained = () => false,
  keepHidden = 1,
  idleMs = 60_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const hiddenOrder = []; // most recently hidden first
  const timers = new Map();
  let current = null;

  function cancel(id) {
    const t = timers.get(id);
    if (t !== undefined) { clearTimer(t); timers.delete(id); }
  }

  function drop(id) {
    cancel(id);
    const i = hiddenOrder.indexOf(id);
    if (i >= 0) hiddenOrder.splice(i, 1);
  }

  function evict(id) {
    if (id === current) return;
    // A page with unsaved input or an open dialog is left alone and asked again later.
    if (isProtected(id)) { arm(id); return; }
    drop(id);
    destroy(id);
  }

  function arm(id) {
    cancel(id);
    timers.set(id, setTimer(() => { timers.delete(id); evict(id); }, idleMs));
  }

  function sweep() {
    for (const id of [...hiddenOrder]) {
      if (isProtected(id)) { if (!timers.has(id)) arm(id); continue; }
      if (isConstrained() || hiddenOrder.indexOf(id) >= keepHidden) evict(id);
      else if (!timers.has(id)) arm(id);
    }
  }

  return {
    /** `id` is now the visible page (null when a non-lifecycle view is showing). */
    setCurrent(id) {
      if (id === current) return;
      const prev = current;
      current = id;
      if (id !== null) drop(id);
      if (prev !== null) { drop(prev); hiddenOrder.unshift(prev); }
      sweep();
    },
    /** A view that was destroyed from outside (crash, window close). */
    forget(id) { drop(id); if (current === id) current = null; },
    /** The window is gone: every view is destroyed by the caller. */
    reset() { for (const id of [...timers.keys()]) cancel(id); hiddenOrder.length = 0; current = null; },
    hidden: () => [...hiddenOrder],
  };
}

module.exports = { createViewLifecycle };
