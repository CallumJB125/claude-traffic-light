'use strict';

// Client for Claude Burst's loopback admin API and support console (verified
// against claude-burst v0.20.36 (40551ad), internal/admin): allow-listed GETs,
// plus the few POSTs in MUTATE_ALLOW, upgrade and compaction. Features are
// gated per capability (CAPABILITY_FLOORS), never on one version string, so an
// older Burst keeps working with the newer features hidden. The admin API has no authentication, so
// everything here fails closed: a non-loopback address, a failed handshake or
// a listener that is not Burst's own LaunchAgent gives `untrusted` and reads
// nothing. Callers get a whitelisted snapshot, never a raw response.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http'); // privacy-flow: burst-local
const Spend = require('./burst-spend.js');
const Codex = require('./burst-codex.js');
const { execFile } = require('node:child_process');

const LABEL = 'ninja.andrewbaker.claude-burst';
// The support console's LaunchAgent (claude-burst scripts/install-console.sh): `claude-burst console`.
const CONSOLE_LABEL = 'ninja.andrewbaker.claude-burst-console';
const DEFAULT_ADMIN = '127.0.0.1:7788';
const DEFAULT_CONSOLE = '127.0.0.1:7789';
const CONSOLE_TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 2000;
// /api/state is ~40 KB and a busy or restarting gateway can take seconds; one retry before `unreachable`.
const STATE_TIMEOUT_MS = 5000;
const STATE_RETRY_MS = 300;
const TEST_TIMEOUT_MS = 5000;
const MODES = new Set(['transparent', 'base-url']);
const COMPACTION_MODES = new Set(['fixed', 'intelligent']);
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;
const UPGRADE_CACHE_MS = 10 * 60 * 1000;

// The Burst version each feature first shipped in. A flag is true when the
// running Burst is at least that version; `looseEnds` is also probed once per
// version (a 404 on /api/loose-ends turns it off). Nothing else is probed.
const CAPABILITY_FLOORS = Object.freeze({
  state: [0, 0, 0],
  usage: [0, 19, 0],
  upgradeStatus: [0, 19, 0],
  handoverAudit: [0, 19, 0],
  handoverFile: [0, 19, 0],
  testConnection: [0, 19, 0],
  looseEnds: [0, 20, 0],
  keepAwake: [0, 20, 0],
  mods: [0, 20, 0],
  finder: [0, 20, 0],
  handoffTaken: [0, 20, 0],
  consoleRepair: [0, 20, 0],
  remoteControl: [0, 20, 0],
  intelligentCompaction: [0, 20, 0],
  codex: [0, 20, 0],
});
const CAPABILITY_NAMES = Object.freeze(Object.keys(CAPABILITY_FLOORS));
function capabilitiesFor(version) {
  const out = {};
  for (const k of CAPABILITY_NAMES) out[k] = atLeast(version, CAPABILITY_FLOORS[k]);
  return out;
}

// Exact paths, GET only. Query keys are limited per path.
const GET_ALLOW = Object.freeze({
  '/api/state': [],
  '/api/usage': ['range', 'repo', 'session', 'limit'],
  '/api/upgrade-status': [],
  '/api/test-connection': [],
  '/api/handover-audit': [],
  '/api/handover-file': ['root'],
  '/api/intelligent-compaction': [],
  '/api/codex': [],
  '/api/coordination': ['days'],
  '/api/requests': ['limit'],
  '/api/history': ['days'],
  '/api/inspect': ['session', 'engine'],
  '/api/automask': [],
  '/api/mac': [],
  '/api/settings': [],
  '/api/audit': ['limit'],
  '/api/mod-status': [],
  '/api/loose-ends': [],
  '/api/finder': [],
});

// Removed from every response before it leaves this module, at any depth:
// conversation text (inspector previews), credentials and their locations.
const SECRET_KEYS = new Set(['preview', 'full', 'Full', 'password', 'api_key', 'apiKey', 'secret', 'token', 'access_token', 'authorization', 'keychain_service', 'key_env_var']);
// Any key that names a password (whatever prefix Burst gives it) goes too.
const SECRET_KEY_RE = /password|passwd/i;
const URL_KEYS = new Set(['base_url', 'settings_base_url', 'destination']);
function scrub(v, depth = 0) {
  if (depth > 20) return null;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (SECRET_KEYS.has(k) || SECRET_KEY_RE.test(k)) continue;
    if (URL_KEYS.has(k) && typeof x === 'string') {
      try { const u = new URL(x); out[k] = `${u.protocol}//${u.host}${u.pathname}`; } catch { /* not a URL: dropped */ }
      continue;
    }
    out[k] = scrub(x, depth + 1);
  }
  return out;
}

const badRequest = (msg) => Object.assign(new Error(msg), { code: 'bad_request' });
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const sessionArg = (v) => { if (typeof v !== 'string' || !SESSION_RE.test(v)) throw badRequest('bad session'); return v; };
const itemArg = (v) => { if (typeof v !== 'string' || !/^[0-9a-f]{16}$/.test(v)) throw badRequest('bad item'); return v; };
const messageArg = (v) => {
  if (typeof v !== 'string' || !v.trim() || v.length > 500 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) throw badRequest('bad message');
  return v.trim();
};
const fileArg = (v) => { if (typeof v !== 'string' || !path.isAbsolute(v) || v.length > 1024 || /[\u0000-\u001f]/.test(v)) throw badRequest('bad path'); return v; };

