'use strict';

// "Keep this Mac awake while AI is working". Without Burst this is Electron's
// powerSaveBlocker: it stops idle sleep only. It cannot hold a closed laptop
// awake and does not keep the screen on, and it is held only while at least
// one AI session is working.

const WORKING = new Set(['prompt-submit', 'tool-use', 'tool-done', 'tool-failed', 'subagent-start', 'subagent-done', 'compact', 'session-start']);

const workingCount = (sessions) => (Array.isArray(sessions) ? sessions.filter((s) => s && WORKING.has(s.signal)).length : 0);

function createKeepAwake({ powerSaveBlocker, platform = process.platform } = {}) {
  let wanted = false;
  let hold = false;
  let id = null;
  const held = () => id !== null && !!powerSaveBlocker && powerSaveBlocker.isStarted(id);
  const release = () => { if (id !== null) { try { powerSaveBlocker.stop(id); } catch { /* already stopped */ } id = null; } };
  return {
    platform,
    setWanted(on) { wanted = !!on; if (!wanted && !hold) release(); },
    // The Tasks queue still has work (queued, running or waiting for a limit reset): stay awake until it drains,
    // whether or not a session is working this second. Idle sleep only; a closed lid still sleeps without Burst.
    setHold(on) {
      hold = !!on;
      if (!powerSaveBlocker) return false;
      if (hold) { if (!held()) id = powerSaveBlocker.start('prevent-app-suspension'); } else if (!wanted) release();
      return held();
    },
    // Called with the live sessions after every status change.
    sync(sessions) {
      if (!powerSaveBlocker) return false;
      if ((wanted && workingCount(sessions) > 0) || hold) { if (!held()) { id = powerSaveBlocker.start('prevent-app-suspension'); } } else release();
      return held();
    },
    held,
    stop: release,
  };
}

module.exports = { createKeepAwake, workingCount, WORKING };
