# Phone approvals: what a security reviewer should check

Status: **not released. Needs an independent review before `site.config.json`
`phone` is flipped on.** This page is the entry point for that review. It
sums up the threat model and lists what to verify, with file pointers. The
full material is `remote/THREAT_MODEL.md` (W2-B), `docs/relay-e2e-threat-model.md`
(W2-A, the end-to-end envelope) and `docs/PHONE-RUNBOOK.md` (how it is wired
and what the owner must do).

## The flow in five lines

1. An AI tool on the Mac asks permission. The hook writes `<requests>/<id>.json`
   and hands the app a per-request key over loopback (`hooks/answer-file.js`).
2. The Mac tells the hub "something is waiting", with no content
   (`src/remote-approvals-main.js` → `POST /api/approvals/v1/ping`). The hub
   sends an **empty** Web Push to the user's paired phones (`board/hub/push.js`).
3. The phone opens, fetches the waiting requests **end to end encrypted**
   through the hub's relay (`board/hub/approval-relay.js`, `interaction-relay.js`).
4. The person taps Approve or Deny. The phone signs the decision and confirms
   it with a platform passkey (Face ID / Touch ID) for that exact request
   (`board/web/js/phone-approvals.js`, `remote/src/decision.js`).
5. The Mac verifies everything and answers the hook (`remote/src/approvals.js`).
   The hub never decides and never sees a request, a decision or a command.

## What is protected, and by what

| Property | Mechanism | Where |
|---|---|---|
| Hub cannot read requests or decisions | W2-A envelope; plaintext approval ops are refused with 400 | `approval-relay.js call()`, `interaction-relay.js encShapeOk` |
| Hub cannot forge or alter pairing | QR secret MAC + both devices' signatures; hub only relays | `remote/src/pairing.js` |
| A phone is one known device | ECDSA device key, non-extractable, created per pairing | `remote/src/keys.js`, `registry.js` |
| A decision needs a human on the phone | WebAuthn passkey assertion, `userVerification: 'required'`, origin and rp id pinned, counter must advance | `remote/src/webauthn.js`, `approvals.js` steps 6–7 |
| Decision applies to one request only | Signed `requestId` + `sha256(tool input)`; mismatch is refused | `approvals.js` steps 8–9 |
| Decisions expire | Request notice: 60 s (`publishRequest ttlMs`). Decision: 90 s issued, 120 s max, 30 s skew; nonce replay cache | `remote/src/decision.js`, `approvals.js` step 3 |
| Timed-out request is denied, not left open | Hook claims `<id>.answer` with a `timeout` marker at its deadline (60 s hook limit, 5 s margin); a late answer is ignored; stale request files (>75 s) are never shown | `hooks/answer-file.js claimTimeout, STALE_REQUEST_MS` |
| Dangerous requests cannot be allowed remotely | Deny-list → "desk only": the phone may only deny | `remote/src/denylist.js`, `allowlist.js`, `shell.js` |
| Revocation is immediate | Registry revoke + host forgets the channel key; hub deletes the push subscription | `remote-approvals-main.js revoke()`, `board/hub/api.js device.revoke` |
| Push cannot be pointed at us | Push endpoints limited to the browser vendors' hosts, https, no credentials, no redirects | `push.js PUSH_HOSTS, endpointOk` |
| Push carries nothing | Zero-length body, `TTL: 60`, VAPID JWT 12 h | `push.js ping()` |
| Abuse limits | Ping coalesced 5 s, 120/h/user; 10 push devices/user; relay limits | `approval-relay.js APPROVAL_LIMITS`, `push.js PUSH_LIMITS` |
| Audit | Mac: hash-chained `audit.jsonl` (hashes only, never tool input). Hub: `audit` row `phone.ping` per wake-up (device, user, sent/failed), `device.create`, `device.revoke` | `remote/src/node`, `approval-relay.js ping()` |
| Plan gate | `phone` and `queue.push` are Plus; the hub refuses a ping from a free account on a hub that sells plans | `src/entitlements.js`, `approval-relay.js PLAN_REQUIRED` |

