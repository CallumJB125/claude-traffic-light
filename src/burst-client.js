'use strict';

// Client for Claude Burst's loopback admin API and support console (verified
// against claude-burst internal/admin, v0.19): allow-listed GETs, plus the few
// POSTs in MUTATE_ALLOW, upgrade and compaction. The admin API has no authentication, so
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
const TEST_TIMEOUT_MS = 5000;
const MODES = new Set(['transparent', 'base-url']);
const COMPACTION_MODES = new Set(['fixed', 'intelligent']);
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;
const UPGRADE_CACHE_MS = 10 * 60 * 1000;

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
});

// Removed from every response before it leaves this module, at any depth:
// conversation text (inspector previews), credentials and their locations.
const SECRET_KEYS = new Set(['preview', 'full', 'Full', 'hotspot_password', 'password', 'api_key', 'apiKey', 'secret', 'token', 'access_token', 'authorization', 'keychain_service', 'key_env_var']);
const URL_KEYS = new Set(['base_url', 'settings_base_url', 'destination']);
function scrub(v, depth = 0) {
  if (depth > 20) return null;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (SECRET_KEYS.has(k)) continue;
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

// The only POSTs besides upgrade and compaction: fixed path, body built here from validated args.
// `console` targets the support console; everything else the gateway.
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

function createBurstClient({ home = os.homedir(), platform = process.platform, inspect = systemInspect, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  const binPath = path.join(home, '.local', 'bin', 'claude-burst');
  const configPath = path.join(home, '.config', 'claude-burst', 'config.json');
  let addr = null;
  let consoleAddr = null;
  let upgradeCache = null;

  const installed = () => { try { fs.accessSync(binPath, fs.constants.X_OK); return true; } catch { return false; } };

  const readConfig = () => { try { return JSON.parse(fs.readFileSync(configPath, 'utf8')) || {}; } catch { return {}; } };
  function readAdminListen() {
    const cfg = readConfig();
    return typeof cfg.admin_listen === 'string' && cfg.admin_listen ? cfg.admin_listen : DEFAULT_ADMIN;
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
      caTrusted: i.ca_trusted === true,
      hostsEntry: i.hosts_entry === true,
      remoteControlExpected: i.remote_control_expected === true,
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
    if (platform !== 'darwin') return { kind: 'unsupported' };
    if (!installed()) return { kind: 'not_installed' };
    addr = parseAdminAddress(readAdminListen());
    if (!addr) return { kind: 'untrusted', installed: true, reason: 'The admin address in Burst\'s config is not on this Mac\'s loopback.' };
    let raw;
    try { raw = await send('GET', '/api/state'); } catch (e) {
      if (e.code === 'unreachable' || e.code === 'timeout') return { kind: 'unreachable', installed: true, reason: e.code };
      return { kind: 'untrusted', installed: true, reason: `Something on the admin port did not answer like Burst (${e.code || 'error'}).` };
    }
    const modeOk = MODES.has(raw && raw.intercept && raw.intercept.mode);
    const shapeOk = raw && typeof raw === 'object' && parseVersion(raw.version) && Number.isInteger(raw.pid)
      && (modeOk || (typeof raw.config_error === 'string' && raw.config_error));
    if (!shapeOk) return { kind: 'untrusted', installed: true, reason: 'The admin port answered, but not with Burst\'s state.' };
    if (!await trusted(raw, addr.port)) return { kind: 'untrusted', installed: true, reason: 'The program answering on the admin port is not Burst\'s own gateway.' };

    const state = normalizeState(raw);
    const capabilities = atLeast(state.version, [0, 19, 0])
      ? { state: true, usage: true, upgradeStatus: true, handoverAudit: true, handoverFile: true, testConnection: true }
      : { state: true, usage: false, upgradeStatus: false, handoverAudit: false, handoverFile: false, testConnection: false };
    let upgrade = null;
    if (capabilities.upgradeStatus && !state.configError) {
      if (upgradeCache && now() - upgradeCache.at < UPGRADE_CACHE_MS) upgrade = upgradeCache.value;
      else {
        try {
          const u = await request('GET', '/api/upgrade-status');
          upgrade = { canUpgrade: u.can_upgrade === true, upToDate: u.up_to_date === true, latestVersion: str(u.latest_version), behind: num(u.behind) };
        } catch (e) { if (e.code === 'http' && e.status === 404) capabilities.upgradeStatus = false; }
        upgradeCache = { at: now(), value: upgrade };
      }
    }
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
    const raw = await send('GET', '/api/state');
    const cfg = raw && raw.pid === d.pid && raw.context && raw.context.compaction;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || typeof cfg.enabled !== 'boolean') throw bad('Burst did not report a compaction setting');
    if ('mode' in cfg && !COMPACTION_MODES.has(cfg.mode)) throw bad('Burst reported a compaction mode Plexiform does not know');
    if (mode !== undefined && !('mode' in cfg)) throw bad('This Burst has no compaction modes');
    const r = await send('POST', '/api/compaction', { body: JSON.stringify({ ...cfg, enabled, ...(mode !== undefined ? { mode } : {}) }), header: true, timeout: Math.max(timeoutMs, TEST_TIMEOUT_MS) });
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
  const intelligentCompaction = async () => request('GET', '/api/intelligent-compaction');

  // The support console answers when the gateway is down, so it gets its own trust check:
  // its LaunchAgent's pid must be the one listening, running Burst's own binary.
  async function consoleDetect() {
    if (platform !== 'darwin') return { kind: 'unsupported' };
    if (!installed()) return { kind: 'not_installed' };
    const listen = readConfig().console_listen;
    if (listen === 'off') return { kind: 'off' };
    const ca = parseAdminAddress(typeof listen === 'string' && listen ? listen : DEFAULT_CONSOLE);
    if (!ca) return { kind: 'untrusted', reason: 'The console address in Burst\'s config is not on this Mac\'s loopback.' };
    const [launchd, listener] = await Promise.all([inspect.launchdPid(CONSOLE_LABEL), inspect.listenerPid(ca.port)]);
    if (!listener) return { kind: 'unreachable' };
    if (!launchd || launchd !== listener || !await exeOk(listener)) return { kind: 'untrusted', reason: 'The program answering on the console port is not Burst\'s own console.' };
    let raw;
    try { raw = await send('GET', '/api/console', { to: ca, timeout: Math.max(timeoutMs, CONSOLE_TIMEOUT_MS) }); } catch (e) {
      return e.code === 'unreachable' || e.code === 'timeout' ? { kind: 'unreachable' } : { kind: 'untrusted', reason: `The console did not answer like Burst (${e.code || 'error'}).` };
    }
    if (!raw || typeof raw !== 'object' || !parseVersion(raw.version) || !Array.isArray(raw.checks)) return { kind: 'untrusted', reason: 'The console port answered, but not with Burst\'s console.' };
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
    let to;
    if (spec.target === 'console') {
      const c = await consoleDetect();
      if (c.kind !== 'present') throw Object.assign(new Error('Burst\'s console is not trusted right now'), { code: 'not_present' });
      if (await inspect.listenerPid(consoleAddr.port) !== c.pid) throw Object.assign(new Error('Burst\'s console changed; try again'), { code: 'pid_changed' });
      to = consoleAddr;
    } else {
      const d = await detect();
      if (d.kind !== 'present') throw Object.assign(new Error('Burst is not trusted right now'), { code: 'not_present' });
      const raw = await send('GET', '/api/state');
      if (!raw || raw.pid !== d.pid) throw Object.assign(new Error('Burst restarted; try again'), { code: 'pid_changed' });
      to = addr;
    }
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
    detect, request, testConnection, requestUpgrade, setCompaction, usage, sessionSecondaryUsd, codex, coordination, handoverAudit, handoverFile,
    requests, history, inspect: inspectContext, audit, automask, mac, settings, modStatus, intelligentCompaction, consoleDetect, mutate,
    binPath,
    adminUrl: () => (addr ? `http://${addr.host === '::1' ? '[::1]' : addr.host}:${addr.port}/` : null),
  };
}

module.exports = { createBurstClient, isAllowed, parseAdminAddress, atLeast, parseVersion, scrub, GET_ALLOW, MUTATE_ALLOW, LABEL, CONSOLE_LABEL };
