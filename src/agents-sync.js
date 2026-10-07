// The OMC / agent-team scan (agents.js) reads files inside each session's own
// project folder. When that folder is under ~/Desktop, ~/Documents or
// ~/Downloads, macOS holds the open() until the person answers its privacy
// prompt — minutes, or for good if the prompt is never seen. On the main
// thread that froze the whole app at launch: no window, no signal server, no
// polling. So the scan runs in a worker thread; a stuck read there only
// delays the agent chips.
const fs = require('fs');
const path = require('path');

// One pass: merge what the scan finds into each session file. writeMerged(file,
// next, readAt) must skip the write when the file changed after readAt.
function syncAgentFiles({ sessionsDir, Agents, writeMerged }) {
  let files;
  try { files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')); } catch { return 0; }
  let wrote = 0;
  for (const f of files) {
    const file = path.join(sessionsDir, f);
    let readAt;
    try { readAt = fs.statSync(file).mtimeMs; } catch { continue; }
    const s = Agents.readJson(file);
    if (!s || !s.sessionId) continue;
    const found = Agents.scanAgents(s);
    const next = { ...s, agents: Agents.mergeAgents(s.agents, found.agents), mode: found.mode, iteration: found.iteration };
    if (JSON.stringify(next) === JSON.stringify(s)) continue;
    // The session ended (file removed) mid-poll; the next poll picks it up.
    try { if (writeMerged(file, next, readAt)) wrote += 1; } catch { /* see above */ }
  }
  return wrote;
}

// The merge write main.js does, for the worker: under the hooks' session lock,
// and only if nobody wrote the file since it was read.
function writeMergedSession(SessionState, file, obj, unchangedSince) {
  return SessionState.withLockOrSkip(file, () => {
    if (fs.statSync(file).mtimeMs !== unchangedSince) return false;
    SessionState.writeJsonAtomic(file, obj);
    return true;
  }) === true;
}

// Main-thread side. tick() hands a pass to the worker unless one is still
// running (a blocked read must not queue up passes behind it), and says so in
// the log once it has been stuck for stuckMs. Without a worker it scans inline.
function createAgentsSync({ startWorker, runInline, log = () => {}, now = Date.now, stuckMs = 10000 }) {
  let worker = null; // null: not started; false: unavailable
  let busy = false;
  let busySince = 0;
  let warned = false;

  function start() {
    try {
      const w = startWorker();
      w.on('message', () => {
        if (warned) log(`[agents] scan finished after ${Math.round((now() - busySince) / 1000)} s`);
        busy = false;
        warned = false;
      });
      w.on('error', (err) => {
        log(`[agents] scan worker failed, scanning inline: ${err.message}`);
        worker = false;
        busy = false;
      });
      w.unref?.();
      return w;
    } catch (err) {
      log(`[agents] no scan worker, scanning inline: ${err.message}`);
      return false;
    }
  }

  function tick() {
    if (worker === null) worker = start();
    if (worker === false) { runInline(); return; }
    if (busy) {
      if (!warned && now() - busySince >= stuckMs) {
        warned = true;
        log(`[agents] scan stuck for ${Math.round((now() - busySince) / 1000)} s: a session's project folder is not answering (macOS may be waiting on a Desktop/Documents/Downloads access prompt)`);
      }
      return;
    }
    busy = true;
    busySince = now();
    worker.postMessage({ type: 'scan' });
  }

  return {
    tick,
    busy: () => busy,
    stop: () => { if (worker) worker.terminate?.(); worker = false; },
  };
}

module.exports = { syncAgentFiles, writeMergedSession, createAgentsSync };
