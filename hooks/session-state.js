// What every writer of a session file shares: set-status.js (Claude Code
// hooks), emit.js (other agents) and the app's /signal endpoint. Lives in
// hooks/ because the packaged hooks run from Resources/hooks with nothing else
// beside them; main.js requires it from here too. The lifecycle itself (which
// signal a write leaves, and the clocks that go with it) is session-machine.js.
const fs = require('fs');
const path = require('path');
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

// Windows: antivirus, the search indexer and a reader that has the file open
// make rename, unlink and create fail for a moment with EPERM, EACCES or
// EBUSY. There that is contention, not failure: a few short retries, and a
// lock that can't be created counts as held. macOS and Linux have no such
// window, and keep failing at once.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
function retryTransient(fn, { platform = process.platform, tries = 5, sleep = (ms) => Atomics.wait(sleeper, 0, 0, ms) } = {}) {
  for (let i = 0; ; i += 1) {
    try { return fn(); } catch (e) {
      if (platform !== 'win32' || !TRANSIENT.has(e.code) || i >= tries - 1) throw e;
      sleep(10 + i * 5);
    }
  }
}

// Each holder writes its own token into the lock, so it only ever releases a
// lock that is still its own.
function newToken() {
  return `${process.pid}-${Math.random().toString(36).slice(2)}`;
}

