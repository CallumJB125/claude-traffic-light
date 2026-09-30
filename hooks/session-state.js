// What every writer of a session file shares: set-status.js (Claude Code
// hooks), emit.js (other agents) and the app's /signal endpoint. Lives in
// hooks/ because the packaged hooks run from Resources/hooks with nothing else
// beside them; main.js requires it from here too. The lifecycle itself (which
// signal a write leaves, and the clocks that go with it) is session-machine.js.
const fs = require('fs');
const Machine = require('./session-machine.js');

const { TURN_END, TRANSIENT_ASK_MS, userTouched } = Machine;

// Hooks for one session can run at the same moment (parallel Agent calls fire
// SubagentStart/Stop together) and each one reads the file, changes it and
// writes it back. Without a lock the last rename wins and the others' changes
// are lost: an agent that never shows, or a SubagentStop that never lands and
// leaves the session "working" for hours.
//
// Held for a read-parse-write only (milliseconds), so a lock older than
// STALE_LOCK_MS belongs to a writer that died holding it.
const STALE_LOCK_MS = 2000;
const LOCK_WAIT_MS = 3000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

// Each holder writes its own token into the lock, so it only ever releases a
// lock that is still its own.
function newToken() {
  return `${process.pid}-${Math.random().toString(36).slice(2)}`;
}

function tryLock(lock, token) {
  try {
    fs.writeFileSync(lock, token, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  breakIfStale(lock, token);
  return false;
}

// Two waiters can both judge the same dead lock stale; if the first breaks it
// and a third writer takes a fresh one, a plain unlink by the second would
// delete that live lock. So the lock is renamed aside, and only deleted if it
// is the very file (same inode) that was judged stale; anything else is put
// back (link fails if yet another lock has appeared since — that one stands).
function breakIfStale(lock, token) {
  let seen;
  try { seen = fs.statSync(lock); } catch { return; }
  if (Date.now() - seen.mtimeMs <= STALE_LOCK_MS) return;
  const aside = `${lock}.${token}.stale`;
  try { fs.renameSync(lock, aside); } catch { return; }
  try {
    if (fs.statSync(aside).ino !== seen.ino) fs.linkSync(aside, lock);
  } catch { /* a newer lock took the name; it stands */ }
  fs.rmSync(aside, { force: true });
}

function release(lock, token) {
  try {
    if (fs.readFileSync(lock, 'utf8') === token) fs.rmSync(lock, { force: true });
  } catch { /* already gone */ }
}

// Runs fn under the session's lock, waiting for it. If it can't be had in
// LOCK_WAIT_MS, fn runs anyway: a lost update is better than a hung hook.
function withLock(file, fn, waitMs = LOCK_WAIT_MS) {
  const lock = `${file}.lock`;
  const token = newToken();
  const deadline = Date.now() + waitMs;
  let held = false;
  try {
    while (!(held = tryLock(lock, token)) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 5);
  } catch { /* the directory is gone or unwritable: run unlocked */ }
  if (!held) process.stderr.write(`session-state: ${lock} still held after ${waitMs} ms, writing anyway\n`);
  try {
    return fn();
  } finally {
    if (held) release(lock, token);
  }
}

// For the app's main process, which must never block: one attempt, and
// `undefined` when another writer holds the lock (the caller retries on its
// next poll).
function withLockOrSkip(file, fn) {
  const lock = `${file}.lock`;
  const token = newToken();
  let held = false;
  try { held = tryLock(lock, token); } catch { return undefined; }
  if (!held) return undefined;
  try {
    return fn();
  } finally {
    release(lock, token);
  }
}

// Write-then-rename, so a reader never sees half a file. The temp name carries
// the pid so two writers can't share one.
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The state step for a writer that only knows a bare signal (emit.js and the
// /signal endpoint): the machine's 'bare' writer, under the same guards as
// the hook (a late subagent-done is bookkeeping, the idle nudge keeps a
// failure). Everything the hooks and the app's pollers store on the file is
// carried through, so a bare signal never wipes it; a held signal keeps its
// tool too.
function applyBareSignal(prev, { sessionId, host, source, cwd, signal, tool = null, hostApp }, nowIso = new Date().toISOString()) {
  const p = prev || {};
  const t = Machine.step(prev, { signal, writer: 'bare' }, nowIso);
  return {
    ...p,
    sessionId,
    host,
    source,
    hostApp: hostApp ?? p.hostApp,
    cwd: cwd || p.cwd || '',
    signal: t.signal,
    tool: t.held ? (p.tool ?? null) : tool,
    prevSignal: t.prevSignal,
    signalSince: t.signalSince,
    workingSince: t.workingSince,
    tasks: p.tasks || { created: 0, done: 0 },
    touchedAt: t.touchedAt,
    updatedAt: t.updatedAt,
    agentsAt: t.agentsAt,
  };
}

// A session whose Claude process has exited without a SessionEnd (killed
// terminal, crash) is over, whatever its file last said. Only a pid recorded
// on this machine can be checked; EPERM means it exists under another user.
function processGone(session, host) {
  const pid = Number(session && session.claudePid);
  if (!pid || pid <= 1 || session.host !== host) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

module.exports = { processGone, TURN_END, STALE_LOCK_MS, LOCK_WAIT_MS, TRANSIENT_ASK_MS, withLock, withLockOrSkip, writeJsonAtomic, readJson, userTouched, applyBareSignal };