// Burst v0.20 mutation vocabularies (internal/admin/mac.go, modband.go, finder.go). A value
// outside these lists never reaches a body; Burst would refuse it too, but nothing is sent.
const KEEP_AWAKE_MODES = Object.freeze(['off', 'ac', 'always']);
const KEEP_AWAKE_MAX_IDLE = 1440; // config.MaxKeepAwakeIdleMinutes
const MOD_ACTIONS = Object.freeze(['install', 'remove', 'toasts', 'handoff', 'handoff_in_path']); // "install" also updates
const PANEL_ACTIONS = Object.freeze(['install', 'remove']);
const FINDER_ACTIONS = Object.freeze(['install', 'remove', 'bypass']);
const FINDER_KEYS = Object.freeze(['claude', 'claude-continue', 'claude-resume', 'omc', 'omc-interop', 'codex', 'codex-continue', 'opencode', 'opencode-continue', 'ghostty']);
const oneOf = (list, v, what) => { if (!list.includes(v)) throw badRequest(`bad ${what}`); return v; };
const keepAwakeBody = (a) => {
  const mode = oneOf(KEEP_AWAKE_MODES, a.mode, 'keep-awake mode');
  const idle = a.idleMinutes === undefined ? 0 : a.idleMinutes;
  if (!Number.isInteger(idle) || idle < 0 || idle > KEEP_AWAKE_MAX_IDLE) throw badRequest('bad idle limit');
  return { mode, idle_minutes: mode === 'off' ? 0 : idle };
};
const modActionBody = (a) => {
  const action = oneOf(MOD_ACTIONS, a.action, 'mod action');
  if (action === 'install' || action === 'remove') return { action };
  if (typeof a.on !== 'boolean') throw badRequest('bad mod option');
  return { action, [action]: a.on };
};
const finderInstallBody = (a) => {
  const action = oneOf(FINDER_ACTIONS, a.action, 'finder action');
  const keys = a.keys === undefined ? undefined : a.keys;
  if (keys !== undefined && (!Array.isArray(keys) || !keys.length || keys.length > FINDER_KEYS.length || keys.some((k) => !FINDER_KEYS.includes(k)))) throw badRequest('bad finder keys');
  if (action === 'bypass') {
    if (!keys || typeof a.on !== 'boolean') throw badRequest('bypass needs keys and on');
    return { action, keys, on: a.on };
  }
  return keys ? { action, keys } : { action };
};

// The only POSTs besides upgrade and compaction: fixed path, body built here from validated args.
// `console` targets the support console; everything else the gateway. `capability` names the
// detect() flag the target must report, so a 0.19 Burst never sees a 0.20 route.
// Not here on purpose: /api/handoff/taken is the burst-session mod's own callback (it tells the
// gateway that a session took in another session's handoff summary); Plexiform never compacts or
// hands off on a session's behalf, so it has no true statement to make. The Wi-Fi tethering routes: never.
const MUTATE_ALLOW = Object.freeze({
  reset: { path: '/api/reset', body: () => ({}) },
  'compaction-drop': { path: '/api/compaction/drop', body: (a) => ({ session: sessionArg(a.session) }) },
  'inspect-remove': { path: '/api/inspect/remove', body: (a) => ({ engine: a.engine === 'codex' ? 'codex' : '', session: sessionArg(a.session), id: itemArg(a.id), restore: a.restore === true }) },
  'coord-message': { path: '/api/coordination-act', body: (a) => ({ session: sessionArg(a.session), message: messageArg(a.message) }) },
  'coord-release': { path: '/api/coordination-act', body: (a) => ({ release: fileArg(a.release) }) },
  // One tiny real request through every hop; Burst bounds it at 50 s.
  trace: { path: '/api/trace', body: () => ({}), timeoutMs: 60000 },
  'console-restart': { target: 'console', path: '/api/console/restart', body: () => ({}), timeoutMs: 25000 },
  'console-diagnose': { target: 'console', path: '/api/console/diagnose', body: () => ({}), timeoutMs: 10000 },
  // Burst writes or removes its own block in ~/.codex/config.toml, backing the file up first.
  'codex-enable': { path: '/api/codex/enable', body: () => ({}) },
  'codex-disable': { path: '/api/codex/disable', body: () => ({}) },
  // v0.20: Burst saves the mode in its config and opens a Terminal window for the root half (lid-awake-root.sh).
  'keep-awake': { path: '/api/keep-awake', body: keepAwakeBody, capability: 'keepAwake', timeoutMs: 10000 },
  // v0.20: install (= update) or remove the burst-session mod via update-mod.sh, or save one mod option.
  'mod-action': { path: '/api/mod-action', body: modActionBody, capability: 'mods', timeoutMs: 10000 },
  // v0.20: install (fetching the usage panel's signed release when no checkout exists) or remove it.
  'panel-install': { path: '/api/panel-install', body: (a) => ({ action: oneOf(PANEL_ACTIONS, a.action, 'panel action') }), capability: 'mods', timeoutMs: 10000 },
  // v0.20: Finder Quick Actions in ~/Library/Services and their launcher scripts.
  'finder-install': { path: '/api/finder-install', body: finderInstallBody, capability: 'finder', timeoutMs: 15000 },
  // v0.20 console: repair.sh in a Terminal window; restore the last config.json that loaded.
  'console-repair': { target: 'console', path: '/api/console/repair', body: () => ({}), capability: 'consoleRepair', timeoutMs: 10000 },
  'console-restore-config': { target: 'console', path: '/api/console/restore-config', body: () => ({}), capability: 'consoleRepair', timeoutMs: 10000 },
});

