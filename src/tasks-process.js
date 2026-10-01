// Electron-free supervisor for the Tasks utilityProcess. No CLI/task text,
// auth key, stderr or environment value is sent to a renderer or app log.
'use strict';
const path = require('node:path');
const WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS = 5;
const PASS = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'TZ', 'CODEX_HOME'];
function tasksEnv(dataDir, base = process.env) {
  const env = {};
  for (const k of PASS) if (typeof base[k] === 'string') env[k] = base[k];
  env.PLEXIFORM_TASKS_DATA_DIR = dataDir;
  return env;
}

function createTasksSupervisor({ fork, entry, dataDir, env = process.env, onStatus = () => {},
  now = Date.now, readyTimeoutMs = 20_000, shutdownGraceMs = 20_000, killPid = process.kill.bind(process),
  timers = { setTimeout, clearTimeout } }) {
  let child = null; let ready = null; let info = null; let disposed = false; let stopping = false; let state = 'stopped';
  const restarts = [];
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
        // Drain outputs without retaining them: errors can contain personal paths.
        c.stderr?.on('data', () => {}); c.stdout?.on('data', () => {});
        c.on('message', (m) => {
          if (m?.type === 'tasks.fatal') fail();
          if (m?.type !== 'tasks.listening' || m.socket !== path.join(dataDir, 'tasks.sock') || !/^[0-9a-f-]{36}$/.test(m.epoch ?? '')) return;
          if (disposed || stopping || child !== c) return fail();
          info = { socketPath: m.socket, epoch: m.epoch }; status('ready'); resolve(info);
        });
        c.once('error', fail);
        c.once('exit', () => {
          if (child !== c) return;
          child = null; info = null;
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
    async stop({ final = false } = {}) {
      if (final) disposed = true;
      stopping = true; const c = child; ready = null; info = null;
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
