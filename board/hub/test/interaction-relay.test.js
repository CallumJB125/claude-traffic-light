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

const require = createRequire(import.meta.url);
const { createRemoteInteractionHost, createRemoteInteractionClient } = require('../../../src/remote-interaction.js');
const { createCodexAppServer } = require('../../../src/codex-app-server.js');
const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test', 'fixtures', 'fake-codex-app-server.js');

const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 15)); } };

async function rig() {
  const lines = [];
  const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
  const h = await startAccounts({ log });
  const signIn = async (email, name) => {
    const r = await h.signIn(email, { device_name: name });
    assert.equal(r.status, 200, r.text);
    return { token: r.body.device_token, device: r.body.device_id, user: r.body.user.id };
  };
  const macA = await signIn('alice@dev.local', 'Alice Mac');
  const winA = await signIn('alice@dev.local', 'Alice Windows');
  const macB = await signIn('bob@dev.local', 'Bob Mac');
  const wsUrl = `${h.base.replace('http', 'ws')}/ws/interaction-host`;
  const hosts = [];
  const host = async (dev, { userId = dev.user } = {}) => {
    const adapter = createCodexAppServer({ bin: FAKE });
    // Contract defaults: boardCurrent refuses unless supplied; remote sessions are board-less.
    const x = createRemoteInteractionHost({ userId, adapters: { codex: adapter }, boardCurrent: (b) => b === null });
    x.adapter = adapter;
    hosts.push(x);
    await x.connect({ url: wsUrl, token: dev.token, WebSocket });
    return x;
  };
  const client = (dev) => createRemoteInteractionClient({ baseUrl: h.base, token: dev.token });
  return {
    h, lines, macA, winA, macB, wsUrl, host, client,
    async close() { for (const x of hosts) x.close(); await h.close(); },
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
    const bob = r.client(r.macB);
    const seen = await bob.hosts();
    assert.deepEqual(seen.body.hosts.map((x) => x.id), [r.macB.device]);
    const cross = await bob.call(r.macA.device, 'list');
    assert.equal(cross.status, 404);
    // Alice's Windows cannot reach Bob's Mac either.
    assert.equal((await r.client(r.winA).call(r.macB.device, 'list')).status, 404);
    // A host built for Alice refuses a hub welcome naming anyone else.
    const wrong = createRemoteInteractionHost({ userId: r.macA.user, adapters: {} });
    await assert.rejects(wrong.connect({ url: r.wsUrl, token: r.macB.token, WebSocket }), /different account/);
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
