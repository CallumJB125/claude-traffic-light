'use strict';

// One gate for every nudge that is not a direct answer to the person: the
// approval "make it a rule?" nudge, the digest notification, and anything
// else that pings unprompted. src/quiet.js (snooze, quiet hours) and
// src/busy-watch.js (a meeting on the calendar, an ICS feed or a Focus mode)
// feed it; nothing else decides. No calendar data reaches here: only "busy".

// quiet(): Quiet's reason or null; busy(): busy-watch says pings are held.
function create({ quiet = () => null, busy = () => false } = {}) {
  const why = () => {
    let q = null;
    try { q = quiet(); } catch { q = null; }
    if (q) return `quiet:${q}`;
    let b = false;
    try { b = busy() === true; } catch { b = false; }
    return b ? 'busy' : null;
  };
  return { why, isInterruptible: () => why() === null };
}

module.exports = { create };
