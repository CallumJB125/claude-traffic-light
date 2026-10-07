// Phone approvals (paid tier W2-B, entitlement 'phone'): answer this
// computer's permission requests from a paired phone, and start a task from it.
//
// REQUIRES INDEPENDENT SECURITY REVIEW before release. A remote approval is a
// remote code execution path (remote/THREAT_MODEL.md, docs/PHONE-RUNBOOK.md).
//
// The pieces, all from the security core in remote/src:
//   - identity + device registry + audit: remote/src/node (0600 files under
//     <data>/remote/), pairing: PairingHost (QR + typed 6-digit code).
//   - every decision goes through RemoteApprovals.handleDecision only, over
//     WidgetRequestStore (hooks/answer-file.js: keyed, first-wins, hook ack).
//     Nothing else here writes an answer (THREAT_MODEL §9.3).
//   - a decision needs, on top of the device's signature, a fresh
//     user-verified passkey assertion over that decision (passkeyFactor), and
//     must arrive on the end-to-end channel of the device that signed it.
//   - deny-listed requests are "desk only" (announced as such; an allow is
//     refused with approve-at-desk); decisions live ≤ 120 s, bound to the
//     request id and the hash of the tool input; a revoked device is refused
//     both by the channel (no key) and by the registry.
//
// Transport: the remote interaction host (src/remote-interaction.js) with
// W2-A's envelope. hostOptions() gives main.js's createHost {e2e, extra}:
// `e2e` is read per frame (required while phone approvals are on), `extra`
// serves the sealed approval ops and the plain pairing ops. The hub only ever
// sees ciphertext for approvals and tasks (board/hub/approval-relay.js), and
// gets a content-free "ping" when a new request is waiting, which it turns
// into a Web Push with no payload (board/hub/push.js).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Remote = require('../remote/src/index.js');
const RemoteNode = require('../remote/src/node/index.js');

const EXTRA_OPS = Object.freeze(['approvals.list', 'approvals.decide', 'approvals.passkey', 'tasks.start']);
const PAIR_OPS = Object.freeze(['pair.init', 'pair.reveal', 'pair.poll']);
const PASSKEY_WINDOW_MS = 10 * 60_000;
const PING_MIN_MS = 5_000;
const POLL_MS = 1_500;
const MAX_LIST = 20;
const MAX_TASK_TEXT = 4000;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const REQ_FILE = /^([A-Za-z0-9._-]{1,200})\.json$/;

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => object(v) && Object.keys(v).every((k) => keys.includes(k));
const refuse = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });
const INVALID = refuse('invalid', 'That request was not understood.');

function originOf(url) {
  try { const u = new URL(url); return u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ? u.origin : null; } catch { return null; }
}

/**
 * The core, without Electron. hub() → {origin, userId, token: () => string} | null
 * (this computer's team-hub sign-in); host() → the remote interaction host or
 * null; ping(url, token) → Promise<status> (the one network call, main side).
 */
