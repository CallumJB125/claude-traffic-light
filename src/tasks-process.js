// Electron-free supervisor for the Tasks utilityProcess. No CLI/task text,
// auth key, stderr or environment value is sent to a renderer or app log.
'use strict';
const path = require('node:path');
const { loginEnvMessage } = require('./login-env-hub.js');
const WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS = 5;
// Main's note ops over parentPort (board/tasks-engine/parent-bus.js): bounded, never queued without limit.
const BUS_MAX_INFLIGHT = 64;
const BUS_TIMEOUT_MS = 12_000;
const busError = (code) => Object.assign(new Error(code === 'TIMEOUT' ? 'The Tasks helper did not answer in time' : 'The Tasks helper is not available'), { code });
// CLAUDE_TRAFFIC_LIGHT_HOME: main's data folder when overridden, where the engine reads spend-gate.json (the router's spend gate).
const PASS = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'TZ', 'CODEX_HOME', 'CLAUDE_TRAFFIC_LIGHT_HOME'];
function tasksEnv(dataDir, base = process.env) {
  const env = {};
  for (const k of PASS) if (typeof base[k] === 'string') env[k] = base[k];
  env.PLEXIFORM_TASKS_DATA_DIR = dataDir;
  return env;
}

// onRuns(rows): the helper's wrapped runs (O1b), [] whenever it is not running; peersForTask(taskId): main's answer
// to a wrapped run's bus_peers. onWork(rows): the helper's wrapped tasks that did real work (O3), for automatic cards;
// [] whenever it is not running.
function createTasksSupervisor({ fork, entry, dataDir, env = process.env, onStatus = () => {}, onRuns = () => {}, peersForTask = async () => null, onWork = () => {},
  loginEnv = () => null, now = Date.now, readyTimeoutMs = 20_000, shutdownGraceMs = 20_000, killPid = process.kill.bind(process),
  timers = { setTimeout, clearTimeout } }) {
  let child = null; let ready = null; let info = null; let disposed = false; let stopping = false; let state = 'stopped';
  const restarts = [];
  // id → {child, resolve, reject, timer}. An answer counts only from the child the request went to.
  const pending = new Map();
  let busSeq = 0;
  const rejectPending = (c, code) => { for (const [id, p] of pending) if (!c || p.child === c) { pending.delete(id); timers.clearTimeout(p.timer); p.reject(busError(code)); } };
  // The login-shell values (src/login-env-hub.js) go over parentPort only: never argv, env or a log line.
  const sendLoginEnvTo = (c, values) => { if (values && c) { try { c.postMessage(loginEnvMessage(values)); } catch { /* exiting */ } } };
  const status = (s) => { state = s; try { onStatus({ state, restarts: restarts.length }); } catch { /* UI may be gone */ } };
  function start() {
    while (restarts.length && now() - restarts[0] > WINDOW_MS) restarts.shift();
    if (restarts.length >= MAX_RESTARTS) { status('failed'); return Promise.reject(new Error('Tasks helper keeps stopping')); }
    if (disposed || stopping) return Promise.reject(new Error('Tasks helper is stopping'));
    status('starting');
    let c;
    let timer;
    const p = new Promise((resolve, reject) => {
      const fail = () => reject(new Error('Tasks helper could not start'));
      try {
        c = fork(entry, [], { env: tasksEnv(dataDir, env), serviceName: 'Plexiform Tasks', stdio: 'pipe' }); // privacy-flow: tasks-process
        child = c;
        sendLoginEnvTo(c, loginEnv());
        // Drain outputs without retaining them: errors can contain personal paths.
        c.stderr?.on('data', () => {}); c.stdout?.on('data', () => {});
        c.on('message', (m) => {
          if (m?.type === 'tasks.busResult') {
            const p = typeof m.id === 'string' ? pending.get(m.id) : null;
            if (!p || p.child !== c) return;
            pending.delete(m.id); timers.clearTimeout(p.timer);
            if (m.ok === true) p.resolve(m.result);
            else p.reject(Object.assign(new Error('The Tasks helper refused the request'), { code: typeof m.code === 'string' ? m.code.slice(0, 32) : 'INTERNAL' }));
            return;
          }
          if (m?.type === 'tasks.fatal') fail();
          if (m?.type === 'tasks.runs' && child === c) { try { onRuns(Array.isArray(m.runs) ? m.runs : []); } catch { /* main's view only */ } return; }
          if (m?.type === 'awareness.peers' && child === c && Number.isSafeInteger(m.id) && typeof m.taskId === 'string') {
            Promise.resolve().then(() => peersForTask(m.taskId)).catch(() => null)
              .then((result) => { if (child === c) { try { c.postMessage({ type: 'awareness.peers.reply', id: m.id, result: result ?? null }); } catch { /* gone */ } } });
            return;
          }
          if (m?.type === 'tasks.work' && child === c) { try { onWork(Array.isArray(m.rows) ? m.rows : []); } catch { /* cards only */ } return; }
          if (m?.type !== 'tasks.listening' || m.socket !== path.join(dataDir, 'tasks.sock') || !/^[0-9a-f-]{36}$/.test(m.epoch ?? '')) return;
          if (disposed || stopping || child !== c) return fail();
          sendLoginEnvTo(c, loginEnv());
          info = { socketPath: m.socket, epoch: m.epoch }; status('ready'); resolve(info);
        });
        c.once('error', fail);
        c.once('exit', () => {
          rejectPending(c, 'UNAVAILABLE');
          if (child !== c) return;
          child = null; info = null;
          try { onRuns([]); } catch { /* main's view only */ }
          try { onWork([]); } catch { /* cards only */ }
          if (stopping || disposed) { status('stopped'); return; }
          const wasReady = state === 'ready'; ready = null; restarts.push(now()); status('failed');
          if (!wasReady) fail();
          // Service reconnection calls ensure after its own bounded backoff.
        });
        timer = timers.setTimeout(fail, readyTimeoutMs); timer.unref?.();
      } catch { fail(); }
    });
    ready = p;
    p.finally(() => timers.clearTimeout(timer)).catch(() => {});
    p.catch(() => {
      if (child === c && c) {
        try { c.kill(); } catch { /* gone */ }
        const force = timers.setTimeout(() => {
          if (child === c) { try { if (c.pid) killPid(c.pid, 'SIGKILL'); else c.kill(); } catch { /* gone */ } }
        }, 2000); force.unref?.();
        c.once('exit', () => timers.clearTimeout(force));
      } else if (ready === p) ready = null;
      if (!stopping && !disposed) status('failed');
    });
    return p;
  }
  return {
    ensure() { if (disposed) return Promise.reject(new Error('Tasks helper is stopped')); return ready || start(); },
    status: () => ({ state, restarts: restarts.length }),
    /** Re-send the login-shell values after main re-read them (a provider or settings change). */
    sendLoginEnv(values) { sendLoginEnvTo(child, values); },
    // One note op to the running helper over parentPort. Refused at once (UNAVAILABLE) with no ready helper or
    // BUS_MAX_INFLIGHT in flight; TIMEOUT after timeoutMs, and a late answer is dropped; the helper exiting or
    // being replaced, or stop(), rejects what is pending. A timeout is ambiguous: the helper may have acted.
    busMain(op, args = {}, { timeoutMs = BUS_TIMEOUT_MS } = {}) {
      const c = child;
      if (!c || state !== 'ready' || stopping || disposed) return Promise.reject(busError('UNAVAILABLE'));
      if (pending.size >= BUS_MAX_INFLIGHT) return Promise.reject(busError('UNAVAILABLE'));
      busSeq += 1;
      const id = `b${busSeq}`;
      return new Promise((resolve, reject) => {
        const timer = timers.setTimeout(() => { if (pending.get(id)?.child === c) { pending.delete(id); reject(busError('TIMEOUT')); } }, timeoutMs);
        timer.unref?.();
        pending.set(id, { child: c, resolve, reject, timer });
        try { c.postMessage({ type: 'tasks.bus', id, op, args }); } catch { pending.delete(id); timers.clearTimeout(timer); reject(busError('UNAVAILABLE')); }
      });
    },
    async stop({ final = false } = {}) {
      if (final) disposed = true;
      stopping = true; const c = child; ready = null; info = null;
      rejectPending(null, 'UNAVAILABLE');
      if (c) await new Promise((resolve) => {
        const t = timers.setTimeout(() => { try { if (c.pid) killPid(c.pid, 'SIGKILL'); else c.kill(); } catch { /* gone */ } resolve(); }, shutdownGraceMs);
        c.once('exit', () => { timers.clearTimeout(t); resolve(); });
        try { c.postMessage({ type: 'tasks.shutdown' }); } catch { try { c.kill(); } catch { timers.clearTimeout(t); resolve(); } }
      });
      if (child === c) child = null;
      status('stopped'); stopping = false;
    },
  };
}
module.exports = { createTasksSupervisor, tasksEnv };
