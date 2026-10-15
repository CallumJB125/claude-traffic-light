'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { create, ENDPOINT } = require('../src/crash-report-sender');
const { wireReport } = require('../board/shared/crash-report.cjs');
const collector = require('../src/crash-reports');
const { testTempDir } = require('./helpers/tmp');
const report = { id: '00000000-0000-4000-8000-000000000001', at: new Date().toISOString(), kind: 'uncaughtException', app: { version: '1.0.2', os: 'darwin', arch: 'arm64' }, error: { name: 'TypeError', message: 'private prompt or token', stack: ['at private-file'] } };
test('sender rebuilds wire allowlist even for tampered local data; no cookies or redirects', async () => {
  let call;
  const send = create({ fetch: async (...args) => { call = args; return new Response(null, { status: 200 }); } });
  assert.deepEqual(await send({ ...report, credentials: 'private' }), { sent: true });
  assert.equal(call[0], ENDPOINT);
  assert.equal(call[1].credentials, 'omit'); assert.equal(call[1].redirect, 'error');
  assert.deepEqual(JSON.parse(call[1].body), wireReport(report));
  assert.doesNotMatch(call[1].body, /private|prompt|token|stack|message/);
  assert.deepEqual(call[1].headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(wireReport({ ...report, app: { version: 'secret', os: 'secret', arch: 'secret' }, error: { name: 'secret' } }).error, { name: 'Error' });
});
test('sender fails closed and never retries failures or invalid reports', async () => {
  let calls = 0;
  const send = create({ fetch: async () => { calls++; throw Error('offline'); } });
  assert.equal((await send(report)).sent, false);
  assert.equal((await send({ ...report, id: 'bad' })).sent, false);
  assert.equal(calls, 1);
});
test('legacy consent cannot activate sending, and a rejected send does not create an unhandled rejection', async () => {
  const dir = testTempDir('crash-consent-');
  fs.writeFileSync(path.join(dir, 'consent.json'), JSON.stringify({ optedIn: true }));
  let calls = 0;
  const c = collector.create({ dir, send: async () => { calls++; throw Error('offline'); } });
  assert.equal(c.isOptedIn(), false);
  c.record('uncaughtException', Error('before')); assert.equal(calls, 0);
  c.setOptIn(true); c.record('uncaughtException', Error('after')); assert.equal(calls, 1);
  await new Promise((r) => setImmediate(r));
  c.setOptIn(false); c.record('uncaughtException', Error('off')); assert.equal(calls, 1);
});