## Reviewer checklist

Tick each one by reading the code and running the named test. All tests:
`npm test` at the root and `npm test` in `board/`.

- [ ] The hub has no code path that writes an `.answer` file or returns a decision. `board/hub/test/approvals-e2e.test.js` ("nothing in board/hub writes answers").
- [ ] A plaintext `approvals.decide` or `tasks.start` to the relay is refused. Same file.
- [ ] A decision signed by a revoked, unknown or other-user device is refused before the passkey is checked. `remote/test/decision.test.js`, `remote/test/review-attacks.test.js`.
- [ ] A decision whose `toolInputHash` does not match the request file is refused. `remote/test/decision.test.js`.
- [ ] A decision past `expiresAt`, with `expiresAt - issuedAt > 120 s`, or more than 30 s ahead of the Mac clock is refused. `remote/test/decision.test.js`.
- [ ] A reused nonce is refused. `remote/test/decision.test.js`.
- [ ] A passkey assertion with `UV` unset, a wrong origin or rp id, or a non-advancing counter is refused. `remote/test/webauthn.test.js`.
- [ ] A deny-listed request cannot be allowed from the phone. `remote/test/denylist.test.js`, `remote/test/deny-bypasses.test.js`.
- [ ] The hook's timeout claim wins over a late answer. `test/answer-file.test.js`.
- [ ] Push subscriptions outside `PUSH_HOSTS`, or with credentials, are refused; a ping has an empty body. `board/hub/test/push.test.js`.
- [ ] A ping from a non-host device or a free account is refused. Same file.
- [ ] Pairing: wrong 6-digit code cancels the pairing; the QR secret works once and expires in 3 min. `remote/test/pairing.test.js`, `test/remote-approvals-main.test.js`.
- [ ] The phone PWA's security core files are byte-identical copies of `remote/src` (drift test). `board/web/test/phone-approvals.test.js`.
- [ ] CSP on `phone-pairing.html` and the PWA; no inline script. `test/remote-approvals-main.test.js` ("CSP-locked"), `board/web/test/phone.test.js`.

## Known residual risks the reviewer should weigh

From `remote/THREAT_MODEL.md` §8 and §10, still open at the time of writing:

- **R1 / O2: the PWA is served by the hub origin.** JS served from that origin
  could use the device key to show one thing and sign another. The design
  decision is a separate static origin with CSP and SRI that the hub operator
  cannot write to. Owner-gated (runbook item 4 and 5). Until then, the hub
  operator is in the trust base for the phone.
- **Passkey registration uses `attestation: 'none'`.** Script on the PWA
  origin within 10 minutes of pairing could register a software key. Closed
  by the separate origin, or by requiring attestation (runbook "Not built").
- **O4: no real-device verification yet** of P-256 WebCrypto, non-extractable
  keys in IndexedDB and platform passkeys on iOS 16.4+ home-screen PWAs.
- **R4: shell judgement is heuristic.** The final bound is the AI tool's own
  permission rules.
- **R9: the Mac's audit chain detects edits, not tail deletion.** Anchor on
  the hub periodically if the review wants that closed.

## What the owner does to enable, in order

1. Read this page, `remote/THREAT_MODEL.md` and `docs/relay-e2e-threat-model.md`;
   get the independent review and record the sign-off here.
2. On a trusted machine: `node board/hub/scripts/gen-vapid.mjs --subject mailto:<ops address>`
   and put the three lines into `/etc/buddy-hub/hub.env` (never in git).
   Restart the hub. `GET /api/auth/methods` now reports `push: true`, and the
   desktop Phone page stops saying the hub doesn't send notifications.
3. Confirm migration 061 is applied and `push_subscriptions` is in the backup.
4. Set up the separate phone origin (runbook item 4 and 5) if the review
   requires it before launch.
5. Flip `phone: true` in `site/site.config.json`, rebuild the site. The
   download page then shows the QR and the steps.
6. Pair your own phone end to end on a real iPhone and Android (O4) before
   telling anyone.
