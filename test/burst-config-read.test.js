'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createBurstClient } = require('../src/burst-client');
const { createFakeBurst, stateV012 } = require('./fixtures/fake-burst');
const { testTempDir } = require('./helpers/tmp');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function makeHome(t) {
  const home = testTempDir('burst-config-');
  const bin = path.join(home, '.local', 'bin', 'claude-burst');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, bin };
}
const unavailable = { kind: 'unreachable', installed: true, reason: 'config_timeout' };
const consoleStatus = { version: '0.19.0', checks: [] };

test('blocked config stays off main, times out with no HTTP, and retains one underlying read across retries', { timeout: 2000 }, async t => {
  const { home } = makeHome(t), blocked = deferred();
  let reads = 0, network = 0, inspections = 0;
  t.mock.method(http, 'request', () => { network += 1; throw new Error('unexpected network'); });
  const c = createBurstClient({ home, platform: 'darwin', configTimeoutMs: 20,
    readConfigFile: (file, encoding) => { reads += 1; assert.equal(path.basename(file), 'config.json'); assert.equal(encoding, 'utf8'); return blocked.promise; },
    inspect: { launchdPid: async () => { inspections += 1; }, listenerPid: async () => { inspections += 1; }, exePath: async () => { inspections += 1; } },
  });
  let responsive = false;
  const heartbeat = new Promise(resolve => setImmediate(() => { responsive = true; resolve(); }));
  const first = await Promise.all([c.detect(), c.consoleDetect(), heartbeat]);
  assert.equal(responsive, true);
  assert.deepEqual(first.slice(0, 2), [unavailable, unavailable]);
  for (let i = 0; i < 3; i += 1) assert.deepEqual(await Promise.all([c.detect(), c.consoleDetect()]), [unavailable, unavailable]);
  assert.equal(reads, 1, 'timeouts retain the actual filesystem read');
  assert.equal(network, 0);
  assert.equal(inspections, 0);
  blocked.resolve(JSON.stringify({ console_listen: 'off' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(network, 0, 'late read completion alone cannot initiate a request');
  assert.equal(c.adminUrl(), null);
  assert.deepEqual(await c.consoleDetect(), { kind: 'off' });
  assert.equal(reads, 2, 'a later explicit detection can read again after settlement');
});

test('missing and malformed config retain the existing default loopback addresses', async t => {
  const { home, bin } = makeHome(t), contacted = [];
  t.mock.method(http, 'request', options => { contacted.push(options.port); throw Object.assign(new Error('probe only'), { code: 'probe' }); });
  for (const readConfigFile of [async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, async () => '{broken']) {
    const c = createBurstClient({ home, platform: 'darwin', readConfigFile,
      inspect: { launchdPid: async () => process.pid, listenerPid: async () => process.pid, exePath: async () => bin },
    });
    assert.equal((await c.detect()).kind, 'untrusted');
    assert.equal((await c.consoleDetect()).kind, 'untrusted');
  }
  assert.deepEqual(contacted, [7788, 7789, 7788, 7789]);
});

test('config timeout revokes cached admin and console authority, including mutations', { timeout: 2000 }, async t => {
  const { home, bin } = makeHome(t), blocked = deferred();
  const fake = await createFakeBurst({ '/api/state': { body: stateV012() }, '/api/console': { body: consoleStatus } });
  t.after(() => fake.close());
  const config = JSON.stringify({ admin_listen: `127.0.0.1:${fake.port}`, console_listen: `127.0.0.1:${fake.port}` });
  let stall = false, reads = 0;
  const c = createBurstClient({ home, platform: 'darwin', configTimeoutMs: 20,
    readConfigFile: async () => { reads += 1; return stall ? blocked.promise : config; },
    inspect: { launchdPid: async () => process.pid, listenerPid: async () => process.pid, exePath: async () => bin },
  });
  assert.equal((await c.detect()).kind, 'present');
  assert.equal((await c.consoleDetect()).kind, 'present');
  assert.ok(c.adminUrl());
  const before = fake.requests.length;
  let network = 0;
  t.mock.method(http, 'request', () => { network += 1; throw new Error('unexpected network'); });
  stall = true;
  assert.deepEqual(await Promise.all([c.detect(), c.consoleDetect()]), [unavailable, unavailable]);
  assert.equal(c.adminUrl(), null);
  await assert.rejects(c.request('GET', '/api/settings'), { code: 'no_address' });
  await assert.rejects(c.requestUpgrade(), { code: 'no_address' });
  await assert.rejects(c.mutate('reset'), { code: 'not_present' });
  await assert.rejects(c.mutate('console-restart'), { code: 'not_present' });
  await assert.rejects(c.setCompaction({ enabled: false }), { code: 'not_present' });
  assert.equal(reads, 3, 'two successful reads and one retained blocked read');
  assert.equal(network, 0);
  assert.equal(fake.requests.length, before);
});

test('a detection awaiting trust cannot restore admin authority after another config read times out', { timeout: 2000 }, async t => {
  const { home, bin } = makeHome(t), blocked = deferred(), trust = deferred(), entered = deferred();
  const fake = await createFakeBurst({ '/api/state': { body: stateV012() } });
  t.after(() => fake.close());
  let reads = 0;
  const c = createBurstClient({ home, platform: 'darwin', configTimeoutMs: 20,
    readConfigFile: async () => ++reads === 1 ? JSON.stringify({ admin_listen: `127.0.0.1:${fake.port}` }) : blocked.promise,
    inspect: { launchdPid: async () => { entered.resolve(); return trust.promise; }, listenerPid: async () => process.pid, exePath: async () => bin },
  });
  const old = c.detect();
  await entered.promise;
  assert.deepEqual(await c.consoleDetect(), unavailable);
  trust.resolve(process.pid);
  assert.deepEqual(await old, unavailable);
  assert.equal(c.adminUrl(), null);
  assert.deepEqual(fake.requests.map(r => r.url), ['/api/state']);
});

test('a console mutation awaiting its PID recheck refuses after config timeout without a POST or TypeError', { timeout: 2000 }, async t => {
  const { home, bin } = makeHome(t), blocked = deferred(), recheck = deferred(), entered = deferred();
  const fake = await createFakeBurst({ '/api/console': { body: consoleStatus }, '/api/console/restart': { body: {} } });
  t.after(() => fake.close());
  let reads = 0, checks = 0;
  const c = createBurstClient({ home, platform: 'darwin', configTimeoutMs: 20,
    readConfigFile: async () => ++reads === 1 ? JSON.stringify({ console_listen: `127.0.0.1:${fake.port}` }) : blocked.promise,
    inspect: { launchdPid: async () => process.pid, listenerPid: async () => { if (++checks === 2) { entered.resolve(); return recheck.promise; } return process.pid; }, exePath: async () => bin },
  });
  const mutation = c.mutate('console-restart');
  await entered.promise;
  assert.deepEqual(await c.detect(), unavailable);
  recheck.resolve(process.pid);
  await assert.rejects(mutation, { code: 'not_present' });
  assert.deepEqual(fake.requests.map(r => [r.method, r.url]), [['GET', '/api/console']]);
});
