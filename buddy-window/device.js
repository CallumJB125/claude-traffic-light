// "Run my cards on this Mac": enrol this Mac as a runner for one team with
// the member's Buddy account, and supervise the board runner under the app.
// Electron-free: index.js injects the account client (accounts.js), the
// vault (safeStorage) and the process fork, so tests drive it with fakes.
//
// The runner authenticates with the account's device token (bdt_, sealed by
// main), or a runner-only token if the hub mints one at enrolment (sealed in
// this controller's file). Either reaches the runner over parentPort only,
// never argv or env, and the runner never persists it (70's runner.config).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { RUNNER_SERVICE } = require('./brand');

const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS = 5;

/** "Callum's MacBook Air": what teammates see as the runner's name. */
function defaultDeviceName(userName, hostName) {
  const who = String(userName || 'My').trim();
  const mac = String(hostName || 'Mac').replace(/\.local$/i, '').replace(/[-_]+/g, ' ').trim() || 'Mac';
  return `${who}’s ${mac}`.slice(0, 100);
}

// A runner entry that is missing, or exits this soon without saying it's
// ready, isn't in this build (70's board/runner/app-entry.js lands with P4).
const NO_RUNNER_MS = 5_000;
const NO_RUNNER = 'Runner not available in this build';
// SIGTERM parks live runs within about 25 s (70's runner); then we kill.
const STOP_GRACE_MS = 30_000;
const RUNNER_STATES = ['connected', 'backoff', 'unauthenticated', 'revoked', 'unavailable', 'stopping'];
/** States in which a runner counts as on (the sidebar says so). */
const RUNNING = new Set(['starting', 'connecting', 'connected', 'backoff', 'restarting', 'unavailable']);

// The one place that knows the enrol answer's token shape: today the hub
// answers {enrollment_id, team_id} and the runner uses the account token; a
// later hub may add a runner-only brt_ token, which then wins.
function runnerTokenFrom(r) {
  const t = r?.runner_token ?? r?.device_token;
  return typeof t === 'string' && /^brt_[A-Za-z0-9_-]{10,200}$/.test(t) ? t : null;
}

/** The widget's live sessions, cut down to what teammates may see. */
function presenceSessions(sessions = []) {
  return sessions.filter((s) => s && typeof s.sessionId === 'string').slice(0, 50).map((s) => {
    const t = Date.parse(s.signalSince ?? s.updatedAt ?? '');
    return {
      session_id: s.sessionId.slice(0, 100),
      agent: typeof s.via === 'string' && s.via ? s.via.slice(0, 40) : 'claude',
      // The folder name only: a full path says who you are and how your disk is laid out.
      project: typeof s.cwd === 'string' ? path.basename(s.cwd).slice(0, 100) : '',
      state: typeof s.signal === 'string' ? s.signal.slice(0, 40) : 'unknown',
      since: new Date(Number.isFinite(t) ? t : Date.now()).toISOString(),
    };
  });
}