function createRemoteApprovals({ dir, requestsDir, keyFor = () => null, entitlements, hub = () => null, host = () => null, ping = async () => 0, clock = Date.now, log = () => {}, realpath = fs.realpathSync.native, home = os.homedir() }) {
  const settingsFile = path.join(dir, 'settings.json');
  let identity = null, registry = null, approvals = null, pairing = null, pairingKey = null, current = null;
  let lastPing = 0;
  const pinged = new Set();
  const started = new Set(); // pids started here: the phone may poll one after the human confirmed it
  const listeners = new Set();
  const changed = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* a page went away */ } } };

  function settings() {
    try {
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      return { enabled: s?.enabled === true, phoneOrigin: typeof s?.phoneOrigin === 'string' ? originOf(s.phoneOrigin) : null };
    } catch { return { enabled: false, phoneOrigin: null }; }
  }
  function saveSettings(next) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${settingsFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, settingsFile);
  }

  const account = () => { const h = hub(); return h && originOf(h.origin) && typeof h.userId === 'string' && h.userId ? h : null; };
  const entitled = () => { try { return entitlements.has('phone') === true; } catch { return false; } };
  const deviceLimit = () => { try { const n = entitlements.limits().devices; return Number.isFinite(n) ? n : 0; } catch { return 0; } };
  const active = () => !!identity && entitled() && settings().enabled && !!account();
  // The origin the phone app runs on (pinned for passkeys): the team hub's
  // own, until the separate static origin exists (docs/PHONE-RUNBOOK.md).
  const phoneOrigin = () => settings().phoneOrigin ?? originOf(account()?.origin ?? '');
  const origins = () => { const o = phoneOrigin(); return o ? [o] : []; };
  const rpId = () => { const o = phoneOrigin(); return o ? new URL(o).hostname : ''; };

  // The widget's pending requests, as the hook wrote them; the owner is the signed-in user.
  const store = () => new RemoteNode.WidgetRequestStore({ requestsDir, ownerId: account()?.userId ?? '\0none', keyFor, clock });
  const pending = { get: (id) => store().get(id), settle: (id, decision, meta) => store().settle(id, decision, meta) };

  const ready = (async () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    identity = await RemoteNode.loadOrCreateIdentity(path.join(dir, 'identity.json'));
    registry = new Remote.DeviceRegistry({ storage: RemoteNode.fileStorage(path.join(dir, 'devices.json')), clock });
    const auditFile = path.join(dir, 'audit.jsonl');
    approvals = new Remote.RemoteApprovals({
      identity, registry, pending, clock, realpath, home,
      audit: RemoteNode.jsonlAudit(auditFile), auditHead: RemoteNode.readAuditHead(auditFile),
      secondFactor: Remote.passkeyFactor({ registry, rpId, origins }),
    });
  })().catch((e) => { log(`[phone] could not load this computer's phone keys: ${e?.message ?? e}`); });

  function e2eConfig() {
    if (!identity) return null;
    // A phone paired under another account of this computer gets no channel while that account is not signed in.
    const peer = async (dev) => { const rec = await registry.get(dev); return rec && rec.ownerId === account()?.userId ? registry.activeAgreeKey(dev) : null; };
    return { did: identity.desktopId, privateKey: identity.agreePrivateKey, peer, required: active() };
  }

  function pairingHost() {
    const a = account();
    if (!a || !identity) return null;
    const key = `${a.origin}\n${a.userId}`;
    if (pairingKey !== key) {
      pairing = new Remote.PairingHost({ identity, registry, ownerId: a.userId, hubUrl: a.origin, clock, audit: RemoteNode.jsonlAudit(path.join(dir, 'audit-pairing.jsonl')) });
      pairingKey = key;
      current = null;
    }
    return pairing;
  }

  async function activeDevices() {
    const a = account();
    return registry ? (await registry.list()).filter((d) => !d.revokedAt && d.ownerId === a?.userId) : [];
  }
  // Every phone not yet removed, any account: all of them can be removed from Settings → Phone.
  async function unrevoked() {
    return registry ? (await registry.list()).filter((d) => !d.revokedAt) : [];
  }

  async function listNotices() {
    let files = [];
    try { files = fs.readdirSync(requestsDir); } catch { return []; }
    const out = [];
    for (const f of files) {
      const m = REQ_FILE.exec(f);
      if (!m) continue;
      const p = await pending.get(m[1]).catch(() => null);
      if (p) out.push(p);
    }
    out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return out.slice(0, MAX_LIST);
  }

  async function registerPasskey(dev, args) {
    if (!closed(args, ['credentialId', 'publicKey', 'algorithm', 'authenticatorData', 'clientDataJSON'])) return INVALID;
    const rec = await registry.get(dev);
    if (!rec || rec.revokedAt) return refuse('forbidden', 'This phone is not paired with this computer.');
    if (rec.passkey) return refuse('conflict', 'This phone already has a passkey here. Pair it again to change it.');
    if (clock() - rec.createdAt > PASSKEY_WINDOW_MS) return refuse('expired', 'Too late to add a passkey for this pairing. Pair this phone again.');
    const r = await Remote.verifyRegistration({ rpId: rpId(), origins: origins(), expectedChallenge: await Remote.passkeyRegistrationChallenge({ desktopId: identity.desktopId, deviceId: dev }), ...args });
    if (!r.ok) return refuse('rejected', 'The passkey could not be checked.', { reason: r.reason });
    const ok = await registry.setPasskey(dev, { credentialId: args.credentialId, publicKey: r.publicKey, signCount: r.signCount });
    changed();
    return ok ? { ok: true } : refuse('conflict', 'This phone already has a passkey here.');
  }

  async function startTask(args, run) {
    if (!closed(args, ['provider', 'text']) || typeof args.provider !== 'string' || !PROVIDER.test(args.provider) || typeof args.text !== 'string') return INVALID;
    const text = args.text.trim();
    if (!text || text.length > MAX_TASK_TEXT) return INVALID;
    const launched = await run('launch', { provider: args.provider });
    if (!launched?.ok || !launched.state) return launched ?? refuse('unavailable', 'The session did not start.');
    const sent = await run('send', { session: launched.state.session, generation: launched.state.generation, text });
    return { ...sent, session: launched.state.session };
  }

  /** extra.run for the interaction host: sealed approval ops (dev = the channel's device) and plain pairing ops. */
  async function run(op, args, { dev = null, run: hostRun = null } = {}) {
    await ready;
    if (!identity) return refuse('unavailable', 'Phone approvals are not ready on this computer.');
    if (!entitled()) return refuse('plan', 'Phone approvals are part of Plexiform Plus.');
    if (!active()) return refuse('off', 'Phone approvals are switched off on this computer.');
    if (PAIR_OPS.includes(op)) {
      const ph = pairingHost();
      if (!ph || !object(args) || typeof args.pid !== 'string') return { ok: false, reason: 'pairing-closed' };
      if (op === 'pair.poll') return started.has(args.pid) ? ph.poll(args.pid) : { ok: false, reason: 'pairing-closed' };
      if (!current || args.pid !== current.pid) return { ok: false, reason: 'pairing-closed' };
      if (op === 'pair.init') return ph.handleInit(args);
      const r = await ph.handleReveal(args);
      if (r.ok && current?.pid === args.pid) { current.stage = 'confirm'; current.deviceName = r.deviceName; changed(); }
      return r;
    }
    if (typeof dev !== 'string' || !EXTRA_OPS.includes(op)) return INVALID;
    const rec = await registry.get(dev);
    if (!rec || rec.revokedAt || rec.ownerId !== account()?.userId) return refuse('forbidden', 'This phone is not paired with this computer for this account.');
    if (op === 'approvals.list') {
      if (!closed(args, [])) return INVALID;
      const items = [];
      for (const p of await listNotices()) items.push(await approvals.announce(p));
      return { ok: true, did: identity.desktopId, items };
    }
    if (op === 'approvals.decide') {
      if (!closed(args, ['envelope', 'assertion'])) return INVALID;
      const out = await approvals.handleDecision(args.envelope, { channelDevice: dev, assertion: args.assertion ?? null });
      if (out.status === 'applied') { changed(); log(`[phone] a request was answered from a paired phone (${out.event?.decision ?? 'unknown'})`); }
      return { ok: true, body: out.body };
    }
    if (op === 'approvals.passkey') return registerPasskey(dev, args);
    if (!hostRun) return refuse('unavailable', 'Tasks are not available on this computer.');
    return startTask(args, hostRun);
  }

  /** Every POLL_MS: a content-free ping to the hub when a new request is waiting. */
  async function tick() {
    await ready;
    const a = account();
    if (!active() || !a || !host()?.status?.().connected) return;
    const ids = (await listNotices()).map((p) => p.requestId);
    for (const id of [...pinged]) if (!ids.includes(id)) pinged.delete(id);
    const fresh = ids.filter((id) => !pinged.has(id));
    if (!fresh.length || clock() - lastPing < PING_MIN_MS) return;
    if (!(await activeDevices()).some((d) => d.passkey)) return;
    lastPing = clock();
    let status = 0;
    try { status = await ping(`${a.origin}/api/approvals/v1/ping`, typeof a.token === 'function' ? a.token() : a.token); } catch { status = 0; }
    if (status >= 200 && status < 300) for (const id of fresh) pinged.add(id);
  }

  // ── Desktop UI (src/remote-pairing-view.js through the page's IPC) ────────
  async function state() {
    await ready;
    const a = account();
    const h = host();
    const st = h?.status?.() ?? null;
    const devices = (await unrevoked()).map((d) => ({ deviceId: d.deviceId, name: d.name, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt, passkey: !!d.passkey, otherAccount: d.ownerId !== a?.userId }));
    const p = current && current.expiresAt > clock() ? current : null;
    if (!p) current = null;
    return {
      ready: !!identity, entitled: entitled(), enabled: settings().enabled, signedIn: !!a,
      hostConnected: !!st?.connected, devices, limit: deviceLimit(), phoneOrigin: phoneOrigin(),
      pairing: p ? { pid: p.pid, link: p.link, expiresAt: p.expiresAt, stage: p.stage, deviceName: p.deviceName ?? null } : null,
    };
  }

  function setEnabled(on) {
    saveSettings({ ...settings(), enabled: on === true });
    changed();
  }

  async function startPairing() {
    await ready;
    if (!entitled()) return refuse('plan', 'Phone approvals are part of Plexiform Plus.');
    if (!active()) return refuse('off', 'Turn on phone approvals first.');
    const st = host()?.status?.();
    if (!st?.connected || typeof st.device !== 'string') return refuse('offline', 'Turn on “Let my other devices use sessions” in Preferences and wait until it says On.');
    if ((await activeDevices()).length >= deviceLimit()) return refuse('limit', `Your plan pairs up to ${deviceLimit()} phones. Remove one first.`);
    const ph = pairingHost();
    if (current) ph.cancel(current.pid);
    const { pid, qr, expiresAt } = await ph.start();
    started.add(pid);
    while (started.size > 16) started.delete(started.values().next().value);
    const params = new URLSearchParams({ pair: '1', hub: qr.hub, did: qr.did, dpk: qr.dpk, pid: qr.pid, s: qr.s, exp: String(qr.exp), h: st.device });
    current = { pid, expiresAt, stage: 'waiting', link: `${phoneOrigin()}/phone/#${params}` };
    changed();
    return { ok: true };
  }

  async function confirmPairing(pid, code) {
    await ready;
    const ph = pairingHost();
    if (!ph || !current || current.pid !== pid) return refuse('stale', 'That pairing has ended. Start again.');
    if ((await activeDevices()).length >= deviceLimit()) { ph.cancel(pid); current = null; changed(); return refuse('limit', 'Your plan’s phone limit is reached.'); }
    const r = await ph.confirm(pid, code);
    if (!r.ok) { current = null; changed(); return refuse('wrong-code', r.reason === 'wrong-code' ? 'That code didn’t match, so the pairing was cancelled. Start again.' : 'The pairing ended. Start again.'); }
    current = null;
    changed();
    return { ok: true, device: { deviceId: r.device.deviceId, name: r.device.name } };
  }

  function cancelPairing() {
    if (current) pairing?.cancel(current.pid);
    current = null;
    changed();
  }

  async function revoke(deviceId) {
    await ready;
    if (typeof deviceId !== 'string' || !registry) return false;
    const ok = await registry.revoke(deviceId);
    try { host()?.forgetDevice?.(deviceId); } catch { /* host gone */ }
    changed();
    return ok;
  }

  return {
    ready, run, tick, state, setEnabled, startPairing, confirmPairing, cancelPairing, revoke, e2eConfig,
    hostOptions: () => ({ e2e: () => e2eConfig(), extra: { ops: EXTRA_OPS, plainOps: PAIR_OPS, run } }),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    close: () => { listeners.clear(); cancelPairing(); },
  };
}