function tryLock(lock, token, platform = process.platform) {
  try {
    fs.writeFileSync(lock, token, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST' && !(platform === 'win32' && TRANSIENT.has(e.code))) throw e;
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
    if (fs.readFileSync(lock, 'utf8') === token) retryTransient(() => fs.rmSync(lock, { force: true }));
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
    retryTransient(() => fs.renameSync(tmp, file));
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
function applyBareSignal(prev, { sessionId, host, source, cwd, signal, tool = null, hostApp, fromSubagent = false, taskId, taskTitle, taskSummary }, nowIso = new Date().toISOString()) {
  const p = prev || {};
  const t = Machine.step(prev, { signal, writer: 'bare', fromSubagent }, nowIso);
  // Local reported task metadata. This conveys neither a destination nor
  // execution authority, and the work-capture boundary scrubs text again.
  const meta = {};
  if (typeof taskId === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(taskId)) {
    meta.taskId = taskId;
    if (taskId !== p.taskId) { meta.taskTitle = null; meta.taskSummary = null; }
  }
  if (typeof taskTitle === 'string') meta.taskTitle = taskTitle.slice(0, 400);
  if (typeof taskSummary === 'string') meta.taskSummary = taskSummary.slice(0, 4000);
  return {
    ...p,
    ...meta,
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

// Where one agent session's file lives. Claude Code's own hook names files
// without a source, so an adapter event for 'claude' lands on the same file.
const safeSessionId = (sessionId) => String(sessionId || 'default').replace(/[^\w.-]/g, '_').slice(0, 120) || 'default';

function sessionFileFor(dir, host, source, sessionId) {
  const id = safeSessionId(sessionId);
  return path.join(dir, source === 'claude' ? `${host}-${id}.json` : `${host}-${source}-${id}.json`);
}

// One normalized adapter event ({ signal, sessionId, cwd, tool, pid } from an
// adapter's normalize()) onto its session file: emit.js --adapter and the
// app's /hook/:adapter route both land here. `decorate(next, prev)` may add
// fields inside the same lock (reporter mode's pid and sequence number).
function applyAdapterEvent(dir, { host, source, event, fallbackSession, fallbackCwd, waitMs, decorate = null }) {
  if (source === 'codex' && event.codexLifecycle === 1) {
    const file = sessionFileFor(dir, host, source, event.sessionId);
    // Lifecycle ordering depends on a held lock. Unlike the legacy writer,
    // never fall through to an unlocked update when the bounded wait ends.
    const lock = `${file}.lock`; const token = newToken();
    const deadline = Date.now() + Math.max(0, Math.min(waitMs ?? 250, 250));
    let held = false;
    try {
      while (!(held = tryLock(lock, token)) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 5);
      if (!held) return null;
      const prev = readJson(file);
      const next = reduceCodexLifecycle(prev, event);
      if (next === undefined) return null;
      if (next === null) { fs.rmSync(file, { force: true }); return file; }
      next.sessionId = event.sessionId; next.host = host; next.source = source;
      if (decorate) decorate(next, prev);
      writeJsonAtomic(file, next);
      return file;
    } finally { if (held) release(lock, token); }
  }
  const sessionId = safeSessionId(event.sessionId || fallbackSession);
  const file = sessionFileFor(dir, host, source, sessionId);
  if (event.signal === 'session-end') { fs.rmSync(file, { force: true }); return file; }
  withLock(file, () => {
    const prev = readJson(file);
    const next = applyBareSignal(prev, { sessionId, host, source, cwd: (typeof event.cwd === 'string' && event.cwd.slice(0, 500)) || prev?.cwd || fallbackCwd || '', signal: event.signal, tool: typeof event.tool === 'string' ? event.tool.slice(0, 80) : null });
    if (Number.isInteger(event.pid) && event.pid > 1) next.claudePid = event.pid;
    if (decorate) decorate(next, prev);
    writeJsonAtomic(file, next);
  }, waitMs);
  return file;
}

// Typed, metadata-only Codex reduction. Opaque turn IDs cannot prove total
// ordering. Refuse known retired/noncurrent events and post-stop work; keep
// bounded child tombstones so an observed stop-before-start cannot reopen it.
// Only a parent SessionStart or prompt establishes an absent session.
function reduceCodexLifecycle(prev, event, nowIso = new Date().toISOString()) {
  const p = prev?.codexLifecycle === 1 ? prev : null;
  const name = event.codexEvent;
  if (name === 'SessionEnd') return p ? null : undefined;
  const isStart = name === 'SessionStart';
  const prompt = name === 'UserPromptSubmit';
  const child = !!event.codexAgentId;
  if (!p && (child || (!isStart && !prompt))) return undefined;
  let turn = p?.codexTurnId || null;
  let closed = p?.codexClosedTurn === true;
  let retired = Array.isArray(p?.codexRetiredTurns) ? p.codexRetiredTurns.filter((v) => typeof v === 'string').slice(-16) : [];
  let roster = Array.isArray(p?.codexAgents) ? p.codexAgents.filter((a) => a && typeof a.id === 'string' && ['working', 'waiting', 'done'].includes(a.status)).slice(0, 64).map((a) => ({ ...a })) : [];
  const retire = () => { if (turn && !retired.includes(turn)) retired = [...retired, turn].slice(-16); };
  if (isStart && event.codexSessionSource !== 'compact') {
    retire(); turn = null; closed = false; roster = [];
  } else if (!isStart && !child) {
    if (retired.includes(event.codexTurnId)) return undefined;
    if (prompt) {
      if (turn === event.codexTurnId && closed) return undefined;
      if (turn !== event.codexTurnId) retire();
      turn = event.codexTurnId; closed = false;
    } else {
      if (turn && event.codexTurnId !== turn) return undefined;
      if (closed) return undefined;
      turn = event.codexTurnId;
    }
  }
  if (child) {
    const found = roster.find((a) => a.id === event.codexAgentId);
    if (!found && roster.length >= 64) return undefined;
    let childRetired = Array.isArray(found?.retiredTurns) ? found.retiredTurns.slice(-8) : [];
    if (childRetired.includes(event.codexTurnId)) return undefined;
    if (found && found.turnId !== event.codexTurnId) {
      if (name !== 'UserPromptSubmit') return undefined;
      childRetired = [...childRetired, found.turnId].slice(-8);
    } else if (found?.status === 'done' && name !== 'SubagentStop') return undefined;
    const entry = { id: event.codexAgentId, turnId: event.codexTurnId, retiredTurns: childRetired,
      status: name === 'SubagentStop' ? 'done' : name === 'PermissionRequest' ? 'waiting' : 'working',
      since: found?.turnId === event.codexTurnId ? found.since : nowIso };
    roster = found ? roster.map((a) => a.id === entry.id ? entry : a) : [...roster, entry];
  }
  if (!child && (name === 'Stop' || name === 'Interrupt')) closed = true;
  const next = applyBareSignal(prev, { sessionId: event.sessionId, source: 'codex', host: prev?.host,
    cwd: child && p ? p.cwd : event.cwd,
    signal: child ? name === 'SubagentStop' ? 'subagent-done' : 'subagent-start' : event.signal, tool: child ? null : event.tool }, nowIso);
  Object.assign(next, { codexLifecycle: 1, codexHookAt: nowIso, codexEvent: name, codexTurnId: turn, codexClosedTurn: closed,
    codexRetiredTurns: retired, codexAgents: roster,
    agents: roster.map((a) => ({ id: a.id, name: 'Codex subagent', kind: 'subagent', status: a.status, since: a.since })),
    askKind: child ? p?.askKind ?? null : name === 'PermissionRequest' ? 'request' : null });
  delete next.claudePid; // Never mistake the short-lived hook process for Codex.
  return next;
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

module.exports = { retryTransient, tryLock, safeSessionId, sessionFileFor, applyAdapterEvent, reduceCodexLifecycle, processGone, TURN_END, STALE_LOCK_MS, LOCK_WAIT_MS, TRANSIENT_ASK_MS, withLock, withLockOrSkip, writeJsonAtomic, readJson, userTouched, applyBareSignal };
