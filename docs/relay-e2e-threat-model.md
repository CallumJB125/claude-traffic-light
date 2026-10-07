# Relay end-to-end encryption + scoped phone sign-in — threat model addendum (W2-A)

> **REQUIRES INDEPENDENT SECURITY REVIEW before release.** Written by the
> implementing agent; not reviewed. Nothing here may be marketed ("the hub
> can't read your chats") until a reviewer outside this lane has signed it
> off (paid-tier plan §4 item 7) and W2-B has wired pairing into the app.

Addendum to `remote/THREAT_MODEL.md` (closes the design of R3 / §12.2 for the
interaction relay) and `board/PHONE.md` (open question 1, the scoped token).

## What was built

| Piece | File |
|---|---|
| Envelope + channels (isomorphic, WebCrypto only) | `src/e2e/relay-envelope.js`; byte-identical `board/web/js/phone-e2e.js`; re-exported by `remote/src/envelope.js`; drift test `test/relay-e2e.test.js` |
| ECDH keys in pairing (MAC, signatures, SAS) | `remote/src/pairing.js`, `remote/src/keys.js` (identity `agree*`), `remote/src/registry.js` (`agreeKey`, `activeAgreeKey`), `remote/src/node/file-store.js` (identity file v2) |
| Desktop host: open sealed calls, seal answers, refuse plaintext | `src/remote-interaction.js` (`e2e` option; `forgetDevice`) |
| Hub: opaque `enc` bodies, shape check only | `board/hub/interaction-relay.js` (`encShapeOk`, op `hello`) |
| Scoped phone credential | `board/shared/migrations/056_device_scope.sql`, `board/hub/identity/accounts.js`, `board/hub/http.js` (`RELAY_SCOPE_ROUTES`) |
| Phone: keys in vault, sealed calls | `board/web/js/phone-vault.js`, `board/web/js/phone-core.js` (`createE2E`), `board/web/js/phone-app.js` |

## Construction

Primitives: ECDH P-256, HKDF-SHA-256, AES-256-GCM (128-bit tag), all through
WebCrypto (`globalThis.crypto.subtle`; Node ≥ 22 and iOS 16.4+ Safari). No
custom primitives. P-256 rather than X25519 because the phone signing key is
already P-256 for the same iOS reason (`remote/src/keys.js`).

1. **Static keys.** Phone: one ECDH key per phone install, private half
   non-extractable in IndexedDB. Desktop: one ECDH key beside its signing
   identity (0600 JSON, extractable so it can be persisted; Keychain/DPAPI is
   later hardening, as for the signing key).
2. **Exchange at pairing.** `deviceAgree` rides in `pair-init` (covered by the
   QR-secret HMAC and the phone's proof-of-possession signature);
   `desktopAgree` in the desktop-signed `pair-challenge` and `pair-complete`;
   both in the typed 6-digit SAS. A hub that swaps either key breaks the MAC,
   a signature or the SAS (tested).
3. **Pair secret** = ECDH(own static, peer static). Only the two ends can
   compute it: a message that opens under it came from the other end.
4. **Session.** `hello` (sealed under the pair secret, nonce nP) → desktop
   answers sealed `{sid, nD}`; session secret = HKDF(pair secret, salt = nP‖nD,
   info = ["plexiform.relay.v1","session",did,dev,sid]). Sessions live in
   desktop memory only (≤ 4 per device, 64 total, 30 min idle, 12 h max).
5. **Message.** Fresh key per message: HKDF(secret, salt = 32 random bytes,
   info = [...,"msg",dir]); random 96-bit IV; AAD =
   `["plexiform.relay",1,dir,did,dev,sid,seq,rid,op]`.
6. **Replay.** Desktop accepts each (sid, seq) once and refuses seq ≤
   highest − 256; a restart forgets all sessions (old envelopes → `no-session`).
   The phone accepts only the answer to its own outstanding request (same
   sid/seq/rid/op, direction d2p). The hub's own request_id replay refusal
   and the desktop's `once(rid)` stay as extra layers.
7. **Policy.** With `e2e` configured the desktop refuses plaintext own-device
   calls (`required`, default on). The phone never shows an answer that does
   not open; the only plaintext it accepts from a sealed call is a fixed-code
   refusal, rendered with the phone's own fixed text.

## What the hub can and cannot see

| The hub CAN see / do | The hub CANNOT |
|---|---|
| Which account, which calling device, which host device (as today) | Read message text, replies, session ids, session state, provider names, launch args — all inside `enc` |
| The op name (`hello`, `list`, `send`, `watch`, …) — kept in clear so the hub can keep its outcome-unknown rule for mutating ops; bound into the AAD so it cannot be changed | Change an op, args or answer (GCM tag over ciphertext + AAD) |
| Envelope metadata: `dev` (device id at that desktop), `sid`, `seq`, sizes, timing, frequency | Move a ciphertext to another request id, op, session, device or direction (AAD) |
| Drop, delay, or refuse to deliver anything (DoS) | Replay a call into the same or a later desktop run (seq window; memory-only sessions) |
| Forge a plaintext refusal (`no-session`, `busy`, …) — shown as a fixed message | Make a send run twice by faking `no-session`: only reads are retried automatically |
| Open a new session by replaying a `hello` (no effect beyond evicting an older session = DoS) | Learn the session secret (needs the pair secret) |
| Hold every phone and desktop public key | Derive any secret from public keys alone |

Teammate **shared** sessions (`interaction-shares.js`) are not paired with the
owner's computer and stay **plaintext through the hub** (unchanged). Desktop
→ desktop own-device calls are plaintext unless the calling desktop is given
a device channel (`createRemoteInteractionClient({e2e})`); with `required` on,
an unpaired desktop client is refused.

## Scoped phone credential

`user_devices.scope` ∈ {`full`, `relay`} (migration 056, existing
`phone-web` rows narrowed in place). A phone sign-in (platform `phone-web`,
or `scope:'relay'` requested, by email code or OAuth) is always `relay`.
`http.js` lets a relay token reach only `GET /api/interaction/v1/hosts`,
`POST …/hosts/:host_id/call`, `GET …/shared`, `POST …/shared/:share_id/call`, `PUT …/role` (client only)
and `POST /api/auth/signout`; every other route is 403 before the body is
read, every WebSocket upgrade (board and host) is refused, the integration
identity callback ignores it, and `PUT role` refuses `host` for it. A stolen phone token
can therefore drive the relay (it could already) but not boards, teams,
devices, account deletion step-ups, runners or hosting.

## Key lifecycle

| Event | Effect |
|---|---|
| Phone first use | `phone-vault agreementKey()` makes the non-extractable ECDH pair |
| Pairing (W2-B UI) | `PairingClient.begin(qr, {agreeKeyPair})` → desktop registry stores `agreeKey`; phone stores `{did, dev, desktopAgree}` per host via `vault.savePairing(hostId, …)` |
| Each relay contact | `hello` → fresh session secret; per-message keys from it |
| Desktop restart | All sessions forgotten; phone re-handshakes (reads automatically; mutating ops report "may not have been handled") |
| Phone sign-out | `vault.clear()` wipes token, token key, ECDH key and pairings; a new sign-in must pair again |
| Old desktop identity file (v1) | Keeps its id, gains an ECDH key, rewritten as v2 |

## Revocation

- **Desktop side (pairing):** `registry.revoke(deviceId)` → `activeAgreeKey`
  returns null → the next sealed call is `unknown-device` and that device's
  sessions are dropped (`peer()` is asked on every message;
  `host.forgetDevice(dev)` drops them at once). A revoked key can never be
  re-added (registry rule).
- **Hub side (account):** removing the phone's device row works as before:
  401 on the next call, and the relay re-checks before forwarding and
  answering. Independent of the pairing: either revocation alone stops it.

## Residual risks (open)

1. **Wired by W2-B, for Plus only.** `src/remote-approvals-main.js` gives the
   host `e2e` (required while phone approvals are on) and Settings → Phone
   pairs a phone (`docs/PHONE-RUNBOOK.md`). Without Plus, or with phone
   approvals off, an unpaired phone's calls stay the old plaintext relay, as
   PRIVACY.md says.
2. **Same-origin script (R1).** The PWA is still served from the hub origin.
   A hub that serves malicious JS can *use* the non-extractable key (decrypt
   and send as the phone) — E2E protects against a passive or relaying hub,
   not one that also controls the phone's code. Closed only by the separate
   pinned static origin decided in `remote/THREAT_MODEL.md` §11.
3. **No forward secrecy against static-key theft.** Session secrets derive
   from the static-static secret plus nonces that cross the wire sealed under
   it; whoever later obtains a static private key *and* recorded traffic can
   decrypt that traffic. The phone key is non-extractable; the desktop key is
   a 0600 file. An ephemeral-ECDH upgrade (Noise-style `ee`) is the fix.
4. **Metadata.** Op names, timing, sizes and frequency remain visible (e.g.
   "a send of ~1 KB at 14:02"). Not padded.
5. **Desktop key at rest** is extractable in a 0600 file (same as the signing
   identity); malware running as the user can take it.
6. **Shared (teammate) sessions** remain plaintext through the hub.
7. **Desktop-to-desktop** own-device calls remain plaintext until desktops
   pair with each other; with `required` they are refused instead.
8. **Scope is self-declared at enrolment**: someone with a mailbox code can
   still enrol a full desktop token (unchanged exposure). Scope limits what a
   *phone's* stored token can do, not who can sign in.
9. **No independent review** of the construction, the code, or the
   AAD/replay reasoning. Required before release.