function isAllowed(method, urlPath) {
  if (method !== 'GET' || typeof urlPath !== 'string' || !/^\/(?!\/)/.test(urlPath)) return false;
  let u;
  try { u = new URL(urlPath, 'http://127.0.0.1'); } catch { return false; }
  const keys = GET_ALLOW[u.pathname];
  if (!keys) return false;
  for (const k of u.searchParams.keys()) if (!keys.includes(k)) return false;
  return true;
}

function parseVersion(v) {
  const m = typeof v === 'string' ? SEMVER.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v, min) {
  const a = parseVersion(v);
  if (!a) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== min[i]) return a[i] > min[i];
  return true;
}

// Loopback IP only; "localhost", "" (all interfaces) and anything else is refused.
function parseAdminAddress(listen) {
  if (typeof listen !== 'string') return null;
  const m = /^(?:\[(::1)\]|(127\.0\.0\.1)):(\d{1,5})$/.exec(listen.trim());
  if (!m) return null;
  const port = Number(m[3]);
  if (!(port >= 1 && port <= 65535)) return null;
  return { host: m[1] || m[2], port };
}

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 3000, maxBuffer: 256 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout))); // privacy-flow: burst-local
});

// Who actually runs the gateway, from launchd and the socket table. Injectable
// so tests need neither launchctl nor lsof.
const systemInspect = {
  async launchdPid(label = LABEL) {
    const out = await run('launchctl', ['print', `gui/${process.getuid()}/${label}`]);
    const m = /^\s*pid = (\d+)\s*$/m.exec(out);
    return m ? Number(m[1]) : null;
  },
  async listenerPid(port) {
    const out = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
    const pids = [...out.matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1]));
    return pids.length === 1 ? pids[0] : null;
  },
  async exePath(pid) {
    return (await run('ps', ['-o', 'comm=', '-p', String(pid)])).trim();
  },
};

// v0.20 read normalizers: whitelisted fields only, so a new Burst key never reaches a renderer by
// accident. Pure, so lanes and tests can run them on fixtures.
const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const asArr = (v) => (Array.isArray(v) ? v : []);
const text = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

// /api/loose-ends → counts per repository and uncommitted file names only: never a diff, a path's
// contents, a commit hash, a stash's subject or Burst's free-text error (`reason` is a fixed word
// matched from it). `stale` is Burst's own count of what is older than `staleHours`.
const LOOSE_ENDS_REASONS = Object.freeze(['unreadable', 'not-a-repo', 'timeout']);
// Seconds of the oldest valid time among Burst's item times (RFC3339 strings or epoch numbers); null when none.
function oldestSecs(times) {
  const secs = times.map((t) => (typeof t === 'number' && Number.isFinite(t) ? (t > 1e12 ? t / 1000 : t) : typeof t === 'string' ? Date.parse(t) / 1000 : NaN)).filter((n) => Number.isFinite(n) && n > 0);
  return secs.length ? Math.min(...secs) : null;
}
function looseEndsReason(err) {
  const e = typeof err === 'string' ? err.toLowerCase() : '';
  if (!e) return '';
  if (/timed? ?out|deadline/.test(e)) return 'timeout';
  if (/not a git repo|not a repo|no such|does not exist|not found/.test(e)) return 'not-a-repo';
  return 'unreadable';
}
function normalizeLooseEnds(raw) {
  const r = asObj(raw);
  const report = asObj(r.report);
  const stale = asObj(r.stale);
  const repos = asArr(report.repos).slice(0, 100).map((x) => {
    const repo = asObj(x);
    const files = asArr(repo.uncommitted);
    const stashes = asArr(repo.stashes);
    return {
      path: text(repo.root, 1000),
      branch: text(repo.branch, 200),
      noRemote: repo.no_remote === true,
      uncommitted: files.length,
      unpushed: count(repo.ahead),
      stashes: stashes.length,
      names: files.slice(0, 20).map((f) => path.basename(text(asObj(f).path, 1000))).filter(Boolean),
      // Oldest item time in seconds (the view's stale badge), never the items themselves.
      oldest: oldestSecs([...files.map((f) => asObj(f).mtime), ...asArr(repo.unpushed).map((c) => asObj(c).when), ...stashes.map((x) => asObj(x).when)]),
      reason: looseEndsReason(repo.error),
    };
  }).filter((repo) => repo.path);
  return {
    kind: 'ok',
    scanned: count(report.scanned),
    stale: { files: count(stale.files), commits: count(stale.commits), stashes: count(stale.stashes) },
    staleHours: count(r.stale_hours),
    withinDays: count(r.within_days),
    repos,
  };
}

