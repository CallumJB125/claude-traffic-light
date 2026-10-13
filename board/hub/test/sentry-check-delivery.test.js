import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSentryConnector } from '../integrations/sentry/index.js';
import { testTempDir } from '../../shared/test-support/tmp.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sentry-check-delivery.mjs');
const sign = (secret, bytes) => createHmac('sha256', Buffer.from(secret, 'utf8')).update(bytes).digest('hex');

// Hand-made, not a recorded delivery: this tests the gate script, not the gate.
function capture(dir, { secret, body = '{"action":"created","data":{"issue":{"id":"1","title":"é \\u2028"}}}', signature } = {}) {
  const bytes = Buffer.from(body, 'utf8');
  writeFileSync(join(dir, 'body.bin'), bytes);
  writeFileSync(join(dir, 'headers.json'), JSON.stringify({ 'Sentry-Hook-Resource': 'issue', 'Sentry-Hook-Timestamp': '1790000000', 'Sentry-Hook-Signature': signature ?? sign(secret, bytes), 'Request-ID': 'r' }));
  return bytes;
}
const run = (dir, secret, extra = []) => spawnSync(process.execPath, [SCRIPT, '--body', join(dir, 'body.bin'), '--headers', join(dir, 'headers.json'), ...extra],
  { encoding: 'utf8', env: { ...process.env, ...(secret ? { SENTRY_CHECK_SECRET: secret } : {}) } });

test('a delivery signed with the real secret passes and its fixture is the same bytes re-signed under a test secret', () => {
  const dir = testTempDir('sentry-gate-');
  const secret = randomBytes(24).toString('hex');
  const bytes = capture(dir, { secret });
  const out = join(dir, 'fixture.json');
  const r = run(dir, secret, ['--fixture', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^OK: signature verifies over \d+ raw bytes \(resource issue/);
  const text = readFileSync(out, 'utf8');
  assert.ok(!text.includes(secret) && !text.includes(sign(secret, bytes)), 'neither the real secret nor its signature is written');
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
  const f = JSON.parse(text);
  assert.equal(f.recorded, true);
  assert.equal(f.resource, 'issue');
  assert.ok(Buffer.from(f.body, 'utf8').equals(bytes));
  assert.notEqual(f.test_secret, secret);
  const v = createSentryConnector().verify({ headers: { 'sentry-hook-signature': f.signature }, rawBody: Buffer.from(f.body, 'utf8'), secrets: { webhook_secret: f.test_secret } });
  assert.equal(v.ok, true);
  assert.equal(run(dir, secret, ['--fixture', out]).status, 1, 'never overwrites a fixture');
});

test('a wrong secret, a re-serialised body or a missing secret fails and writes nothing', () => {
  const dir = testTempDir('sentry-gate-');
  const secret = randomBytes(24).toString('hex');
  capture(dir, { secret });
  const wrong = run(dir, randomBytes(24).toString('hex'), ['--fixture', join(dir, 'a.json')]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /^FAIL: bad signature\. .*do not add sentry to connectorsFor/);
  const reserialised = Buffer.from(JSON.stringify(JSON.parse('{"action":"created","data":{"issue":{"id":"1"}}}'), null, 1));
  capture(dir, { secret, signature: sign(secret, Buffer.from('{"action":"created","data":{"issue":{"id":"1"}}}')) });
  writeFileSync(join(dir, 'body.bin'), reserialised);
  assert.equal(run(dir, secret).status, 1);
  assert.equal(run(dir, null).status, 2);
  assert.throws(() => readFileSync(join(dir, 'a.json')));
  assert.throws(() => execFileSync(process.execPath, [SCRIPT], { stdio: 'pipe' }));
});
