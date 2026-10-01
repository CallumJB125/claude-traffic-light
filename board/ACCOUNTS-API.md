# Plexiform accounts API (hub `BOARD_AUTH=accounts`, P1–P4)

For the desktop app builder. What exists today: P1 sign-in (email codes, and Google/GitHub through the desktop loopback), P2 teams and members, P3 invites, P4 runner enrolment. Decisions: CONTRACT.md D50–D82; background: ACCOUNTS-DESIGN.md (where the two differ, this file and the D-decisions win).

The product name is **Plexiform** (`shared/brand.js`). Only user-facing text uses it; technical names keep `buddy` for now (the `__Host-buddy_*` cookies, the `bdt_` token prefix, `BOARD_*` env vars, route paths).

## Conventions

- JSON in and out. Every response has header `Board-Protocol: 1`. Mutations need `Content-Type: application/json`.
- Errors: `{"error": {"code": "<CODE>", "message": "…", …extra}}`. The HTTP status comes from the code (table at the end). `429` responses also send `Retry-After: <s>` and `error.retry_after_s`.
- `request_id` (uuid) is optional on the account routes. When present on a mutation, a repeat within 10 minutes replays the first answer (header `Board-Replayed: 1`).
- Timestamps are ISO-8601 UTC strings.

## Sign-in methods and mail (D66)

The hub sends **no mail unless a mailer is configured**, and none is required. Sign-in is meant to be Google or GitHub (see "OAuth sign-in" below); the email one-time code exists only on a hub with a mailer (`BOARD_RESEND_API_KEY` + `BOARD_MAIL_FROM`).

### `GET /api/auth/methods`

**No auth**, rate limited (60 a minute per IP). → `{"google": true, "github": true, "email": false}`: booleans only, so the app shows the right sign-in buttons. `google`/`github` are true when the hub has that provider's client id **and** secret (`BOARD_GOOGLE_CLIENT_ID`/`_SECRET`, `BOARD_GITHUB_CLIENT_ID`/`_SECRET`); `email` is true only when the hub has a mailer.

Without a mailer:

- `POST /api/auth/email/start` and `/verify` answer `404 METHOD_DISABLED` (nothing is written, nothing printed, no code exists). Deleting an account or a team then needs the Google/GitHub re-authentication step-up (below); with neither a mailer nor a provider, only the operator can erase (`hub/admin.js`).
- Invites are still created and still bound to the invited address, but the hub sends nothing: the inviter gets the link and the code once and shares them (copy, or a prefilled `mailto:` draft in their own mail client). See `POST /api/teams/:id/invites`.

An exposed hub (a `BOARD_PUBLIC_URL` off loopback, or a tunnel probe) must be https, behind cloudflared with `BOARD_TRUST_CF_IP=1`, and have at least one sign-in method (a configured Google or GitHub client, `BOARD_SIGNIN_METHODS`, or a mailer); it never uses the console mailer.

## Credentials

There are two, and only two, credentials.

### Desktop: a per-install device token (Bearer)

