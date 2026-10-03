// "Run my cards on this Mac": enrol this install as a runner for one team
// (P4, POST /api/teams/:id/enrol) and supervise that team's board runner
// under the app. Electron-free: index.js injects the account client
// (accounts.js), the vault (safeStorage) and the process fork, so tests drive
// it with fakes.
//
// The hub answers an enrolment with a runner token (brt_) for this team only,
// shown once. It is sealed in this controller's own file (0600, one per hub
// and team) and reaches the runner over parentPort only: never argv, env, a
// log line or a plaintext file. The account's device token never reaches the
// runner.
'use strict';
const { storageHelp } = require('./secure-storage');

const fs = require('node:fs');
const path = require('node:path');
const { RUNNER_SERVICE } = require('./brand');
const WindowsPrivate = require('../board/shared/windows-private-directory.cjs');

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
const RUNNER_STATES = ['connected', 'backoff', 'unavailable', 'stopping'];
/** States in which a runner counts as on (the sidebar says so). */
const RUNNING = new Set(['starting', 'connecting', 'connected', 'backoff', 'restarting', 'unavailable']);
// The runner's own words for its socket closing 4401 / 4403 (D37a): the hub
// ended this enrolment, and the runner won't reconnect.
const ENDED = { unauthenticated: 4401, revoked: 4403 };

const RUNNER_TOKEN_RE = /^brt_[A-Za-z0-9_-]{43}$/;
/** The enrol answer's runner token, or null: only a runner token, never the account's own. */
function runnerTokenFrom(r) {
  const t = r?.runner_token;
  return typeof t === 'string' && RUNNER_TOKEN_RE.test(t) ? t : null;
}

// The runner's stderr is its own log; should it ever echo a token, it stops here.
const scrubTokens = (s) => String(s).replace(/\b(?:brt|bdt)_[A-Za-z0-9_-]+/g, '<token>');

// A session's one line for teammates: its own summary if it has one, else
// the tool it is using. The runner redacts it again before it leaves.
function summaryOf(s) {
  const t = typeof s.summary === 'string' && s.summary.trim() ? s.summary : (typeof s.tool === 'string' && s.tool ? `Using ${s.tool}` : '');
  const line = t.replace(/\s+/g, ' ').trim().slice(0, 120);
  return line || null;
}

/** The widget's live sessions, cut down to what teammates may see; summaries only when asked for. */
function presenceSessions(sessions = [], { summaries = false } = {}) {
  return sessions.filter((s) => s && typeof s.sessionId === 'string').slice(0, 50).map((s) => {
    const t = Date.parse(s.signalSince ?? s.updatedAt ?? '');
    const out = {
      session_id: s.sessionId.slice(0, 100),
      agent: typeof s.via === 'string' && s.via ? s.via.slice(0, 40) : 'claude',
      // The runner needs the folder to find which repo this is (it reads the folder's git origin). It
      // crosses only the private channel to the runner on this Mac; the runner sends the hub the repo,
      // branch and state, never a path (D37b).
      cwd: typeof s.cwd === 'string' ? s.cwd.slice(0, 1000) : '',
      state: typeof s.signal === 'string' ? s.signal.slice(0, 40) : 'unknown',
      since: new Date(Number.isFinite(t) ? t : Date.now()).toISOString(),
    };
    const sum = summaries ? summaryOf(s) : null;
    return sum ? { ...out, summary: sum } : out;
  });
}

const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CARD_KEY = /^[A-Za-z][A-Za-z0-9]{0,15}-[0-9]{1,9}$/;
const money = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000 ? v : null);

/**
 * The only runner event the app forwards: the giver's run stopped at its budget. A runner message
 * `{type:'runner.event', event:'run.budget_reached', run_id, card_id, card_key?, spent_usd, budget_usd}`
 * becomes a small validated object, anything else is dropped: nothing else from the runner reaches
 * the rest of the app, and no text from it is ever shown (the card's title is read from the hub).
 */
function runnerEventFrom(m) {
  if (!m || m.type !== 'runner.event' || m.event !== 'run.budget_reached') return null;
  const spent = money(m.spent_usd);
  const budget = money(m.budget_usd);
  if (typeof m.run_id !== 'string' || !EVENT_ID.test(m.run_id) || typeof m.card_id !== 'string' || !EVENT_ID.test(m.card_id) || spent === null || budget === null) return null;
  const out = { type: 'run.budget_reached', run_id: m.run_id, card_id: m.card_id, spent_usd: spent, budget_usd: budget };
  if (typeof m.card_key === 'string' && m.card_key.length <= 32 && CARD_KEY.test(m.card_key)) out.card_key = m.card_key;
  return out;
}

