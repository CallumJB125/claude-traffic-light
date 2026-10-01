// Remote devices: machines paired to report their agent sessions here
// (hooks/remote.js on their side). Owns the device registry, the signed
// POST /remote/event route and the namespaced session files it writes, and
// the listeners devices reach it on. No electron: main.js hands it what it
// needs.
//
// What a paired device can do: move lights for sessions under its own
// ~/.claude-traffic-light/remote/<device id>/ and nothing else. Its session
// ids are validated (never sanitized into a collision) and prefixed with the
// device on read, its folder and tool names are display strings only (main.js
// keeps remote sessions out of terminal jumps, roaming, Finder, editor and
// shell actions), and liveness is judged on this machine's clock.
//
// Every remote session carries three markers, any one of which says remote:
// `remote: true`, `device: <device id>`, and a sessionId starting `remote:`.
// `host` is the device's name, for display only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http'); // privacy-flow: remote-listener
const crypto = require('crypto');
const { execFile } = require('child_process');
const Protocol = require('../hooks/remote-protocol.js');
const SessionState = require('../hooks/session-state.js');
const Rules = require('../rules.js');
const Adapters = require('../adapters/index.js');

const REGISTRY_FILE = 'devices.json';
const REMOTE_DIR = 'remote';
const MAX_DEVICES = 32;
const MAX_SESSIONS_PER_DEVICE = 64;
// A pairing code nobody used in this long stops working.
const PAIR_EXPIRY_MS = 10 * 60 * 1000;
// The reporter's heartbeat loop runs every 30 s by default; three misses and
// a session it vouched for is taken as gone (machine asleep, tunnel down,
// agent killed).
const HEARTBEAT_TTL_MS = 90000;
// Per device: a steady 10 requests a second, bursts of 30.
const RATE_PER_S = 10;
const RATE_BURST = 30;
// Ended sessions remembered per device (on disk, so a restart can't let a
// late event bring one back), and how far the device's latest timestamp may
// run ahead of what devices.json records before it is written again.
const MAX_TOMBSTONES = 256;
const TOMBSTONE_FILE = 'ended';
const HIGHWATER_STEP_MS = 10000;
const KNOWN_SIGNALS = new Set(Rules.SIGNALS.filter((x) => x.hook).map((x) => x.id).concat(['session-end']));
const { displayString } = Protocol;

function cleanName(name) {
  const n = displayString(String(name || ''), 40).trim();
  return /^[\p{L}\p{N} ._'-]{1,40}$/u.test(n) ? n : null;
}

function mintId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'device';
  return `${slug}-${crypto.randomBytes(3).toString('hex')}`;
}

// Hashed, so ids differing only in case can't share a file on a
// case-insensitive disk (APFS by default). The id itself lives in the file.
const fileKey = (source, id) => crypto.createHash('sha256').update(`${source}\n${id}`).digest('hex').slice(0, 32);

// The session list minus remote ones, for everything that acts on this
// machine (terminal jumps, roaming, Finder, editor, shell actions).
const isRemote = (s) => !!s && (s.remote === true || typeof s.device === 'string' || String(s.sessionId || '').startsWith('remote:'));
const localSessions = (sessions) => (sessions || []).filter((s) => !isRemote(s));

// ── Tailscale address ───────────────────────────────────────────────────────
// Tailscale's own interface: utunN on macOS, tailscale0 elsewhere, a /32
// IPv4 in 100.64/10 with an fd7a:115c:a1e0::/48 IPv6 beside it. Other VPNs
// also use utun and even CGNAT addresses, so the Tailscale CLI's answer is
// preferred, and without it only a single unambiguous candidate is used.
function tailnetCandidates(ifaces = os.networkInterfaces(), platform = process.platform) {
  const nameOk = platform === 'darwin' ? /^utun\d+$/ : /^tailscale\d*$/;
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    if (!nameOk.test(name)) continue;
    const list = addrs || [];
    const v6 = list.some((a) => a && (a.family === 'IPv6' || a.family === 6) && /^fd7a:115c:a1e0:/i.test(a.address));
    for (const a of list) {
      if (a && (a.family === 'IPv4' || a.family === 4) && !a.internal && Protocol.isTailnetIPv4(a.address) && a.netmask === '255.255.255.255' && v6) out.push({ name, address: a.address });
    }
  }
  return out;
}

