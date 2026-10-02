// LOCAL / DISPOSABLE PROOF ONLY — not production account acceptance.
// The phone PWA's own client code (web/js/phone-core.js) against an
// in-process accounts hub on a loopback port and a "Mac" host backed by the
// FAKE codex app-server (same rig as interaction-relay.test.js). The phone
// signs in with the email-code flow as a browser would (same-origin Origin
// header, no cookies), then lists hosts, opens a session, sends, reads the
// streamed reply, steers, interrupts and closes. No real provider, browser,
// Cloudflare or deployed hub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { startAccounts } from './accounts-helpers.js';
import { createApi, createController, sessionView } from '../../web/js/phone-core.js';

const require = createRequire(import.meta.url);
const { createRemoteInteractionHost } = require('../../../src/remote-interaction.js');
const { createCodexAppServer } = require('../../../src/codex-app-server.js');
const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, '..', '..', '..', 'test', 'fixtures', 'fake-codex-app-server.js');
const WEB = join(HERE, '..', '..', 'web'); // the real shell, not the test fixture web dir

const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 15)); } };

function memVault() {
  let t = null;
  return { saved: () => t, load: async () => t, save: async (x) => { t = x; }, clear: async () => { t = null; } };
}

// What a browser on the hub's own origin sends: an Origin on every
// non-GET, the cookie jar never (credentials: 'omit' is asserted).
function browserFetch(base, seen) {
  return (url, init) => {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    seen.push({ url, method: init.method });
    const headers = { ...init.headers };
    if (init.method !== 'GET') headers.origin = base;
    return fetch(url, { ...init, headers });
  };
}

// Every test is bounded: a refused host or a stuck poll fails fast, never hangs.
const T = { timeout: 30_000 };

async function rig() {
  const h = await startAccounts();
  let host = null;
  try {
    const mac = await h.signIn('alice@dev.local', { device_name: 'Alice Mac' });
    assert.equal(mac.status, 200, mac.text);
    const adapter = createCodexAppServer({ bin: FAKE });
    host = createRemoteInteractionHost({ userId: mac.body.user.id, adapters: { codex: adapter }, boardCurrent: (b) => b === null, retry: { baseMs: 50, maxMs: 100 } });
    // The Mac's explicit opt-in (role 'host'), then its connection: what the app does.
    const st = await host.enable({ baseUrl: h.base, token: mac.body.device_token, WebSocket, fetch });
    assert.equal(st.state, 'connected', JSON.stringify(st));
    return rigOf(h, mac, host);
  } catch (e) { host?.close(); await h.close(); throw e; }
}

function rigOf(h, mac, host) {
  const seen = [];
  const api = createApi({ fetch: browserFetch(h.base, seen), uuid: () => crypto.randomUUID(), origin: h.base });
  const vault = memVault();
  const ctl = createController({ api, vault, deviceName: 'Alice iPhone' });
  return { h, mac, host, ctl, vault, seen, async close() { ctl.back(); ctl.back(); host.close(); await h.close(); } };
}

