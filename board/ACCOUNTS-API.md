# Plexiform accounts API (hub `BOARD_AUTH=accounts`, P1–P4)

For the desktop app builder. What exists today: P1 sign-in (email codes, and Google/GitHub through the desktop loopback), P2 teams and members, P3 invites, P4 runner enrolment. Decisions: CONTRACT.md D50–D82; background: ACCOUNTS-DESIGN.md (where the two differ, this file and the D-decisions win).

The product name is **Plexiform** (`shared/brand.js`). Only user-facing text uses it; technical names keep `buddy` for now (the `__Host-buddy_*` cookies, the `bdt_` token prefix, `BOARD_*` env vars, route paths).

## Conventions

- JSON in and out. Every response has header `Board-Protocol: 1`. Mutations need `Content-Type: application/json`. A body is read only after the route's credential is checked, is at most 64 KiB on these routes (`413 PAYLOAD_TOO_LARGE`) and must arrive within 20 s (`408 TIMEOUT`) (CONTRACT D105).
- Errors: `{"error": {"code": "<CODE>", "message": "…", …extra}}`. The HTTP status comes from the code (table at the end). `429` responses also send `Retry-After: <s>` and `error.retry_after_s`.
- `request_id` (uuid) is optional on the account routes. When present on a mutation, a repeat within 10 minutes replays the first answer (header `Board-Replayed: 1`). Creating or resending an invite is the exception: its answer holds a link and code shown once, so a repeat answers `409 CONFLICT {reason:'REPLAYED'}` "This invite was already made. Resend it to get a new link." and the replay cache never holds them; the apps offer Resend.
- Automatic account setup and client routes always evaluate current authority and return a fresh answer instead of using that response cache. Client workspace creation uses its durable request record; client invite acceptance uses its accepted invite record. Neither replays withdrawn access or a secret invitation link.
- The dedicated client artifact upload accepts an 8 MiB file encoded as JSON base64 (body ceiling 11,188,908 bytes). At most four uploads across the hub may read, decode or wait for their board queue at once; other uploads return `429` with a one-second retry hint. Authentication, CSRF and admin/item checks precede body reading. Ordinary account/client mutations retain 64 KiB bodies.
- Timestamps are ISO-8601 UTC strings.

## Sign-in methods and mail (D66)

The hub sends **no mail unless a mailer is configured**, and none is required. Sign-in is meant to be Google or GitHub (see "OAuth sign-in" below); the email one-time code exists only on a hub with a mailer (`BOARD_RESEND_API_KEY` + `BOARD_MAIL_FROM`, or `BOARD_MAIL_PROVIDER=ses` with the `BOARD_SES_*` settings: `hub/README.md`).

### `GET /api/auth/methods`

**No auth**, rate limited (60 a minute per IP). → `{"google": true, "github": true, "email": false}`: booleans only, so the app shows the right sign-in buttons. `google`/`github` are true when the hub has that provider's client id **and** secret (`BOARD_GOOGLE_CLIENT_ID`/`_SECRET`, `BOARD_GITHUB_CLIENT_ID`/`_SECRET`); `email` is true only when the hub has a mailer and its last 5 background sends have not all failed; the next send that succeeds turns it back on. Only this flag changes: the email routes stay open, so someone mid-flow still verifies and a new start may still try (`GET /api/health` `mail.failing` says the same).

Without a mailer:

- `POST /api/auth/email/start` and `/verify` answer `404 METHOD_DISABLED` (nothing is written, nothing printed, no code exists). Deleting an account or a team then needs the Google/GitHub re-authentication step-up (below); with neither a mailer nor a provider, only the operator can erase (`hub/admin.js`).
- Invites are still created and still bound to the invited address, but the hub sends nothing: the inviter gets the link and the code once and shares them (copy, or a prefilled `mailto:` draft in their own mail client). See `POST /api/teams/:id/invites`.

An exposed hub (a `BOARD_PUBLIC_URL` off loopback, or a tunnel probe) must be https, behind cloudflared with `BOARD_TRUST_CF_IP=1`, and have at least one sign-in method (a configured Google or GitHub client, `BOARD_SIGNIN_METHODS`, or a mailer); it never uses the console mailer.

### Sign-up control (D104)

