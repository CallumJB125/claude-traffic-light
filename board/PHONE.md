# Phone control (`/phone/` PWA)

A phone-sized, installable web app served by an accounts-mode hub. Signed in
on a phone, you see your computers that run Plexiform with "Let my other
devices use sessions" on, list the sessions started from your devices on one,
open a session, read its deliveries and replies as they stream, send a
message, steer a running turn, interrupt it and close the session.

It is a client of the interaction relay (`hub/interaction-relay.js`,
`src/remote-interaction.js`) and changes neither.

## Files

| Path served | Source | Notes |
|---|---|---|
| `/phone`, `/phone/` | `web/phone.html` | accounts mode only (`ACCOUNT_PAGES`) |
| `/phone/sw.js` | `web/phone-sw.js` | scope `/phone/`; never served under `/web/` |
| `/phone/manifest.webmanifest` | `web/phone.webmanifest` | `application/manifest+json` |
| `/web/phone.css`, `/web/phone-icon-{192,512}.png` | `web/` | icons from `build/icons/` |
| `/web/js/phone-*.js` | `phone-core.js` (API client + state machine), `phone-render.js` (vnode screens via `h.js`), `phone-vault.js` (token at rest), `phone-app.js` (DOM wiring) | plain ES modules, no build |

The only hub change is that static allowlist (`hub/http.js`: `TYPES`,
`WEB_FILES`, `ACCOUNT_PAGES`). No new route, credential kind or table.

## Sign-in (enrolment)

The relay accepts only desktop-kind device tokens (`cred.kind === 'device'`)
and refuses cookie sessions. The phone therefore enrols as a device through
the existing email-code flow, from its own page on the hub's origin:

1. `POST /api/auth/email/start {email, client:'buddy_desktop', device_name, platform:'phone-web'}`
2. `POST /api/auth/email/verify {flow_id, code, device_name, platform}` → `device_token` (`bdt_…`, shown once).

The phone is then a `user_devices` row like any computer: listed in
`GET /api/account/devices` (platform `phone-web`), revocable from any other
device (`DELETE /api/account/devices/:id`), and signed out with
`POST /api/auth/signout`. A `401` from any call wipes the stored token and
returns to sign-in. Google/GitHub sign-in is not offered: the desktop OAuth
flow needs a loopback redirect a phone browser cannot serve.

## Client rules

- Every request: `Authorization: Bearer`, `credentials: 'omit'` (the board's
  cookie never rides along), `cache: 'no-store'`. Each relay call gets a fresh
  `request_id`. The token is never in a URL.
- Liveness: a session's status is shown as live only while the `watch`
  long-poll answers (≤ 20 s each) and the last answer is < 30 s old.
  Otherwise the pill reads Reconnecting / Offline / Unavailable with
  "Last known: …", and sending is disabled. Lists (computers, sessions) are
  snapshots labelled "Checked … ago" and "Last known: …".
- Failures back off 1 s → 30 s with jitter (honouring `retry_after_s`); going
  online or returning to the page retries at once. An offline host (`404`)
  keeps retrying. A `stale` result (session closed or replaced) stops the poll.
- A send that fails on the network says it may not have been sent; it is not
  retried automatically (the relay refuses replays by design).
- Provider text (delivery text, response, error, notices) only becomes text
  nodes (`h.js` has no HTML path).

## Threat model

Assets: the phone's device token (full account device credential, see open
question 1), message text and replies in transit.

| Threat | Mitigation |
|---|---|
| Cookie/CSRF: another site makes the browser call the relay | Relay refuses cookie sessions (unchanged). The phone sends no cookies; the token is never ambient. Mutations from another Origin are refused by the hub (`sameOrigin`), tested. |
| XSS on the hub origin steals the token | Strict CSP from the hub (`script-src 'self'`, no inline, no third-party); provider text rendered as text only. Residual: any script on the hub origin (board app included) can read IndexedDB and use the key. Same origin as the board web is the main residual risk. |
| Token at rest on a lost/backed-up phone | AES-GCM encrypted in IndexedDB under a non-extractable `CryptoKey`; never `localStorage`, URL or cookie. Revoke the phone from any computer: effective at once (next poll is `401`, the relay re-checks credentials before forwarding and before answering). |
| Service worker caches private data | Worker caches only a fixed list of static shell files; it does not intercept `/api/`, `/auth/`, non-GET, cross-origin or query-string requests (tested). |
| Stale state shown as live | Liveness rule above; ended is the only status shown without a live poll. |
| Phishing the email code onto an attacker's "phone" | Same exposure as desktop sign-in; the mail names the device and platform. |

## Proof

LOCAL / DISPOSABLE only (in-process accounts hub on loopback, outbox mailer,
FAKE codex app-server): `hub/test/phone-pwa.test.js`, `web/test/phone.test.js`,
and `node web/scripts/phone-smoke.mjs <outDir>` (headless Chrome at 390 px,
dark + light, offline reload). Not tested on a real phone, a deployed hub or
a real provider.

## Open questions (need a decision / independent review)

1. **Scope.** The phone's `bdt_` can do anything a desktop token can (boards,
   teams, runner enrolment, account deletion step-ups). A narrower
   `client:'phone'` token, accepted only on `/api/interaction/v1/*`,
   `/api/auth/signout` and `/api/account/devices`, would cut the XSS blast
   radius. That needs an accounts change (a `client`/scope column checked in
   `authenticate`) and was deliberately not done in this lane.
2. **Origin separation.** Serving `/phone/` from its own origin (e.g. a
   `phone.` subdomain pointing at the same hub) would keep board-web script
   out of the phone's storage. The relay's `sameOrigin` check would then need
   that origin allowed.
3. **Pairing from the Mac.** QR/code pairing (a signed-in computer mints a
   short-lived one-time code the phone redeems for its device) would avoid
   typing an email code on the phone and is a better fit for (1). Needs a new
   route; not built.
4. **Email wording.** The sign-in mail says "Plexiform for desktop"; a phone
   sign-in should say so.