// /api/mac `keep_awake` → mode, idle limit, whether sleep is held off right now, the daemon's state.
function normalizeKeepAwake(raw) {
  const ka = asObj(asObj(raw).keep_awake);
  const live = asObj(ka.live);
  const mode = KEEP_AWAKE_MODES.includes(ka.mode) ? ka.mode : 'off';
  return {
    kind: 'ok',
    mode,
    idleLimit: count(ka.idle_minutes),
    held: live.sleep_disabled === true,
    heldKnown: live.sleep_disabled_known === true,
    onAc: live.on_ac === true,
    appliedMode: KEEP_AWAKE_MODES.includes(live.applied_mode) ? live.applied_mode : '',
    daemon: ['off', 'ok', 'stale', 'missing', 'stopped'].includes(ka.daemon) ? ka.daemon : 'off',
    problem: text(ka.problem, 300),
  };
}

// /api/mod-status (the burst-session mod) + /api/mac `panel` (the usage panel) → one list.
// Burst reports no version or currency for the panel, so `current` mirrors `installed` there.
function normalizeMods(modStatusRaw, macRaw) {
  const m = asObj(modStatusRaw);
  const p = asObj(asObj(macRaw).panel);
  const run = (x) => (x && typeof x === 'object' ? { action: text(x.action, 20), running: !x.finished, ok: x.ok === true } : null);
  return {
    kind: 'ok',
    claudeVersion: text(m.claude, 40),
    mods: [
      { id: 'burst-session', name: 'Burst session mod', installed: m.installed === true, current: m.current === true, version: text(m.version, 40), supported: m.supported === true, source: text(m.source, 1000), error: text(m.error, 300), hint: text(m.hint, 300), options: { toasts: m.toasts === true, handoff: m.handoff === true, handoffInPath: m.handoff_in_path === true }, last: run(m.last) },
      { id: 'usage-panel', name: 'Usage panel', installed: p.installed === true, current: p.installed === true, version: '', supported: true, source: text(p.repo_dir, 1000), error: '', hint: '', running: p.running === true, last: run(p.last_run) },
    ],
  };
}

// /api/finder → whether Ghostty is there and, per shortcut, its install state. Notes and script text stay out.
function normalizeFinder(raw) {
  const r = asObj(raw);
  return {
    kind: 'ok',
    ghostty: r.ghostty === true,
    shortcuts: asArr(r.shortcuts).slice(0, 40).map(asObj).filter((s) => FINDER_KEYS.includes(s.key)).map((s) => ({
      key: s.key,
      name: text(s.name, 120),
      group: text(s.group, 60),
      option: text(s.option, 60),
      tool: text(s.tool, 40),
      installed: s.installed === true,
      ours: s.ours === true,
      launcher: s.launcher === true,
      toolFound: s.tool_found === true,
      missing: text(s.missing, 40),
      bypassOn: s.bypass_on === true,
      bypassOk: s.bypass_ok === true,
    })),
  };
}