function createDeviceController({ account, teamId, credsFile, seal, unseal, canSeal = () => true, fork, runnerEntry, entryExists = () => fs.existsSync(runnerEntry), dataDir, onStatus = () => {}, log = () => {}, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), stopGraceMs = STOP_GRACE_MS }) {
  // account: accounts.js client for the team's hub (origin, enrol(), unenrol(), accessToken()).
  let creds = null;
  try { if (fs.existsSync(credsFile)) creds = JSON.parse(unseal(fs.readFileSync(credsFile))); } catch (e) { log('device creds unreadable; treat as not enrolled', e.message); creds = null; }
  if (creds && (creds.hub !== account.origin || creds.team_id !== teamId)) creds = null;

  let child = null;
  let starting = false;
  let runner = { state: 'off', detail: null };
  let wanted = !!creds?.enabled;
  let parked = 0;
  let presence = { enabled: false, sessions: [] };
  const restarts = [];

  const view = () => ({
    enrolled: !!creds,
    enrollment_id: creds?.enrollment_id ?? null,
    name: creds?.name ?? null,
    enabled: wanted,
    runner,
    parked,
  });
  const emit = () => { try { onStatus(view()); } catch { /* UI gone */ } };

  function persist() {
    if (!creds) { fs.rmSync(credsFile, { force: true }); return; }
    const tmp = `${credsFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, seal(JSON.stringify(creds)), { mode: 0o600 });
    fs.renameSync(tmp, credsFile);
  }

  function setRunner(state, detail = null) { runner = { state, detail }; emit(); }

  async function start() {
    if (child || starting || !creds || !wanted) return;
    if (!entryExists()) { setRunner('missing', NO_RUNNER); return; }
    starting = true;
    let token;
    try { token = creds.runner_token ?? (await account.accessToken()); } catch { token = null; } finally { starting = false; }
    if (child || !creds || !wanted) return;
    if (!token) { setRunner('unauthenticated'); return; }
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    // No args and no cwd: the entry refuses to run without a parentPort, and a
    // cwd inside app.asar makes the fork fail silently.
    const c = fork(runnerEntry, [], { serviceName: RUNNER_SERVICE, stdio: 'pipe', env: { HOME: process.env.HOME, PATH: process.env.PATH, USER: process.env.USER, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR } }); // privacy-flow: team-hub-runner
    child = c;
    c.startedAt = now();
    c.ready = false;
    setRunner('starting');
    // The runner's stderr is its own log; it never prints the token (70's runner).
    c.stderr?.on?.('data', (d) => log('runner', String(d).trimEnd()));
    c.on('message', (m) => {
      if (c !== child || !m || typeof m.type !== 'string') return;
      if (m.type === 'runner.ready') { c.ready = true; setRunner('connecting'); if (presence.enabled) send(c, presence); } else if (m.type === 'runner.status') setRunner(RUNNER_STATES.includes(m.state) ? m.state : 'unknown', typeof m.detail === 'string' ? m.detail.slice(0, 200) : null);
      else if (m.type === 'runner.stopped') { parked = Number.isInteger(m.parked) && m.parked > 0 ? m.parked : 0; emit(); } else if (m.type === 'runner.fatal') { c.fatal = true; setRunner('failed', String(m.message ?? 'The runner stopped.').slice(0, 200)); }
    });
    c.once('exit', (code) => onExit(c, code));
    c.postMessage({ type: 'runner.config', hub_url: account.origin, device_token: token, team_id: teamId, data_dir: dataDir }); // privacy-flow: team-hub-runner
  }

  function send(c, p) { try { c.postMessage({ type: 'runner.presence', enabled: p.enabled, sessions: p.enabled ? p.sessions : [] }); } catch { /* exiting */ } } // privacy-flow: team-hub-runner

  function onExit(c, code) {
    if (c !== child) return;
    child = null;
    if (!wanted) { setRunner('off'); return; }
    if (!c.ready && !c.fatal && now() - c.startedAt < NO_RUNNER_MS) { setRunner('missing', NO_RUNNER); return; }
    // Exit 2 is a config the runner refused; revoked/unauthenticated won't
    // get better either. Restarting any of them would only loop.
    if (code === 2 || ['revoked', 'unauthenticated'].includes(runner.state)) return;
    const t = now();
    while (restarts.length && t - restarts[0] > RESTART_WINDOW_MS) restarts.shift();
    if (restarts.length >= MAX_RESTARTS) { setRunner('failed', `The runner keeps stopping (last exit code ${code}).`); return; }
    restarts.push(t);
    const delay = Math.min(30_000, 1000 * 2 ** (restarts.length - 1));
    setRunner('restarting', null);
    schedule(() => (wanted && !child ? start() : undefined), delay);
  }

  function stop() {
    const c = child;
    if (!c) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { if (c.pid) process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } resolve(); }, stopGraceMs);
      c.once('exit', () => { clearTimeout(t); resolve(); });
      // SIGTERM: the runner parks its runs per the handover rules first.
      try { c.kill(); } catch { clearTimeout(t); resolve(); }
    });
  }

  return {
    status: view,
    /** Enrol this Mac in the team with the signed-in account (no service tokens). */
    async enroll({ name }) {
      if (creds) return { ok: false, error: 'This Mac is already set up for this team.' };
      const n = String(name ?? '').trim().slice(0, 100);
      if (!n) return { ok: false, error: 'Give this Mac a name.' };
      // No enrolment the hub would list for a runner that can't start here.
      if (!entryExists()) { setRunner('missing', NO_RUNNER); return { ok: false, error: `${NO_RUNNER}.` }; }
      // Nothing the hub would count as enrolled unless we can keep it sealed.
      if (!canSeal()) return { ok: false, error: 'This Mac can’t store the runner’s sign-in securely right now, so it can’t run cards.' };
      const r = await account.enrol(teamId);
      if (!r.ok) return { ok: false, error: r.signedOut ? 'Sign in again, then turn this on.' : r.error };
      if (typeof r.enrollment_id !== 'string' || !r.enrollment_id || (r.team_id != null && String(r.team_id) !== teamId)) return { ok: false, error: 'The team hub didn’t set this Mac up. Try again.' };
      creds = { hub: account.origin, team_id: teamId, enrollment_id: r.enrollment_id, runner_token: runnerTokenFrom(r), name: n, enabled: true };
      try {
        persist();
      } catch (e) {
        // An enrolment we can't remember would run nowhere and linger on the hub.
        log('could not seal the runner enrolment; undoing it', e.message);
        creds = null;
        await account.unenrol(teamId).catch(() => {});
        return { ok: false, error: 'This Mac couldn’t store the runner’s sign-in securely. Nothing was turned on.' };
      }
      wanted = true;
      emit();
      await start();
      return { ok: true };
    },
    async setEnabled(on) {
      if (!creds) return { ok: false, error: 'Set this Mac up first.' };
      wanted = !!on;
      creds.enabled = wanted;
      persist();
      if (wanted) { restarts.length = 0; await start(); } else await stop();
      emit();
      return { ok: true };
    },
    /** Stop, revoke on the hub (best effort) and forget every secret. */
    async remove() {
      wanted = false;
      await stop();
      const had = !!creds;
      creds = null;
      persist();
      if (had) await account.unenrol(teamId).catch(() => {});
      setRunner('off');
      return { ok: true };
    },
    /** Stop and forget every secret without asking the hub (signed out, or the account is gone). */
    async discard() {
      wanted = false;
      await stop();
      creds = null;
      persist();
      setRunner('off');
    },
    running: () => wanted && RUNNING.has(runner.state),
    /** Share (or stop sharing) the live sessions list; `enabled:false` clears at once. */
    setPresence(enabled, sessions = []) {
      const next = { enabled: !!enabled, sessions: enabled ? presenceSessions(sessions) : [] };
      if (JSON.stringify(next) === JSON.stringify(presence)) return;
      presence = next;
      if (child?.ready) send(child, presence);
    },
    /** App start: resume the runner if the member left it on. */
    resume() { return creds && wanted ? start() : Promise.resolve(); },
    stop: () => { wanted = false; return stop(); },
  };
}

module.exports = { createDeviceController, defaultDeviceName, presenceSessions, runnerTokenFrom, NO_RUNNER };
