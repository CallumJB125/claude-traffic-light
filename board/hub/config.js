// Hub configuration from the environment. Every variable is documented in
// hub/README.md; keep the two in sync.

import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const int = (v, d) => {
  if (v == null || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got ${v}`);
  return n;
};
const flag = (v) => v === '1' || v === 'true' || v === 'yes';

const LOCAL_BINDS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopback(host) {
  if (host === 'localhost') return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  if (isIP(host) === 6) return host === '::1' || host === '0:0:0:0:0:0:0:1';
  return false;
}

export function loadConfig(env = process.env) {
  const auth = env.BOARD_AUTH || 'access';
  const dataDir = env.BOARD_DATA_DIR ? resolve(env.BOARD_DATA_DIR) : resolve(HERE, 'data');
  const cfg = {
    bind: env.BOARD_BIND || '127.0.0.1',
    port: int(env.BOARD_PORT, 8787),
    dataDir,
    dbPath: env.BOARD_DB ? resolve(env.BOARD_DB) : join(dataDir, 'board.db'),
    auth,
    accessTeam: env.BOARD_ACCESS_TEAM || null,
    accessAud: env.BOARD_ACCESS_AUD || null,
    secret: env.BOARD_SECRET || null,
    publicUrl: env.BOARD_PUBLIC_URL || null,
    devSeed: flag(env.BOARD_DEV_SEED),
    devRepo: env.BOARD_DEV_REPO || null,
    devLoginSecret: env.BOARD_DEV_LOGIN_SECRET || null,
    localSecret: env.BOARD_LOCAL_SECRET || null,
    bootstrap: env.BOARD_BOOTSTRAP || null,
    bootstrapBoard: env.BOARD_BOOTSTRAP_BOARD || (auth === 'local' ? 'Me:ME' : 'Team:BRD'),
    restore: flag(env.BOARD_RESTORE),
    tunnelProbeUrl: env.BOARD_TUNNEL_PROBE_URL || null,
    tunnelProbeMs: int(env.BOARD_TUNNEL_PROBE_MS, 15_000),
    githubToken: env.BOARD_GITHUB_TOKEN || null,
    githubApi: env.BOARD_GITHUB_API || 'https://api.github.com',
    githubPollMs: int(env.BOARD_GITHUB_POLL_MS, 60_000),
    webDir: env.BOARD_WEB_DIR ? resolve(env.BOARD_WEB_DIR) : resolve(HERE, '..', 'web'),
    sharedDir: resolve(HERE, '..', 'shared'),
    logLevel: env.BOARD_LOG_LEVEL || 'info',
    shutdownGraceMs: int(env.BOARD_SHUTDOWN_GRACE_MS, 5_000),
  };
  delete env.BOARD_LOCAL_SECRET;
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg) {
  if (!['access', 'dev', 'local'].includes(cfg.auth)) throw new Error(`BOARD_AUTH must be access, dev or local, got ${cfg.auth}`);
  // Local = the hub embedded in the desktop app: only its own window may reach it.
  if (cfg.auth === 'local') {
    if (!LOCAL_BINDS.has(cfg.bind)) throw new Error(`BOARD_AUTH=local needs BOARD_BIND=127.0.0.1, ::1 or localhost (got ${cfg.bind})`);
    if (cfg.publicUrl || cfg.tunnelProbeUrl) throw new Error('BOARD_AUTH=local must never sit behind a proxy or tunnel: unset BOARD_PUBLIC_URL and BOARD_TUNNEL_PROBE_URL');
    if (cfg.devSeed) throw new Error('BOARD_AUTH=local does not take BOARD_DEV_SEED');
  }
  if (cfg.localSecret != null && process.parentPort) throw new Error('BOARD_LOCAL_SECRET is for tests only: the desktop app generates its own per-launch secret');
  if (cfg.localSecret != null && cfg.auth !== 'local') throw new Error('BOARD_LOCAL_SECRET needs BOARD_AUTH=local');
  if (cfg.localSecret != null && Buffer.byteLength(cfg.localSecret) < 32) throw new Error('BOARD_LOCAL_SECRET must be at least 32 bytes');
  if (cfg.devSeed && cfg.auth !== 'dev') throw new Error('BOARD_DEV_SEED needs BOARD_AUTH=dev');
  if (cfg.auth === 'dev' && !isLoopback(cfg.bind)) throw new Error(`BOARD_AUTH=dev is allowed only on a loopback bind (BOARD_BIND=${cfg.bind})`);
  // Behind a proxy or tunnel every request arrives from loopback, so the
  // loopback check on /api/dev/login proves nothing there: refuse outright.
  if (cfg.auth === 'dev' && (cfg.publicUrl || cfg.tunnelProbeUrl)) throw new Error('BOARD_AUTH=dev must never sit behind a proxy or tunnel: unset BOARD_PUBLIC_URL and BOARD_TUNNEL_PROBE_URL, or use BOARD_AUTH=access');
  if (cfg.devLoginSecret != null && Buffer.byteLength(cfg.devLoginSecret) < 16) throw new Error('BOARD_DEV_LOGIN_SECRET must be at least 16 bytes');
  if (cfg.auth === 'access' && (!cfg.accessTeam || !cfg.accessAud)) throw new Error('BOARD_AUTH=access needs BOARD_ACCESS_TEAM and BOARD_ACCESS_AUD');
  if (cfg.secret != null && Buffer.byteLength(cfg.secret) < 32) throw new Error('BOARD_SECRET must be at least 32 bytes');
  return cfg;
}
