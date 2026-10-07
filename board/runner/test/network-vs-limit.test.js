// A dropped connection is its own fail kind: retried with its own backoff,
// never spending a limit retry, and ending as failed{network} only when exhausted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor, readFakeLog } from './helpers.js';
import { failKindOf, NETWORK_RETRIES } from '../run.js';

async function withRunner(scenario, fn) {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario });
  try { await fn({ hub, sup }); } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
}

test('failKindOf: the network phrases are network, a 429 stays limit', () => {
  for (const t of ['write EPIPE: broken pipe', 'read ECONNRESET', 'connect ETIMEDOUT 1.2.3.4:443', 'getaddrinfo ENOTFOUND api.anthropic.com', 'TypeError: fetch failed', 'timeout awaiting response headers']) {
    assert.equal(failKindOf(t), 'network', t);
  }
  assert.equal(failKindOf('API Error: 429 rate_limit_error'), 'limit');
  assert.equal(failKindOf('something broke'), 'error');
});

test('fetch failed / ECONNRESET: retried then recovers, never counted as a limit retry', () => withRunner({
  steps: [{ result: 'error_during_execution', text: 'fetch failed: ECONNRESET' }],
  on_input: { 'network dropped': [{ result: 'success', text: 'ok' }] },
}, async ({ hub, sup }) => {
  const run = await claimRun(sup, hub, offerFor({ key: 'N-1' }));
  await waitFor(() => readFakeLog(run.runDir).some((e) => e.ev === 'turn' && /network dropped/.test(e.text)), { what: 'continue sent', timeout: 8000 });
  await waitFor(() => run.turnSucceeded, { what: 'recovered' });
  assert.equal(hub.outs('run.failed').length, 0);
  assert.equal(run.limitRetries, 0);
  assert.equal(run.networkRetries, 0);
}));

test('persistent network failure: NETWORK_RETRIES retries, then failed{network}, limit retries untouched', () => withRunner({
  steps: [{ result: 'error_during_execution', text: 'timeout awaiting response headers' }],
  on_input: { 'network dropped': [{ result: 'error_during_execution', text: 'timeout awaiting response headers' }] },
}, async ({ hub, sup }) => {
  const run = await claimRun(sup, hub, offerFor({ key: 'N-2' }));
  const f = await waitFor(() => hub.outs('run.failed')[0], { what: 'failed', timeout: 15000 });
  assert.equal(f.fail_kind, 'network');
  assert.equal(readFakeLog(run.runDir).filter((e) => e.ev === 'turn' && /network dropped/.test(e.text)).length, NETWORK_RETRIES);
  assert.equal(run.limitRetries, 0);
}));