/** Paid-wiring entry point (src/paid-wiring.js). */
function register(ctx) {
  const { ipcMain, rootDir, entitlements, fromPage, onQuit, log } = ctx;
  const { net } = require('electron'); // privacy-flow: phone-approvals
  const core = createRemoteApprovals({
    dir: path.join(rootDir, 'remote'),
    requestsDir: ctx.requestsDir ?? path.join(rootDir, 'requests'),
    keyFor: typeof ctx.keyFor === 'function' ? ctx.keyFor : () => null,
    entitlements, log,
    hub: () => { const id = ctx.buddy?.()?.interactionHostIdentity?.(); return id ? { origin: id.origin, userId: id.userId, token: id.token } : null; },
    host: () => ctx.interactionHost?.() ?? null,
    // The only network call: "a request is waiting", no content (board/hub/approval-relay.js).
    ping: async (url, token) => (await net.fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: '{}' })).status, // privacy-flow: phone-approvals
  });
  ctx.setInteractionHostExtras?.(() => core.hostOptions());

  const page = () => ctx.buddy?.()?.pageWebContents?.('phone') ?? null;
  core.onChange(() => { const wc = page(); if (wc && !wc.isDestroyed()) wc.send('phone:changed'); });
  const ok = (e) => fromPage(e, 'phone');
  ipcMain.handle('phone:state', (e) => (ok(e) ? core.state() : null));
  ipcMain.handle('phone:set', (e, patch) => { if (!ok(e) || !object(patch) || typeof patch.enabled !== 'boolean') return null; core.setEnabled(patch.enabled); return core.state(); });
  ipcMain.handle('phone:pair-start', (e) => (ok(e) ? core.startPairing() : null));
  ipcMain.handle('phone:pair-confirm', (e, pid, code) => (ok(e) && typeof pid === 'string' && typeof code === 'string' && code.length <= 20 ? core.confirmPairing(pid, code) : null));
  ipcMain.handle('phone:pair-cancel', (e) => { if (ok(e)) core.cancelPairing(); return null; });
  ipcMain.handle('phone:revoke', (e, deviceId) => (ok(e) && typeof deviceId === 'string' && deviceId.length <= 64 ? core.revoke(deviceId) : null));
  ipcMain.handle('phone:upgrade', (e) => { if (ok(e)) ctx.buddy?.()?.open?.('upgrade'); return null; });

  const timer = setInterval(() => { core.tick().catch((err) => log(`[phone] ${err?.message ?? err}`)); }, POLL_MS);
  timer.unref?.();
  onQuit?.(() => { clearInterval(timer); core.close(); });
  return core;
}

module.exports = { register, createRemoteApprovals, EXTRA_OPS, PAIR_OPS, PASSKEY_WINDOW_MS };