Who may make a **new** account. `BOARD_SIGNUP=allowlist` (the default in accounts mode) or `open` (any verified address, as before D104). With `allowlist`, a new account is made only for a verified address that `BOARD_SIGNUP_ALLOW` lists (a comma list of `domain:<domain>` and `email:<address>`, folded like stored addresses: NFKC, trimmed, lower case; a `domain:` entry matches that exact domain only, never a sub-domain or a longer name, so `domain:example.com` does not admit `a@evilexample.com`, `a@example.com.evil.com` or `a@sub.example.com`), or that holds a pending invite still good to accept (the invite is the allowlist for its address), or that an admin or `BOARD_BOOTSTRAP` gave a member row not yet linked to an account. An empty list is invite-only (one warning at start-up). Existing accounts sign in on every path as before. The address that counts is the one the sign-in proved: an email code's, GitHub's verified primary, or a Google address Google is authoritative for (D83; a non-authoritative Google address never qualifies, not even with an invite). **GitHub never qualifies through a `domain:` entry**: its verified primary may be a mailbox the person lost years ago, so a new GitHub account needs an `email:` entry for that exact address, a usable invite, or an unlinked member row.

- **Email code start** for a new address that may not sign up: the same `200 {flow_id, expires_in}`, no mail, a dud flow (as for a silenced start), and it spends no mail budget and is never a mail failure.
- **Verify** re-checks when it would make the account (the list or the invite may have changed since the start): `403 SIGNUP_CLOSED`, the account is not made and the flow is spent.
- **Google / GitHub** for a new user who may not sign up: `403 SIGNUP_CLOSED`, no account, identity or token.

**Invited accounts don't spread.** A new account records what let it in (`users.signup_via`: `allowlist`, `member_row`, `invite`, or `open` when `BOARD_SIGNUP=open`; accounts from before this are `NULL` and count as `allowlist`). It is set when the account is made and never changes. While `BOARD_SIGNUP=allowlist`, an account that only an invite let in (`invite`) may accept invites and be in any number of teams, but `POST /api/teams` answers it `403 FORBIDDEN` "Only team owners invited by the hub administrator can create teams while sign-up is invite-only", so it never owns a team it could invite more newcomers into. With `open` everyone may create teams.

`SIGNUP_CLOSED`'s message is always "Sign-up is invite-only right now. Ask a team owner for an invite.": it names the mode, never the list. The list is never in an answer, a log line or the database. Audit: `auth.signup.refused` (`method`; `email_ref` or `subject_ref`, keyed hashes).

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
| OAuth flows open at once, per IP (IPv6 /64) | 10 | `429` (`retry_after_s` = until the oldest expires) |
| OAuth exchange, per IP (IPv6 /64) | 30 / h | `429` (no other lockout: each flow is single use) |
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

Errors: `400 VALIDATION` (bad email, bad client), `401 UNAUTHENTICATED` (a delete flow while signed out), `404 METHOD_DISABLED` (no mailer on this hub), `429 RATE_LIMITED`. A new address that may not sign up (D104) gets the ordinary `200`, and no mail.

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
- **The linking trade-off.** An address is the only thing that ties such a pre-made member row (or an invite) to a person. If an admin typed the wrong address, whoever proves that address (by a code sent to it, or by a Google account authoritative for it: Workspace `hd` = its domain, or Gmail) gets that membership. Addresses are compared in one canonical form (NFKC-folded, trimmed, lower-cased with full Unicode). Only an email identity (a code sent to the address), an authoritative Google identity, or a primary address one of those set proves an address; a GitHub identity never does (D83).
- Magic link (web only): the page at `/auth/email` reads the fragment and POSTs `{flow_id, code, via:'link'}`. A browser without the matching `__Host-buddy_flow` cookie gets `428 CONFIRM_REQUIRED {email_masked:"j•••@example.com"}`, and the page asks "Sign in as j•••@example.com?" before re-POSTing with `confirm:true`. A link scanner's GET only loads the page, because the fragment never reaches the server, so it consumes nothing.
- Errors:
  - `400 INVALID_TOKEN`: one generic answer for an unknown, wrong, used, expired or dead flow. After a wrong code it includes `attempts_left`; a made-up flow_id answers `attempts_left: 5`. A start the limits silenced still has a flow (no mail, and no code matches it), so its tries count down and it dies like any other; it never ends a live flow of the address. Sign-in flows are deleted a day after they expire.
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
- `pending_invites` lists the open invites addressed to one of the user's **verified** addresses, in teams that exist and that the user isn't already in, and that could still be accepted (not one whose inviter may no longer invite as its role). Accept one with `POST /api/invites/accept {invite_id}` (no token needed).

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
- a Google/GitHub re-authentication **from this same device token**: `POST /api/auth/oauth/start {purpose:'delete', …}` (no `team_id`) with the Bearer, the provider, `exchange` (→ `{stepup_until}`), then `DELETE /api/account {flow_id}` with the OAuth `flow_id` (or no `flow_id`: the newest open OAuth step-up of this device is used).

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
| `GET /signin` | minimal email → code sign-in page (client `web`); `#invite=<token>` resumes that explicit join once signed in, then opens the invited team's board. A failed join returns to `/invite#<token>` for recovery. First sign-in with no memberships and no usable invite automatically creates the first team and board; pending invitations are offered for acceptance; creation failures retain Create or join a team |
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

   → `{"flow_id": "…", "url": "https://accounts.google.com/…", "state": "<43 chars>", "expires_in": 600}`. `provider`: `'google'` or `'github'`. `redirect_uri` must match `^http://127\.0\.0\.1:(\d{4,5})/callback$` with port 1024–65535, exactly (no query, no other host, not `localhost`); anything else `400 VALIDATION`. `client` is `'buddy_desktop'` (the default). `device_name` (≤ 100) and `platform` (≤ 50) are optional and name the device token a sign-in makes; step-ups need neither. `purpose`: `'signin'` (default), `'delete'` or `'delete_team'` (the step-ups: they need the Bearer, `401 UNAUTHENTICATED` without one). A team-deletion step-up names its team: `team_id` (required with `'delete_team'`; a `'delete'` step-up with a `team_id` also serves only that team). An account step-up (`'delete'`, no `team_id`) never deletes a team, and a team step-up never deletes the account. Control characters in `device_name`/`platform` are removed.