function chooseTailnet({ ifaces = os.networkInterfaces(), cliIp = null, platform = process.platform } = {}) {
  const cands = tailnetCandidates(ifaces, platform);
  if (cliIp) {
    const hit = cands.find((c) => c.address === cliIp);
    return hit ? { address: hit.address } : { error: `Tailscale reports ${cliIp}, but no Tailscale interface carries it; not listening.` };
  }
  if (cands.length === 1) return { address: cands[0].address };
  if (cands.length > 1) return { error: `Several interfaces look like Tailscale (${cands.map((c) => `${c.name} ${c.address}`).join(', ')}) and the tailscale command isn't available to say which is live; not listening.` };
  const stray = Object.entries(ifaces || {}).flatMap(([name, addrs]) => (addrs || []).filter((a) => a && !a.internal && Protocol.isTailnetIPv4(a.address)).map((a) => `${name} ${a.address}`));
  return { error: stray.length ? `${stray.join(', ')} is not a Tailscale interface; not listening.` : 'No Tailscale address on this machine (is Tailscale running?)' };
}

// The CLI on PATH first, then the one inside the Mac app. Each binary is
// named where it runs, so the privacy guard can see both are local.
const firstTailnetIp = (out) => String(out || '').split('\n').map((l) => l.trim()).find(Protocol.isTailnetIPv4) || null;
const askTailscale = (run) => new Promise((resolve) => run((err, out) => resolve(err ? null : firstTailnetIp(out))));
async function tailscaleIp() {
  return (await askTailscale((cb) => execFile('tailscale', ['ip', '-4'], { timeout: 3000 }, cb)))
    || askTailscale((cb) => execFile('/Applications/Tailscale.app/Contents/MacOS/Tailscale', ['ip', '-4'], { timeout: 3000 }, cb));
}