/** The token rides this URL: https or wss, or cleartext only to this machine (the runner refuses anything else too). */
function hubUrlOk(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'https:' || u.protocol === 'wss:') return true;
  return (u.protocol === 'http:' || u.protocol === 'ws:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

/**
 * The runner's data_dir: created 0700, then checked, not trusted: a real
 * directory (not a symlink), ours, and 0700. → null, or why it isn't safe.
 */
function ensurePrivateDir(dir, { uid = process.getuid?.(), platform = process.platform, windowsPrivate = WindowsPrivate } = {}) {
  try {
    if (platform === 'win32') { windowsPrivate.ensureDirectory(dir); return null; }
    // Look before making: mkdir would follow a symlink or trip over a file.
    let st = null;
    try { st = fs.lstatSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!st) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); st = fs.lstatSync(dir); }
    if (st.isSymbolicLink() || !st.isDirectory()) return 'not a directory';
    if (uid != null && st.uid !== uid) return 'owned by someone else';
    if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
    st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || (st.mode & 0o777) !== 0o700) return 'not private';
    return null;
  } catch (e) {
    return e.code ?? 'unusable';
  }
}

function createDeviceController({ account, teamId, credsFile, seal, unseal, canSeal = () => true, fork, runnerEntry, entryExists = () => fs.existsSync(runnerEntry), dataDir, onStatus = () => {}, onEvent = () => {}, log = () => {}, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), stopGraceMs = STOP_GRACE_MS }) {
  // account: accounts.js client for the team's hub (origin, enrol(), unenrol()).
  let creds = null; // {hub, team_id, enrollment_id, runner_token, name}: on this Mac ⇔ enrolled and on
  try { if (fs.existsSync(credsFile)) creds = JSON.parse(unseal(fs.readFileSync(credsFile))); } catch (e) { log('runner enrolment unreadable; treated as off', e.message); creds = null; }
  if (creds && (creds.hub !== account.origin || creds.team_id !== teamId)) creds = null;
  else if (creds && !runnerTokenFrom(creds)) {
    // A file from before runner tokens (the runner used the account's token): that path is gone.
    creds = null;
    try { fs.rmSync(credsFile, { force: true }); } catch { /* next start retries */ }
  }

  let child = null;
  let busy = false; // an enrol or unenrol in flight: a second click must not rotate the token twice
  let epoch = 0; // bumped by every turn-off, discard and quit: an enrol answering after one is not kept
  let runner = { state: 'off', detail: null };
  let wanted = !!creds;
  let ended = null; // 4401 | 4403: the hub ended this enrolment and its token is gone from this Mac
  let parked = 0;
  let parkedPending = 0; // runs waiting on the hub to take them over
  let presence = { enabled: false, share_summaries: false, sessions: [] };
  const restarts = [];

  const view = () => ({
    enrolled: !!creds,
    enrollment_id: creds?.enrollment_id ?? null,
    name: creds?.name ?? null,
    enabled: !!creds && wanted,
    ended,
    runner,
    parked,
    parkedPending,
  });
  const emit = () => { try { onStatus(view()); } catch { /* UI gone */ } };

  // tmp + rename: a rotated token replaces the old one whole, or not at all.
  function persist() {
    if (!creds) { fs.rmSync(credsFile, { force: true }); return; }
    const tmp = `${credsFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, seal(JSON.stringify(creds)), { mode: 0o600 });
      fs.renameSync(tmp, credsFile);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }

  function forget() {
    creds = null;
    try { persist(); } catch (e) { log('could not delete the sealed runner enrolment', e.code ?? 'error'); }
  }

  function setRunner(state, detail = null) { runner = { state, detail }; emit(); }

  async function start() {
    if (child || !creds || !wanted) return;
    if (!entryExists()) { setRunner('missing', NO_RUNNER); return; }
    if (!hubUrlOk(account.origin)) { setRunner('failed', 'This team hub isn’t on https, so the runner won’t send it this Mac’s runner key.'); return; }
    const unsafe = ensurePrivateDir(dataDir);
    if (unsafe) { log('runner data folder refused', unsafe); setRunner('failed', 'The runner’s folder on this Mac isn’t private to you, so it won’t start.'); return; }
    // No args and no cwd: the entry refuses to run without a parentPort, and a
    // cwd inside app.asar makes the fork fail silently. The env is a fixed few
    // names: nothing secret is in it.
    const c = fork(runnerEntry, [], { serviceName: RUNNER_SERVICE, stdio: 'pipe', env: { HOME: process.env.HOME, PATH: process.env.PATH, USER: process.env.USER, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR } }); // privacy-flow: team-hub-runner
    child = c;
    c.startedAt = now();
    c.ready = false;
    setRunner('starting');
    c.stderr?.on?.('data', (d) => log('runner', scrubTokens(d).trimEnd()));
    c.on('message', (m) => {
      if (c !== child || !m || typeof m.type !== 'string') return;
      if (m.type === 'runner.ready') { c.ready = true; setRunner('connecting'); if (presence.enabled) send(c, presence); } else if (m.type === 'runner.status' && ENDED[m.state]) {
        // A rotation in flight closes the old socket 4403 by design: that must not delete the new token.
        if (c.retiring) c.endedWhileRetiring = ENDED[m.state]; else endedByHub(c, ENDED[m.state]);
      }
      else if (m.type === 'runner.status') setRunner(RUNNER_STATES.includes(m.state) ? m.state : 'unknown', typeof m.detail === 'string' ? scrubTokens(m.detail).slice(0, 200) : null);
      else if (m.type === 'runner.stopped') {
        const n = (v) => (Number.isInteger(v) && v > 0 ? Math.min(v, 1000) : 0);
        parked = n(m.parked);
        parkedPending = n(m.parked_pending);
        emit();
      } else if (m.type === 'runner.event') {
        const ev = runnerEventFrom(m);
        if (ev) { try { onEvent({ ...ev, team_id: teamId }); } catch { /* a listener's error never reaches the runner loop */ } }
      } else if (m.type === 'runner.fatal') { c.fatal = true; setRunner('failed', scrubTokens(m.message ?? 'The runner stopped.').slice(0, 200)); }
    });
    c.once('exit', (code) => onExit(c, code));
    // Exactly these five: no device id, account token or Access service token.
    c.postMessage({ type: 'runner.config', hub_url: account.origin, runner_token: creds.runner_token, team_id: teamId, data_dir: dataDir }); // privacy-flow: team-hub-runner
  }

  function send(c, p) { try { c.postMessage({ type: 'runner.presence', enabled: p.enabled, share_summaries: p.enabled && p.share_summaries, sessions: p.enabled ? p.sessions : [] }); } catch { /* exiting */ } } // privacy-flow: team-hub-runner

  /** The runner's socket closed 4401 or 4403: the token is dead, so it leaves this Mac and the runner stops. */
  function endedByHub(c, code) {
    wanted = false;
    ended = code;
    forget();
    setRunner('removed');
    stopChild(c);
  }

  function onExit(c, code) {
    if (c !== child) return;
    child = null;
    if (c.stopping || !wanted) { if (runner.state !== 'removed') setRunner('off'); return; }
    if (!c.ready && !c.fatal && now() - c.startedAt < NO_RUNNER_MS) { setRunner('missing', NO_RUNNER); return; }
    // Exit 2 is a config the runner refused: restarting would only loop.
    if (code === 2) return;
    const t = now();
    while (restarts.length && t - restarts[0] > RESTART_WINDOW_MS) restarts.shift();
    if (restarts.length >= MAX_RESTARTS) { setRunner('failed', `The runner keeps stopping (last exit code ${code}).`); return; }
    restarts.push(t);
    const delay = Math.min(30_000, 1000 * 2 ** (restarts.length - 1));
    setRunner('restarting', null);
    schedule(() => (wanted && !child ? start() : undefined), delay);
  }

  // One SIGTERM per process: a 4403 and a pruned team can both ask for the same stop.
  function stopChild(c) {
    if (!c) return Promise.resolve();
    if (c.stopping) return c.stopping;
    c.stopping = new Promise((resolve) => {
      const t = setTimeout(() => { try { if (c.pid) process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } resolve(); }, stopGraceMs);
      c.once('exit', () => { clearTimeout(t); resolve(); });
      // SIGTERM: the runner parks its runs per the handover rules first.
      try { c.kill(); } catch { clearTimeout(t); resolve(); }
    });
    return c.stopping;
  }
  const stop = () => stopChild(child);

  /** Turn off here and on the hub: the runner stops, the token leaves this Mac, then DELETE /enrol. */
  async function dropLocal() {
    epoch += 1;
    wanted = false;
    await stop();
    forget();
    ended = null;
    setRunner('off');
  }
  async function unenrol() {
    const had = !!creds;
    await dropLocal();
    if (!had) return { ok: true };
    const r = await account.unenrol(teamId).catch(() => ({ ok: false }));
    // 404: the hub had already dropped it. Unreached: no one holds the token any more, so it can't run.
    if (r.ok || r.status === 404 || r.signedOut) return { ok: true };
    return { ok: true, notice: `Turned off on this Mac. ${new URL(account.origin).host} didn’t hear it, so this Mac may still be listed as a runner there.` };
  }

  return {
    status: view,
    /**
     * Turn on: enrol this install in the team. Enrolling again (on while already on) rotates: the hub
     * kills the old token at once, the new one replaces it in the sealed file, and the runner restarts.
     */
    async enable({ name } = {}) {
      if (busy) return { ok: false, error: 'Still working on the last change. Try again in a moment.' };
      const n = String(name ?? '').trim().slice(0, 100);
      if (!n) return { ok: false, error: 'Give this Mac a name.' };
      // No enrolment the hub would list for a runner that can't start here.
      if (!entryExists()) { setRunner('missing', NO_RUNNER); return { ok: false, error: `${NO_RUNNER}.` }; }
      // Nothing the hub would count as enrolled unless we can keep its token sealed.
      if (!canSeal()) return { ok: false, error: `Plexiform can’t save this device’s key securely, so running cards stays off. ${storageHelp()}` };
      busy = true;
      const old = child;
      const asked = epoch;
      if (old) old.retiring = true;
      try {
        const r = await account.enrol(teamId, { deviceName: n });
        if (epoch !== asked) {
          // Turned off, signed out or quit meanwhile: whatever the hub minted is not kept or run.
          if (r.ok) await account.unenrol(teamId).catch(() => {});
          return { ok: false, error: 'That was cancelled.' };
        }
        if (!r.ok) {
          // Refused: the old token still works, unless its socket was closed for another reason meanwhile.
          if (old) old.retiring = false;
          if (old && old.endedWhileRetiring && old === child) endedByHub(old, old.endedWhileRetiring);
          return { ok: false, error: r.signedOut ? 'Sign in again, then turn this on.' : r.error };
        }
        const token = runnerTokenFrom(r);
        if (typeof r.enrollment_id !== 'string' || !r.enrollment_id || String(r.team_id) !== teamId || !token) {
          // Enrolled on the hub but nothing this Mac can run with (and any old token is dead now): undo it.
          await dropLocal();
          await account.unenrol(teamId).catch(() => {});
          return { ok: false, error: 'The team hub didn’t set this Mac up. Try again.' };
        }
        const prev = creds;
        creds = { hub: account.origin, team_id: teamId, enrollment_id: r.enrollment_id, runner_token: token, name: n };
        try {
          persist();
        } catch (e) {
          // A token we can't keep would run nowhere and linger on the hub.
          log('could not seal the runner enrolment; undoing it', e.code ?? 'error');
          creds = prev;
          await dropLocal();
          await account.unenrol(teamId).catch(() => {});
          return { ok: false, error: `Plexiform couldn’t save this device’s key securely. Nothing was turned on. ${storageHelp()}` };
        }
        wanted = true;
        ended = null;
        restarts.length = 0;
        // A runner still on the old token is already refused by the hub: restart it on the new one.
        await stop();
        emit();
        await start();
        return { ok: true };
      } finally {
        busy = false;
      }
    },
    /** Turn off: DELETE /api/teams/:id/enrol; the app stays signed in. */
    async disable() {
      if (busy) return { ok: false, error: 'Still working on the last change. Try again in a moment.' };
      busy = true;
      try { return await unenrol(); } finally { busy = false; }
    },
    /** Stop, unenrol on the hub (best effort) and forget the token: signing out or switching account. */
    remove: () => unenrol(),
    /** Stop and forget the token without asking the hub (signed out, revoked here, or the team is gone). */
    async discard() {
      epoch += 1;
      wanted = false;
      await stop();
      forget();
      if (runner.state !== 'removed') setRunner('off');
    },
    running: () => wanted && RUNNING.has(runner.state),
    /** Share (or stop sharing) the live sessions list; `enabled:false` clears at once. Summaries need both switches. */
    setPresence(enabled, sessions = [], { shareSummaries = false } = {}) {
      const summaries = !!enabled && shareSummaries === true;
      const next = { enabled: !!enabled, share_summaries: summaries, sessions: enabled ? presenceSessions(sessions, { summaries }) : [] };
      if (JSON.stringify(next) === JSON.stringify(presence)) return;
      presence = next;
      if (child?.ready) send(child, presence);
    },
    /** App start: resume the runner of a team this Mac is enrolled in. */
    resume() { return creds && wanted ? start() : Promise.resolve(); },
    /** App quit: stop, keep the enrolment for next launch. */
    stop: () => { epoch += 1; wanted = false; return stop(); },
  };
}

module.exports = { runnerEventFrom, createDeviceController, defaultDeviceName, presenceSessions, runnerTokenFrom, scrubTokens, ensurePrivateDir, hubUrlOk, NO_RUNNER };
