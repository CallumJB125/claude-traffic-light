#!/usr/bin/env node
// Make the hub's phone-push (VAPID, RFC 8292) key pair. OWNER-GATED: run it on
// a trusted machine, paste the lines into the hub env only, never into git.
//
//   node board/hub/scripts/gen-vapid.mjs --subject mailto:ops@example.com
//
// Prints the three BOARD_PUSH_VAPID_* lines the hub needs (board/hub/push.js,
// docs/PHONE-RUNBOOK.md). Writes no file. Rotating the pair invalidates every
// phone's subscription; phones re-subscribe with "Turn on notifications".

import { generateKeyPairSync } from 'node:crypto';

const args = process.argv.slice(2);
const at = args.indexOf('--subject');
const subject = at >= 0 ? args[at + 1] : null;
if (!subject || !/^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/.test(subject)) {
  process.stderr.write('usage: gen-vapid.mjs --subject <mailto:you@example.com | https://your.site>\n');
  process.exit(2);
}
const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
process.stdout.write(`BOARD_PUSH_VAPID_PUBLIC_KEY=${pub}\nBOARD_PUSH_VAPID_PRIVATE_KEY=${jwk.d}\nBOARD_PUSH_VAPID_SUBJECT=${subject}\n`);