- `POST /api/auth/email/verify` with `client:'buddy_desktop'` returns `device_token` (`bdt_` + 43 base64url characters) **once**. The hub stores only its sha256. Keep it in the macOS Keychain.
- **Electron main injects `Authorization: Bearer <device_token>` into every request the in-app web view makes to the hub origin (via `session.webRequest.onBeforeSendHeaders`), including the `/ws/board` WebSocket upgrade. The page never sees the token.** Main's own calls (`/api/account`, sign-out, …) send the same header.
- Bearer requests need **no CSRF token**, because no ambient credential exists. The hub still checks `Origin`: when an `Origin` header is present it must be the hub's own origin (`BOARD_PUBLIC_URL`), or the request gets `403`. The web view's requests carry the page's own origin, so they pass. Main's Node requests send no `Origin`, and those pass too.
- The token does not expire. It stops working when the user signs out on that device, revokes it from another device, or deletes the account, and after a hub restore from backup (which signs every device and browser out, since the backup can't know about revocations made after it). After that every call returns `401 UNAUTHENTICATED`, and open sockets get `session.revoked` then close `4401`. On `401`, drop the token from the Keychain and show sign-in.
- A request with an `Authorization` header that doesn't name a live device is `401`. It never falls back to a cookie.
- These tokens are `user_devices` rows, the same kind the design's device flow (§6) uses. Runners don't use them: an install enrols as a runner per team and gets a separate runner token (P4, below). Google/GitHub sign-in returns the same device token.

### Plain browser: a cookie session (`client:'web'`)

- Verify with `client:'web'` sets `__Host-buddy_session` (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`) and returns `csrf_token`. Idle expiry is 14 days, absolute expiry 30 days. The cookie value rotates on use after 24 h (the old value still works for 60 s). A hub restore signs everyone out.
- Every cookie-authenticated mutation needs all three:
  - `Origin` equal to the hub origin,
  - `Sec-Fetch-Site: same-origin` (if the browser sends that header),
  - `X-CSRF-Token: <csrf_token>`.
  Otherwise the answer is `403 FORBIDDEN`. `GET /api/account` returns the token again, and it stays the same for the life of the session.
- A `/ws/board` upgrade with the cookie also needs a same-origin `Origin`.
- The desktop app doesn't use cookies.

## Rate limits

| Rule | Limit | Over the limit |
|---|---|---|
| start, per mailbox **and requesting network** (/24, IPv6 /64) | 3 / 15 min and 10 / h | **same `200 {flow_id}` answer**, no mail sent; verify on that flow_id → `INVALID_TOKEN` |
| start, per mailbox from every network together | 40 / h | the same silent answer |
| start, per IP | 20 / h | `429` |
| start, whole hub | 500 / h | `429` |
| verify, per IP | 10 / 10 min | `429` |
| verify, per address and requesting network (every attempt) | 10 / 15 min | `429` for that network only |
| **wrong codes per address** (the failure budget, every network together) | 20 in any 24 h (`BOARD_AUTH_FAIL_BUDGET`, 1–100) | `429` on every verify for that address, **even with the right code** (it isn't checked), until the rolling day frees a slot; each exhaustion also locks for 1 h, doubling per exhaustion up to 24 h. A right code resets it. When it runs out for an address that has an account, that address gets one mail a day: "Someone is trying sign-in codes for your account" |
| wrong codes per flow | 5 | the flow dies; `INVALID_TOKEN` from then on |
| mails the hub sends (sign-in, invites, notices), whole hub | 2000 / day (`BOARD_MAIL_DAILY_CAP`), of which at most half to addresses that have no account yet | sign-in: the silent answer; invites: created but not mailed (`mailed: false`) |
| new users, per IP | 10 / day | `429` on the verify that would create the user |
| any mutation, per IP | 300 / min | `429` |
| any mutation, per signed-in user or member | 120 / min | `429` |
| OAuth start, per IP (IPv6 /64) | 20 / h | `429` |
| OAuth flows open at once, per network (/24, IPv6 /48) | 5 | `429` (`retry_after_s` = until the oldest expires) |
| OAuth exchange, per IP (IPv6 /64) | 30 / h | `429` |
| failed OAuth exchanges (`INVALID_TOKEN`, `PROVIDER_ERROR`) per IP (/64) | the failure budget (`BOARD_AUTH_FAIL_BUDGET`, 20 a day, then locks that double) | `429` on every exchange from there, before anything is checked |
| runner enrolments, per user | 30 / h | `429` |

A **mailbox** is the address with any `+tag` removed (`jo+1@example.com` and `jo@example.com` share the start limits and the lockout notice); the failure budget and the account stay per address. Keeping half the daily mail cap for addresses that already have an account means a flood of made-up addresses can stop new sign-ups for the day but not existing users signing in or confirming a deletion.

The failure budget lives in hub memory, bounded at 20 000 addresses (least recently failed first out) and swept at most once a minute. At start the hub re-reads the last 24 h of wrong codes from the sign-in flows, except those a later right code for the same address cleared, so a restart does not lift a lockout.

Step-ups (`purpose:'delete'` and `'delete_team'`) only ever come from the signed-in user, so their start limits, their verify limit and their wrong codes are counted per user, not per address: someone who locks your address out of email-code sign-in cannot stop you confirming a deletion from a device you are already signed in on, and a wrong step-up code never sends the lockout notice.

A hub without `BOARD_PUBLIC_URL` or a tunnel (the loopback try-out, `BOARD_ACCOUNTS_DEV=1`) serves direct loopback requests only, like `BOARD_AUTH=dev`: a request with a proxy header (`CF-Connecting-IP`, `X-Forwarded-For`, …) or a non-loopback `Host` gets `403`.

IPv6 clients are keyed by their /64. Behind cloudflared (`BOARD_TRUST_CF_IP=1`, required once exposed), the client IP is `CF-Connecting-IP`. Pairing the per-address limits with the requesting network means someone else hammering your address from their network can't stop you from getting a code on yours; the lockout itself counts only wrong codes. (Anyone who knows your address can still spend its failure budget and pause email-code sign-in for it; the notice mail says so, and Google/GitHub sign-in is unaffected.)

## Routes built in P1

### `POST /api/auth/email/start`

No auth for `purpose:'signin'`. `purpose:'delete'` and `purpose:'delete_team'` need the Bearer token (or the cookie + CSRF token).

```json
{ "email": "jo@example.com", "client": "buddy_desktop", "device_name": "Jo's MacBook Pro", "platform": "darwin-arm64", "purpose": "signin" }
```

- `client`: `'buddy_desktop'` (default) or `'web'`.
- `device_name` (≤ 100 chars) and `platform` (≤ 50) are optional. The mail names them ("This signs in Plexiform for desktop on "Jo's MacBook Pro" (darwin-arm64)") so a phished user can see what they would be approving. Whoever starts the flow chooses them, so they are cleaned like invite names: one line, ≤ 60 / 30 characters, no control characters, quotes or angle brackets, schemes stripped and domains defanged (`evil[.]com/refund`).
- `purpose`: `'signin'` (default), `'delete'` (step-up for deleting the account) or `'delete_team'` (step-up for deleting a team). For the step-ups, `email` and `client` are ignored: the code goes to the signed-in account's own address. Each step-up is spent only by its own action: a `'delete_team'` code never deletes the account, and a `'delete'` code never deletes a team. The `'delete_team'` mail says "Someone signed in to your account asked to delete a team you own", never "your account".

→ `200 {"flow_id": "<24 chars>", "expires_in": 600}`. The answer is the same whether or not an account exists, and whether or not the per-address limit silently dropped the mail.

The mail holds a 6-digit code, valid for 10 minutes and one use, with "Never share this code…". A `web` sign-in mail also carries a magic link `https://<hub>/auth/email#f=<flow_id>&c=<code>`. Desktop mails have no link: the user types the code into the app. At most 3 flows per address are live at once; a 4th kills the oldest.

For `client:'web'` the response also sets `__Host-buddy_flow` (10 min). That cookie binds the magic link to this browser.

Errors: `400 VALIDATION` (bad email, bad client), `401 UNAUTHENTICATED` (a delete flow while signed out), `404 METHOD_DISABLED` (no mailer on this hub), `429 RATE_LIMITED`.

### `POST /api/auth/email/verify`

No auth for sign-in. A delete flow needs the same user's credential.

```json
{ "flow_id": "…", "code": "123456", "device_name": "Jo's MacBook Pro", "platform": "darwin-arm64", "form_factor": "laptop" }
```

`device_name` defaults to the one given at start; `form_factor` is `'laptop' | 'desktop' | null`.

→ desktop sign-in:

```json
{
  "user": { "id": "…", "display_name": "jo", "email": "jo@example.com", "email_verified": true },
  "teams": [ { "id": "…", "name": "Acme", "slug": "acme", "role": "owner", "member_id": "…", "boards": [ { "id": "…", "name": "Acme", "key_prefix": "ACM" } ] } ],
  "device_token": "bdt_…",
  "device_id": "…"
}
```

→ web sign-in: the same without `device_token` and `device_id`, plus `csrf_token`. It sets the `__Host-buddy_session` cookie and clears `__Host-buddy_flow`.

→ delete flow: `{"ok": true, "flow_id": "…", "step_up_expires_in": 300}`. A delete flow never signs anyone in.

- Sign-up = sign-in. The first verify for an address creates the user, with a verified email and `display_name` = the part of the address before `@` (editable later). Any member row an admin added with that address earlier (Access era, `BOARD_BOOTSTRAP`) joins the user, so its team shows up in `teams`.
- **The linking trade-off.** An address is the only thing that ties such a pre-made member row (or an invite) to a person. If an admin typed the wrong address, whoever proves that address (by a code sent to it, or later by a Google/GitHub account verified for it) gets that membership. Addresses are compared in one canonical form (trimmed, lower-cased with full Unicode). Only an email identity (a code sent to the address) or the account's own verified primary address proves an address; a GitHub identity carried over from the Access era never does.
- Magic link (web only): the page at `/auth/email` reads the fragment and POSTs `{flow_id, code, via:'link'}`. A browser without the matching `__Host-buddy_flow` cookie gets `428 CONFIRM_REQUIRED {email_masked:"j•••@example.com"}`, and the page asks "Sign in as j•••@example.com?" before re-POSTing with `confirm:true`. A link scanner's GET only loads the page, because the fragment never reaches the server, so it consumes nothing.
- Errors:
  - `400 INVALID_TOKEN`: one generic answer for an unknown, wrong, used, expired or dead flow. After a wrong code it includes `attempts_left`; a flow_id with no flow behind it (made up, or a start the limits silenced) answers `attempts_left: 5`.
  - `428 CONFIRM_REQUIRED`: see the magic-link rule above.
  - `429 RATE_LIMITED`.
  - `400 VALIDATION`: bad `form_factor` or an oversized name.
  - `404 METHOD_DISABLED`: no mailer on this hub.

### `GET /api/account`

Bearer or cookie.

→ `{"user": {…}, "identities": [{"provider": "google"}], "teams": [ {id, name, slug, plan, role, member_id, boards:[{id, name, key_prefix}]} ], "pending_invites": [ {id, team_name, inviter_first_name, role, expires_at} ]}`, plus `csrf_token` for cookie sessions.

- `identities`: the sign-in methods this account has proven (`email`, `google`, `github`), provider names only, sorted, no subjects or addresses. Offer only these for a step-up.

- `teams` has one entry per live membership in a team that isn't deleted, sorted by name: `{id, name, slug, plan, role, member_id, boards}`.
- Every team has a `slug` (teams made by the legacy seed/bootstrap paths get one the first time they're listed).
- `pending_invites` lists the open invites addressed to one of the user's **verified** addresses, in teams that exist and that the user isn't already in. Accept one with `POST /api/invites/accept {invite_id}` (no token needed).

`401 UNAUTHENTICATED` without a valid credential.

### `GET /api/me`

Kept for the existing web board. In accounts mode it returns `/api/account`'s fields plus the legacy `{member, org, boards}` of the chosen team:

- the team named by header `X-Board-Team` (or `Board-Org`), or `?team=` (or `?org=`), which must be one of the user's teams (`404` otherwise),
- else the only team,
- else `409 CONFLICT {orgs:[…]}`.

A user with no team gets `member: null, org: null, boards: []`. The app should use `/api/account`.

### `POST /api/auth/signout`

Bearer or cookie + CSRF. Body `{}`.

→ `{"ok": true}`.

- Bearer: revokes this device token, and its sockets close `4401`.
- Cookie: revokes the session and clears the cookie.

### `GET /api/account/devices`

Bearer or cookie.

→ `{"devices": [ {id, name, client:'buddy_desktop', platform, form_factor, created_at, last_seen_at, current} ]}`: the live devices, where `current` marks the caller's own device.

### `DELETE /api/account/devices/:id`

Bearer or cookie + CSRF. Body `{}`.

→ `{"ok": true}`. The token dies at once, and that device's sockets get `session.revoked` and close `4401`.

`404 NOT_FOUND` when the id is not one of the caller's live devices.

### `DELETE /api/account`

Bearer or cookie + CSRF.

Body `{"flow_id": "…"}`: a step-up this user completed **within the last 5 minutes**, not used before. Either:

- an email flow: `start {purpose:'delete'}`, the code from the mail, `verify {flow_id, code}`, then `DELETE /api/account {flow_id}`; or
- a Google/GitHub re-authentication **from this same device token**: `POST /api/auth/oauth/start {purpose:'delete', …}` with the Bearer, the provider, `exchange` (→ `{stepup_until}`), then `DELETE /api/account {flow_id}` with the OAuth `flow_id` (or no `flow_id`: the newest open OAuth step-up of this device is used).

The step-up is spent in the deletion's own transaction: a refused deletion (`409 CONFLICT` below) leaves it unspent until `stepup_until`.

→ `{"ok": true}`. In one transaction the hub:

- revokes every device token (their names, platforms and last IP prefixes are cleared) and deletes the web sessions,
- deletes the sign-in identities and pending flows,
- withdraws pending invites addressed to any of the user's addresses, and replaces the address on every invite they accepted or that names them with `deleted:<invite id>`,
- turns the user into a tombstone ("Deleted user", no email),
- removes the user from every team, with the member rows renamed "Deleted user" and their email cleared,
- revokes those members' runner devices.

Afterwards no table holds the address (audit rows only ever carry a keyed hash of it). Cards, comments and journal entries stay with their teams, attributed to "Deleted user". Open sockets close `4401`, and (with a mailer) a confirmation mail goes to the old address. Signing in again later with that address creates a new, empty account.

Errors:

- `401 STEP_UP_REQUIRED {max_age_s: 300, purpose: 'delete'}`: no fresh verified delete flow.
- `409 CONFLICT {sole_owner_of: [{id, name}]}`: the user is the only owner of a team that has other members.

Teams where the user was the only member are soft-deleted with the account (see `DELETE /api/teams/:id`), and their integrations are revoked.

**Without a mailer** the step-up is the Google/GitHub re-authentication. With neither a mailer nor a configured provider a user can't delete their account or team from the app; the hub logs a warning at start when it has users and neither. The operator erases on the hub host, with the hub's environment:

```sh
node hub/admin.js delete-user <email>   # the same transaction as DELETE /api/account, no step-up
node hub/admin.js delete-team <slug>    # the same as DELETE /api/teams/:id
```

It opens the database file directly and refuses when there is none (not the hub host) or the hub isn't `BOARD_AUTH=accounts`. Stop the hub first, or rely on its 5 s SQLite `busy_timeout`; a running hub's open sockets close at their next credential check. Audit rows record `by: "operator"`. Not yet (P5): stopping the user's active runs, purging those teams, and "also erase my comments".

### `/ws/board` (WebSocket)

- The upgrade authenticates `Authorization: Bearer <device_token>` (injected by main) or the session cookie. A cookie upgrade also needs a same-origin `Origin`.
- With no credential, or an unknown or revoked one, the upgrade gets a plain **HTTP `401`** and no socket opens. A foreign `Origin` gets HTTP `403`.
- `welcome {protocol, hub_epoch, member, user:{id, display_name}}`: `member` is `null` until you `subscribe` to a board. The member is resolved per subscription from the user's live teams, so one socket can move between teams' boards.
- `subscribe` to a board of a team you're not in → `error {code:'NOT_FOUND'}`. The socket stays open.
- Revocation (sign-out, device revoke, account deletion) → frame `session.revoked {}` then close `4401`. Removal from a team closes a socket subscribed there with `4403`.

The design's WS ticket and `Sec-WebSocket-Protocol` options are not built: the injected header covers the app, and a browser has its cookie.

### Pages (no auth)

| Path | What |
|---|---|
| `GET /signin` | minimal email → code sign-in page (client `web`) |
| `GET /auth/email` | the same page; handles `#f=<flow_id>&c=<code>` magic links |
| `GET /invite` | the invite landing page (see Invites) |
| `GET /download` | `302` to `BOARD_DOWNLOAD_URL` (the app download), or `404` when none is configured |

All static pages send `Referrer-Policy: no-referrer`. Every hub response forbids framing (`X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`), and with an https `BOARD_PUBLIC_URL` it sends `Strict-Transport-Security: max-age=31536000`.

## OAuth sign-in: Google and GitHub (desktop loopback + PKCE)

For the desktop app. The app listens on `http://127.0.0.1:<port>/callback` (any port 1024–65535), makes a PKCE verifier (43–128 characters) and its S256 challenge, and:

1. `POST /api/auth/oauth/start` (no auth for sign-in):

   ```json
   { "provider": "google", "code_challenge": "<base64url sha256, 43 chars>", "redirect_uri": "http://127.0.0.1:53682/callback",
     "device_name": "Jo's MacBook Pro", "platform": "darwin-arm64", "client": "buddy_desktop", "purpose": "signin" }
   ```

   → `{"flow_id": "…", "url": "https://accounts.google.com/…", "state": "<43 chars>", "expires_in": 600}`. `provider`: `'google'` or `'github'`. `redirect_uri` must match `^http://127\.0\.0\.1:(\d{4,5})/callback$` with port 1024–65535, exactly (no query, no other host, not `localhost`); anything else `400 VALIDATION`. `client` is `'buddy_desktop'` (the default). `device_name` (≤ 100) and `platform` (≤ 50) are optional and name the device token a sign-in makes; step-ups need neither. `purpose`: `'signin'` (default), `'delete'` or `'delete_team'` (the step-ups: they need the Bearer, `401 UNAUTHENTICATED` without one).
2. Open `url` in the browser. The provider sends the browser to the loopback listener with `?code&state`. **Compare `state` with the one `start` returned (constant time)**; on a mismatch, stop.
3. `POST /api/auth/oauth/exchange` (a step-up sends the same Bearer as its start):

   ```json
   { "flow_id": "…", "code": "<from the redirect>", "state": "<from the redirect>", "code_verifier": "<the PKCE verifier>", "form_factor": "laptop" }
   ```

   → sign-in: the same body as email verify, `{"user": {…}, "teams": […], "device_token": "bdt_…", "device_id": "…"}`. → step-up: exactly `{"stepup_until": "2026-10-01T12:05:00.000Z"}` (no token, user or teams); then `DELETE /api/account` or `DELETE /api/teams/:id` with this `flow_id` (see those routes).

Rules:

- **One attempt per flow.** The hub checks everything it holds (the flow exists, unused, unexpired (10 minutes), from the same network (/24, IPv6 /48) as its start, `state`, the verifier against the challenge, and for a step-up the same user and device token) and then burns the flow before it calls the provider, whether the checks passed or not. A provider failure never reopens it: start again.
- Google: the hub exchanges the code with the stored `redirect_uri` and the verifier, and verifies the `id_token` (signature against Google's keys, issuer, audience, expiry, the nonce it minted, `email_verified: true`). GitHub: the hub exchanges the code, then reads `/user` and `/user/emails` and uses the address that is **primary and verified**. The provider's tokens are thrown away at once: never stored, logged or audited, and no refresh token is ever asked for.
- Accounts: the same Google/GitHub account always signs in to the same user (keyed by the provider's account id, never the address; a GitHub login rename changes nothing). A first sign-in whose verified address already belongs to an account (an email-code sign-in, the other provider, or the account's address) **joins that account**; otherwise it creates one (sign-up = sign-in). Member rows an admin added with that address join too (as for email codes). A GitHub id an admin typed in the Access era never counts as proof of anything.
- A step-up must be the account's **own** Google/GitHub identity (one listed in `GET /api/account` `identities`), from the device token that started it. Anything else is the generic `400 INVALID_TOKEN`, never a `401` (a `401` means only a bad or missing Bearer, and the app signs out on it).

Errors:

| Answer | When |
|---|---|
| `400 VALIDATION` | bad `provider`, `purpose`, `client`, `code_challenge` or `redirect_uri` (start); bad `form_factor` (exchange) |
| `400 INVALID_TOKEN` | any flow problem (unknown, used, expired, another network, wrong `state` or verifier, a `redirect_uri` or `provider` in the body that differs), an id_token that fails a check, a step-up by another identity or device. One generic answer |
| `401 UNAUTHENTICATED` | a step-up start without a valid Bearer |
| `403 EMAIL_UNVERIFIED` | the Google account's address isn't verified, or the GitHub account has no primary verified address |
| `404 METHOD_DISABLED` | that provider isn't configured on this hub |
| `429 RATE_LIMITED` | see Rate limits (starts, open flows, exchanges, failure budget) |
| `502 PROVIDER_ERROR` | the provider refused the code (reused, expired, or the verifier didn't match at the provider) |
| `503 PROVIDER_UNAVAILABLE` | the provider (or Google's signing keys) couldn't be reached; start again later |

Audit rows: `auth.oauth.start`, `auth.oauth.failed` (`reason`), `auth.signin` (`method`, and `subject_ref`, a keyed hash of the provider account id), `identity.link`, `user.create`, `auth.stepup`. Never the code, state, verifier, tokens or an address.

## Routes built in P2: teams and members

### Which team a request acts in

Membership is resolved from the **resource in the URL**, never from a "current team" (CONTRACT D61):

- `/api/teams/:id/…`, `/api/boards/:id/…`, `/api/cards/:id/…`, `/api/permission-requests/:id/…`, `/api/devices/:id`: the team that owns that id. If the user isn't a live member of that team, the id doesn't exist, or the team was deleted, the answer is **`404 NOT_FOUND`**, never `403`, so a foreign id and a made-up one look the same.
- Routes without an id (`GET /api/me`, `GET|POST /api/repos`, `GET|POST /api/devices`): the team named by header `X-Board-Team: <team_id>` (or `Board-Org`) or query `?team=` (or `?org=`); else the user's only team; else `409 CONFLICT {orgs}`. A named team the user isn't in → `404`.
- A header or query naming a team **and** a URL id in a different team → `404`.
- Inside a team, a role that may not do something gets `403 FORBIDDEN` (the member already knows the thing exists).

The `/ws/board` socket works the same way: each `subscribe {board_id}` picks the membership in that board's team.

### Roles

`owner` > `admin` > `member` > `viewer` (the full matrix is `hub/permissions.js`, CONTRACT D60):

| | owner | admin | member | viewer |
|---|---|---|---|---|
| read the team, its boards, cards, journal, member names | ✓ | ✓ | ✓ | ✓ |
| member emails | ✓ | ✓ | | |
| create / edit cards, comment, dispatch, answer | ✓ | ✓ | ✓ | |
| rename the team, add boards, repos; change roles; remove members; invite | ✓ | ✓ | | |
| make or unmake owners, remove an owner, delete the team | ✓ | | | |
| leave (remove yourself) | ✓ | ✓ | ✓ | ✓ |

The **last owner** can't be demoted or removed, and can't leave (`409 CONFLICT {reason:'LAST_OWNER'}`; a database trigger enforces it too). Make someone else owner first.

### Quotas (free plan)

| Resource | Limit | Error |
|---|---|---|
| teams a user owns | 10 | `403 QUOTA_EXCEEDED {resource:'teams', limit:10}` |
| boards per team | 10 | `403 QUOTA_EXCEEDED {resource:'boards', limit:10}` |
| members per team (pending invites count) | 25 | `403 QUOTA_EXCEEDED {resource:'members', limit:25}` |
| team creations | 3 a day per user | `429 RATE_LIMITED` |

`pro` teams get ×10; teams that existed before accounts are `self_hosted` (no limits).

### `POST /api/teams`

Bearer or cookie + CSRF. The user's email must be verified (`403 EMAIL_UNVERIFIED` otherwise).

```json
{ "name": "Acme Rockets", "slug": "acme" }
```

- `name`: 1–60 characters, no control characters (whitespace runs collapse to one space).
- `slug` (optional): 3–40 of `a-z 0-9 -`, not starting or ending with `-`, not reserved (`api`, `admin`, `invite`, …). Taken → `409 CONFLICT`. Without it the hub makes one from the name (`acme-rockets`, then `acme-rockets-2`, …; names that don't slug get `team-<6 hex>`). Slugs never change on rename, and a deleted team's slug stays taken.

→ `{"team": {id, name, slug, plan:'free'}, "board": {id, name, key_prefix}}`. The creator becomes the owner, and one board named after the team is created (key prefix from the name's first letters, e.g. `ACM`).

### `GET /api/teams/:id`

Any member. → `{team:{id, name, slug, plan}, me:{member_id, role}, counts:{members, boards}, quotas:{members, boards}}` (`null` = unlimited).

### `PATCH /api/teams/:id`

Admin. `{name}` → `{team}`.

### `DELETE /api/teams/:id`

Owner. `{"confirm_slug": "<the team's slug>", "flow_id": "…"}` → `{ok:true, purge_after}`. Like `DELETE /api/account`, it needs a **step-up**, which this spends (single use, in the deletion's transaction): either a `purpose:'delete_team'` email flow this user started and verified within the last 5 minutes (`start {purpose:'delete_team'}`, the code from the mail, `verify {flow_id, code}`; an email `'delete'` (account) step-up is refused), or a Google/GitHub re-authentication from this device token (`purpose:'delete'` or `'delete_team'`; no mail is involved, so one purpose serves both deletions), with its OAuth `flow_id` or none. A wrong slug → `400 VALIDATION`; no fresh, unused step-up → `401 STEP_UP_REQUIRED {max_age_s: 300, purpose: 'delete_team'}`.

Soft delete: from that moment every route for the team, its boards and cards answers `404`, it drops out of `/api/account`, runner devices enrolled in it are revoked (their sockets close `4403`), browser sockets subscribed to its boards close `4403`, and its integrations are revoked with their stored secrets erased (their webhooks answer `404`). The hard purge 7 days later is P5 (not built); there is no restore route yet.

### `POST /api/teams/:id/boards`

Admin. `{name, key_prefix?}` (`key_prefix`: 1–10 capital letters) → `{board:{id, name, key_prefix}}`.

### `GET /api/teams/:id/members`

Any member. → `{members:[{member_id, user_id, display_name, role, joined_at, email?}]}`, owners first. `email` only for owners and admins.

### `PATCH /api/teams/:id/members/:member_id`

Admin; changes to or from `owner` need an owner. `{role}` → `{member}`.

### `DELETE /api/teams/:id/members/:member_id`

Admin (an owner only by an owner), or the member themselves (leave). `{}` → `{ok:true}`. The row stays for history (cards and journal keep pointing at it); the member's runner devices in that team are revoked and closed, and their browser sockets on that team close `4403`. The old `POST /api/members` and `DELETE /api/members/:id` are not served in accounts mode.

Every team and member change writes an `audit` row (`team.create`, `team.update`, `team.delete`, `board.create`, `member.role`, `member.remove`, `member.leave`) with `org_id` and `actor_user_id`.

## Routes built in P3: invites

### The link, the page and the app

One universal link per invite: **`https://<hub>/invite#<token>`**, with `token` = `inv_` + 43 base64url characters (32 random bytes). The token is in the URL **fragment**, so it never reaches the hub, its logs, Cloudflare's logs or a `Referer`; it is stored only as its sha256.

The hub serves `/invite` as a static page (`Referrer-Policy: no-referrer`). Its script reads the fragment, removes it from the address bar, POSTs `/api/invites/preview {t}`, and shows "*Jo* invited you to join *Acme* as a member". It then tries the desktop app:

1. **`plexiform://invite/<token>`** at once,
2. if the page is still in front 1.5 s later, it shows **"Open with older Buddy"**; only a click on it sends the token to the legacy scheme **`claudebuddy://invite/<token>`** (older builds register only that one, and any app could claim it, so the token never goes there on its own). A malformed fragment shows the generic "not valid" message,

and always shows **"Open in Plexiform"** (the `plexiform://` link) and **"Download Plexiform for Mac"** (`/download`, which redirects to `BOARD_DOWNLOAD_URL`), with the steps: install, open (the app isn't signed by Apple yet: right-click or Control-click it in Applications, choose Open, then Open again), sign in with the invited address, then click the invite link in the email again.

**The app**: register `plexiform://` (and keep `claudebuddy://` as an alias). On `plexiform://invite/<token>`, call preview to show who invited whom, then `POST /api/invites/accept {t}` with the Bearer token. If the user isn't signed in yet, sign in first and keep the token in memory (not on disk) until then.

The invite mail (plain text) carries the team and inviter names, the link, an 8-letter **code** (`XXXX-XXXX`, for typing into the app instead of clicking), the expiry, and "You got this because *name* invited *address*. Ignore it to decline." Names are made safe: no control characters, quotes or angle brackets, one line, ≤ 60 characters, schemes stripped and domains defanged (`evil[.]com`), so the only link in the mail is the hub's.

### Rules

- Only owners and admins invite, as `admin`, `member` or `viewer`, **never above their own role and never as `owner`** (`403 FORBIDDEN`; make someone owner after they join). The inviter's email must be verified (`403 EMAIL_UNVERIFIED`).
- One invite per address per team at a time: a second → `409 CONFLICT {invite_id}` (resend the first instead). An address already in the team → `409 ALREADY_MEMBER {team:{id, name}}`.
- 7 days, single use. Acceptance needs a signed-in user whose **verified** email is the invite's.
- The inviter's role is checked again at preview and accept: if they have since been removed or demoted below the invite's role, the invite answers `INVALID_TOKEN` (it works again if the role comes back).
- Removing the inviter, deleting the team, or deleting the inviter's account withdraws their unused invites.
- Quotas: active members **plus pending invites** ≤ 25 per team (free), pending invites ≤ 100 (`403 QUOTA_EXCEEDED`). Rate limits: invites sent (create + resend) 20 a day per team, 50 a day per user, 50 an hour per IP; preview 30 per 10 min per IP; accept 30 per 10 min per IP and per user (`429`).
- Every step is audited: `invite.create`, `invite.resend`, `invite.revoke`, `invite.accept`, `invite.accept.wrong_account`.

### `POST /api/teams/:id/invites`

Admin. `{email, role}` (`role` defaults to `member`) → `{"invite": {id, email, role, expires_at}, "link": "https://<hub>/invite#inv_…", "code": "BCDF-GHJK", "mailed": true}`. The link and the code are shown **once** (the hub can't show them again). With a mailer the invite mail goes out at the same time (`mailed: true`); without one (D66) nothing is sent (`mailed: false`) and the app lets the inviter copy the link or code, or open a prefilled `mailto:` draft. Either way only the invited address can accept: a link forwarded to anyone else answers `WRONG_ACCOUNT`.

### `GET /api/teams/:id/invites`

Admin. → `{invites:[{id, email, role, expires_at, created_at, created_by_name}]}`: pending ones only, never tokens.

### `DELETE /api/teams/:id/invites/:invite_id`

Admin. `{}` → `{ok:true}`. The token dies at once. An unknown, used or already withdrawn invite → `404`.

### `POST /api/teams/:id/invites/:invite_id/resend`

Admin (the same role ceiling). `{}` → `{invite, link, code, mailed}`: a **new** invite id, token and code, a fresh 7 days and (with a mailer) a new mail; the old token and code die. Works for an expired invite too.

### `POST /api/invites/preview`

**No auth.** `{t}` → `{team_name, inviter_first_name, role}` and nothing else (never the invited address). Any token that is malformed, unknown, used, expired, withdrawn or for a deleted team gets the same `400 INVALID_TOKEN`. POST only: there is no GET form with the token in the URL.

### `POST /api/invites/accept`

Bearer or cookie + CSRF. One of:

- `{t}`: the token from the link;
- `{invite_id}`: an id from `GET /api/account` `pending_invites`;
- `{code}`: the `XXXX-XXXX` code from the mail (case and the dash don't matter).

→ `{"team": {id, name, slug, plan}, "member": {member_id, role}}`. The user joins with the invite's role; a user who was in the team before and was removed gets their old member row back (history stays attached).

| Answer | When |
|---|---|
| `200` (same body again) | the same user accepts the same invite again (idempotent) |
| `400 INVALID_TOKEN` | the token is malformed, unknown, used by someone else, expired, withdrawn, or its team was deleted; with `invite_id`/`code`, also any invite not addressed to one of **your** verified addresses (so ids and codes reveal nothing) |
| `403 WRONG_ACCOUNT {email_masked}` | a valid token addressed to someone else, e.g. `c•••@example.com`: sign in with that address |
| `409 ALREADY_MEMBER {team:{id, name}}` | you are already in that team |
| `403 QUOTA_EXCEEDED` | the team is full |

`POST /api/account/invites/:invite_id/accept` (body `{}`) is the same as `{invite_id}` in the body.

## Routes built in P4: runner enrolment

An install of the desktop app (its device token) enrols as a runner in one team at a time and gets a **runner token** for that team only. Revoking the runner never signs the app out; signing the app out (or revoking the install from another device) ends its runner enrolments.

### `POST /api/teams/:id/enrol`

Bearer (the desktop device token; a cookie session gets `403`). Role member or above (a viewer gets `403 FORBIDDEN`). `{"device_name": "Jo's MacBook Pro"}` (optional, ≤ 100; defaults to the install's name).

→ `{"enrollment_id": "…", "team_id": "…", "runner_token": "brt_…"}`. `runner_token` is `brt_` + 43 base64url characters, **shown once** (the hub keeps only its sha256). Enrolling the same install in the same team again **rotates**: a new token, and the old one stops working at once (its runner socket closes `4403`); the runner keeps its hub-side device and outbox sequence.

Caps: 5 active enrolments per person per team, 20 per person (`403 QUOTA_EXCEEDED {resource:'runner_enrollments', limit}`); 30 enrolments an hour per person (`429`).

### `DELETE /api/teams/:id/enrol`

Bearer. `{}` → `{ok:true}`: this install stops being a runner in this team; its runner socket closes `4403`. The app stays signed in. `404` when this install isn't enrolled there.

### `GET /api/teams/:id/enrolments`

Any member: admins and owners see the team's enrolments, others their own. → `{"enrolments": [ {id, user:{id, display_name}, name, created_at, last_seen_at, revoked_at, online, current} ]}`, newest first (at most 200), revoked ones included (`revoked_at` set). `current` marks the caller's own install; tokens are never shown again.

### `DELETE /api/teams/:id/enrolments/:enrollment_id`

An admin or owner, or the enrolment's own user. `{}` → `{ok:true}`; its socket closes `4403`. Unknown, revoked or another team's → `404`; someone else's as a member → `403`.

### The runner socket

`/ws/runner` with `Authorization: Bearer brt_…` and `Board-Team: <team_id>`, one socket per enrolled team:

- An unknown token, no `Board-Team`, a `Board-Team` that isn't the enrolment's team, or any Bearer that isn't a runner token (an old device token, the app's own `bdt_`): close `4401`, all with the same reason (a token for team A never reveals anything about B). Accounts mode has no `POST /api/devices`; runners only enrol.
- The install signed out or revoked, the account deleted, or a hub restore: close `4401`. Enrolment revoked (by the user, an admin or rotation), removed from the team, demoted to viewer, or the team deleted: close `4403`. These are re-checked on every reaper pass (≈ 1 s) as well as when they happen, so a live socket closes within a second; a runner that gets `4401`/`4403` does not reconnect.
- `hello` may send `device_id: ""`; `welcome` names the runner device (`device_id`) and member (`member_id`). The socket is bound to its team for life: offers, allowlist and commands are that team's only, and frames that name another team's card, run or repo are refused.

The app's runner process gets `{"type": "runner.config", "hub_url": "https://…", "runner_token": "brt_…", "team_id": "…", "data_dir": "/abs/path"}` over its parent port (one runner process per enrolled team; no `device_id`, `device_token` or `cf_*` fields with it). It sends the two headers on the WebSocket connect only: never in argv, the environment, a log line or a file. Under Electron the hook shim and the board MCP server it hands to Claude run with `ELECTRON_RUN_AS_NODE=1` (CONTRACT D82).

## Error codes used here

| Code | HTTP | When |
|---|---|---|
| `VALIDATION` | 400 | bad body |
| `INVALID_TOKEN` | 400 | sign-in flow or code unknown, wrong, used, expired or dead (`attempts_left` after a wrong code); an OAuth flow or id_token that fails a check, or a step-up by another identity; an invite token, id or code that is unknown, used, expired, withdrawn or not yours |
| `UNAUTHENTICATED` | 401 | no, unknown or revoked credential |
| `STEP_UP_REQUIRED` | 401 | `DELETE /api/account` or `DELETE /api/teams/:id` without a fresh, unused step-up: an email flow of its purpose, or a Google/GitHub re-authentication from this device (`max_age_s`, `purpose`: `'delete'` / `'delete_team'`) |
| `FORBIDDEN` | 403 | cross-origin request, a cookie mutation without a valid `X-CSRF-Token`, or a role that may not do this in a team the user is in |
| `EMAIL_UNVERIFIED` | 403 | creating a team, or inviting, without a verified email |
| `WRONG_ACCOUNT` | 403 | a valid invite token for another address (`email_masked`) |
| `QUOTA_EXCEEDED` | 403 | a plan limit, or the runner enrolment caps (`resource`, `limit`) |
| `NOT_FOUND` | 404 | unknown route, or a resource (or team header) outside the user's live teams |
| `METHOD_DISABLED` | 404 | an email-code route on a hub without a mailer (D66), or an OAuth route for a provider this hub hasn't configured |
| `CONFLICT` | 409 | deleting the only owner of a team with members (`sole_owner_of`); several teams and no `X-Board-Team` on `/api/me`; the last owner (`reason:'LAST_OWNER'`); a taken slug; a second pending invite for one address (`invite_id`) |
| `ALREADY_MEMBER` | 409 | inviting, or accepting an invite, for someone already in the team (`team`) |
| `CONFIRM_REQUIRED` | 428 | magic link opened in a different browser (`email_masked`) |
| `RATE_LIMITED` | 429 | see Rate limits (`retry_after_s`) |
| `PROVIDER_ERROR` | 502 | Google or GitHub refused the sign-in code |
| `PROVIDER_UNAVAILABLE` | 503 | Google or GitHub (or Google's signing keys) couldn't be reached |
