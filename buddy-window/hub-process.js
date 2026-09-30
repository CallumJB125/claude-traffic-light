// Supervises the embedded board hub (board/hub/server.js) in an Electron
// utilityProcess. Electron-free: main.js injects `fork`, so tests drive it
// with a fake child.
//
// Modes:
//   local — BOARD_AUTH=local (callumbaker-70's hub work). The hub picks its own
//           port and a per-launch secret and reports both over parentPort
//           ({type:'board.listening', port, hub_epoch, local_secret}); the
//           secret never goes through env, where same-user processes can read it.
//   dev   — BOARD_AUTH=dev + seed, unpackaged builds only, until local auth
//           lands. We pick the port and poll /api/health for readiness.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS = 5;
const READY_TIMEOUT_MS = 20_000;
const SHUTDOWN_GRACE_MS = 5_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitForHealth(port, { fetchImpl = fetch, timeoutMs = READY_TIMEOUT_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return await res.json();
    } catch { /* not listening yet */ }
    await sleep(150);
  }
  throw new Error(`board hub did not answer /api/health within ${timeoutMs} ms`);
}

// Only what the hub needs: no member credentials or tokens from our own env
// reach it (same allowlist idea as the runner's CLI env, CONTRACT D15).
const ENV_PASS = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'TZ'];

function hubEnv({ mode, dataDir, port, devSecret, baseEnv = process.env }) {
  const env = {};
  for (const k of ENV_PASS) if (baseEnv[k] != null) env[k] = baseEnv[k];
  Object.assign(env, {
    BOARD_BIND: '127.0.0.1',
    BOARD_DATA_DIR: dataDir,
    BOARD_LOG_LEVEL: 'info',
  });
  if (mode === 'dev') {
    Object.assign(env, { BOARD_AUTH: 'dev', BOARD_PORT: String(port), BOARD_DEV_SEED: '1', BOARD_DEV_LOGIN_SECRET: devSecret });
  } else {
    Object.assign(env, { BOARD_AUTH: 'local', BOARD_PORT: '0' });
  }
  return env;
}

/**
 * createHubSupervisor({fork, hubEntry, dataDir, mode, isPackaged, onStatus, log})
 *   .ensure()  → Promise<{url, port, mode, localSecret?, devSecret?}> (starts lazily, once)
 *   .stop()    → Promise (SIGTERM, then kill after the grace)
 *   .status()  → {state:'stopped'|'starting'|'ready'|'failed', error?, restarts}
 */
function createHubSupervisor(opts) {
  const {
    fork, hubEntry, dataDir, isPackaged = false, onStatus = () => {}, log = () => {},
    now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms).unref?.(), fetchImpl = fetch, readyTimeoutMs = READY_TIMEOUT_MS, pickPort = freePort,
  } = opts;
  const mode = opts.mode === 'dev' ? 'dev' : 'local';
  if (mode === 'dev' && isPackaged) throw new Error('dev hub auth is never allowed in a packaged build');

  let child = null;
  let ready = null; // Promise of the current start
  let info = null;
  let state = 'stopped';
  let lastError = null;
  let stopping = false;
  const restarts = [];

  const set = (s, extra = {}) => { state = s; onStatus({ state, ...extra, restarts: restarts.length }); };

  function start() {
    ready = (async () => {
      set('starting');
      const devSecret = mode === 'dev' ? crypto.randomBytes(24).toString('base64url') : null;
      const port = mode === 'dev' ? await pickPort() : 0;
      // The hub's DB holds the board; only this user may read it.
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dataDir, 0o700);
      const env = hubEnv({ mode, dataDir, port, devSecret });
      const c = fork(hubEntry, [], { env, cwd: path.dirname(path.dirname(hubEntry)), serviceName: 'Buddy Board Hub', stdio: 'pipe' });
      child = c;
      c.stderr?.on?.('data', (d) => log('stderr', String(d).trimEnd()));
      c.stdout?.on?.('data', (d) => log('stdout', String(d).trimEnd()));

      const reported = new Promise((resolve, reject) => {
        c.on('message', (m) => {
          if (m?.type === 'board.listening' && Number.isInteger(m.port)) resolve(m);
          else if (m?.type === 'board.fatal') reject(new Error(String(m.message ?? 'board hub failed to start')));
        });
        c.once('exit', (code) => reject(new Error(`board hub exited during start (code ${code})`)));
      });
      reported.catch(() => {});

      c.once('exit', (code) => onExit(c, code));

      let result;
      if (mode === 'dev') {
        await Promise.race([waitForHealth(port, { fetchImpl, timeoutMs: readyTimeoutMs }), reported.then(() => new Promise(() => {}))]);
        result = { mode, port, url: `http://127.0.0.1:${port}`, devSecret };
      } else {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('board hub did not report its port in time')), readyTimeoutMs).unref?.());
        const m = await Promise.race([reported, timeout]);
        if (typeof m.local_secret !== 'string' || m.local_secret.length < 32) throw new Error('board hub reported no local secret (is BOARD_AUTH=local on this hub?)');
        result = { mode, port: m.port, url: `http://127.0.0.1:${m.port}`, localSecret: m.local_secret, hubEpoch: m.hub_epoch ?? null };
      }
      info = result;
      lastError = null;
      set('ready', { url: result.url });
      return result;
    })();
    ready.catch((e) => {
      lastError = e.message;
      log('start failed', e.message);
      try { child?.kill(); } catch { /* already gone */ }
      set('failed', { error: e.message });
      ready = null;
    });
    return ready;
  }

  function onExit(c, code) {
    if (c !== child) return;
    child = null;
    info = null;
    if (stopping) { set('stopped'); return; }
    const t = now();
    while (restarts.length && t - restarts[0] > RESTART_WINDOW_MS) restarts.shift();
    if (state !== 'ready') return; // a start failure is reported by start(), not restarted
    if (restarts.length >= MAX_RESTARTS) {
      lastError = `board hub keeps crashing (${MAX_RESTARTS} restarts in 10 min, last exit code ${code})`;
      ready = null;
      set('failed', { error: lastError });
      return;
    }
    restarts.push(t);
    const delay = Math.min(30_000, 500 * 2 ** (restarts.length - 1));
    log('hub exited; restarting', { code, delay });
    ready = null;
    set('restarting', { delay });
    schedule(() => { if (!stopping && !child) start().catch(() => {}); }, delay);
  }

  return {
    mode,
    ensure() {
      stopping = false;
      if (ready) return ready;
      return start();
    },
    /** A manual retry after a 'failed' state clears the crash budget. */
    retry() { restarts.length = 0; ready = null; return this.ensure(); },
    status: () => ({ state, error: lastError, restarts: restarts.length, url: info?.url ?? null }),
    async stop({ graceMs = SHUTDOWN_GRACE_MS } = {}) {
      stopping = true;
      const c = child;
      if (!c) return;
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { if (c.pid) process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } resolve(); }, graceMs);
        c.once('exit', () => { clearTimeout(t); resolve(); });
        // utilityProcess.kill() sends SIGTERM; the hub's handler closes the DB cleanly.
        try { c.kill(); } catch { clearTimeout(t); resolve(); }
      });
      child = null;
      ready = null;
      set('stopped');
    },
  };
}

module.exports = { createHubSupervisor, hubEnv, waitForHealth, freePort, MAX_RESTARTS, RESTART_WINDOW_MS };