function createBurstClient({ home = os.homedir(), platform = process.platform, inspect = systemInspect, now = Date.now, timeoutMs = TIMEOUT_MS, stateTimeoutMs = Math.max(timeoutMs, STATE_TIMEOUT_MS), stateRetryMs = STATE_RETRY_MS, configTimeoutMs = TIMEOUT_MS, readConfigFile = (file, encoding) => fs.promises.readFile(file, encoding) } = {}) {
  const binPath = path.join(home, '.local', 'bin', 'claude-burst');
  const configPath = path.join(home, '.config', 'claude-burst', 'config.json');
  let addr = null;
  let consoleAddr = null;
  let upgradeCache = null;
  let probeCache = null; // { version, looseEnds }
  let caps = null; // the last present detection's capabilities; reads of v0.20 features are gated on it
  let configInFlight = null;
  let authorityEpoch = 0;

  const installed = () => { try { fs.accessSync(binPath, fs.constants.X_OK); return true; } catch { return false; } };

  const configUnavailable = () => Object.assign(new Error('Burst\'s config is not available right now'), { code: 'config_timeout' });
  const unavailableDetection = () => ({ kind: 'unreachable', installed: true, reason: 'config_timeout' });
  const configDeadlineMs = Number.isFinite(configTimeoutMs) && configTimeoutMs > 0 ? configTimeoutMs : TIMEOUT_MS;
  async function readConfig() {
    // macOS can hold a filesystem open behind a privacy prompt. Leave that
    // read off main, and retain it until it settles: timing out a caller must
    // not queue another blocked open on every tray refresh.
    if (!configInFlight) {
      const pending = Promise.resolve().then(() => readConfigFile(configPath, 'utf8'))
        .then((text) => JSON.parse(text) || {}).catch(() => ({}));
      configInFlight = pending;
      pending.then(() => { if (configInFlight === pending) configInFlight = null; });
    }
    let timer;
    try {
      return await Promise.race([configInFlight, new Promise((_, reject) => {
        timer = setTimeout(() => {
          // An unread config cannot grant the default loopback address, or
          // leave an older detection/mutation holding cached authority.
          authorityEpoch += 1;
          addr = null;
          consoleAddr = null;
          reject(configUnavailable());
        }, configDeadlineMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  function send(method, urlPath, { body = null, header = false, timeout = timeoutMs, to = addr } = {}) {
    return new Promise((resolve, reject) => {
      if (!to) { reject(Object.assign(new Error('no trusted address'), { code: 'no_address' })); return; }
      const headers = { Host: '127.0.0.1', Accept: 'application/json' };
      if (body !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
      if (header) headers['X-Claude-Burst-Admin'] = '1';
      let done = false;
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
      const req = http.request({ host: to.host, port: to.port, method, path: urlPath, headers, agent: false }, (res) => { // privacy-flow: burst-local
        const type = String(res.headers['content-type'] || '');
        if (res.statusCode !== 200) {
          const parts = [];
          let n = 0;
          res.on('data', (c) => { if (n < 2000) { parts.push(c); n += c.length; } });
          res.on('end', () => { finish(reject, Object.assign(new Error(`http ${res.statusCode}`), { code: 'http', status: res.statusCode, detail: Buffer.concat(parts).toString('utf8').slice(0, 300).trim() })); req.destroy(); });
          res.on('error', (e) => finish(reject, Object.assign(e, { code: 'unreachable' })));
          return;
        }
        if (!/json/i.test(type)) { res.resume(); finish(reject, Object.assign(new Error('not json'), { code: 'not_json' })); req.destroy(); return; }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BYTES) { finish(reject, Object.assign(new Error('response too large'), { code: 'too_large' })); req.destroy(); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          try { finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(reject, Object.assign(new Error('bad json'), { code: 'bad_json' })); }
        });
        res.on('error', (e) => finish(reject, Object.assign(e, { code: 'unreachable' })));
      });
      const timer = setTimeout(() => { finish(reject, Object.assign(new Error('timeout'), { code: 'timeout' })); req.destroy(); }, timeout);
      req.on('error', (e) => finish(reject, Object.assign(e, { code: e.code === 'ECONNREFUSED' ? 'unreachable' : (e.code || 'unreachable') })));
      if (body !== null) req.write(body);
      req.end();
    });
  }

  // The public request path: the allow-list is enforced here, in code.
  async function request(method, urlPath) {
    if (!isAllowed(method, urlPath)) throw Object.assign(new Error(`denied: ${method} ${urlPath}`), { code: 'denied' });
    return scrub(await send(method, urlPath, { timeout: urlPath.startsWith('/api/test-connection') ? Math.max(timeoutMs, TEST_TIMEOUT_MS) : timeoutMs }));
  }

  const num = (v) => (Number.isFinite(v) ? v : 0);
  const str = (v) => (typeof v === 'string' ? v.slice(0, 500) : '');
  function normalizeState(s) {
    const i = s.intercept && typeof s.intercept === 'object' ? s.intercept : {};
    const dg = s.downgrade && typeof s.downgrade === 'object' ? s.downgrade : {};
    const ph = s.primary_health && typeof s.primary_health === 'object' ? s.primary_health : {};
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    const heal = (h) => (h && typeof h === 'object' ? { installed: h.installed === true, running: h.running === true, lastCheckSeconds: Number.isFinite(h.last_check_seconds) ? h.last_check_seconds : -1 } : null);
    const tls = s.client_tls && typeof s.client_tls === 'object' ? s.client_tls : null;
    const slot = (r) => ({ provider: str(obj(r).provider), model: str(obj(r).model), strategy: str(obj(r).strategy), keyPresent: obj(r).key_present === true });
    const chain = {};
    for (const [k, v] of Object.entries(obj(dg.chain)).slice(0, 20)) if (Array.isArray(v)) chain[str(k)] = v.slice(0, 10).map(str);
    return {
      version: s.version,
      configError: str(s.config_error),
      route: s.route === 'SECONDARY' ? 'SECONDARY' : 'PRIMARY',
      until: str(s.until),
      claim: str(s.claim),
      mode: i.mode,
      active: i.active === true,
      inactiveReason: str(i.inactive_reason),
      rejected: Array.isArray(dg.rejected) ? dg.rejected.slice(0, 20).map((r) => ({ model: str(r && r.model), until: str(r && r.until), fallsBackTo: str(r && r.falls_back_to) })) : [],
      primaryFailures: num(ph.failures),
      primaryFailingSince: str(ph.failing_since),
      primaryLastError: str(ph.last_error).slice(0, 300),
      secondaryReady: s.secondary_ready === true,
      overflow: s.overflow === true,
      reason: str(s.reason),
      // v0.20.36 keeps these under `intercept`; an older or newer layout may lift them to the top.
      caTrusted: i.ca_trusted === true || s.ca_trusted === true,
      hostsEntry: i.hosts_entry === true || s.hosts_entry === true,
      remoteControlExpected: i.remote_control_expected === true || s.remote_control_expected === true,
      primaryHealth: { failures: num(ph.failures), failingSince: str(ph.failing_since), lastAnswer: str(ph.last_answer), lastFailure: str(ph.last_failure), lastError: str(ph.last_error).slice(0, 300), networkDown: ph.network_down === true },
      pfHeal: heal(i.pf_heal),
      selfHeal: heal(i.self_heal),
      clientTls: tls ? { failures: num(tls.failures), successes: num(tls.successes), threshold: num(tls.threshold), rejecting: tls.rejecting === true, lastClass: str(tls.last_class), lastFailure: str(tls.last_failure) } : null,
      primary: slot(s.primary),
      secondary: slot(s.secondary),
      downgrade: { enabled: dg.enabled === true, chain },
      compaction: Spend.normalizeCompaction(s),
      contextFill: Codex.normalizeContextFill(s),
    };
  }

  async function exeOk(pid) {
    const exe = await inspect.exePath(pid);
    if (!exe) return false;
    let real = binPath;
    try { real = fs.realpathSync(binPath); } catch { /* the plain path is compared below */ }
    return exe === binPath || exe === real;
  }

  async function trusted(state, port) {
    const [launchd, listener] = await Promise.all([inspect.launchdPid(LABEL), inspect.listenerPid(port)]);
    if (!launchd || !listener || launchd !== listener || state.pid !== listener) return false;
    return exeOk(listener);
  }

  async function detect() {
    const d = await detectInner();
    caps = d.kind === 'present' ? d.capabilities : null;
    return d;
  }

  async function detectInner() {
    if (platform !== 'darwin') return { kind: 'unsupported' };
    if (!installed()) return { kind: 'not_installed' };
    const epoch = authorityEpoch;
    let cfg;
    try { cfg = await readConfig(); } catch { return unavailableDetection(); }
    if (epoch !== authorityEpoch) return unavailableDetection();
    addr = null;
    const candidate = parseAdminAddress(typeof cfg.admin_listen === 'string' && cfg.admin_listen ? cfg.admin_listen : DEFAULT_ADMIN);
    if (!candidate) return { kind: 'untrusted', installed: true, reason: 'The admin address in Burst\'s config is not on this Mac\'s loopback.' };
    let raw;
    const readState = () => epoch === authorityEpoch
      ? send('GET', '/api/state', { timeout: stateTimeoutMs, to: candidate }) : Promise.reject(configUnavailable());
    try {
      raw = await readState().catch(async (e) => {
        if (e.code !== 'unreachable' && e.code !== 'timeout') throw e;
        await new Promise((r) => setTimeout(r, stateRetryMs));
        return readState();
      });
    } catch (e) {
      if (e.code === 'config_timeout') return unavailableDetection();
      if (e.code === 'unreachable' || e.code === 'timeout') return { kind: 'unreachable', installed: true, reason: e.code };
      return { kind: 'untrusted', installed: true, reason: `Something on the admin port did not answer like Burst (${e.code || 'error'}).` };
    }
    const modeOk = MODES.has(raw && raw.intercept && raw.intercept.mode);
    const shapeOk = raw && typeof raw === 'object' && parseVersion(raw.version) && Number.isInteger(raw.pid)
      && (modeOk || (typeof raw.config_error === 'string' && raw.config_error));
    if (!shapeOk) return { kind: 'untrusted', installed: true, reason: 'The admin port answered, but not with Burst\'s state.' };
    if (!await trusted(raw, candidate.port)) return { kind: 'untrusted', installed: true, reason: 'The program answering on the admin port is not Burst\'s own gateway.' };
    if (epoch !== authorityEpoch) return unavailableDetection();

    const state = normalizeState(raw);
    const capabilities = capabilitiesFor(state.version);
    if (capabilities.looseEnds && !state.configError) {
      if (probeCache && probeCache.version === state.version) capabilities.looseEnds = probeCache.looseEnds;
      else {
        try { await send('GET', '/api/loose-ends', { to: candidate }); } catch (e) { if (e.code === 'http' && e.status === 404) capabilities.looseEnds = false; }
        probeCache = { version: state.version, looseEnds: capabilities.looseEnds };
      }
    }
    let upgrade = null;
    if (capabilities.upgradeStatus && !state.configError) {
      if (upgradeCache && now() - upgradeCache.at < UPGRADE_CACHE_MS) upgrade = upgradeCache.value;
      else {
        try {
          const u = scrub(await send('GET', '/api/upgrade-status', { to: candidate }));
          upgrade = { canUpgrade: u.can_upgrade === true, upToDate: u.up_to_date === true, latestVersion: str(u.latest_version), behind: num(u.behind), error: str(u.error).slice(0, 160) };
        } catch (e) { if (e.code === 'http' && e.status === 404) capabilities.upgradeStatus = false; }
        upgradeCache = { at: now(), value: upgrade };
      }
    }
    if (epoch !== authorityEpoch) return unavailableDetection();
    addr = candidate;
    return { kind: state.configError ? 'broken' : 'present', installed: true, state, capabilities, upgrade, pid: raw.pid };
  }

  async function testConnection() {
    const r = await request('GET', '/api/test-connection');
    return { ok: r.ok === true, mode: str(r.mode), detail: str(r.detail) };
  }

  // The single mutating call, for an explicit Update click: Burst opens its own Terminal.
  async function requestUpgrade() {
    await send('POST', '/api/upgrade', { body: JSON.stringify({ mode: 'upgrade' }), header: true });
    return { ok: true };
  }

  // The one narrow mutation besides upgrade: POST /api/compaction replaces Burst's whole
  // compaction config, so this re-reads it through the full trust check and changes only
  // `enabled` (and `mode`). An unexpected shape fails closed with nothing sent.
  async function setCompaction({ enabled, mode } = {}) {
    const bad = (msg) => Object.assign(new Error(msg), { code: 'bad_config' });
    if (typeof enabled !== 'boolean' || (mode !== undefined && !COMPACTION_MODES.has(mode))) throw Object.assign(new Error('bad request'), { code: 'bad_request' });
    const d = await detect();
    if (d.kind !== 'present') throw Object.assign(new Error('Burst is not trusted right now'), { code: 'not_present' });
    const to = addr, epoch = authorityEpoch;
    const raw = await send('GET', '/api/state', { to });
    const cfg = raw && raw.pid === d.pid && raw.context && raw.context.compaction;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || typeof cfg.enabled !== 'boolean') throw bad('Burst did not report a compaction setting');
    if ('mode' in cfg && !COMPACTION_MODES.has(cfg.mode)) throw bad('Burst reported a compaction mode Plexiform does not know');
    if (mode !== undefined && !('mode' in cfg)) throw bad('This Burst has no compaction modes');
    if (epoch !== authorityEpoch || addr !== to) throw Object.assign(new Error('Burst is not trusted right now'), { code: 'not_present' });
    const r = await send('POST', '/api/compaction', { body: JSON.stringify({ ...cfg, enabled, ...(mode !== undefined ? { mode } : {}) }), header: true, timeout: Math.max(timeoutMs, TEST_TIMEOUT_MS), to });
    if (!r || typeof r.ok !== 'string') throw Object.assign(new Error('Burst did not confirm'), { code: 'bad_json' });
    return { ok: true };
  }

  const q = (o) => new URLSearchParams(o).toString();

  async function usage({ range = '7d', session = '' } = {}) {
    const r = ['1h', '24h', '7d', '30d'].includes(range) ? range : '7d';
    return Spend.normalizeUsage(await request('GET', `/api/usage?${q({ range: r, limit: '200', ...(session ? { session } : {}) })}`));
  }

  // Overflow USD of one session over the last 30 days; 0 when Burst has none.
  async function sessionSecondaryUsd(session) {
    if (!session) return 0;
    return Spend.secondaryUsdOf(await usage({ range: '30d', session }));
  }

  // Both are best-effort extras: an older Burst answers 404 and callers treat any failure as absent.
  async function codex() { return Codex.normalizeCodex(await request('GET', '/api/codex')); }
  async function codexRouting() { return Codex.codexRouting(await request('GET', '/api/codex')); }
  async function coordination({ days = 1 } = {}) { return Codex.normalizeCoordination(await request('GET', `/api/coordination?days=${[1, 7, 14].includes(days) ? days : 1}`)); }

  // Scrubbed raw answers for the normalizers in burst-route/-requests/-inspect/-notices and This Mac.
  const clamp = (n, lo, hi, d) => (Number.isInteger(n) && n >= lo && n <= hi ? n : d);
  const requests = async ({ limit = 200 } = {}) => request('GET', `/api/requests?${q({ limit: String(clamp(limit, 1, 500, 200)) })}`);
  const history = async ({ days = 14 } = {}) => request('GET', `/api/history?${q({ days: String(clamp(days, 1, 90, 14)) })}`);
  const inspectContext = async ({ session, engine } = {}) => request('GET', `/api/inspect?${q({ session: sessionArg(session), ...(engine === 'codex' ? { engine: 'codex' } : {}) })}`);
  const audit = async ({ limit = 50 } = {}) => request('GET', `/api/audit?${q({ limit: String(clamp(limit, 1, 1000, 50)) })}`);
  const automask = async () => request('GET', '/api/automask');
  const mac = async () => request('GET', '/api/mac');
  const settings = async () => request('GET', '/api/settings');
  const modStatus = async () => request('GET', '/api/mod-status');
  // v0.20 reads, whitelisted here (burst-ipc hands them to the renderer as they are). Each answers
  // `{kind:'unsupported'}` when the last detection did not report the capability.
  const unsupported = { kind: 'unsupported' };
  const looseEnds = async () => (caps && caps.looseEnds ? normalizeLooseEnds(await request('GET', '/api/loose-ends')) : unsupported);
  const keepAwake = async () => (caps && caps.keepAwake ? normalizeKeepAwake(await request('GET', '/api/mac')) : unsupported);
  const mods = async () => (caps && caps.mods ? normalizeMods(await request('GET', '/api/mod-status'), await request('GET', '/api/mac')) : unsupported);
  const finder = async () => (caps && caps.finder ? normalizeFinder(await request('GET', '/api/finder')) : unsupported);
  const intelligentCompaction = async () => request('GET', '/api/intelligent-compaction');

  // The support console answers when the gateway is down, so it gets its own trust check:
  // its LaunchAgent's pid must be the one listening, running Burst's own binary.
  async function consoleDetect() {
    if (platform !== 'darwin') return { kind: 'unsupported' };
    if (!installed()) return { kind: 'not_installed' };
    const epoch = authorityEpoch;
    let cfg;
    try { cfg = await readConfig(); } catch { return unavailableDetection(); }
    if (epoch !== authorityEpoch) return unavailableDetection();
    const listen = cfg.console_listen;
    if (listen === 'off') return { kind: 'off' };
    const ca = parseAdminAddress(typeof listen === 'string' && listen ? listen : DEFAULT_CONSOLE);
    if (!ca) return { kind: 'untrusted', reason: 'The console address in Burst\'s config is not on this Mac\'s loopback.' };
    const [launchd, listener] = await Promise.all([inspect.launchdPid(CONSOLE_LABEL), inspect.listenerPid(ca.port)]);
    if (!listener) return { kind: 'unreachable' };
    if (!launchd || launchd !== listener || !await exeOk(listener)) return { kind: 'untrusted', reason: 'The program answering on the console port is not Burst\'s own console.' };
    if (epoch !== authorityEpoch) return unavailableDetection();
    let raw;
    try { raw = await send('GET', '/api/console', { to: ca, timeout: Math.max(timeoutMs, CONSOLE_TIMEOUT_MS) }); } catch (e) {
      return e.code === 'unreachable' || e.code === 'timeout' ? { kind: 'unreachable' } : { kind: 'untrusted', reason: `The console did not answer like Burst (${e.code || 'error'}).` };
    }
    if (!raw || typeof raw !== 'object' || !parseVersion(raw.version) || !Array.isArray(raw.checks)) return { kind: 'untrusted', reason: 'The console port answered, but not with Burst\'s console.' };
    if (epoch !== authorityEpoch) return unavailableDetection();
    consoleAddr = ca;
    return {
      kind: 'present', pid: listener,
      status: {
        version: raw.version,
        dashboardUp: raw.dashboard_up === true,
        configError: str(raw.config_error),
        checks: raw.checks.slice(0, 30).filter((c) => c && typeof c === 'object').map((c) => ({ name: str(c.name).slice(0, 100), ok: c.ok === true, detail: str(c.detail) })),
        logTail: (Array.isArray(raw.log_tail) ? raw.log_tail : []).slice(-50).map(str),
      },
    };
  }

  // Every allow-listed POST: args are validated before anything is sent, then the target is
  // re-trusted (detect + pid re-read, as setCompaction does) right before the one POST.
  async function mutate(kind, args = {}) {
    const spec = Object.prototype.hasOwnProperty.call(MUTATE_ALLOW, kind) ? MUTATE_ALLOW[kind] : null;
    if (!spec) throw Object.assign(new Error(`denied: ${kind}`), { code: 'denied' });
    const body = JSON.stringify(spec.body(args && typeof args === 'object' ? args : {}));
    const timeout = Math.max(timeoutMs, spec.timeoutMs || TEST_TIMEOUT_MS);
    let to, epoch;
    if (spec.target === 'console') {
      const c = await consoleDetect();
      if (c.kind !== 'present') throw Object.assign(new Error('Burst\'s console is not trusted right now'), { code: 'not_present' });
      if (spec.capability && !capabilitiesFor(c.status.version)[spec.capability]) throw Object.assign(new Error('This Burst console is too old for that'), { code: 'unsupported' });
      to = consoleAddr;
      epoch = authorityEpoch;
      if (!to || await inspect.listenerPid(to.port) !== c.pid) throw Object.assign(new Error('Burst\'s console changed; try again'), { code: 'pid_changed' });
    } else {
      const d = await detect();
      if (d.kind !== 'present') throw Object.assign(new Error('Burst is not trusted right now'), { code: 'not_present' });
      if (spec.capability && !d.capabilities[spec.capability]) throw Object.assign(new Error('This Burst is too old for that'), { code: 'unsupported' });
      to = addr;
      epoch = authorityEpoch;
      const raw = await send('GET', '/api/state', { to });
      if (!raw || raw.pid !== d.pid) throw Object.assign(new Error('Burst restarted; try again'), { code: 'pid_changed' });
    }
    if (epoch !== authorityEpoch || (spec.target === 'console' ? consoleAddr : addr) !== to) throw Object.assign(new Error('Burst is not trusted right now'), { code: 'not_present' });
    const r = await send('POST', spec.path, { body, header: true, timeout, to });
    return { ok: true, data: scrub(r) };
  }

  async function handoverAudit() {
    const a = await request('GET', '/api/handover-audit');
    return (Array.isArray(a) ? a : []).slice(0, 200).filter((e) => e && typeof e.root === 'string' && e.exists === true)
      .map((e) => ({ root: str(e.root, 1000), modified: str(e.modified, 40), lastWrite: str(e.last_write, 40) }));
  }

  async function handoverFile(root) {
    const r = await request('GET', `/api/handover-file?${q({ root })}`);
    return typeof r.content === 'string' ? r.content.slice(0, 64 * 1024) : '';
  }

  return {
    detect, request, testConnection, requestUpgrade, setCompaction, usage, sessionSecondaryUsd, codex, codexRouting, coordination, handoverAudit, handoverFile,
    requests, history, inspect: inspectContext, audit, automask, mac, settings, modStatus, looseEnds, keepAwake, mods, finder, intelligentCompaction, consoleDetect, mutate,
    capabilities: () => (caps ? { ...caps } : null),
    binPath,
    adminUrl: () => (addr ? `http://${addr.host === '::1' ? '[::1]' : addr.host}:${addr.port}/` : null),
  };
}

module.exports = {
  createBurstClient, isAllowed, parseAdminAddress, atLeast, parseVersion, scrub, capabilitiesFor, CAPABILITY_FLOORS, CAPABILITY_NAMES, GET_ALLOW, MUTATE_ALLOW, LABEL, CONSOLE_LABEL,
  normalizeLooseEnds, normalizeKeepAwake, normalizeMods, normalizeFinder, LOOSE_ENDS_REASONS, KEEP_AWAKE_MODES, MOD_ACTIONS, PANEL_ACTIONS, FINDER_ACTIONS, FINDER_KEYS,
};
