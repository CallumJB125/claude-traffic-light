#!/usr/bin/env node
// Exact captured bytes only. Secret read from a private file, never argv/output.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createLinearConnector } from '../integrations/linear/index.js';
import { createJiraConnector } from '../integrations/jira/index.js';
export function checkDelivery({ provider, rawBody, headers, secret, receivedAt = Date.now() }) {
  const factory = { linear: createLinearConnector, jira: createJiraConnector }[provider];
  if (!factory || !Buffer.isBuffer(rawBody) || rawBody.length > 256 * 1024 || !Number.isFinite(receivedAt)) throw Error('invalid capture arguments');
  const normalized = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const result = factory({ now: () => receivedAt }).verify({ rawBody, headers: normalized, secrets: { webhook_secret: secret } });
  return { provider, signatureAccepted: result.ok === true, bodySha256: createHash('sha256').update(rawBody).digest('hex'), bytes: rawBody.length, checkedAt: new Date().toISOString(), receivedAt: new Date(receivedAt).toISOString(), provenance: 'Provided capture; provider origin and staging acceptance require separate evidence.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [provider, bodyFile, headersFile, secretFile, at] = process.argv.slice(2);
    if (!provider || !bodyFile || !headersFile || !secretFile) throw Error('usage: verify-connector-delivery.mjs <linear|jira> <body.bin> <headers.json> <private-secret-file> [received-at-ISO]');
    for (const file of [bodyFile, headersFile, secretFile]) if (fs.statSync(file).size > 256 * 1024) throw Error('capture file too large');
    if (process.platform !== 'win32' && (fs.statSync(secretFile).mode & 0o077)) throw Error('secret file must be private (mode 0600)');
    const result = checkDelivery({ provider, rawBody: fs.readFileSync(bodyFile), headers: JSON.parse(fs.readFileSync(headersFile, 'utf8')), secret: fs.readFileSync(secretFile, 'utf8').trim(), ...(at ? { receivedAt: Date.parse(at) } : {}) });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.signatureAccepted) process.exitCode = 1;
  } catch { process.stderr.write('Capture verification failed. Check provider, file permissions, byte limits and capture time. No payload or secret was printed.\n'); process.exitCode = 2; }
}
