// LOCAL / DISPOSABLE PROOF ONLY — not production account acceptance.
// An in-process accounts-mode hub on a loopback temp port, a "Windows" client
// device and a "Mac" host device of the same account (both real desktop
// device tokens from the email sign-in flow), the Mac's sessions backed by
// the FAKE codex app-server fixture (test/fixtures/fake-codex-app-server.js),
// plus a second account's Mac. No real provider, Cloudflare or deployed hub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { startAccounts } from './accounts-helpers.js';
import { createLogger } from '../log.js';
import { RELAY_LIMITS } from '../interaction-relay.js';

const require = createRequire(import.meta.url);
const { createRemoteInteractionHost, createRemoteInteractionClient } = require('../../../src/remote-interaction.js');
const { createCodexAppServer } = require('../../../src/codex-app-server.js');
const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test', 'fixtures', 'fake-codex-app-server.js');

const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 15)); } };

async function rig({ limits } = {}) {
  const lines = [];
  const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
  const h = await startAccounts({ log, config: limits ? { interactionLimits: limits } : {} });
  const signIn = async (email, name) => {
    const r = await h.signIn(email, { device_name: name });
    assert.equal(r.status, 200, r.text);
    return { token: r.body.device_token, device: r.body.device_id, user: r.body.user.id };
  };
  const macA = await signIn('alice@dev.local', 'Alice Mac');
  const winA = await signIn('alice@dev.local', 'Alice Windows');
  const macB = await signIn('bob@dev.local', 'Bob Mac');
  const winB = await signIn('bob@dev.local', 'Bob Windows');
  const wsUrl = `${h.base.replace('http', 'ws')}/ws/interaction-host`;
  const hosts = [];
  const host = async (dev, { userId = dev.user, retry } = {}) => {
    const adapter = createCodexAppServer({ bin: FAKE });
    // Contract defaults: boardCurrent refuses unless supplied; remote sessions are board-less.
    const x = createRemoteInteractionHost({ userId, adapters: { codex: adapter }, boardCurrent: (b) => b === null, retry });
    x.adapter = adapter;
    hosts.push(x);
    // The explicit opt-in: this device's role becomes 'host', then it connects.
    const st = await x.enable({ baseUrl: h.base, token: dev.token, WebSocket });
    assert.equal(st.state, 'connected');
    return x;
  };
  const setRole = (dev, role) => h.call('PUT', '/api/interaction/v1/role', { token: dev.token, body: { role } });
  // A hand-driven host socket (role must already be 'host'): → {ws, welcome, frames, closed}.
  const rawHost = (dev, headers = {}, opts = {}) => new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${dev.token}`, ...headers }, ...opts });
    const out = { ws, frames: [], closed: null };
    ws.on('message', (d) => { const f = JSON.parse(String(d)); if (f.type === 'relay.welcome') { out.welcome = f; resolve(out); } else out.frames.push(f); });
    ws.on('close', (code) => { out.closed = code; });
    ws.once('unexpected-response', (req, res) => { req.destroy(); reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })); });
    ws.on('error', () => {});
    hostsRaw.push(ws);
  });
  const hostsRaw = [];
  const client = (dev) => createRemoteInteractionClient({ baseUrl: h.base, token: dev.token });
  return {
    h, lines, macA, winA, macB, winB, wsUrl, host, client, setRole, rawHost,
    async close() { for (const x of hosts) x.close(); for (const w of hostsRaw) w.terminate(); await h.close(); },
  };
}

test('LOCAL PROOF: Windows device sends to and reads the reply of an owned session on the same account\'s Mac', async () => {
  const r = await rig();
  try {
    const mac = await r.host(r.macA);
    const win = r.client(r.winA);
    const listed = await win.hosts();
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.hosts.map((x) => [x.id, x.current]), [[r.macA.device, false]]);

    const caps = await win.call(r.macA.device, 'capabilities');
    assert.equal(caps.body.result.providers[0].provider, 'codex');
    const launched = await win.call(r.macA.device, 'launch', { provider: 'codex' });
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    const s = launched.body.result.state;
    assert.equal(s.ownership, 'plexiform-owned');

    const sent = await win.call(r.macA.device, 'send', { session: s.session, generation: s.generation, text: 'hello from windows' });
    assert.equal(sent.body.result.status, 'acknowledged');
    assert.equal(sent.body.result.delivery.mode, 'new-turn');

    // Long-poll until the reply has streamed back through the relay.
    let after = 0, done = null;
    await until(async () => {
      const w = await win.call(r.macA.device, 'watch', { session: s.session, after });
      assert.equal(w.status, 200);
      after = w.body.result.version;
      done = w.body.result.state.deliveries.find((d) => d.state === 'completed');
      return done;
    });
    assert.equal(done.response, 'echo:hello from windows');
    assert.equal(done.recorded, true);

    // Steer + interrupt carry the same contract.
    await win.call(r.macA.device, 'send', { session: s.session, generation: s.generation, text: 'HOLD' });
    const turn = await until(async () => (await win.call(r.macA.device, 'state', { session: s.session })).body.result.state.activeTurn);
    const busy = await win.call(r.macA.device, 'send', { session: s.session, generation: s.generation, text: 'again' });
    assert.equal(busy.body.result.status, 'busy');
    const steer = await win.call(r.macA.device, 'send', { session: s.session, generation: s.generation, text: 'more', expectedTurn: turn });
    assert.equal(steer.body.result.delivery.mode, 'steer');
    await win.call(r.macA.device, 'send', { session: s.session, generation: s.generation, text: 'HOLD 2' });
    const turn2 = await until(async () => (await win.call(r.macA.device, 'state', { session: s.session })).body.result.state.activeTurn);
    const intr = await win.call(r.macA.device, 'interrupt', { session: s.session, generation: s.generation, turn: turn2 });
    assert.equal(intr.body.result.status, 'interrupt-requested');
    await until(async () => (await win.call(r.macA.device, 'state', { session: s.session })).body.result.state.deliveries.some((d) => d.state === 'interrupted'));

    // Notices (a refused provider approval) travel with the delivery.
    await win.call(r.macA.device, 'send', { session: s.session, generation: s.generation, text: 'APPROVAL please' });
    const noticed = await until(async () => (await win.call(r.macA.device, 'state', { session: s.session })).body.result.state.deliveries.find((d) => d.notices.length));
    assert.match(noticed.notices[0], /approval/);

    // The list is the account's remote sessions; close ends one.
    const list = await win.call(r.macA.device, 'list');
    assert.deepEqual(list.body.result.sessions.map((x) => x.session), [s.session]);
    assert.equal((await win.call(r.macA.device, 'close', { session: s.session, generation: s.generation })).body.result.status, 'closed');

    // No provider thread id on the wire; no message text in hub logs.
    const target = mac.hub.targetOf(s.session); // null after close; take one from a live session instead
    const s2 = (await win.call(r.macA.device, 'launch', { provider: 'codex' })).body.result.state;
    const t2 = mac.hub.targetOf(s2.session);
    assert.ok(t2);
    const wire = JSON.stringify([listed.body, launched.body, sent.body, (await win.call(r.macA.device, 'list')).body]);
    assert.ok(!wire.includes(t2));
    assert.equal(target, null);
    // A provider exit shows as an ended session on the remote side.
    mac.adapter.stop();
    const ended = await until(async () => { const st = (await win.call(r.macA.device, 'state', { session: s2.session })).body.result.state; return st.status === 'ended' && st; });
    assert.equal(ended.status, 'ended');
    assert.equal((await win.call(r.macA.device, 'send', { session: s2.session, generation: s2.generation, text: 'late' })).body.result.status, 'stale');
    const logs = r.lines.join('\n');
    for (const secret of ['hello from windows', 'echo:', 'HOLD', 'more', 'APPROVAL']) assert.ok(!logs.includes(secret), `log carries ${secret}`);
  } finally { await r.close(); }
});

test('HOSTILE: cross-account — user B cannot see or reach user A\'s Mac, and a host never serves another user', async () => {
  const r = await rig();
  try {
    await r.host(r.macA);
    await r.host(r.macB);
    const bob = r.client(r.winB);
    const seen = await bob.hosts();
    assert.deepEqual(seen.body.hosts.map((x) => x.id), [r.macB.device]);
    const cross = await bob.call(r.macA.device, 'list');
    assert.equal(cross.status, 404);
    // Alice's Windows cannot reach Bob's Mac either.
    assert.equal((await r.client(r.winA).call(r.macB.device, 'list')).status, 404);
    // A host built for Alice refuses a hub welcome naming anyone else.
    const wrong = createRemoteInteractionHost({ userId: r.macA.user, adapters: {} });
    const b2 = await r.h.signIn('bob@dev.local', { device_name: 'Bob Mac 2' });
    const macB2 = { token: b2.body.device_token };
    assert.equal((await r.setRole(macB2, 'host')).status, 200);
    await assert.rejects(wrong.connect({ url: r.wsUrl, token: macB2.token, WebSocket }), /different account/);
    // …and refuses a (forged or misrouted) request frame for another user.
    const res = await wrong.handle({ type: 'relay.request', id: crypto.randomUUID(), rid: crypto.randomUUID(), user: r.macB.user, from: 'x', op: 'list', args: {} });
    assert.equal(res.status, 'forbidden');
    wrong.close();
  } finally { await r.close(); }
});

test('HOSTILE: revoking a device cuts access at once (client and host)', async () => {
  const r = await rig();
  try {
    const mac = await r.host(r.macA);
    const win = r.client(r.winA);
    const s = (await win.call(r.macA.device, 'launch', { provider: 'codex' })).body.result.state;
    // Revoke the Windows device (from the Mac's own token): its next call fails.
    const rev = await r.h.call('DELETE', `/api/account/devices/${r.winA.device}`, { token: r.macA.token, body: {} });
    assert.equal(rev.status, 200, rev.text);
    assert.equal((await win.call(r.macA.device, 'list')).status, 401);
    assert.equal((await win.hosts()).status, 401);
    // Revoke the Mac host: the hub drops its socket, nobody can reach it.
    const win2 = await r.h.signIn('alice@dev.local', { device_name: 'Alice Windows 2' });
    const c2 = r.client({ token: win2.body.device_token });
    assert.equal((await c2.call(r.macA.device, 'list')).status, 200);
    assert.equal((await r.h.call('DELETE', `/api/account/devices/${r.macA.device}`, { token: win2.body.device_token, body: {} })).status, 200);
    assert.equal((await c2.call(r.macA.device, 'list')).status, 404);
    await until(() => !mac.connected());
    // The Mac ends its remote sessions when its own device is revoked.
    await until(() => mac.hub.list(mac.actor).length === 0);
    assert.equal(mac.hub.targetOf(s.session), null);
    assert.deepEqual((await c2.hosts()).body.hosts, []);
    // A revoked token cannot open a host socket again.
    await assert.rejects(mac.connect({ url: r.wsUrl, token: r.macA.token, WebSocket }), /401/);
  } finally { await r.close(); }
});

test('HOSTILE: replayed send, stale generation, oversized message, forged actor and cookie/browser hosts are refused', async () => {
  const r = await rig();
  try {
    const mac = await r.host(r.macA);
    const win = r.client(r.winA);
    const s = (await win.call(r.macA.device, 'launch', { provider: 'codex' })).body.result.state;
    const msg = { session: s.session, generation: s.generation, text: 'once' };

    // Replay: the same request_id is refused, the provider sees one send.
    const rid = crypto.randomUUID();
    assert.equal((await win.call(r.macA.device, 'send', msg, rid)).body.result.status, 'acknowledged');
    const again = await win.call(r.macA.device, 'send', msg, rid);
    assert.equal(again.status, 409); assert.equal(again.body.error.reason, 'REPLAYED');
    await until(async () => (await win.call(r.macA.device, 'state', { session: s.session })).body.result.state.deliveries.every((d) => d.state === 'completed'));
    assert.equal((await win.call(r.macA.device, 'state', { session: s.session })).body.result.state.deliveries.length, 1);
    // The host also refuses a relay id or (device, request_id) it already handled.
    const frame = { type: 'relay.request', id: crypto.randomUUID(), rid: crypto.randomUUID(), user: r.macA.user, from: r.winA.device, op: 'list', args: {} };
    assert.equal((await mac.handle(frame)).ok, true);
    assert.equal((await mac.handle(frame)).status, 'stale');
    assert.equal((await mac.handle({ ...frame, id: crypto.randomUUID() })).status, 'stale');

    // Stale generation: the provider target was replaced on the Mac.
    await mac.hub.replaceTarget(s.session);
    const stale = await win.call(r.macA.device, 'send', msg);
    assert.equal(stale.body.result.status, 'stale');
    const fresh = (await win.call(r.macA.device, 'state', { session: s.session })).body.result.state;
    assert.equal(fresh.generation, s.generation + 1);
    // Stale turn id for steer / interrupt.
    assert.equal((await win.call(r.macA.device, 'interrupt', { session: s.session, generation: fresh.generation, turn: crypto.randomUUID() })).body.result.status, 'stale');

    // Oversized: over the core text bound, and over the relay args bound.
    assert.equal((await win.call(r.macA.device, 'send', { ...msg, generation: fresh.generation, text: 'x'.repeat(4001) })).body.result.status, 'invalid');
    assert.equal((await win.call(r.macA.device, 'send', { ...msg, generation: fresh.generation, text: 'x'.repeat(17000) })).status, 413);
    assert.equal((await win.request('POST', `/api/interaction/v1/hosts/${r.macA.device}/call`, { request_id: crypto.randomUUID(), op: 'send', args: { pad: 'x'.repeat(80_000) } })).status, 413);

    // Forged actor / user: extra fields are refused by the hub and by the contract.
    const forged = await win.request('POST', `/api/interaction/v1/hosts/${r.macA.device}/call`, { request_id: crypto.randomUUID(), op: 'list', args: {}, user: r.macB.user, actor: 'account:x' });
    assert.equal(forged.status, 400);
    assert.equal((await win.call(r.macA.device, 'send', { ...msg, generation: fresh.generation, actor: 'overview:1:1' })).body.result.status, 'invalid');
    assert.equal((await win.call(r.macA.device, 'launch', { provider: 'codex', actor: 'account:x' })).body.result.status, 'invalid');
    assert.equal((await win.call(r.macA.device, 'nope')).status, 400);
    // An Overview-owned (local) session on the same Mac hub is not reachable remotely.
    const local = (await mac.hub.launch({ provider: 'codex' }, 'overview:1:1')).state;
    assert.equal((await win.call(r.macA.device, 'state', { session: local.session })).body.result.status, 'stale');
    assert.equal((await win.call(r.macA.device, 'send', { session: local.session, generation: local.generation, text: 'hi' })).body.result.status, 'forbidden');
    assert.ok(!(await win.call(r.macA.device, 'list')).body.result.sessions.some((x) => x.session === local.session));

    // Hosting needs a desktop device token: no token, a browser Origin, or a web cookie session are refused.
    const status = (headers) => new Promise((resolve) => {
      const ws = new WebSocket(r.wsUrl, { headers });
      ws.once('unexpected-response', (req, res) => { resolve(res.statusCode); req.destroy(); });
      ws.once('open', () => { resolve(101); ws.terminate(); });
      ws.once('error', () => {});
    });
    assert.equal(await status({}), 401);
    assert.equal(await status({ authorization: `Bearer ${r.winA.token}`, origin: 'https://evil.example' }), 403);
    const web = await r.h.webSignIn('alice@dev.local');
    assert.equal(await status({ cookie: web.cookie }), 403);
    assert.equal((await r.h.call('GET', '/api/interaction/v1/hosts', { cookie: web.cookie })).status, 403);
  } finally { await r.close(); }
});

const callBody = (op = 'list', args = {}, rid = crypto.randomUUID()) => ({ request_id: rid, op, args });
const post = (r, dev, host, body) => r.h.call('POST', `/api/interaction/v1/hosts/${host}/call`, { token: dev.token, body });
const answer = (raw, f, result) => raw.ws.send(JSON.stringify({ type: 'relay.reply', id: f.id, result }));

test('HOSTILE: hosting needs the device\'s own opt-in; a host cannot call and a client cannot host', async () => {
  const r = await rig();
  try {
    // Default role is client: no host socket.
    await assert.rejects(r.rawHost(r.macA), (e) => e.status === 403);
    assert.equal((await r.setRole(r.macA, 'host')).status, 200);
    const raw = await r.rawHost(r.macA);
    assert.equal(raw.welcome.device, r.macA.device);
    assert.ok(raw.welcome.resume.length >= 32);
    // The host's token cannot drive hosts (its own or any other).
    assert.equal((await r.client(r.macA).hosts()).status, 403);
    assert.equal((await post(r, r.macA, r.macA.device, callBody())).status, 403);
    // Only the device's own role changes; bad bodies refused; cookies cannot set it.
    assert.equal((await r.h.call('PUT', '/api/interaction/v1/role', { token: r.winA.token, body: { role: 'host', device: r.macA.device } })).status, 400);
    const web = await r.h.webSignIn('alice@dev.local');
    assert.equal((await r.h.call('PUT', '/api/interaction/v1/role', { cookie: web.cookie, headers: { 'x-csrf-token': web.csrf }, body: { role: 'host' } })).status, 403);
    // Turning hosting off drops the live socket and hides the host at once.
    assert.equal((await r.client(r.winA).hosts()).body.hosts.length, 1);
    assert.equal((await r.setRole(r.macA, 'client')).status, 200);
    await until(() => raw.closed === 1000);
    assert.deepEqual((await r.client(r.winA).hosts()).body.hosts, []);
    // Even a socket left open is not reachable once the flag is off (checked in liveHost).
    assert.equal((await r.setRole(r.macA, 'host')).status, 200);
    const raw2 = await r.rawHost(r.macA);
    r.h.db.run("UPDATE user_devices SET interaction_role = 'client' WHERE id = ?", r.macA.device);
    assert.equal((await post(r, r.winA, r.macA.device, callBody())).status, 404);
    await until(() => raw2.closed === 1000);
  } finally { await r.close(); }
});

test('HOSTILE: device-kind check in call — cookie sessions and host-role devices cannot call', async () => {
  const r = await rig();
  try {
    await r.host(r.macA);
    const web = await r.h.webSignIn('alice@dev.local');
    const res = await r.h.call('POST', `/api/interaction/v1/hosts/${r.macA.device}/call`, { cookie: web.cookie, headers: { 'x-csrf-token': web.csrf }, body: callBody() });
    assert.equal(res.status, 403);
    assert.equal((await post(r, r.macA, r.macA.device, callBody())).status, 403);
    assert.equal((await post(r, r.winA, r.macA.device, callBody())).status, 200);
  } finally { await r.close(); }
});

test('HOSTILE: replacement rule — a live host is not replaced without its resume nonce; REPLACED is told, not silent', async () => {
  const r = await rig({ limits: { probeMs: 150 } });
  try {
    await r.setRole(r.macA, 'host');
    const a = await r.rawHost(r.macA);
    // A thief with the same token but not the nonce is refused; the live host is told.
    await assert.rejects(r.rawHost(r.macA), (e) => e.status === 409);
    await until(() => a.frames.some((f) => f.type === 'relay.notice' && f.kind === 'replace-refused'));
    assert.equal(a.closed, null);
    // The real host re-handshaking with its nonce replaces the old socket, which is closed 4409.
    const b = await r.rawHost(r.macA, { 'x-plexiform-resume': a.welcome.resume });
    await until(() => a.closed === 4409);
    assert.notEqual(b.welcome.resume, a.welcome.resume);
    // The old nonce is dead with its socket.
    await assert.rejects(r.rawHost(r.macA, { 'x-plexiform-resume': a.welcome.resume }), (e) => e.status === 409);
    // The host module shows a 4409 as 'replaced' and stops retrying.
    b.ws.terminate();
    await until(async () => (await r.client(r.winA).hosts()).body.hosts.length === 0);
    const mac = await r.host(r.macA);
    const c = await r.rawHost(r.macA, { 'x-plexiform-resume': 'x'.repeat(32) }).catch((e) => e);
    assert.equal(c.status, 409);
    assert.match(mac.status().notice, /refused/);
    // A half-open host (no pong) is dropped after probeMs so the real one gets back in.
    mac.close();
    await until(() => !r.h.hub.interactionRelay.hosts.has(r.macA.device));
    const dead = await r.rawHost(r.macA, {}, { autoPong: false });
    await assert.rejects(r.rawHost(r.macA), (e) => e.status === 409);
    await until(() => dead.closed !== null);
    const back = await r.rawHost(r.macA);
    assert.ok(back.welcome);
  } finally { await r.close(); }
});

test('HOSTILE: host module shows REPLACED and does not reconnect', async () => {
  const r = await rig();
  try {
    const mac = await r.host(r.macA, { retry: { baseMs: 20, maxMs: 40 } });
    r.h.hub.interactionRelay.hosts.get(r.macA.device).ws.close(4409, 'replaced by a newer connection');
    await until(() => mac.status().state === 'replaced');
    await new Promise((res) => setTimeout(res, 120));
    assert.equal(mac.connected(), false);
    assert.equal(mac.status().state, 'replaced');
  } finally { await r.close(); }
});

test('HOSTILE: a bad host frame drops the host socket', async () => {
  const r = await rig();
  try {
    await r.setRole(r.macA, 'host');
    const a = await r.rawHost(r.macA);
    a.ws.send('not json');
    await until(() => a.closed === 1008);
    const b = await r.rawHost(r.macA);
    b.ws.send(JSON.stringify({ type: 'relay.reply', id: 'x', result: {}, extra: 1 }));
    await until(() => b.closed === 1008);
    const c = await r.rawHost(r.macA);
    c.ws.send(Buffer.from('{}'), { binary: true });
    await until(() => c.closed === 1008);
  } finally { await r.close(); }
});

test('HOSTILE: 32-pending cap, request_id burnt only on dispatch, 25s timeout reports an unknown outcome, 768KB reply limit', async () => {
  assert.equal(RELAY_LIMITS.pendingPerHost, 32);
  assert.equal(RELAY_LIMITS.timeoutMs, 25_000);
  assert.equal(RELAY_LIMITS.replyBytes, 768 * 1024);
  const r = await rig({ limits: { timeoutMs: 400 } });
  try {
    // Offline host: 404, and the request_id stays usable.
    const rid = crypto.randomUUID();
    assert.equal((await post(r, r.winA, r.macA.device, callBody('list', {}, rid))).status, 404);
    await r.setRole(r.macA, 'host');
    const raw = await r.rawHost(r.macA);
    const calls = Array.from({ length: 32 }, () => post(r, r.winA, r.macA.device, callBody()));
    await until(() => raw.frames.length === 32);
    const over = await post(r, r.winA, r.macA.device, callBody('list', {}, rid));
    assert.equal(over.status, 429);
    for (const f of raw.frames.splice(0)) answer(raw, f, { ok: true, sessions: [] });
    assert.deepEqual((await Promise.all(calls)).map((x) => x.status), Array(32).fill(200));
    // The 429'd request_id was never dispatched: it still goes through, once.
    const p = post(r, r.winA, r.macA.device, callBody('list', {}, rid));
    await until(() => raw.frames.length === 1);
    assert.equal(raw.frames[0].rid, rid);
    answer(raw, raw.frames.pop(), { ok: true, sessions: [] });
    assert.equal((await p).status, 200);
    assert.equal((await post(r, r.winA, r.macA.device, callBody('list', {}, rid))).body.error.reason, 'REPLAYED');

    // No answer in time: a send's outcome is unknown, not failed; a read just times out.
    const send = await post(r, r.winA, r.macA.device, callBody('send', { session: crypto.randomUUID(), generation: 1, text: 'slow' }));
    assert.equal(send.status, 408);
    assert.equal(send.body.error.reason, 'OUTCOME_UNKNOWN');
    assert.match(send.body.error.message, /outcome is unknown/);
    const read = await post(r, r.winA, r.macA.device, callBody('list'));
    assert.equal(read.status, 408);
    assert.notEqual(read.body.error.reason, 'OUTCOME_UNKNOWN');
    // The late answer is dropped, the socket stays up.
    for (const f of raw.frames.splice(0)) answer(raw, f, { ok: true, status: 'acknowledged' });
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(raw.closed, null);

    // Reply limit: over 768KB is refused, the socket stays up.
    const big = post(r, r.winA, r.macA.device, callBody('list'));
    await until(() => raw.frames.length === 1);
    answer(raw, raw.frames.pop(), { ok: true, pad: 'x'.repeat(RELAY_LIMITS.replyBytes) });
    assert.equal((await big).status, 413);
    const ok = post(r, r.winA, r.macA.device, callBody('list'));
    await until(() => raw.frames.length === 1);
    answer(raw, raw.frames.pop(), { ok: true, pad: 'x'.repeat(700 * 1024) });
    assert.equal((await ok).status, 200);
  } finally { await r.close(); }
});

test('HOSTILE: the same request_id from two users is accepted independently; empty replay maps are dropped', async () => {
  const r = await rig({ limits: { replayTtlMs: 1000 } });
  try {
    await r.host(r.macA);
    await r.host(r.macB);
    const rid = crypto.randomUUID();
    assert.equal((await post(r, r.winA, r.macA.device, callBody('list', {}, rid))).status, 200);
    assert.equal((await post(r, r.winB, r.macB.device, callBody('list', {}, rid))).status, 200);
    assert.equal((await post(r, r.winA, r.macA.device, callBody('list', {}, rid))).status, 409);
    const relay = r.h.hub.interactionRelay;
    assert.equal(relay.seen.size, 2);
    r.h.clock.advance(2000);
    relay.sweep(r.h.hub.mono());
    assert.equal(relay.seen.size, 0);
  } finally { await r.close(); }
});

test('HOSTILE: revoked mid-flight — the answer is withheld from a client revoked while the host answered', async () => {
  const r = await rig();
  try {
    await r.setRole(r.macA, 'host');
    const raw = await r.rawHost(r.macA);
    const p = post(r, r.winA, r.macA.device, callBody('state', { session: crypto.randomUUID() }));
    await until(() => raw.frames.length === 1);
    assert.equal((await r.h.call('DELETE', `/api/account/devices/${r.winA.device}`, { token: r.macA.token, body: {} })).status, 200);
    answer(raw, raw.frames.pop(), { ok: true, state: { secret: 'answer text' } });
    const res = await p;
    assert.equal(res.status, 401);
    assert.ok(!res.text.includes('answer text'));
  } finally { await r.close(); }
});

test('HOSTILE: account deletion closes and reaps the host', async () => {
  const r = await rig();
  try {
    // A fresh account (alice owns the seeded team, which blocks deletion).
    const dev = async (name) => { const x = await r.h.signIn('carol@dev.local', { device_name: name }); return { token: x.body.device_token, device: x.body.device_id, user: x.body.user.id }; };
    const cMac = await dev('Carol Mac'), cWin = await dev('Carol Windows');
    const mac = await r.host(cMac);
    const s = (await r.client(cWin).call(cMac.device, 'launch', { provider: 'codex' })).body.result.state;
    assert.ok(mac.hub.targetOf(s.session));
    const flow = await r.h.stepUp(cWin.token, 'carol@dev.local');
    const del = await r.h.call('DELETE', '/api/account', { token: cWin.token, body: { flow_id: flow } });
    assert.equal(del.status, 200, del.text);
    await until(() => mac.status().state === 'signed-out');
    await until(() => mac.hub.list(mac.actor).length === 0);
    assert.equal(mac.hub.targetOf(s.session), null);
  } finally { await r.close(); }
});

test('HOSTILE: leaksTarget withholds an answer carrying a current or previously replaced provider target', async () => {
  const r = await rig();
  try {
    const mac = await r.host(r.macA);
    const win = r.client(r.winA);
    const s = (await win.call(r.macA.device, 'launch', { provider: 'codex' })).body.result.state;
    const t1 = mac.hub.targetOf(s.session);
    // The fake echoes the text: an answer naming the target must not reach the wire.
    await win.call(r.macA.device, 'send', { session: s.session, generation: s.generation, text: t1 });
    let wire = '';
    await until(async () => { const w = await win.call(r.macA.device, 'state', { session: s.session }); wire += w.text ?? JSON.stringify(w.body); return w.body.result.status === 'unavailable'; });
    assert.ok(!wire.includes(t1), 'the target reached the wire');
    // Replace the target; the old one is still withheld.
    await mac.hub.replaceTarget(s.session);
    const g = (await win.call(r.macA.device, 'list')).body.result.sessions[0].generation;
    assert.notEqual(mac.hub.targetOf(s.session), t1);
    await win.call(r.macA.device, 'send', { session: s.session, generation: g, text: `old ${t1}` });
    let wire2 = '';
    await until(async () => { const w = await win.call(r.macA.device, 'state', { session: s.session }); wire2 += JSON.stringify(w.body); return w.body.result.status === 'unavailable'; });
    assert.ok(!wire2.includes(t1), 'a replaced target reached the wire');
    // Control: the check really fires (a target present in plain text is caught).
    const frame = { type: 'relay.request', id: crypto.randomUUID(), rid: crypto.randomUUID(), user: r.macA.user, from: r.winA.device, op: 'state', args: { session: s.session } };
    assert.equal((await mac.handle(frame)).status, 'unavailable');
  } finally { await r.close(); }
});

test('RESILIENCE: reconnects with backoff after a hub restart (4000); a refusal (401) or a long outage reaps remote sessions', async () => {
  const r = await rig();
  try {
    const relay = () => r.h.hub.interactionRelay;
    const mac = await r.host(r.macA, { retry: { baseMs: 30, maxMs: 120, idleReapMs: 60_000 } });
    const win = r.client(r.winA);
    const s = (await win.call(r.macA.device, 'launch', { provider: 'codex' })).body.result.state;
    const before = relay().hosts.get(r.macA.device);
    relay().close();
    await until(() => { const now = relay().hosts.get(r.macA.device); return now && now !== before; });
    await until(() => mac.status().state === 'connected');
    const after = await win.call(r.macA.device, 'list');
    assert.equal(after.body.result?.sessions[0].session, s.session, JSON.stringify(after.body));

    // Revoked while offline: the reconnect is refused (401) and the sessions end.
    const mac2 = await r.host(r.winB, { retry: { baseMs: 200, maxMs: 400, idleReapMs: 60_000 } });
    const bob = createRemoteInteractionClient({ baseUrl: r.h.base, token: (await r.h.signIn('bob@dev.local', { device_name: 'Bob 3' })).body.device_token });
    const l2 = await bob.call(r.winB.device, 'launch', { provider: 'codex' });
    assert.equal(l2.status, 200, JSON.stringify(l2.body));
    const s2 = l2.body.result.state;
    relay().hosts.get(r.winB.device).ws.close(4000, 'restart');
    await until(() => mac2.status().state === 'retrying');
    r.h.db.run("UPDATE user_devices SET revoked_at = 'x', token_hash = NULL WHERE id = ?", r.winB.device);
    await until(() => mac2.status().state === 'signed-out');
    await until(() => mac2.hub.targetOf(s2.session) === null);

    // Down longer than idleReapMs: remote sessions are reaped even before any refusal.
    const mac3 = await r.host(r.macB, { retry: { baseMs: 5000, maxMs: 5000, idleReapMs: 150 } });
    const s3 = (await bob.call(r.macB.device, 'launch', { provider: 'codex' })).body.result.state;
    relay().hosts.get(r.macB.device).ws.close(4000, 'restart');
    await until(() => mac3.hub.targetOf(s3.session) === null);
    assert.equal(mac3.status().state, 'retrying');
  } finally { await r.close(); }
});