module.exports = function createRemoteDevices({ rootDir, onChange = () => {}, log = () => {}, now = () => Date.now(), mono = Protocol.monoMs }) {
  const registryFile = path.join(rootDir, REGISTRY_FILE);
  const remoteDir = path.join(rootDir, REMOTE_DIR);
  const nonces = Protocol.nonceCaches();
  const lastSeen = new Map(); // device id -> ms, since this app started
  const buckets = new Map(); // device id -> { tokens, at (mono ms) }
  const tombstones = new Map(); // device id -> Map(fileKey -> seq of its session-end)
  const highwater = new Map(); // device id -> { ts: latest accepted timestamp (sender's clock), mono: when }
  let cache = { key: null, devices: [] };

  // Remote writes come in bursts; the widget needs one refresh per burst.
  let changeTimer = null;
  const changed = () => {
    if (changeTimer) return;
    changeTimer = setTimeout(() => { changeTimer = null; onChange(); }, 200);
    if (changeTimer.unref) changeTimer.unref();
  };

  function load() {
    let stat;
    try { stat = fs.statSync(registryFile); } catch { cache = { key: 'none', devices: [] }; return cache.devices; }
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (cache.key === key) return cache.devices;
    let devices = [];
    try {
      const raw = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      devices = (Array.isArray(raw && raw.devices) ? raw.devices : []).filter((d) => d && Protocol.DEVICE_ID.test(String(d.id)) && Protocol.TOKEN.test(String(d.token)) && cleanName(d.name));
    } catch (e) { log(`[remote] ${registryFile} unreadable, no devices: ${e.message}`); }
    cache = { key, devices };
    return devices;
  }

  function save(devices) {
    fs.mkdirSync(rootDir, { recursive: true });
    const tmp = `${registryFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, devices }, null, 2), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, registryFile);
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
    cache = { key: null, devices: [] };
  }

  const expired = (d, t = now()) => !d.confirmedAt && t - (Date.parse(d.createdAt) || 0) > PAIR_EXPIRY_MS;
  // A device whose code expired unused answers exactly like an unknown one.
  // highTs: the latest timestamp this device has had accepted, from memory
  // or (after a restart) devices.json, whichever is later.
  const lookup = (id) => {
    const d = load().find((x) => x.id === id);
    if (!d || expired(d)) return null;
    const mem = highwater.get(id);
    const stored = Number.isFinite(d.highTs) ? d.highTs : -Infinity;
    // highMono only when the in-memory mark is the one in force: a mark read
    // back from disk has no nonces behind it.
    if (mem && mem.ts >= stored) return { ...d, highTs: mem.ts, highMono: mem.mono };
    return Number.isFinite(stored) ? { ...d, highTs: stored } : d;
  };

  // After a verified request: the first one confirms the pairing, and the
  // high-water mark reaches devices.json in HIGHWATER_STEP_MS steps.
  function accepted(device, ts) {
    if (ts > (highwater.get(device.id)?.ts ?? -Infinity)) highwater.set(device.id, { ts, mono: mono() });
    const stored = load().find((d) => d.id === device.id) || {};
    const persist = !stored.confirmedAt || !(ts - (Number(stored.highTs) || 0) < HIGHWATER_STEP_MS);
    if (!persist) return;
    try {
      save(load().map((d) => (d.id === device.id ? { ...d, confirmedAt: d.confirmedAt || new Date(now()).toISOString(), highTs: Math.max(Number(d.highTs) || 0, highwater.get(d.id).ts) } : d)));
    } catch (e) { log(`[remote] could not record device state: ${e.message}`); }
  }

  function endedFor(id) {
    if (tombstones.has(id)) return tombstones.get(id);
    let m = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(deviceDir(id), TOMBSTONE_FILE), 'utf8'));
      m = new Map(Object.entries(raw).filter(([k, v]) => /^[0-9a-f]{32}$/.test(k) && Protocol.validSeq(v)));
    } catch { /* none yet */ }
    tombstones.set(id, m);
    return m;
  }

  function saveEnded(id) {
    const m = endedFor(id);
    const keep = [...m].sort((a, b) => b[1] - a[1]).slice(0, MAX_TOMBSTONES);
    tombstones.set(id, new Map(keep));
    const file = path.join(deviceDir(id), TOMBSTONE_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function deviceDir(id) {
    if (!Protocol.DEVICE_ID.test(String(id))) throw new Error('bad device id');
    return path.join(remoteDir, id);
  }

  // → { device: { id, name, createdAt }, code }. The code (id + key) is shown
  // once; the registry keeps the key, since verifying an HMAC needs it.
  function pair(name) {
    const clean = cleanName(name);
    if (!clean) return { error: 'Give the device a name: letters, numbers, spaces, dots, dashes (up to 40).' };
    const devices = load();
    if (devices.length >= MAX_DEVICES) return { error: `At most ${MAX_DEVICES} devices; revoke one first.` };
    if (devices.some((d) => d.name.toLowerCase() === clean.toLowerCase())) return { error: `A device called "${clean}" is already paired.` };
    // A remote session's host is the device name; one equal to this machine's
    // would read as a local session anywhere that compares hosts.
    // Compared as cleaned names: a hostname over 40 characters (CI runners have
    // them) is cut by cleanName, so a raw comparison would never match it.
    const here = os.hostname();
    const own = [here, here.split('.')[0]].map((h) => (cleanName(h) || '').toLowerCase()).filter(Boolean);
    if (own.includes(clean.toLowerCase())) return { error: `"${clean}" is this computer's own name; call the other machine something else.` };
    let id;
    do { id = mintId(clean); } while (devices.some((d) => d.id === id));
    const token = crypto.randomBytes(32).toString('hex');
    const device = { id, name: clean, token, createdAt: new Date(now()).toISOString(), confirmedAt: null };
    save(devices.concat([device]));
    return { device: { id, name: clean, createdAt: device.createdAt }, code: Protocol.pairingCode(id, token) };
  }

  // Revoking forgets the key (so every later request fails verification)
  // and drops the device's sessions from the widget at once.
  function revoke(id) {
    const devices = load();
    if (!devices.some((d) => d.id === id)) return false;
    save(devices.filter((d) => d.id !== id));
    fs.rmSync(deviceDir(id), { recursive: true, force: true });
    nonces.forget(id);
    buckets.delete(id);
    lastSeen.delete(id);
    tombstones.delete(id);
    highwater.delete(id);
    onChange();
    return true;
  }

  function sessionFiles(id) {
    try { return fs.readdirSync(deviceDir(id)).filter((f) => f.endsWith('.json')); } catch { return []; }
  }

  // `live`: { device id: sessions the widget shows } from main.js, which owns
  // the stale windows; without it, sessions whose heartbeat hasn't lapsed.
  function list(live = null) {
    const t = now();
    return load().map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      pairing: d.confirmedAt ? 'paired' : expired(d, t) ? 'expired' : 'waiting',
      lastSeenAt: lastSeen.has(d.id) ? new Date(lastSeen.get(d.id)).toISOString() : null,
      sessions: live ? (live[d.id] || 0) : readSessions().filter((s) => s.device === d.id && !isGone(s, t)).length,
    }));
  }

  // ── Applying a verified envelope ──────────────────────────────────────────
  function fileFor(device, source, remoteId) {
    const dir = deviceDir(device.id);
    const file = path.join(dir, `${fileKey(source, remoteId)}.json`);
    if (path.dirname(path.resolve(file)) !== path.resolve(dir)) throw new Error('path escapes the device directory');
    return file;
  }

  // One event or heartbeat entry → its normalized form, or a reason it's refused.
  function normalize(e, { snapshot = false } = {}) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { error: 'event is not an object' };
    if (!KNOWN_SIGNALS.has(e.signal) || (snapshot && e.signal === 'session-end')) return { error: `unknown signal ${displayString(String(e.signal), 40)}` };
    if (!Protocol.validSessionId(e.sessionId)) return { error: 'bad session id' };
    if (!Protocol.SOURCE.test(String(e.source))) return { error: 'bad source' };
    if (!Protocol.validSeq(e.seq)) return { error: 'bad seq' };
    return { e: { ...e, source: Adapters.get(e.source) ? e.source : 'custom' } };
  }

  // Returns 'applied' | 'stale'. The caller holds the session's lock. Nothing
  // moves backwards: an event or snapshot (session-end included) not newer
  // than what the file, or the session's recorded end, says is dropped,
  // whatever order the detached senders delivered them in.
  function applyOne(device, e, nowIso, { snapshot = false } = {}) {
    const key = fileKey(e.source, e.sessionId);
    const file = fileFor(device, e.source, e.sessionId);
    const ended = endedFor(device.id);
    if (ended.has(key) && e.seq <= ended.get(key)) return 'stale';
    const prev = SessionState.readJson(file);
    if (prev && Number(prev.remoteSeq) >= e.seq) {
      // Older news, but a heartbeat still vouches the session is running.
      if (snapshot) SessionState.writeJsonAtomic(file, { ...prev, heartbeatAt: nowIso, heartbeatMode: true });
      return 'stale';
    }
    if (e.signal === 'session-end') {
      fs.rmSync(file, { force: true });
      ended.set(key, e.seq);
      return 'ended';
    }
    const next = SessionState.applyBareSignal(prev, {
      sessionId: `remote:${device.id}:${e.source}-${e.sessionId}`,
      host: device.name,
      source: e.source,
      cwd: displayString(e.cwd, 500),
      signal: e.signal,
      tool: displayString(e.tool, 80) || null,
      fromSubagent: e.fromSubagent === true,
    }, nowIso);
    // A blocking PermissionRequest can only be answered on its own machine,
    // so 'request' is never taken from a remote.
    next.askKind = next.signal === 'permission-ask' ? (e.askKind === 'question' ? 'question' : 'notification') : null;
    next.via = displayString(e.via, 60) || (snapshot ? 'remote heartbeat' : 'remote');
    Object.assign(next, { remote: true, device: device.id, remoteId: e.sessionId, remoteSource: e.source, remoteSeq: e.seq, heartbeatAt: nowIso });
    if (snapshot) next.heartbeatMode = true;
    // Terminal-jump data (pid, host app, the SessionStart `terminal` record)
    // describes this machine's processes; a remote never gets to set it.
    delete next.claudePid;
    delete next.hostApp;
    delete next.terminal;
    SessionState.writeJsonAtomic(file, next);
    return 'applied';
  }

  // Every lock or none: `fn` runs only once all of `files` are held, and
  // undefined comes back (nothing written) if any one is busy.
  function withLocks(files, fn) {
    if (!files.length) return fn();
    return SessionState.withLockOrSkip(files[0], () => withLocks(files.slice(1), fn));
  }

  // → { status, body }. The whole request is checked, the session cap
  // included, before anything is written.
  function apply(device, env, t = now()) {
    if (!env || typeof env !== 'object' || Array.isArray(env) || env.v !== Protocol.VERSION) return { status: 400, body: { error: 'unsupported envelope version' } };
    if (env.device !== device.id) return { status: 400, body: { error: 'envelope device does not match the signing device' } };
    const nowIso = new Date(t).toISOString();
    if (env.kind === 'ping') return { status: 200, body: { ok: true, name: device.name } };
    const snapshot = env.kind === 'heartbeat';
    if (!snapshot && env.kind !== 'session') return { status: 400, body: { error: 'unknown kind' } };
    const items = snapshot ? env.sessions : env.events;
    const max = snapshot ? Protocol.MAX_HEARTBEAT_SESSIONS : Protocol.MAX_EVENTS;
    if (!Array.isArray(items) || items.length > max || (!snapshot && !items.length)) return { status: 400, body: { error: snapshot ? 'bad heartbeat' : 'bad events' } };
    const list = [];
    for (const raw of items) {
      const n = normalize(raw, { snapshot });
      if (n.error) return { status: 400, body: { error: n.error } };
      list.push(n.e);
    }
    const existing = new Set(sessionFiles(device.id));
    const fresh = new Set(list.filter((e) => e.signal !== 'session-end').map((e) => `${fileKey(e.source, e.sessionId)}.json`).filter((f) => !existing.has(f)));
    if (existing.size + fresh.size > MAX_SESSIONS_PER_DEVICE) return { status: 429, body: { error: 'too many sessions on this device' } };
    let applied;
    try {
      fs.mkdirSync(deviceDir(device.id), { recursive: true, mode: 0o700 });
      const files = [...new Set(list.map((e) => fileFor(device, e.source, e.sessionId)))];
      applied = withLocks(files, () => {
        let n = 0;
        let endedAny = false;
        for (const e of list) {
          const r = applyOne(device, e, nowIso, { snapshot });
          if (r !== 'stale') n += 1;
          if (r === 'ended') endedAny = true;
        }
        if (endedAny) saveEnded(device.id);
        return n;
      });
    } catch (e) {
      changed();
      return { status: 500, body: { error: 'could not store the event' } };
    }
    if (applied === undefined) return { status: 503, body: { error: 'session busy, try again' } };
    changed();
    return { status: 200, body: { ok: true, applied } };
  }

  function allow(id) {
    const t = mono();
    const b = buckets.get(id) || { tokens: RATE_BURST, at: t };
    b.tokens = Math.min(RATE_BURST, b.tokens + ((t - b.at) / 1000) * RATE_PER_S);
    b.at = t;
    buckets.set(id, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  // The route handler, for both listeners. Verifies the signature over the
  // raw bytes before parsing any of them, and signs every answer it can (to
  // a request it verified) so the reporter knows it reached this app.
  function handle(req, done) {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > Protocol.MAX_BODY_BYTES) { aborted = true; done(413, JSON.stringify({ error: 'body too large' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const body = Buffer.concat(chunks);
      const v = Protocol.verify({ headers: req.headers, body, lookup, nonces, now: now(), mono: mono() });
      const reply = (status, obj) => {
        const text = JSON.stringify(obj);
        const headers = v.device && v.nonce ? { [Protocol.HEADERS.sig]: Protocol.signResponse(v.device.token, { nonce: v.nonce, status, body: text }) } : {};
        done(status, text, headers);
      };
      if (!v.ok) return reply(v.status, { error: v.error });
      if (!allow(v.device.id)) return reply(429, { error: 'too many requests' });
      lastSeen.set(v.device.id, now());
      accepted(v.device, v.ts);
      let env;
      try { env = JSON.parse(body.toString('utf8')); } catch { return reply(400, { error: 'bad json' }); }
      const r = apply(v.device, env, now());
      return reply(r.status, r.body);
    });
  }

  // ── Reading, for the widget ───────────────────────────────────────────────
  // Every stored session of every still-registered device. The device comes
  // from the directory and the session from the file's own id, which must
  // hash to the file's name; nothing that describes this machine is read.
  function readSessions() {
    const out = [];
    for (const d of load()) {
      const deviceName = displayString(d.name, 40);
      for (const f of sessionFiles(d.id)) {
        const s = SessionState.readJson(path.join(deviceDir(d.id), f));
        if (!s || typeof s !== 'object' || !Protocol.validSessionId(s.remoteId) || !Protocol.SOURCE.test(String(s.remoteSource))) continue;
        if (f !== `${fileKey(s.remoteSource, s.remoteId)}.json`) continue;
        out.push({
          ...s,
          sessionId: `remote:${d.id}:${s.remoteSource}-${s.remoteId}`,
          logId: `${d.id}:${s.remoteId.slice(0, 8)}`,
          remote: true,
          device: d.id,
          deviceName,
          host: deviceName,
          cwd: displayString(s.cwd, 500),
          tool: displayString(s.tool, 80) || null,
          claudePid: undefined,
          hostApp: undefined,
          terminal: undefined,
        });
      }
    }
    return out;
  }

  // Only sessions the device's heartbeat has vouched for can go stale by it;
  // the rest age out on the usual working and waiting windows.
  const isGone = (s, t = now()) => !!s.heartbeatMode && t - (Date.parse(s.heartbeatAt || '') || 0) > HEARTBEAT_TTL_MS;

  const deviceDirs = () => load().map((d) => deviceDir(d.id));

  // ── Listeners for devices ─────────────────────────────────────────────────
  // Servers that serve the signed route and nothing else, so what reaches
  // them from another machine can't read /status or use /signal and /hook:
  // one on loopback (where an ssh -R tunnel lands; other users of the far
  // host can reach that end too) and, opt-in, one on the Tailscale address.
  // Never 0.0.0.0. The far end is someone else's machine, hence the tight
  // timeouts and caps; checked every 500 ms so a stalled client is gone
  // within 5.5 s of connecting.
  function routeOnlyServer() {
    const server = http.createServer({ connectionsCheckingInterval: 500, headersTimeout: 5000, requestTimeout: 5000, keepAliveTimeout: 1000 }, (req, res) => {
      const done = (code, text, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(text); };
      if (req.headers.origin !== undefined) return done(403, JSON.stringify({ error: 'browser requests are not accepted' }));
      if (req.method !== 'POST' || req.url !== '/remote/event') return done(404, JSON.stringify({ error: 'POST /remote/event' }));
      return handle(req, done);
    });
    server.maxConnections = 32;
    server.maxHeadersCount = 20;
    return server;
  }

  const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;

  let loopback = { server: null, port: null, listening: false, error: null };
  function listenLoopback(port) {
    if (loopback.server) return loopbackStatus();
    if (!validPort(port)) { loopback = { server: null, port: null, listening: false, error: `Not listening for devices: ${String(port)} is not a port.` }; return loopbackStatus(); }
    const server = routeOnlyServer();
    loopback = { server, port, listening: false, error: null };
    server.on('listening', () => { if (loopback.server === server) loopback.listening = true; });
    server.on('error', (e) => { log(`[remote] device listener on 127.0.0.1:${port}: ${e.message}`); if (loopback.server === server) loopback = { server: null, port, listening: false, error: `Not listening for devices on 127.0.0.1:${port}: ${e.code || e.message}` }; });
    server.listen(port, '127.0.0.1'); // privacy-flow: remote-listener
    return loopbackStatus();
  }
  const loopbackStatus = () => ({ listening: loopback.listening, port: loopback.port, error: loopback.error });
  function closeLoopback() { if (loopback.server) loopback.server.close(); loopback = { server: null, port: null, listening: false, error: null }; }

  let tailnet = { server: null, address: null, listening: false, error: null };

  function closeTailnet() {
    if (tailnet.server) tailnet.server.close();
    tailnet = { server: null, address: null, listening: false, error: null };
  }

  // Sync, with what it needs handed in (tests); syncTailnet below asks the
  // Tailscale CLI first.
  function setTailnet(enabled, port, { ifaces, cliIp = null, platform } = {}) {
    if (!enabled) { closeTailnet(); return tailnetStatus(); }
    if (!validPort(port)) { closeTailnet(); tailnet.error = `${String(port)} is not a port.`; return tailnetStatus(); }
    const pick = chooseTailnet({ ifaces, cliIp, platform });
    if (tailnet.server && tailnet.address === pick.address) return tailnetStatus();
    closeTailnet();
    if (!pick.address) { tailnet.error = pick.error; return tailnetStatus(); }
    const server = routeOnlyServer();
    tailnet = { server, address: pick.address, listening: false, error: null };
    server.on('listening', () => { if (tailnet.server === server) tailnet.listening = true; });
    server.on('error', (e) => { log(`[remote] tailnet listener: ${e.message}`); if (tailnet.server === server) tailnet = { server: null, address: null, listening: false, error: `Not listening on ${pick.address}:${port}: ${e.code || e.message}` }; });
    server.listen(port, pick.address); // privacy-flow: remote-listener
    return tailnetStatus();
  }

  async function syncTailnet(enabled, port) {
    return setTailnet(enabled, port, { cliIp: enabled ? await tailscaleIp() : null });
  }

  const tailnetStatus = () => ({ listening: tailnet.listening, address: tailnet.address, error: tailnet.error });

  return { pair, revoke, list, lookup, apply, handle, readSessions, isGone, deviceDirs, listenLoopback, loopbackStatus, closeLoopback, setTailnet, syncTailnet, closeTailnet, tailnetStatus, registryFile, remoteDir, nonces };
};

Object.assign(module.exports, { HEARTBEAT_TTL_MS, MAX_SESSIONS_PER_DEVICE, PAIR_EXPIRY_MS, RATE_BURST, displayString, isRemote, localSessions, tailnetCandidates, chooseTailnet, tailscaleIp, fileKey });
