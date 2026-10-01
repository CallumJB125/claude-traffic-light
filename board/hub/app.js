// Wiring: DB → Hub (boot: restore bump, new hub_epoch, hub_boot per live
// card) → HTTP + WS server → timers (1 s reaper, GitHub merge poll, tunnel
// self-probe) → graceful shutdown. Tests build this with a fake clock and
// drive hub.tick() themselves (timers: false).

import { loadKey, loadPreviousKey } from './vault.js';
import { createBus } from './bus.js';
import { createIntegrations } from './integrations/registry.js';
import { connectorsFor } from './integrations/index.js';
import { createServer } from 'node:http'; // privacy-flow: local-board-hub
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws'; // privacy-flow: local-board-hub
import { WS_CLOSE } from '../shared/protocol.js';
import { REAPER_MS, TIME_SCALE } from '../shared/liveness.js';
import { openDb } from './db.js';
import { Hub, defaultClock } from './hub.js';
import { Api } from './api.js';
import { createAccessVerifier } from './auth.js';
import { createGitHub, noGitHub } from './github.js';
import { createHttpHandler, createUpgradeHandler, makeAuthenticate, REQUEST_LIMITS } from './http.js';
import { createLogger } from './log.js';
import { seedDev, seedLocal, bootstrapAdmin } from './seed.js';
import { Accounts } from './identity/accounts.js';
import { createMailer } from './identity/mailer.js';
import { Teams } from './identity/teams.js';
import { Invites } from './identity/invites.js';
import { Clients } from './identity/clients.js';
import { ClientArtifacts } from './identity/client-artifacts.js';
import { ClientFeedback } from './identity/client-feedback.js';
import { OAuth } from './identity/oauth.js';
import { Enrolments } from './identity/enrolments.js';
import { oauthProviders } from './config.js';

export function createApp(config, { clock = defaultClock, log = createLogger({ level: config.logLevel }), github = null, fetchImpl = globalThis.fetch, timers = true, mailer } = {}) { // privacy-flow: hub-server
  const db = openDb(config.dbPath, { now: () => new Date(clock.wall()).toISOString() });
  const gh = github ?? (config.githubToken ? createGitHub({ token: config.githubToken, api: config.githubApi, fetchImpl }) : noGitHub);
  if (config.auth !== 'local' && db.meta('local_member')) {
    db.close();
    throw new Error('this database belongs to the desktop app (BOARD_AUTH=local)');
  }
  const hub = new Hub({ db, config, clock, log, github: gh });
  // Dev login needs this per-process secret (header Board-Dev-Secret), printed
  // at startup: a loopback bind alone does not prove who is asking.
  hub.devLoginSecret = config.auth === 'dev' ? (config.devLoginSecret ?? randomBytes(18).toString('base64url')) : null;
  hub.access = config.auth === 'access'
    ? createAccessVerifier({ team: config.accessTeam, aud: config.accessAud, fetchImpl, now: clock.wall })
    : null;
  // Local mode (D35): a fresh per-launch secret the embedding app sets as the
  // board_local cookie; never logged or printed.
  hub.localSecret = config.auth === 'local' ? (config.localSecret ?? randomBytes(32).toString('hex')) : null;
  hub.localMemberId = config.auth === 'local' ? seedLocal(hub, config.bootstrapBoard) : null;
  // Accounts mode (D51): its own sign-in; the BOARD_BOOTSTRAP owner is linked
  // to whoever first proves that email address.
  hub.accounts = config.auth === 'accounts' ? new Accounts(hub, { mailer: mailer !== undefined ? mailer : createMailer(config, { fetchImpl, now: () => new Date(clock.wall()) }) }) : null;
  hub.teams = hub.accounts ? new Teams(hub, { accounts: hub.accounts }) : null;
  hub.invites = hub.accounts ? new Invites(hub, { accounts: hub.accounts, teams: hub.teams }) : null;
  hub.clients = hub.accounts ? new Clients(hub) : null;
  hub.clientArtifacts = hub.clients ? new ClientArtifacts(hub) : null;
  hub.clientFeedback = hub.clients ? new ClientFeedback(hub) : null;
  hub.oauth = hub.accounts ? new OAuth(hub, { accounts: hub.accounts, fetchImpl }) : null;
  hub.enrolments = hub.accounts ? new Enrolments(hub, { accounts: hub.accounts }) : null;
  // Deleting an account or a team needs a step-up: an email code (a mailer)
  // or an OAuth re-authentication (a configured provider). Without either,
  // say so, and how an operator erases.
  if (hub.accounts && !hub.accounts.mailer && !oauthProviders(config).length && db.get('SELECT 1 AS x FROM users WHERE deleted_at IS NULL LIMIT 1')) {
    log.warn('account and team deletion is unavailable: no mailer and no OAuth sign-in method for the step-up; an operator can erase with `node hub/admin.js delete-user <email>` or `delete-team <slug>`');
  }
  if (config.devSeed) seedDev(hub, { repoUrl: config.devRepo });
  if (config.bootstrap) bootstrapAdmin(hub, config.bootstrap, config.bootstrapBoard);
  hub.boot();
  // D41: a hub outside the desktop app loads its integrations key from
  // BOARD_ENC_KEY or a keyfile outside the data dir (D36 covers local mode).
  if (config.auth !== 'local') {
    const key = loadKey({ dataDir: config.dataDir, hasParentPort: !!process.parentPort, refusePlaceholder: config.auth === 'accounts' });
    const previous = loadPreviousKey({ hasParentPort: !!process.parentPort, refusePlaceholder: config.auth === 'accounts' });
    if (key) hub.setVaultKey(key, previous);
  }

  const api = new Api(hub);
  // Integrations (D40/D41): consumers read the journal through the bus.
  const bus = createBus({ db, log });
  hub.on('journal', () => bus.poke());
  const integrations = createIntegrations({ hub, api, bus, log, fetchImpl, publicUrl: config.publicUrl });
  for (const c of connectorsFor(config)) integrations.register(c);
  // Expired pending connections (D97) go with the reaper (the registry runs it at most once a minute).
  hub.sweepIntegrationsPending = () => integrations.sweepPending();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 }); // privacy-flow: local-board-hub
  const handler = createHttpHandler({ hub, api, config, integrations });
  const lim = { ...REQUEST_LIMITS, ...config.requestLimits };
  const server = createServer({
    requestTimeout: lim.requestTimeoutMs, headersTimeout: lim.headersTimeoutMs, keepAliveTimeout: lim.keepAliveTimeoutMs, connectionsCheckingInterval: lim.checkIntervalMs,
  }, handler);
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
          const res = await fetchImpl(config.tunnelProbeUrl, { signal: AbortSignal.timeout(10_000), redirect: 'manual' }); // privacy-flow: hub-server
          hub.noteTunnel(res.ok && res.headers.get('board-protocol') != null);
        } catch {
          hub.noteTunnel(false);
        }
      };
      probe();
      intervals.push(setInterval(probe, config.tunnelProbeMs));
    }
    for (const i of intervals) i.unref?.();
    bus.start();
  }

  return {
    hub, api, server, db, config, routes: handler.routes, devLoginSecret: hub.devLoginSecret, integrations, bus,
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
      bus.stop();
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