2. Open `url` in the browser. The provider sends the browser to the loopback listener with `?code&state`. **Compare `state` with the one `start` returned (constant time)**; on a mismatch, stop.
3. `POST /api/auth/oauth/exchange` (a step-up sends the same Bearer as its start):

   ```json
   { "flow_id": "…", "code": "<from the redirect>", "state": "<from the redirect>", "code_verifier": "<the PKCE verifier>", "form_factor": "laptop" }
   ```

   → sign-in: the same body as email verify, `{"user": {…}, "teams": […], "device_token": "bdt_…", "device_id": "…"}`. → step-up: exactly `{"stepup_until": "2026-10-01T12:05:00.000Z"}` (no token, user or teams); then `DELETE /api/account` or `DELETE /api/teams/:id` with this `flow_id` (see those routes).

Rules:

- **One attempt per flow.** The hub checks everything it holds (the flow exists, unused, unexpired (10 minutes), from the same network (/24, IPv6 /48) as its start, `state`, the verifier against the challenge, and for a step-up the same user and device token) and then burns the flow before it calls the provider, whether the checks passed or not. A provider failure never reopens it: start again.
- Google: the hub exchanges the code with the stored `redirect_uri` and the verifier, and verifies the `id_token` (signature against Google's keys, issuer, audience, expiry, the nonce it minted, `email_verified: true`). GitHub: the hub exchanges the code, then reads `/user` and `/user/emails` and uses the address that is **primary and verified**. The provider's tokens are thrown away at once: never stored, logged or audited, and no refresh token is ever asked for.
- Accounts: the same Google/GitHub account always signs in to the same user (keyed by the provider's account id, never the address; a GitHub login rename changes nothing). A first sign-in **joins an existing account by address only when the provider is authoritative for that address**: a Google Workspace account whose `hd` is the address's domain, or a `gmail.com`/`googlemail.com` address. Any other Google address, and every GitHub address (even primary + verified), makes a **separate** account: an address can be recycled, and GitHub or Google verifying it once doesn't prove who holds it now. Such an account gets the address only if no other account has it; an email code or an authoritative Google sign-in for that address later makes its own account and takes the address over. Member rows an admin added with that address join only on an authoritative proof (email code, or authoritative Google). A GitHub id an admin typed in the Access era never counts as proof of anything.
- Invites: an email-code address, an authoritative Google address, or a GitHub primary + verified address may accept an invite addressed to it (an invite is a team admin's deliberate grant to that address; the residual risk is a GitHub account still verified for an address its owner has lost). A non-authoritative Google address may not.
- A step-up must be the account's **own** Google/GitHub identity (one listed in `GET /api/account` `identities`), from the device token that started it. Anything else is the generic `400 INVALID_TOKEN`, never a `401` (a `401` means only a bad or missing Bearer, and the app signs out on it).

Errors:

| Answer | When |
|---|---|
| `400 VALIDATION` | bad `provider`, `purpose`, `client`, `code_challenge` or `redirect_uri` (start); bad `form_factor` (exchange) |
| `400 INVALID_TOKEN` | any flow problem (unknown, used, expired, another network, wrong `state` or verifier, a `redirect_uri` or `provider` in the body that differs), an id_token that fails a check, a step-up by another identity or device. One generic answer |
| `401 UNAUTHENTICATED` | a step-up start without a valid Bearer |
| `403 EMAIL_UNVERIFIED` | the Google account's address isn't verified, or the GitHub account has no primary verified address |
| `403 SIGNUP_CLOSED` | a new user this hub's sign-up control does not admit (D104); no account is made |
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

### `POST /api/account/setup`

Bearer or cookie + CSRF, with the normal mutation origin and rate protections. The desktop and web clients call this after sign-in when an account has no memberships and no usable pending invitation. Returns the same account shape as `GET /api/account`, plus `setup: 'created' | 'existing' | 'invited' | 'client' | 'client_invited'`. Accepted client access or a usable pending client invite prevents personal-team creation, while ordinary pending invitations retain their existing precedence. Setup always rechecks live state and does not replay a cached account response.

One immediate transaction checks current memberships and usable invites before creating anything. Existing members keep their teams; a pending invite that the verified address can accept wins over personal-team creation. Otherwise the ordinary `POST /api/teams` creation path makes **"<first name>'s team"** and its first board, with the caller as owner. The name fits the existing 60-character rule, strips control characters and falls back to `My team` if no first name is available. Concurrent requests from different installs reuse the one first team. The creation audit, verified-email requirement, invite-only newcomer restriction, quotas and per-user creation budget are the same as manual creation; failures write no partial team and clients retain the create-or-join fallback. Account reads and authentication itself remain free of setup mutations.

Opening an explicit invite and signing in resumes acceptance into the inviter's team without a personal team or another Join click. Unsolicited pending invitations still need an acceptance choice. A wrong-account, expired, full or rate-limited invitation retains its existing recovery flow and never falls through to personal setup.

### `POST /api/teams`

Bearer or cookie + CSRF. The user's email must be verified (`403 EMAIL_UNVERIFIED` otherwise). While sign-up is `allowlist`, an account an invite let in (`signup_via` `invite`, see Sign-up control) gets `403 FORBIDDEN` "Only team owners invited by the hub administrator can create teams while sign-up is invite-only".

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

Owner. `{"confirm_slug": "<the team's slug>", "flow_id": "…"}` → `{ok:true, purge_after}`. Like `DELETE /api/account`, it needs a **step-up**, which this spends (single use, in the deletion's transaction): either a `purpose:'delete_team'` email flow this user started and verified within the last 5 minutes (`start {purpose:'delete_team'}`, the code from the mail, `verify {flow_id, code}`; an email `'delete'` (account) step-up is refused), or a Google/GitHub re-authentication from this device token that names this team (`purpose:'delete_team'` or `'delete'`, with `team_id` = this team at start), with its OAuth `flow_id` or none. A wrong slug → `400 VALIDATION`; no fresh, unused step-up → `401 STEP_UP_REQUIRED {max_age_s: 300, purpose: 'delete_team'}`.

Soft delete: from that moment every route for the team, its boards and cards answers `404`, it drops out of `/api/account`, runner devices enrolled in it are revoked (their sockets close `4403`), browser sockets subscribed to its boards close `4403`, and its integrations are revoked with their stored secrets erased (their webhooks answer `404`). The hard purge 7 days later is P5 (not built); there is no restore route yet.

### `POST /api/teams/:id/boards`

Admin. `{name, key_prefix?}` (`key_prefix`: 1–10 capital letters) → `{board:{id, name, key_prefix, archived_at:null}}`. Prefixes are unique within a team, including archived boards. Without an explicit prefix the hub derives one from the name and adds letter suffixes when needed (`ALP`, `ALPA`, `ALPB`). An explicit collision is `409 CONFLICT {reason:'PREFIX_TAKEN'}`. The existing total-board quota includes archived boards.

### Board lifecycle and selection

Release 1 boards are **team-wide**: every team role can see every board, including archived boards opened explicitly. No private board grants are introduced here.

| Route | Who | Request / response |
|---|---|---|
| `GET /api/teams/:id/boards?include_archived=1` | any team member | `{boards:[{id,name,key_prefix,archived_at}]}`; active only without the flag |
| `GET /api/boards?include_archived=1` | any member of the selected team | same list; selected by the normal team header |
| `POST /api/boards` | admin of selected team | same creation body and policy as `POST /api/teams/:id/boards` |
| `PATCH /api/boards/:id` | admin | `{name}` → `{board}`; names only, keys remain unchanged |
| `POST /api/boards/:id/archive` | admin | `{}` → `{board}`; idempotent; last active board → `409 CONFLICT {reason:'LAST_ACTIVE_BOARD'}`, active or queued runs → `{reason:'ACTIVE_RUN'}` |
| `POST /api/boards/:id/restore` | admin | `{}` → `{board}`; idempotent |

Archival checks and member mutations share the board queue, and a queued write rechecks archival before it runs. Archived boards leave `/api/me`, `/api/account` team board arrays and other active lists. Explicit snapshots, card details and journal remain readable; card, label, repo-link and lifecycle rename mutations fail `409 CONFLICT {reason:'BOARD_ARCHIVED'}` until restore. Integrations and state-machine facts cannot mutate an archived board. Audit and journal cover `board.create`, `board.rename`, `board.archive`, `board.restore`; the same transaction commits the change. `team.boards {org_id,boards}` pushes the full public board list only to authenticated members of that team.

The bundled web page used by the desktop app has a board switcher and admin Boards controls for New, rename, archive and restore. Switching resets cards, selection, filters, drawer, dialogs, socket and dashboard; late replies from the previous board are ignored. The last active board is remembered separately per team and account in the browser partition. Explicit archived links open read-only.

Each integration connection stores `target_board_id`; admin `PATCH /api/integrations/:id {target_board_id}` accepts only an active board in that connection's team. Existing connections migrate to their original first board; new ones start on the team's first active board. The Integrations view exposes the selection. An archived target **pauses intake** until restored or changed, without moving new work to another board. The compatibility helper `ctx.boardIds()[0]` respects the selected target; `ctx.boards()` omits archives.

Migration **029** adds archival, prefix uniqueness and the connection target. A legacy duplicate prefix refuses the migration before persistent schema changes, without rewriting any card, journal, run or external link. Preview affected board IDs and card counts with **`node hub/board-prefix-audit.js <path-to-board.db>`**; the script opens SQLite read-only and prints review options. An empty board can receive an unused prefix after operator review. Boards with cards require a reviewed key/link or forward-allocation repair plan before retrying migration; no automatic rekey is performed.

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

A browser already signed in to the hub (cookie session) doesn't jump to the app: the page offers **"Join *team*"** right there (`POST /api/invites/accept {t}` with the session's CSRF token, then the team's board), with the app as a second choice; signed in as another address it says so and offers to sign out and sign in with the right one. Signed out, on a hub with email codes, **"Join in your browser"** opens `/signin#invite=<token>` (the fragment again), which accepts that explicit invite once signed in and opens the invited team; failures come back to `/invite#<token>` for recovery. The page always shows **"Open in Plexiform"** (the `plexiform://` link) and, signed out, **"Download Plexiform for Mac"** (`/download`, which redirects to `BOARD_DOWNLOAD_URL`), with the steps: install, open (the app isn't signed by Apple yet: right-click or Control-click it in Applications, choose Open, then Open again), sign in with the invited address, then click the invite link in the email again.

**The app**: register `plexiform://` (and keep `claudebuddy://` as an alias). On `plexiform://invite/<token>`, call preview to show who invited whom, then `POST /api/invites/accept {t}` with the Bearer token. If the user isn't signed in yet, sign in first and keep the token in memory (not on disk) until then; successful sign-in resumes acceptance without another Join click. A generic sign-in with pending invitations offers them for acceptance and creates no personal team.

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
| `403 WRONG_ACCOUNT` | a valid token addressed to someone else: sign in with that address (the answer names no address, not even masked) |
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
| `WRONG_ACCOUNT` | 403 | a valid invite token for another address (names no address) |
| `SIGNUP_CLOSED` | 403 | a new account the hub's sign-up control does not admit (D104): Google, GitHub, or an email code whose address stopped qualifying after the start; the fixed invite-only text, never the list |
| `QUOTA_EXCEEDED` | 403 | a plan limit, or the runner enrolment caps (`resource`, `limit`) |
| `NOT_FOUND` | 404 | unknown route, or a resource (or team header) outside the user's live teams |
| `METHOD_DISABLED` | 404 | an email-code route on a hub without a mailer (D66), or an OAuth route for a provider this hub hasn't configured |
| `CONFLICT` | 409 | deleting the only owner of a team with members (`sole_owner_of`); several teams and no `X-Board-Team` on `/api/me`; the last owner (`reason:'LAST_OWNER'`); a taken slug; a second pending invite for one address (`invite_id`) |
| `ALREADY_MEMBER` | 409 | inviting, or accepting an invite, for someone already in the team (`team`) |
| `CONFIRM_REQUIRED` | 428 | magic link opened in a different browser (`email_masked`) |
| `TIMEOUT` | 408 | the request body did not arrive within 20 s (D105) |
| `PAYLOAD_TOO_LARGE` | 413 | a body over 64 KiB (D105) |
| `RATE_LIMITED` | 429 | see Rate limits (`retry_after_s`) |
| `PROVIDER_ERROR` | 502 | Google or GitHub refused the sign-in code |
| `PROVIDER_UNAVAILABLE` | 503 | Google or GitHub (or Google's signing keys) couldn't be reached |


## Client workspaces and scoped client access

A client workspace is an ordinary isolated team marked in `client_workspaces` (migration031). Its staff keep the existing owner/admin/member/viewer rules and team-wide board visibility. Agency linkage is metadata only: agency teammates gain no inherited membership. Client guests are separate rows with explicit project grants; they are never ordinary members, viewers, runner targets, integration actors or MCP capabilities.

`GET /api/account` also returns `client_workspaces: [{id,name,mode:'staff'|'client',role?}]` and `pending_client_invites: [{id,workspace_name,inviter_first_name,expires_at}]`. A guest-only account has an empty `teams` array. These account fields, setup and client routes recheck current access. Client routes bypass the general response replay cache, so replay cannot resurrect removed access. Credentials are rechecked after a mutation body arrives, and queued project/publication operations recheck the credential, live admin membership and active board before writing.

| Route | Authority and input | Result |
|---|---|---|
| `POST /api/client-workspaces` | Signed-in, verified user allowed by ordinary team-creation policy; `{request_id,name,agency_team_id?}` | `{workspace:{id,name},projects:[{id,name,board_id}]}`. Team/first board/workspace/project/request row commit atomically. A persistent request ID reuses the same workspace only while the creator still has live access. Ordinary creation rate/owned-team quotas apply. |
| `GET /api/teams/:team_id/client-workspace` | Live workspace owner/admin | Workspace/projects, live client guests and their grants, usable pending invites. Contains guest email only for authorized staff. |
| `POST /api/boards/:board_id/client-project` | Workspace owner/admin; `{name?}` | Idempotently marks an owned active board as a client project. One project per board. |
| `POST /api/teams/:team_id/client-invites` | Verified workspace owner/admin; `{email,grants:[{project_id,scopes}]}` | `{invite:{id,email,grants,expires_at},link,mailed}`. Link shown once; raw token never stored or replay-cached. Shared ordinary/client seat and invitation quotas and invitation rate/mail budgets apply. |
| `POST /api/teams/:team_id/client-invites/:invite_id/resend` | Verified workspace owner/admin; still-usable pending invite | New link; old token revoked atomically. |
| `DELETE /api/teams/:team_id/client-invites/:invite_id` | Workspace owner/admin | Withdraws the link; accepted guest access is revoked through the guest route. |
| `PATCH /api/teams/:team_id/client-guests/:guest_id` | Workspace owner/admin; `{grants:[{project_id,scopes}]}` | Replaces live project grants atomically. |
| `DELETE /api/teams/:team_id/client-guests/:guest_id` | Workspace owner/admin | Revokes client access immediately on subsequent operations. Old accepted links cannot restore it. |
| `POST /api/client-invites/preview` | Public, rate limited; `{t}` | Fixed workspace/inviter names, scope names and expiry only. No project/card contents, guest email or developer data. |
| `POST /api/client-invites/accept` | Signed-in user with invited verified address; `{t}` or `{invite_id}` from own pending list | `{workspace:{id,name}}`. Atomic, same-user retries idempotent while access is still live. Does not create an ordinary membership or a personal team. |
| `GET /api/client/workspaces` | Signed-in user | Own live client workspace catalog. |
| `GET /api/client/workspaces/:workspace_id/projects` | Own workspace staff or explicit client grant | `{workspace,projects:[{id,name,scopes}]}`; guest projection omits internal board IDs. |
| `GET /api/client/projects/:project_id` | Staff board reader or live guest with `status.read` on that project | `{project:{id,name},items:[{id,title,summary,status,updated_at,artifact?,approvals?}]}`. Only expressly published safe fields; artifact metadata requires `artifacts.read`, and a guest sees only their own assigned approval requests. |
| `POST /api/boards/:board_id/client-items` | Workspace owner/admin; `{card_id,title,summary?,status}` | Publishes/upserts a clean client projection of an owned card; no automatic copy of private title/body/repo/logs. Status is `todo`, `in_progress`, `review` or `done`. Archived boards refuse writes. |
| `DELETE /api/client-items/:item_id` | Workspace owner/admin | Stops sharing that item; scoped reads/export omit it immediately. |
| `GET /api/account/client-export` | Signed-in user | Own permitted workspace/status projection plus own guest access/grant history and pending invites; no tokens or unrelated clients' identities. Staff projections retain permitted assigned approval recipient names. |

All mutations require JSON; cookie sessions require same-origin and CSRF. Workspace, invite, acceptance, grant, project and publication bodies reject unknown configuration fields. Grant scopes are the closed set `status.read`, `artifacts.read`, `feedback.create`, `approvals.decide`; each grant must include `status.read`. Those scopes authorize only dedicated client operations, never ordinary board reads/writes, dispatch, permission allowances or deployment. Grants require 1–20 distinct owned projects, and each request is bounded by the normal accounts body limit. Database triggers also reject cross-workspace project/guest/inviter/grant/card links.

Client invitations use `clinv_` plus 32 random bytes, SHA-256 storage and seven-day expiry. They require the issuer's current admin authority and a live workspace on preview/admission/acceptance. Signup admission uses the existing authoritative-email rules: a usable client invite admits an invite-only newcomer, but neither a weak Google address nor an unverified GitHub address becomes authoritative through a link. Verification rechecks admission if an invite is withdrawn while a sign-in code is pending. An invited newcomer retains the restriction against creating further teams/workspaces while signup is invite-only.

The real `/client-invite#<token>` page removes the token from the address bar, previews it and offers explicit acceptance. Browser sign-in carries it only as `/signin#client_invite=<token>` and resumes that explicit acceptance; wrong-account/expired/revoked failures return to the invitation recovery page without creating a team. Generic sign-in finds unsolicited pending client invitations on `/clients` and still asks for acceptance. The desktop’s Open client projects action uses that same `/clients` page in its existing authenticated sandboxed hub partition, with no ordinary guest workspace/member/runner and no renderer token. It works with existing Google/GitHub device sign-in on a hub without email. Browser email-code sign-in retains the existing configured-mailer requirement. The `/clients` page lets staff create a workspace, publish/unpublish selected updates, invite/revoke clients and replace project permissions. Guests see permitted published status without developer tools, and refresh/polling removes revoked projections. Account/team deletion revokes client guests/invites; account deletion scrubs invitation email, and restored databases invalidate old guest cookies/device tokens through the existing credential epoch.

### Immutable deliverables and assigned approvals (migration032)

| Route | Authority and input | Result |
|---|---|---|
| `POST /api/client-items/:item_id/artifacts` | Live workspace owner/admin, published item on active board; `{request_id,name,mime,data_base64}` | New immutable `{artifact}` version. Request ID persists per creating member; an identical retry returns that version after current authority checks, conflicting bytes/item/name/type return `409`. |
| `GET /api/client/items/:item_id/artifacts` | Staff board reader or live guest with `artifacts.read` | Version history, newest first, and permitted assigned approvals. |
| `GET /api/client/items/:item_id/artifacts/:version_id` | Same live artifact authority; version must belong to that exact published item | `{artifact:{id,item_id,version_number,name,mime,byte_length,sha256,created_at,current,content_url}}`. No storage paths, staff IDs, internal board/card/repo data or bearer URLs. |
| `GET /api/client/items/:item_id/artifacts/:version_id/content` | Same live authority on every request, including forwarded URLs | Exact hash-checked bytes with fixed MIME, `attachment`, `nosniff`, no-store and restrictive CSP. PDF and active-content-looking text are never an inline hub-origin preview. |
| `POST /api/client-items/:item_id/approvals` | Live owner/admin on active board; `{request_id,artifact_version_id,guest_ids:[1–25 IDs]}` | `{approval}` bound by server to the current stored version/hash. Every intended recipient must be a live same-project guest with both `artifacts.read` and `approvals.decide`. Identical retries persist; different bindings conflict. |
| `GET /api/client/approvals/:approval_id` | Staff board reader, or live scoped guest explicitly assigned to that request | Exact version/hash, current/superseded/withdrawn state, permitted decisions. A guest sees their own decision only. |
| `POST /api/client/approvals/:approval_id/decision` | Live assigned guest with both scopes; active board/current published version; `{decision:'approve'|'reject',artifact_version_id,sha256,comment?}` | Atomic exact-version decision, derived from the authenticated guest. Identical decision/comment retry is idempotent; changed decision, replaced/withdrawn version, mismatched hash or modified stored bytes conflict. |
| `DELETE /api/client-approval-requests/:approval_id` | Live workspace owner/admin, active published item | Withdraws that exact request. No new client decision can be made. |

Uploads are 1 byte–8 MiB. Name has a matching PNG/JPEG/WebP/PDF/TXT extension and no path/control characters; decoded bytes are checked against the MIME signature or valid UTF-8 text. The hub computes SHA-256 from the actual bytes, stores files under generated opaque IDs outside static roots with exclusive creation and `0600`, and fsyncs before committing metadata. A failed commit removes its file; startup removes only uncommitted opaque orphan files. Free workspaces allow 256 MiB/500 versions total and 50 per item; pro allows 1 GiB/2000 versions and 200 per item. All plans remain finite. Limits are checked inside the board transaction before file/directory writes. Approval history is bounded at 200 requests per item.

New versions supersede earlier approval requests. Historical decisions stay attached to their exact old version and never approve a replacement. Approval does not dispatch an agent, allow tools, deploy or merge. Scope changes, guest/credential/account/team revocation and unpublication block metadata/content/decision routes immediately on the next request, including queued writes. Archived projects retain readable bytes/history but refuse uploads, requests and decisions. Self export includes only live permitted version and own assigned approval projections. Team-owned immutable files/history follow ordinary team content retention when an author deletes their account; their profile is shown as Deleted user.

In the desktop client pane, a user-gesture download from its exact same-origin artifact content route or fixed `/api/account/client-export` route can open a native Save dialog. Main keeps the bearer, re-fetches authorized content after that dialog and checks the current view/credential before saving to the user-selected path. Deliverables require exact byte length/hash verification; self exports require the current own JSON projection and are bounded at 16 MiB. Arbitrary session downloads remain blocked. Operators must retain `client-artifacts/` alongside the database when backing up or restoring deliverables; database-only recovery deliberately refuses unavailable exact bytes rather than accepting an asserted hash. The deployment guide documents the paired directory backup requirement; the existing database-only timer/Litestream copy does not cover artifact bytes.

### Client feedback intake and delivery history (migration035)

Feedback intake is disabled by default. An owner/admin explicitly enables it through their own membership; the server derives that exact delegate, rather than accepting another actor ID. Every new task and persistent retry requires the currently configured delegate's live `card.write` authority, live user/workspace and active project board inside the board queue/transaction. Removal, deletion or demotion to viewer pauses intake. No owner or other staff member is substituted. An admin may explicitly re-enable through their own membership; a change from admin to ordinary member retains the existing writer authority.

| Route | Authority and input | Result |
|---|---|---|
| `GET /api/boards/:board_id/client-feedback-intake` | Live client workspace staff board reader | `{intake:{enabled,active,delegate:{member_id,name,writable}|null}}`. Staff can see the configured paused delegate. |
| `PATCH /api/boards/:board_id/client-feedback-intake` | Live owner/admin on active client project; only `{enabled:boolean}` | Explicitly enables own staff delegation or disables existing intake. Queued configuration rechecks credential/current admin authority. |
| `GET /api/client/items/:item_id/feedback` | Staff board reader or live guest with `feedback.create` on the published item/project | `{feedback,feedback_available}`. Guests see only their own feedback; staff see actual client source, authorizing delegate and internal task link. |
| `POST /api/client/items/:item_id/feedback` | Live scoped guest, published item, active enabled intake and exact live staff delegate; only `{request_id,message}` | `{feedback}` and one linked real To do triage card, committed atomically. Message is 1–4000 characters, plain text. Persistent `(guest_id,request_id)` retries with the same item/message reuse the record after live checks; different input returns `409`. |

The destination is always the source item's project board. Guests cannot name board/card/repo/actor/guest/agent/budget/labels/dispatch fields, call ordinary card APIs or become regular members. The internal transaction-only card insertion helper is not routable. Creation has no repo, assignees, run or dispatch. `cards.created_by` retains the fixed authorizing staff membership, while immutable feedback provenance records the actual guest. Staff card detail and feed separately identify the client source and staff-authorized intake; journal payloads have system actor plus actual guest/user/delegate IDs and no client message/name/email. Later staff edits hash external client card text in the permanent journal. Deleted client identities are shown as Deleted user; team-owned messages/tasks follow ordinary team content retention.

Intake allows ten new feedback tasks per guest per hour and at most 1000 per client project; durable identical retries do not spend the intake rate budget. `409` with reason `CLIENT_INTAKE_PAUSED` means the team must explicitly resume the configured intake; it never chooses a replacement actor. Archived projects permit existing history reads but pause new intake. Current grant/guest/account/team/credential revocation and original item unpublication remove feedback reads/export and prevent retry writes; they are checked again inside queued operations.

Guest feedback projections contain only opaque feedback/item IDs, own message/source name/time, a `staff_authorized` intake flag and any explicitly published clean follow-up update/history. They contain no private triage card/board/repo/member IDs or other clients' messages. Internal task state, private text and run events never automatically publish. Staff shares follow-up progress through the existing clean client-item publication controls. Published status items include `history:[{id,title,summary,status,created_at}]`, retaining the last 50 changed staff-published snapshots per item. Unpublished items and their delivery history are absent from client projections. Own export includes current permitted history and feedback, with authorized staff retaining their ordinary project-wide projections.
