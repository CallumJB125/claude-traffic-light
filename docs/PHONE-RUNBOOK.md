# Phone approvals runbook (W2-B: remote approvals, push, tasks from the phone)

> **REQUIRES INDEPENDENT SECURITY REVIEW before release.** A remote approval
> is a remote code execution path. Written by the implementing agent and not
> reviewed. Nothing here may be released or marketed until a reviewer outside
> this lane has signed off W2-A (`docs/relay-e2e-threat-model.md`) and W2-B
> together (paid-tier plan §4 item 7; `remote/THREAT_MODEL.md` ground rule).

The code is in place. Every step under "Owner-gated" involves keys, DNS,
hosting or production, so only the owner does it. No agent generates or
commits VAPID keys, sends a real push, deploys or touches `app.plexiform.dev`.

## What the code does

**Desktop** (`src/remote-approvals-main.js`, registered by `src/paid-wiring.js`):

- Gated by `entitlements.has('phone')` (Plus) and a switch in Settings → Phone
  (`phone-pairing.html`, `src/remote-pairing-view.js`). Free: the page shows the
  upsell; nothing is paired, pinged or answered. Paired-phone limit:
  `entitlements.limits().devices` (Plus: 3).
- Keys and records in `<data>/remote/` (0700 dir, 0600 files): `identity.json`
  (desktop ECDSA signing + ECDH agreement keys), `devices.json` (paired phones,
  their passkey public key and counter), `audit.jsonl` (hash-chained decision
  log, input hash only), `audit-pairing.jsonl`, `settings.json`.
- Wires W2-A into the remote interaction host through
  `setInteractionHostExtras` (main.js keeps one `let` and one spread in
  `createHost`): `e2e` is read on every frame and is **required** while phone
  approvals are on, so a plain own-device call is refused.
