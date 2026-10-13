#!/usr/bin/env node
// The Sentry go-live gate (CONTRACT D42 addendum "the Sentry connector"), run
// by the hub owner on a captured real delivery. Offline: no network, no hub.
//
//   SENTRY_CHECK_SECRET=<the integration's client secret> \
//     node board/hub/scripts/sentry-check-delivery.mjs --body body.bin --headers headers.json [--fixture out.json]
//
// --body is the delivery's exact bytes; --headers a JSON object of its request
// headers. The secret comes from the environment so it stays out of shell
// history and argv. Checks the real signature over the raw bytes with the
// connector's own verify(). If it does not match, stop and tell the hub owner:
// the connector is never adapted to verify a re-serialised body. With
// --fixture, writes the same bytes re-signed under a fresh test secret
// (refuses to overwrite); the real secret and signature are never written.

import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSentryConnector } from '../integrations/sentry/index.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const bodyPath = opt('--body'), headersPath = opt('--headers'), fixturePath = opt('--fixture');
const secret = process.env.SENTRY_CHECK_SECRET;
delete process.env.SENTRY_CHECK_SECRET;
if (!bodyPath || !headersPath || !secret) {
  process.stderr.write('usage: SENTRY_CHECK_SECRET=<client secret> sentry-check-delivery.mjs --body <file> --headers <file.json> [--fixture <out.json>]\n');
  process.exit(2);
}

const rawBody = readFileSync(resolve(bodyPath));
const given = JSON.parse(readFileSync(resolve(headersPath), 'utf8'));
const headers = Object.fromEntries(Object.entries(given).map(([k, v]) => [k.toLowerCase(), String(v)]));
const resource = headers['sentry-hook-resource'];
const result = createSentryConnector().verify({ headers, rawBody, secrets: { webhook_secret: secret } });
if (!result.ok) {
  process.stderr.write(`FAIL: ${result.reason}. The real signature does not verify over these raw bytes. Stop and tell the hub owner; do not add sentry to connectorsFor().\n`);
  process.exit(1);
}
process.stdout.write(`OK: signature verifies over ${rawBody.length} raw bytes (resource ${resource ?? 'unknown'}, dedupe ${result.dedupe_key}).\n`);

if (fixturePath) {
  const testSecret = randomBytes(24).toString('base64url');
  const fixture = {
    recorded: true,
    note: 'A real Sentry delivery: exact bytes, re-signed under a test secret after its real signature verified (sentry-check-delivery.mjs).',
    resource: resource ?? null,
    timestamp: headers['sentry-hook-timestamp'] ?? null,
    body: rawBody.toString('utf8'),
    test_secret: testSecret,
    signature: createHmac('sha256', Buffer.from(testSecret, 'utf8')).update(rawBody).digest('hex'),
  };
  const out = resolve(fixturePath);
  try { writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`, { flag: 'wx' }); }
  catch (e) {
    process.stderr.write(`could not write ${out}: ${e.code === 'EEXIST' ? 'it already exists (refusing to overwrite)' : e.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`Fixture written to ${out} (re-signed under a test secret).\n`);
}
