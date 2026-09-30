// Wiring: DB → Hub (boot: restore bump, new hub_epoch, hub_boot per live
// card) → HTTP + WS server → timers (1 s reaper, GitHub merge poll, tunnel
// self-probe) → graceful shutdown. Tests build this with a fake clock and
// drive hub.tick() themselves (timers: false).

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { WS_CLOSE } from '../shared/protocol.js';
import { REAPER_MS, TIME_SCALE } from '../shared/liveness.js';
import { openDb } from './db.js';
import { Hub, defaultClock } from './hub.js';
import { Api } from './api.js';
import { createAccessVerifier } from './auth.js';
import { createGitHub, noGitHub } from './github.js';
import { createHttpHandler, createUpgradeHandler, makeAuthenticate } from './http.js';
import { createLogger } from './log.js';
import { seedDev, bootstrapAdmin } from './seed.js';

export function createApp(config, { clock = defaultClock, log = createLogger({ level: config.logLevel }), github = null, fetchImpl = globalThis.fetch, timers = true } = {}) {
  const db = openDb(config.dbPath, { now: () => new Date(clock.wall()).toISOString() });
  const gh = github ?? (config.githubToken ? createGitHub({ token: config.githubToken, api: config.githubApi, fetchImpl }) : noGitHub);
  const hub = new Hub({ db, config, clock, log, github: gh });
  // Dev login needs this per-process secret (header Board-Dev-Secret), printed
  // at startup: a loopback bind alone does not prove who is asking.
  hub.devLoginSecret = config.auth === 'dev' ? (config.devLoginSecret ?? randomBytes(18).toString('base64url')) : null;
  hub.access = config.auth === 'access'
    ? createAccessVerifier({ team: config.accessTeam, aud: config.accessAud, fetchImpl, now: clock.wall })
    : null;
  if (config.devSeed) seedDev(hub, { repoUrl: config.devRepo });
  if (config.bootstrap) bootstrapAdmin(hub, config.bootstrap, config.bootstrapBoard);
  hub.boot();

  const api = new Api(hub);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const server = createServer(createHttpHandler({ hub, api, config }));
  server.on('upgrade', createUpgradeHandler({ hub, config, wss, authenticate: makeAuthenticate({ hub, config }) }));

  if (TIME_SCALE !== 1) log.warn('BOARD_TEST_TIME_SCALE is set: every liveness timer is compressed (tests only)', { scale: TIME_SCALE });
  const intervals = [];
  let ticking = false;
  let closed = false;
  function startTimers() {
    intervals.push(setInterval(async () => {
      if (ticking || closed) return;
      ticking = true;
      try { await hub.tick(); } catch (e) { log.error('reaper tick failed', { err: e }); } finally { ticking = false; }
    }, REAPER_MS));
    if (gh.enabled) {
      intervals.push(setInterval(() => { hub.pollMerges().catch((e) => log.warn('merge poll failed', { err: e })); }, config.githubPollMs));
    }
    if (config.tunnelProbeUrl) {
      const probe = async () => {
        try {
          // Healthy only when the answer came from this hub through the edge
          // (an Access login page or a 530 from Cloudflare is not the origin).
          const res = await fetchImpl(config.tunnelProbeUrl, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
          hub.noteTunnel(res.ok && res.headers.get('board-protocol') != null);
        } catch {
          hub.noteTunnel(false);
        }
      };
      probe();
      intervals.push(setInterval(probe, config.tunnelProbeMs));
    }
    for (const i of intervals) i.unref?.();
  }

  return {
    hub, api, server, db, config, devLoginSecret: hub.devLoginSecret,
    listen(port = config.port, host = config.bind) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          if (timers) startTimers();
          // Warm the JWKS cache so the first sign-in doesn't wait on it. Not
          // fatal: until a fetch succeeds, requests get 503 / close 4503.
          hub.access?.refresh().catch((e) => log.warn('Access JWKS prefetch failed', { err: e }));
          log.info('hub listening', { bind: host, port: server.address().port, auth: config.auth });
          resolve(server.address());
        });
      });
    },
    async close({ graceMs = config.shutdownGraceMs ?? 5000 } = {}) {
      if (closed) return;
      closed = true;
      for (const i of intervals) clearInterval(i);
      const done = new Promise((resolve) => server.close(() => resolve()));
      const grace = () => new Promise((r) => setTimeout(r, graceMs).unref());
      const handshakes = [...wss.clients].map((ws) => new Promise((r) => { if (ws.readyState === 3) r(); else ws.once('close', r); }));
      for (const ws of wss.clients) ws.close(WS_CLOSE.HUB_SHUTDOWN, 'hub shutting down');
      server.closeIdleConnections?.();
      await Promise.race([Promise.all([hub.idle(), ...handshakes]), grace()]);
      server.closeAllConnections?.();
      for (const ws of wss.clients) ws.terminate();
      await Promise.race([done, grace()]);
      db.close();
      log.info('hub stopped');
    },
  };
}
