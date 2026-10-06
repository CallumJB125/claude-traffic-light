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
  for (const [m, p] of [['POST', '/api/force'], ['GET', '/api/force'], ['POST', '/api/revert'], ['POST', '/api/install'], ['POST', '/api/state'], ['GET', '/api/secondary-key'], ['POST', '/api/secondary-key'], ['GET', '/api/settings'], ['GET', '/api/usage?evil=1'], ['GET', '/api/handover-file?path=/etc/passwd'], ['POST', '/api/upgrade'], ['GET', '//evil.test/api/state']]) {
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
