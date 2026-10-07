'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBurstClient, isAllowed, parseAdminAddress, atLeast } = require('../src/burst-client.js');
const { createFakeBurst, stateV019, stateV012, upgradeStatus } = require('./fixtures/fake-burst.js');

const BIN = (home) => path.join(home, '.local', 'bin', 'claude-burst');

function makeHome({ installed = true, adminListen } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-home-'));
  if (installed) {
    fs.mkdirSync(path.dirname(BIN(home)), { recursive: true });
    fs.writeFileSync(BIN(home), '#!/bin/sh\n', { mode: 0o755 });
  }
  if (adminListen) {
    fs.mkdirSync(path.join(home, '.config', 'claude-burst'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify({ admin_listen: adminListen }));
  }
  return home;
}

// Fake launchd/lsof/ps: the gateway is this test process, run from the binary.
const trustedInspect = (home, port) => ({ launchdPid: async () => process.pid, listenerPid: async (p) => (p === port ? process.pid : null), exePath: async () => BIN(home) });

async function setup(routes, opts = {}) {
  const fake = await createFakeBurst(routes);
  const home = makeHome({ adminListen: `127.0.0.1:${fake.port}`, ...opts.home });
  const client = createBurstClient({ home, platform: 'darwin', inspect: opts.inspect || trustedInspect(home, fake.port), timeoutMs: opts.timeoutMs || 2000 });
  return { fake, home, client, done: async () => { await fake.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}

test('v0.19 answering as the LaunchAgent: present, whitelisted snapshot, full capabilities', async () => {
  const t = await setup({ '/api/state': { body: { ...stateV019(), secondary: { key_present: true, secret: 'x' } } }, '/api/upgrade-status': { body: upgradeStatus() } });
  const d = await t.client.detect();
  assert.equal(d.kind, 'present');
  assert.equal(d.state.version, '0.19.0');
  assert.equal(d.state.active, true);
  assert.equal(d.state.mode, 'base-url');
  assert.deepEqual(d.capabilities, { state: true, usage: true, upgradeStatus: true, handoverAudit: true, handoverFile: true, testConnection: true });
  assert.deepEqual(d.upgrade, { canUpgrade: true, upToDate: false, latestVersion: '0.20.0', behind: 3 });
  assert.ok(!JSON.stringify(d).includes('"secret"'));
  for (const r of t.fake.requests) { assert.equal(r.method, 'GET'); assert.equal(r.headers.host, '127.0.0.1'); assert.equal(r.headers['x-claude-burst-admin'], undefined); }
  await t.done();
});

test('old v0.12: capabilities marked unsupported and no probe of newer endpoints', async () => {
  const t = await setup({ '/api/state': { body: stateV012() } });
  const d = await t.client.detect();
  assert.equal(d.kind, 'present');
  assert.equal(d.capabilities.upgradeStatus, false);
  assert.equal(d.capabilities.usage, false);
  assert.deepEqual(t.fake.requests.map((r) => r.url), ['/api/state']);
  await t.done();
});

test('404 on upgrade-status downgrades that capability instead of failing', async () => {
  const t = await setup({ '/api/state': { body: stateV019() } });
  const d = await t.client.detect();
  assert.equal(d.kind, 'present');
  assert.equal(d.capabilities.upgradeStatus, false);
  await t.done();
});

test('wrong-version impostor is untrusted', async () => {
  const t = await setup({ '/api/state': { body: stateV019({ version: 'banana' }) } });
  assert.equal((await t.client.detect()).kind, 'untrusted');
  await t.done();
});

test('impostor with a plausible state but not the LaunchAgent pid is untrusted, and nothing else is read', async () => {
  const t = await setup({ '/api/state': { body: stateV019() }, '/api/upgrade-status': { body: upgradeStatus() } }, {
    inspect: { launchdPid: async () => 4242, listenerPid: async () => process.pid, exePath: async () => '/tmp/evil' },
  });
  const d = await t.client.detect();
  assert.equal(d.kind, 'untrusted');
  assert.equal(d.state, undefined);
  assert.deepEqual(t.fake.requests.map((r) => r.url), ['/api/state']);
  await t.done();
});

test('right pid but the wrong executable is untrusted', async () => {
  const home0 = makeHome();
  const t = await setup({ '/api/state': { body: stateV019() } }, { inspect: { launchdPid: async () => process.pid, listenerPid: async () => process.pid, exePath: async () => '/usr/bin/python3' } });
  assert.equal((await t.client.detect()).kind, 'untrusted');
  fs.rmSync(home0, { recursive: true, force: true });
  await t.done();
});

test('a state whose pid is not the listener is untrusted', async () => {
  const t = await setup({ '/api/state': { body: stateV019({ pid: 1 }) } });
  assert.equal((await t.client.detect()).kind, 'untrusted');
  await t.done();
});

test('state without an intercept mode is untrusted', async () => {
  const t = await setup({ '/api/state': { body: stateV019({ intercept: { mode: 'weird', active: true } }) } });
  assert.equal((await t.client.detect()).kind, 'untrusted');
  await t.done();
});

test('config_error is broken (and only config_error may omit the mode)', async () => {
  const t = await setup({ '/api/state': { body: { version: '0.19.0', pid: process.pid, config_error: 'invalid character' } } });
  const d = await t.client.detect();
  assert.equal(d.kind, 'broken');
  assert.equal(d.state.configError, 'invalid character');
  assert.deepEqual(t.fake.requests.map((r) => r.url), ['/api/state']);
  await t.done();
});

test('non-loopback admin_listen is refused without any request', async () => {
  for (const listen of ['0.0.0.0:7788', '192.168.1.5:7788', 'localhost:7788', ':7788', 'example.com:7788', '127.0.0.1.evil.test:7788']) {
    const fake = await createFakeBurst({ '/api/state': { body: stateV019() } });
    const home = makeHome({ adminListen: listen });
    const c = createBurstClient({ home, platform: 'darwin', inspect: trustedInspect(home, 7788) });
    assert.equal((await c.detect()).kind, 'untrusted', listen);
    assert.equal(fake.requests.length, 0);
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  assert.deepEqual(parseAdminAddress('[::1]:7788'), { host: '::1', port: 7788 });
  assert.equal(parseAdminAddress('127.0.0.1:99999'), null);
});

test('a 404 on /api/state is untrusted, not a crash', async () => {
  const t = await setup({});
  assert.equal((await t.client.detect()).kind, 'untrusted');
  await t.done();
});

test('a slow response times out as unreachable', async () => {
  const t = await setup({ '/api/state': { body: stateV019(), delay: 400 } }, { timeoutMs: 100 });
  const d = await t.client.detect();
  assert.equal(d.kind, 'unreachable');
  await t.done();
});

test('a 10 MB body is cut off at the cap and refused', async () => {
  const t = await setup({ '/api/state': { body: Buffer.alloc(10 * 1024 * 1024, 0x20) } });
  assert.equal((await t.client.detect()).kind, 'untrusted');
  await t.done();
});

test('a non-JSON answer is untrusted', async () => {
  const t = await setup({ '/api/state': { body: '<html>hi</html>', type: 'text/html' } });
  assert.equal((await t.client.detect()).kind, 'untrusted');
  await t.done();
});

test('nothing listening: unreachable when installed', async () => {
  const home = makeHome({ adminListen: '127.0.0.1:1' });
  const c = createBurstClient({ home, platform: 'darwin', inspect: trustedInspect(home, 1) });
  assert.equal((await c.detect()).kind, 'unreachable');
  fs.rmSync(home, { recursive: true, force: true });
});

test('not installed: no request is made even if something answers', async () => {
  const fake = await createFakeBurst({ '/api/state': { body: stateV019() } });
  const home = makeHome({ installed: false, adminListen: `127.0.0.1:${fake.port}` });
  const c = createBurstClient({ home, platform: 'darwin', inspect: trustedInspect(home, fake.port) });
  assert.equal((await c.detect()).kind, 'not_installed');
  assert.equal(fake.requests.length, 0);
  await fake.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('other platforms: unsupported, no file or network access', async () => {
  const c = createBurstClient({ home: '/nonexistent', platform: 'win32' });
  assert.deepEqual(await c.detect(), { kind: 'unsupported' });
});

test('allow-list: POST /api/force and every other mutating or secret path is rejected before any request', async () => {
  const t = await setup({ '/api/state': { body: stateV019() }, '/api/force': { body: {} }, '/api/secondary-key': { body: {} } });
  await t.client.detect();
  const before = t.fake.requests.length;
  for (const [m, p] of [['POST', '/api/force'], ['GET', '/api/force'], ['POST', '/api/revert'], ['POST', '/api/install'], ['POST', '/api/state'], ['GET', '/api/secondary-key'], ['POST', '/api/secondary-key'], ['GET', '/api/inspect-item?i=1'], ['GET', '/api/log'], ['GET', '/api/usage?evil=1'], ['GET', '/api/handover-file?path=/etc/passwd'], ['POST', '/api/upgrade'], ['GET', '//evil.test/api/state']]) {
    await assert.rejects(t.client.request(m, p), { code: 'denied' }, `${m} ${p}`);
  }
  assert.equal(t.fake.requests.length, before, 'denied calls never reach the server');
  assert.ok(isAllowed('GET', '/api/usage?range=7d&repo=a&session=b'));
  assert.ok(isAllowed('GET', '/api/handover-file?root=%2Fr'));
  await t.done();
});

test('requestUpgrade is the only POST: /api/upgrade with the mutation header', async () => {
  const t = await setup({ '/api/state': { body: stateV019() }, '/api/upgrade': (req) => ({ body: { ok: true, method: req.method } }) });
  await t.client.detect();
  await t.client.requestUpgrade();
  const posts = t.fake.requests.filter((r) => r.method !== 'GET');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/upgrade');
  assert.ok(posts[0].headers['x-claude-burst-admin']);
  await t.done();
});

test('testConnection reads the GET endpoint and returns a normalized result', async () => {
  const t = await setup({ '/api/state': { body: stateV019() }, '/api/test-connection': { body: { ok: false, mode: 'transparent', detail: 'could not reach', extra: 1 } } });
  await t.client.detect();
  assert.deepEqual(await t.client.testConnection(), { ok: false, mode: 'transparent', detail: 'could not reach' });
  await t.done();
});

test('version compare', () => {
  assert.ok(atLeast('0.19.0', [0, 19, 0]) && atLeast('v1.0.0', [0, 19, 0]) && !atLeast('0.18.9', [0, 19, 0]) && !atLeast('nope', [0, 1, 0]));
});

// ── WP0: extended reads, console, mutations ──────────────────────────────

const { MUTATE_ALLOW, scrub } = require('../src/burst-client.js');
const SID = '0f6e3c1a-2b4d-4e5f-8a9b-0c1d2e3f4a5b';
const VALID_ARGS = {
  reset: {},
  'compaction-drop': { session: SID },
  'inspect-remove': { session: SID, id: '0123456789abcdef' },
  'coord-message': { session: SID, message: 'please commit src/a.js' },
  'coord-release': { release: '/Users/me/src/app/a.js' },
  trace: {},
};
const GATEWAY_KINDS = Object.keys(VALID_ARGS);
const okRoutes = () => Object.fromEntries(Object.values(MUTATE_ALLOW).filter((m) => !m.target).map((m) => [m.path, { body: { ok: 'done' } }]));

test('allow-list: inspect-item, log and every secret path stay unreachable; the new reads are allowed', () => {
  for (const p of ['/api/inspect-item?i=1', '/api/inspect-item', '/api/log', '/api/secondary-key', '/api/settings-save', '/api/hotspot-password', '/api/responses', '/api/inspect?i=1', '/api/settings?x=1']) assert.equal(isAllowed('GET', p), false, p);
  for (const p of ['/api/requests?limit=50', '/api/history?days=7', '/api/inspect?session=s&engine=codex', '/api/automask', '/api/mac', '/api/settings', '/api/audit?limit=50', '/api/mod-status', '/api/intelligent-compaction']) assert.ok(isAllowed('GET', p), p);
  for (const m of Object.values(MUTATE_ALLOW)) assert.ok(!/secondary-key|settings-save|hotspot|secondary$|force|revert|install|config/.test(m.path), m.path);
});

test('/api/secondary-key is not reachable through any exported function', async () => {
  const t = await setup({ '/api/state': { body: stateV019() }, '/api/secondary-key': { body: { ok: 'stored' } }, ...okRoutes() });
  await t.client.detect();
  await assert.rejects(t.client.request('POST', '/api/secondary-key'), { code: 'denied' });
  await assert.rejects(t.client.request('GET', '/api/secondary-key'), { code: 'denied' });
  await assert.rejects(t.client.mutate('secondary-key', { api_key: 'sk-x' }), { code: 'denied' });
  await assert.rejects(t.client.mutate('/api/secondary-key', {}), { code: 'denied' });
  await assert.rejects(t.client.mutate('__proto__', {}), { code: 'denied' });
  for (const [k, fn] of Object.entries(t.client)) {
    if (typeof fn !== 'function' || ['adminUrl'].includes(k)) continue;
    await Promise.resolve().then(() => fn({ session: SID, api_key: 'sk-x', path: '/api/secondary-key' })).catch(() => {});
  }
  for (const kind of GATEWAY_KINDS) await t.client.mutate(kind, { ...VALID_ARGS[kind], api_key: 'sk-x', path: '/api/secondary-key' }).catch(() => {});
  assert.ok(!t.fake.requests.some((r) => r.url.startsWith('/api/secondary-key')), 'never requested');
  assert.ok(!t.fake.requests.some((r) => r.body.includes('sk-x')), 'extra args never forwarded');
  await t.done();
});

test('unknown mutate kind throws denied and sends nothing', async () => {
  const t = await setup({ '/api/state': { body: stateV019() } });
  for (const k of ['force', 'revert', 'hotspot-password', '', undefined, 'toString']) await assert.rejects(t.client.mutate(k, {}), { code: 'denied' }, String(k));
  assert.equal(t.fake.requests.length, 0);
  await t.done();
});

test('coord-message rejects a message over 500 characters and a non-string session before any request', async () => {
  const t = await setup({ '/api/state': { body: stateV019() }, ...okRoutes() });
  for (const args of [{ session: SID, message: 'x'.repeat(501) }, { session: 42, message: 'hi' }, { session: [SID], message: 'hi' }, { session: SID, message: '' }, { session: SID, message: 5 }, { session: '../x', message: 'hi' }, { session: SID, message: 'a\u0000b' }]) {
    await assert.rejects(t.client.mutate('coord-message', args), { code: 'bad_request' }, JSON.stringify(args).slice(0, 60));
  }
  for (const [k, a] of [['compaction-drop', {}], ['inspect-remove', { session: SID, id: 'nothex' }], ['coord-release', { release: 'relative/a.js' }]]) await assert.rejects(t.client.mutate(k, a), { code: 'bad_request' }, k);
  assert.equal(t.fake.requests.length, 0);
  await t.client.mutate('coord-message', { session: SID, message: 'x'.repeat(500) });
  await t.done();
});

test('every gateway mutate re-checks trust, sends the header and exactly one POST with an allow-listed body', async () => {
  const t = await setup({ '/api/state': { body: stateV019() }, ...okRoutes() });
  for (const kind of GATEWAY_KINDS) {
    const from = t.fake.requests.length;
    const r = await t.client.mutate(kind, VALID_ARGS[kind]);
    assert.deepEqual(r, { ok: true, data: { ok: 'done' } });
    const sent = t.fake.requests.slice(from);
    const posts = sent.filter((x) => x.method === 'POST');
    assert.equal(posts.length, 1, kind);
    assert.equal(posts[0].url, MUTATE_ALLOW[kind].path);
    assert.equal(posts[0].headers['x-claude-burst-admin'], '1', kind);
    assert.ok(sent.filter((x) => x.method === 'GET' && x.url === '/api/state').length >= 2, `${kind}: detect + pid re-read`);
    assert.deepEqual(Object.keys(JSON.parse(posts[0].body)).sort(), Object.keys(MUTATE_ALLOW[kind].body(VALID_ARGS[kind])).sort());
  }
  await t.done();
});

test('a pid flip between detect and the POST sends nothing', async () => {
  let n = 0;
  const t = await setup({ '/api/state': () => ({ body: stateV019({ pid: n++ === 0 ? process.pid : process.pid + 1 }) }), ...okRoutes() });
  await assert.rejects(t.client.mutate('reset'), { code: 'pid_changed' });
  // and a gateway that is no longer the LaunchAgent fails detect itself
  await assert.rejects(t.client.mutate('reset'), { code: 'not_present' });
  assert.equal(t.fake.requests.filter((r) => r.method === 'POST').length, 0);
  await t.done();
});

test('responses are scrubbed of previews, secrets and URL queries at any depth', async () => {
  const inspect = { session: SID, items: [{ group: 'tools', name: 'Read', tokens: 10, preview: 'conversation text', Full: 'all of it', id: '0123456789abcdef' }] };
  const settings = { hotspot: { ssid: 'phone', password_stored: true, hotspot_password: 'pw' }, secondary: { api_key: 'sk-1', keychain_service: 'svc', base_url: 'https://h.example/v1?key=abc' } };
  const t = await setup({ '/api/state': { body: stateV019() }, '/api/inspect': { body: inspect }, '/api/settings': { body: settings }, '/api/requests': { body: [{ destination: 'https://api.example.com/v1/messages?beta=1&key=x', model: 'm' }] } });
  await t.client.detect();
  const i = await t.client.inspect({ session: SID });
  assert.equal(i.items[0].name, 'Read');
  assert.ok(!('preview' in i.items[0]) && !('Full' in i.items[0]));
  const s = JSON.stringify(await t.client.settings());
  for (const bad of ['hotspot_password', '"pw"', 'sk-1', 'keychain_service', 'key=abc']) assert.ok(!s.includes(bad), bad);
  assert.equal((await t.client.requests({ limit: 9999 }))[0].destination, 'https://api.example.com/v1/messages');
  assert.ok(t.fake.requests.some((r) => r.url === '/api/requests?limit=200'), 'limit clamped');
  await assert.rejects(t.client.inspect({ session: 'a b' }), { code: 'bad_request' });
  assert.deepEqual(scrub({ a: [{ preview: 1, b: 2 }] }), { a: [{ b: 2 }] });
  await t.done();
});

test('state normalization exposes health facts but never base_url, keychain names or keys', async () => {
  const raw = stateV019({
    primary: { provider: 'anthropic', base_url: 'https://api.anthropic.com', model: 'claude' },
    secondary: { provider: 'together', base_url: 'https://t.example?k=1', model: 'glm', keychain_service: 'claude-burst-together', key_env_var: 'X', key_present: false },
    intercept: { mode: 'transparent', ca_trusted: false, hosts_entry: true, remote_control_expected: true, active: false, inactive_reason: 'pf off', pf_heal: { installed: true, running: false, last_check_seconds: -1 }, bailout_cmd: 'sudo x', settings_base_url: 'http://127.0.0.1:7777' },
    client_tls: { failures: 4, successes: 1, threshold: 3, rejecting: true, last_class: 'unknown_ca' },
    downgrade: { enabled: true, chain: { fable: ['opus'] }, rejected: [{ model: 'fable', until: 'x', falls_back_to: 'opus' }] },
  });
  const t = await setup({ '/api/state': { body: raw }, '/api/upgrade-status': { body: upgradeStatus() } });
  const d = await t.client.detect();
  assert.equal(d.state.caTrusted, false);
  assert.deepEqual(d.state.pfHeal, { installed: true, running: false, lastCheckSeconds: -1 });
  assert.equal(d.state.selfHeal, null);
  assert.equal(d.state.clientTls.rejecting, true);
  assert.deepEqual(d.state.secondary, { provider: 'together', model: 'glm', strategy: '', keyPresent: false });
  assert.deepEqual(d.state.downgrade.chain, { fable: ['opus'] });
  assert.equal(d.state.rejected[0].fallsBackTo, 'opus');
  const j = JSON.stringify(d);
  for (const bad of ['base_url', 'baseUrl', 'claude-burst-together', 'key_env_var', 'sudo x', 'api.anthropic.com', '7777']) assert.ok(!j.includes(bad), bad);
  await t.done();
});

// The console is its own LaunchAgent on its own port.
async function setupConsole({ consoleRoutes, gatewayRoutes = { '/api/state': { body: stateV019() } }, consoleLaunchd } = {}) {
  const gw = await createFakeBurst(gatewayRoutes);
  const con = await createFakeBurst(consoleRoutes);
  const home = makeHome({ adminListen: `127.0.0.1:${gw.port}` });
  fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify({ admin_listen: `127.0.0.1:${gw.port}`, console_listen: `127.0.0.1:${con.port}` }));
  const labels = [];
  const inspect = {
    launchdPid: async (label) => { labels.push(label); return label === 'ninja.andrewbaker.claude-burst-console' ? (consoleLaunchd ?? process.pid) : process.pid; },
    listenerPid: async (p) => (p === gw.port || p === con.port ? process.pid : null),
    exePath: async () => BIN(home),
  };
  const client = createBurstClient({ home, platform: 'darwin', inspect });
  return { gw, con, client, labels, done: async () => { await gw.close(); await con.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}
const consoleStatus = { version: '0.19.0', dashboard: 'http://127.0.0.1:7788/', dashboard_up: false, checks: [{ name: 'Gateway service', ok: false, detail: 'not loaded' }], log_tail: ['a', 'b'], now: 'x' };

test('console: read only after its LaunchAgent check; restart posts with the header to the console', async () => {
  const t = await setupConsole({ consoleRoutes: { '/api/console': { body: consoleStatus }, '/api/console/restart': { body: { detail: 'Restarted' } } }, gatewayRoutes: {} });
  const c = await t.client.consoleDetect();
  assert.equal(c.kind, 'present');
  assert.deepEqual(c.status, { version: '0.19.0', dashboardUp: false, configError: '', checks: [{ name: 'Gateway service', ok: false, detail: 'not loaded' }], logTail: ['a', 'b'] });
  assert.ok(t.labels.includes('ninja.andrewbaker.claude-burst-console'));
  assert.deepEqual(await t.client.mutate('console-restart'), { ok: true, data: { detail: 'Restarted' } });
  const posts = t.con.requests.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/console/restart');
  assert.equal(posts[0].headers['x-claude-burst-admin'], '1');
  assert.equal(t.gw.requests.length, 0, 'the gateway is not needed for console actions');
  await t.done();
});

test('console: a listener that is not the console LaunchAgent is untrusted and gets no request', async () => {
  const t = await setupConsole({ consoleRoutes: { '/api/console': { body: consoleStatus }, '/api/console/restart': { body: {} } }, consoleLaunchd: 4242 });
  assert.equal((await t.client.consoleDetect()).kind, 'untrusted');
  await assert.rejects(t.client.mutate('console-restart'), { code: 'not_present' });
  assert.equal(t.con.requests.length, 0);
  await t.done();
});

test('console: console_listen off or off-loopback is never contacted', async () => {
  const t = await setupConsole({ consoleRoutes: { '/api/console': { body: consoleStatus } } });
  const cfgPath = path.join(t.client.binPath, '..', '..', '..', '.config', 'claude-burst', 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ console_listen: 'off' }));
  assert.equal((await t.client.consoleDetect()).kind, 'off');
  fs.writeFileSync(cfgPath, JSON.stringify({ console_listen: '0.0.0.0:7789' }));
  assert.equal((await t.client.consoleDetect()).kind, 'untrusted');
  assert.equal(t.con.requests.length, 0);
  await t.done();
});
