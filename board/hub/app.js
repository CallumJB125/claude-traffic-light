// Wiring: DB → Hub (boot: restore bump, new hub_epoch, hub_boot per live
// card) → HTTP + WS server → timers (1 s reaper, GitHub merge poll, tunnel
// self-probe) → graceful shutdown. Tests build this with a fake clock and
// drive hub.tick() themselves (timers: false).

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { WS_CLOSE } from '../shared/protocol.js';
import { openDb } from './db.js';
import { Hub, defaultClock } from './hub.js';
import { Api } from './api.js';
import { createAccessVerifier } from './auth.js';
import { createGitHub, noGitHub } from './github.js';
import { createHttpHandler, createUpgradeHandler, makeAuthMember } from './http.js';
import { createLogger } from './log.js';
import { seedDev, bootstrapAdmin } from './seed.js';

export function createApp(config, { clock = defaultClock, log = createLogger({ level: config.logLevel }), github = null, fetchImpl = globalThis.fetch, timers = true } = {}) {
  const db = openDb(config.dbPath, { now: () => new Date(clock.wall()).toISOString() });
  const gh = github ?? (config.githubToken ? createGitHub({ token: config.githubToken, api: config.githubApi, fetchImpl }) : noGitHub);
  const hub = new Hub({ db, config, clock, log, github: gh });
  hub.access = config.auth === 'access'
    ? createAccessVerifier({ team: config.accessTeam, aud: config.accessAud, fetchImpl, now: clock.wall })
    : null;
  if (config.devSeed) seedDev(hub, { repoUrl: config.devRepo });
  if (config.bootstrap) bootstrapAdmin(hub, config.bootstrap, config.bootstrapBoard);
  hub.boot();

  const api = new Api(hub);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const server = createServer(createHttpHandler({ hub, api, config }));
  server.on('upgrade', createUpgradeHandler({ hub, config, wss, authMember: makeAuthMember({ hub, config }) }));

  const intervals = [];
  let ticking = false;
  let closed = false;
  function startTimers() {
    intervals.push(setInterval(async () => {
      if (ticking || closed) return;
      ticking = true;
      try { await hub.tick(); } catch (e) { log.error('reaper tick failed', { err: e }); } finally { ticking = false; }
    }, 1000));
    if (gh.enabled) {
      intervals.push(setInterval(() => { hub.pollMerges().catch((e) => log.warn('merge poll failed', { err: e })); }, config.githubPollMs));
    }
    if (config.tunnelProbeUrl) {
      const probe = async () => {
        try {
          const res = await fetchImpl(config.tunnelProbeUrl, { signal: AbortSignal.timeout(10_000) });
          hub.noteTunnel(res.ok);
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
    hub, api, server, db, config,
    listen(port = config.port, host = config.bind) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          if (timers) startTimers();
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
      for (const c of [...hub.runners.values(), ...hub.browsers]) c.close(WS_CLOSE.HUB_SHUTDOWN, 'hub shutting down');
      server.closeIdleConnections?.();
      await Promise.race([hub.idle(), new Promise((r) => setTimeout(r, graceMs).unref())]);
      server.closeAllConnections?.();
      for (const ws of wss.clients) ws.terminate();
      await Promise.race([done, new Promise((r) => setTimeout(r, graceMs).unref())]);
      db.close();
      log.info('hub stopped');
    },
  };
}