- Sealed ops (end-to-end only): `approvals.list` (signed `buddy.request`
  notices, desk-only marked), `approvals.decide` (signed decision + passkey
  assertion → `RemoteApprovals.handleDecision` → `WidgetRequestStore` with
  `keyFor` from the signal server), `approvals.passkey` (one passkey per
  pairing, within 10 minutes of pairing), `tasks.start` (launch + send through
  the host's own session ops). Plain ops: `pair.init`, `pair.reveal`,
  `pair.poll`, only for the pairing this computer is showing.
- Every 1.5 s, if a new answerable request is waiting, phone approvals are
  on, the host is connected and a paired phone has a passkey: one
  `POST /api/approvals/v1/ping` with body `{}` (at most every 5 s).

**Decision checks** (in order, first failure wins, all audited): shape → audience
→ device known and not revoked → device signature → transport binding (the
end-to-end channel's device must be the signer) → TTL ≤ 120 s / skew / not
expired → nonce unused → **passkey**: user-verified assertion over
`sha256(canonical decision payload)`, origin and rp id pinned, counter not
regressing → request still pending, ids and tool match → `sha256(tool input)`
matches → owner policy → allow only: deny-list + remote allow-list ("desk
only") → first-wins answer file with the per-request key → hook ack.

**Hub** (`board/hub/approval-relay.js`, `board/hub/push.js`, migration `061_push_subscriptions.sql`):

- `POST /api/approvals/v1/hosts/:host_id/call`: approval/task ops must be
  `enc` envelopes (plaintext → 400); pairing ops must be plain `args`
  (≤ 4 KB). Routed through the interaction relay's `forward()` (own user's live
  host only, replay refusal, revocation re-checks, timeouts).
- `POST /api/approvals/v1/ping`: full-scope device token with the host role
  only; on a hub that sells plans, a paid account only (`PLAN_REQUIRED`);
  coalesced within 5 s, 120 per hour per user.
- `GET /api/push/v1/key`, `PUT|DELETE /api/push/v1/subscription`: the phone's
  push endpoint, one per phone sign-in, push-service hosts only
  (`PUSH_HOSTS`), https, no credentials. Deleted on device revoke / sign-out,
  account deletion, and a 404/410 from the push service.
- Pushes are **empty** (no payload, no encryption needed), `TTL: 60`,
  `Urgency: high`, `Topic: needs-you`, VAPID JWT (ES256, 12 h). Off unless the
  three `BOARD_PUSH_VAPID_*` variables are set.
- Phone-scoped (`relay`) sign-ins may use exactly these phone routes
  (`RELAY_SCOPE_ROUTES` in `board/hub/http.js`).
- Nothing in `board/hub` reads or writes `.answer` files (tested:
  `board/hub/test/approvals-e2e.test.js`, THREAT_MODEL §9.3).

**Phone** (`board/web/js/phone-approvals.js`, `phone-app.js`, `phone-sw.js`,
`board/web/js/remote/*` = byte-identical copies of the security core, drift-tested):
pairing by link/QR (fragment only, removed from the address bar), SAS shown
to type on the computer, fresh non-extractable signing key per pairing,
platform passkey (`userVerification: 'required'`), sealed list/decide/task,
push subscribe, voice via the browser's own `SpeechRecognition`.

## Owner-gated

1. **Security review sign-off** for W2-A + W2-B before any release.
2. **VAPID key pair into the hub env.** Generate offline on a trusted machine
   (for example `openssl ecparam -name prime256v1 -genkey -noout` and export
   the raw public point and private scalar as base64url), then set on the hub
   only, never in git:
   - `BOARD_PUSH_VAPID_PUBLIC_KEY` — base64url, 65-byte uncompressed point
   - `BOARD_PUSH_VAPID_PRIVATE_KEY` — base64url, 32-byte scalar (hidden in config dumps, deleted from `process.env` at start)
   - `BOARD_PUSH_VAPID_SUBJECT` — `mailto:` or `https:` contact for push services
   The hub refuses to start with only some of them, or with a mismatched pair.
   Rotating the pair invalidates every phone's subscription (they re-subscribe
   on "Turn on notifications").
3. **Deploy migration 061** with the hub and check the Litestream → R2 backup
   includes `push_subscriptions`.
4. **Separate static PWA origin** (THREAT_MODEL §11 R1; closes W2-A residual
   risk 2): DNS for e.g. `phone.plexiform.dev`, a Cloudflare Pages project
   built from pinned releases the hub operator can't write, the hub only a
   `connect-src` (CORS for that origin on the phone routes, which today assume
   same-origin). Then set the desktop's pinned phone origin (`settings.json`
   `phoneOrigin` in `<data>/remote/`, used for the passkey origin and rp id and
   the pairing link) to that origin. Passkeys registered on the hub origin will
   not work on the new origin: phones must pair again. The phone code also
   assumes it is served by the hub today (relative API paths;
   `parsePairingLink` checks the link's hub against its own origin): point
   `createApi({origin})` and that check at the hub when moving.
5. **CSP pins on that origin:** `default-src 'none'; script-src 'self'` with
   SRI on every script, `connect-src https://app.plexiform.dev`,
   `img-src 'self'`, `style-src 'self'`, `manifest-src 'self'`,
   `worker-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`.
6. **Legal:** PRIVACY.md now names Apple, Google, Mozilla and Microsoft push
   services; fill the POPIA s72 / GDPR Chapter V transfer-basis placeholder.
7. **Real-device check (O4):** iOS 16.4+ home-screen PWA: P-256 WebCrypto,
   non-extractable keys in IndexedDB, platform passkey with UV,
   `getPublicKey()` / `getAuthenticatorData()` on the registration response,
   Web Push delivery of an empty push. Android Chrome the same.

## Not built / known limits

- The phone can only paste or open a pairing link; there is no in-app camera
  scanner (iOS opens a scanned link in Safari, whose storage is separate from
  the home-screen app, so on iPhone copy the link with the desktop's Copy
  button and paste it in the app).
- Desktop revocation does not end the phone's hub sign-in; remove it in
  Account → Devices to stop its notifications.
- Starting a task needs no passkey (like the existing `send`), only the paired
  end-to-end channel and the Plus gate.
- Passkey registration uses `attestation: 'none'`: the computer checks that
  the key and id the phone reports are the ones in the authenticator's own
  data, and the UP/UV flags, but cannot prove they came from a real platform
  authenticator. Script running on the phone app's origin within 10 minutes
  of pairing could register a software key instead (and then approve without
  a biometric). Closed by the separate pinned origin (owner-gated item 4), or
  by requiring and verifying attestation.