test('LOCAL PROOF: the hub serves the PWA shell with a strict CSP; the worker is scoped to /phone/', T, async () => {
  const h = await startAccounts({ config: { webDir: WEB } });
  try {
    const get = async (p) => { const r = await fetch(`${h.base}${p}`); return { status: r.status, type: r.headers.get('content-type'), csp: r.headers.get('content-security-policy'), text: await r.text() }; };
    const page = await get('/phone/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.csp, /script-src 'self'/);
    assert.match(page.csp, /default-src 'self'/);
    assert.match(page.csp, /base-uri 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(page.csp));
    assert.ok(!/<script>|\son[a-z]+=|style="/i.test(page.text), 'no inline script, handlers or styles');
    const sw = await get('/phone/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.type, /text\/javascript/);
    const manifest = await get('/phone/manifest.webmanifest');
    assert.equal(manifest.status, 200);
    assert.match(manifest.type, /application\/manifest\+json/);
    const m = JSON.parse(manifest.text);
    assert.equal(m.scope, '/phone/');
    for (const icon of m.icons) assert.equal((await get(icon.src)).status, 200, icon.src);
    for (const p of ['/web/phone.css', '/web/js/phone-app.js', '/web/js/phone-core.js', '/web/js/phone-render.js', '/web/js/phone-vault.js', '/web/js/h.js']) assert.equal((await get(p)).status, 200, p);
    // The worker is served only at its scoped path.
    assert.equal((await get('/web/phone-sw.js')).status, 404);
    assert.equal((await get('/phone/../web/phone-sw.js')).status, 404);
  } finally { await h.close(); }
});

test('LOCAL PROOF: a phone signs in by email code, sees the Mac, sends, reads the reply, steers, interrupts and closes', T, async () => {
  const r = await rig();
  const { ctl } = r;
  try {
    await ctl.boot();
    assert.equal(ctl.state.view, 'signin');
    await ctl.startSignIn('alice@dev.local', 'Alice iPhone');
    assert.ok(ctl.state.auth.flowId, JSON.stringify(ctl.state.auth));
    await ctl.verifyCode(r.h.codeFor('alice@dev.local'));
    assert.equal(ctl.state.view, 'hosts', JSON.stringify(ctl.state.auth));
    assert.match(r.vault.saved(), /^bdt_/);
    // The phone is a device of the account like any other: listed and revocable.
    const devs = await r.h.call('GET', '/api/account/devices', { token: r.mac.body.device_token });
    const phone = devs.body.devices.find((d) => d.name === 'Alice iPhone');
    assert.equal(phone.platform, 'phone-web');
    assert.deepEqual(ctl.state.hosts.items.map((x) => x.name), ['MacBook-Pro']);

    await ctl.openHost(r.mac.body.device_id);
    assert.deepEqual(ctl.state.sessions.items, []);
    assert.equal(ctl.state.sessions.providers[0].provider, 'codex');
    await ctl.launch('codex');
    assert.equal(ctl.state.view, 'session');
    assert.equal(ctl.state.session.state.ownership, 'plexiform-owned');

    assert.equal(await ctl.send('hello from the phone'), true);
    const done = await until(() => ctl.state.session.state.deliveries.find((d) => d.state === 'completed'));
    assert.equal(done.response, 'echo:hello from the phone');
    assert.equal(sessionView(ctl.state.session, Date.now()).live, true);

    // A running turn: the next message steers it, then interrupt it.
    assert.equal(await ctl.send('HOLD'), true);
    await until(() => ctl.state.session.state.activeTurn);
    assert.equal(sessionView(ctl.state.session, Date.now()).canSteer, true);
    assert.equal(await ctl.send('more'), true);
    await until(() => ctl.state.session.state.deliveries.some((d) => d.mode === 'steer'));
    await until(() => !ctl.state.session.state.activeTurn);
    assert.equal(await ctl.send('HOLD 2'), true);
    await until(() => ctl.state.session.state.activeTurn);
    assert.equal(await ctl.interrupt(), true);
    await until(() => ctl.state.session.state.deliveries.some((d) => d.state === 'interrupted'));

    // A refused provider approval reaches the phone as a notice.
    await until(() => !ctl.state.session.state.activeTurn);
    assert.equal(await ctl.send('APPROVAL please'), true);
    const noticed = await until(() => ctl.state.session.state.deliveries.find((d) => d.notices.length));
    assert.match(noticed.notices[0], /approval/);

    assert.equal(await ctl.close(), true);
    ctl.back();
    await until(() => ctl.state.view === 'sessions' && ctl.state.sessions.items?.length === 0);
    // Nothing about the token or message text went into a URL.
    for (const { url } of r.seen) { assert.ok(!url.includes('bdt_')); assert.ok(!url.includes('hello')); }
  } finally { await r.close(); }
});

test('HOSTILE: revoking the phone from the Mac signs it out on its next poll; a cross-origin page cannot drive the relay', T, async () => {
  const r = await rig();
  const { ctl } = r;
  try {
    await ctl.boot();
    await ctl.startSignIn('alice@dev.local', 'Alice iPhone');
    await ctl.verifyCode(r.h.codeFor('alice@dev.local'));
    const token = r.vault.saved();
    await ctl.openHost(r.mac.body.device_id);
    await ctl.launch('codex');
    assert.equal(ctl.state.view, 'session');

    // A page on another origin holding the token is still refused (Origin check).
    const cross = await r.h.call('POST', `/api/interaction/v1/hosts/${r.mac.body.device_id}/call`, { token, headers: { origin: 'https://evil.example' }, body: { request_id: crypto.randomUUID(), op: 'list', args: {} } });
    assert.equal(cross.status, 403);
    // A browser cookie session is never accepted by the relay (unchanged rule).
    const web = await r.h.webSignIn('alice@dev.local');
    assert.equal((await r.h.call('GET', '/api/interaction/v1/hosts', { cookie: web.cookie })).status, 403);

    // The phone's token can never make the phone a host (server-side, by platform).
    const asHost = await r.h.call('PUT', '/api/interaction/v1/role', { token, headers: { origin: r.h.base }, body: { role: 'host' } });
    assert.equal(asHost.status, 403, asHost.text);
    assert.match(asHost.body.error.message, /desktop app/);
    assert.equal((await r.h.call('PUT', '/api/interaction/v1/role', { token, headers: { origin: r.h.base }, body: { role: 'client' } })).status, 200);

    const devs = await r.h.call('GET', '/api/account/devices', { token: r.mac.body.device_token });
    const phone = devs.body.devices.find((d) => d.name === 'Alice iPhone');
    assert.equal(phone.platform, 'phone-web');
    assert.equal((await r.h.call('DELETE', `/api/account/devices/${phone.id}`, { token: r.mac.body.device_token, body: {} })).status, 200);
    // The watch in flight answers 401 (or the next one does): the phone drops its token.
    await ctl.send('poke').catch(() => {});
    await until(() => ctl.state.view === 'signin');
    assert.equal(r.vault.saved(), null);
  } finally { await r.close(); }
});

test('LOCAL PROOF: Bob\'s phone lists a session Alice shared with their team, watches it read-only, then sends once it is "watch and send"', T, async () => {
  const r = await rig();
  const bobCtl = createController({ api: createApi({ fetch: browserFetch(r.h.base, r.seen), uuid: () => crypto.randomUUID(), origin: r.h.base }), vault: memVault(), deviceName: 'Bob Phone' });
  try {
    const s = (await r.host.hub.launch({ provider: 'codex' }, r.host.actor)).state;
    await bobCtl.boot();
    await bobCtl.startSignIn('bob@dev.local', 'Bob Phone');
    await bobCtl.verifyCode(r.h.codeFor('bob@dev.local'));
    await until(() => bobCtl.state.shared.items);
    assert.deepEqual(bobCtl.state.shared.items, [], 'nothing is shared by default');
    assert.deepEqual(bobCtl.state.hosts.items, [], 'Bob never sees Alice\'s computers');

    const w = await r.host.shareSession({ session: s.session, team: r.h.ids.org, scope: 'watch' });
    assert.equal(w.ok, true, JSON.stringify(w));
    await bobCtl.loadHosts();
    await until(() => bobCtl.state.shared.items?.length === 1);
    assert.equal(bobCtl.state.shared.items[0].scope, 'watch');
    await bobCtl.openShared(w.share.id);
    assert.equal(bobCtl.state.view, 'session');
    const v = sessionView(bobCtl.state.session, Date.now());
    assert.equal(v.readOnly, true); assert.equal(v.canSend, false);
    assert.equal(await bobCtl.send('sneaky'), false);
    assert.equal(await bobCtl.close(), false);
    // Alice types on her Mac; Bob's phone sees it stream in.
    await r.host.hub.send({ session: s.session, generation: s.generation, text: 'alice on the mac' }, r.host.actor);
    const seen = await until(() => bobCtl.state.session.state.deliveries.find((d) => d.state === 'completed'));
    assert.equal(seen.response, 'echo:alice on the mac');
    bobCtl.back();
    assert.equal(bobCtl.state.view, 'hosts');

    const i = await r.host.shareSession({ session: s.session, team: r.h.ids.org, scope: 'interact' });
    await bobCtl.loadHosts();
    await until(() => bobCtl.state.shared.items?.[0]?.id === i.share.id);
    await bobCtl.openShared(i.share.id);
    assert.equal(sessionView(bobCtl.state.session, Date.now()).canSend, true);
    assert.equal(await bobCtl.send('bob from the phone'), true);
    const mine = await until(() => r.host.hub.state({ session: s.session }, r.host.actor).deliveries.find((d) => d.text === 'bob from the phone'));
    assert.ok(mine.by, 'labelled with the sender');
    // Alice stops sharing: Bob's phone loses it.
    r.host.stopSharing(i.share.id);
    await until(() => bobCtl.state.session?.link === 'gone' || bobCtl.state.session?.error);
    bobCtl.back();
    await until(async () => { await bobCtl.loadShared(); return bobCtl.state.shared.items?.length === 0; });
  } finally { bobCtl.back(); await r.close(); }
});
