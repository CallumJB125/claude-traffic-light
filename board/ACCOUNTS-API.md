# Plexiform accounts API (hub `BOARD_AUTH=accounts`, P1–P3)

For the desktop app builder. What exists today (P1 sign-in, P2 teams and members, P3 invites), and the P4 routes that are planned but **not built yet**. Decisions: CONTRACT.md D50–D66; background: ACCOUNTS-DESIGN.md (where the two differ, this file and the D-decisions win).

The product name is **Plexiform** (`shared/brand.js`). Only user-facing text uses it; technical names keep `buddy` for now (the `__Host-buddy_*` cookies, the `bdt_` token prefix, `BOARD_*` env vars, route paths).

## Conventions

- JSON in and out. Every response has header `Board-Protocol: 1`. Mutations need `Content-Type: application/json`.
- Errors: `{"error": {"code": "<CODE>", "message": "…", …extra}}`. The HTTP status comes from the code (table at the end). `429` responses also send `Retry-After: <s>` and `error.retry_after_s`.
- `request_id` (uuid) is optional on the account routes. When present on a mutation, a repeat within 10 minutes replays the first answer (header `Board-Replayed: 1`).
- Timestamps are ISO-8601 UTC strings.

## Sign-in methods and mail (D66)

The hub sends **no mail unless a mailer is configured**, and none is required. Sign-in is meant to be Google or GitHub (the OAuth phase comes next); the email one-time code exists only on a hub with a mailer (`BOARD_RESEND_API_KEY` + `BOARD_MAIL_FROM`).

### `GET /api/auth/methods`

**No auth**, rate limited (60 a minute per IP). → `{"google": false, "github": false, "email": true}`: booleans only, so the app shows the right sign-in buttons. `google`/`github` follow `BOARD_SIGNIN_METHODS`; `email` is true only when the hub has a mailer.

Without a mailer:

- `POST /api/auth/email/start` and `/verify` answer `404 METHOD_DISABLED` (nothing is written, nothing printed, no code exists). The email step-up for deleting an account or a team is then unavailable too, until the OAuth phase adds a re-authentication step-up.
- Invites are still created and still bound to the invited address, but the hub sends nothing: the inviter gets the link and the code once and shares them (copy, or a prefilled `mailto:` draft in their own mail client). See `POST /api/teams/:id/invites`.

An exposed hub (a `BOARD_PUBLIC_URL` off loopback, or a tunnel probe) must be https, behind cloudflared with `BOARD_TRUST_CF_IP=1`, and have at least one sign-in method (`BOARD_SIGNIN_METHODS` or a mailer); it never uses the console mailer.

## Credentials

There are two, and only two, credentials.

### Desktop: a per-install device token (Bearer)

- `POST /api/auth/email/verify` with `client:'buddy_desktop'` returns `device_token` (`bdt_` + 43 base64url characters) **once**. The hub stores only its sha256. Keep it in the macOS Keychain.
- **Electron main injects `Authorization: Bearer <device_token>` into every request the in-app web view makes to the hub origin (via `session.webRequest.onBeforeSendHeaders`), including the `/ws/board` WebSocket upgrade. The page never sees the token.** Main's own calls (`/api/account`, sign-out, …) send the same header.
- Bearer requests need **no CSRF token**, because no ambient credential exists. The hub still checks `Origin`: when an `Origin` header is present it must be the hub's own origin (`BOARD_PUBLIC_URL`), or the request gets `403`. The web view's requests carry the page's own origin, so they pass. Main's Node requests send no `Origin`, and those pass too.
- The token does not expire. It stops working when the user signs out on that device, revokes it from another device, or deletes the account. After that every call returns `401 UNAUTHENTICATED`, and open sockets get `session.revoked` then close `4401`. On `401`, drop the token from the Keychain and show sign-in.
- A request with an `Authorization` header that doesn't name a live device is `401`. It never falls back to a cookie.
- These tokens are `user_devices` rows, the same kind the design's device flow (§6) uses. Runners will reuse them in P4 (rotation arrives then).

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
| start, per address **and requesting network** (/24, IPv6 /64) | 3 / 15 min and 10 / h | **same `200 {flow_id}` answer**, no mail sent; verify on that flow_id → `INVALID_TOKEN` |
| start, per address from every network together | 40 / h | the same silent answer |
| start, per IP | 20 / h | `429` |
| start, whole hub | 500 / h | `429` |
| verify, per IP | 10 / 10 min | `429` |
| verify, per address and requesting network (every attempt) | 10 / 15 min | `429` for that network only |
| **wrong codes per address** (the failure budget, every network together) | 20 in any 24 h (`BOARD_AUTH_FAIL_BUDGET`) | `429` on every verify for that address, **even with the right code** (it isn't checked), until the rolling day frees a slot; each exhaustion also locks for 1 h, doubling per exhaustion up to 24 h. A right code resets it. When it runs out for an address that has an account, that address gets one mail a day: "Someone is trying sign-in codes for your account" |
| wrong codes per flow | 5 | the flow dies; `INVALID_TOKEN` from then on |
| new users, per IP | 10 / day | `429` on the verify that would create the user |
| any mutation, per IP | 300 / min | `429` |
| any mutation, per signed-in user or member | 120 / min | `429` |

IPv6 clients are keyed by their /64. Behind cloudflared (`BOARD_TRUST_CF_IP=1`, required once exposed), the client IP is `CF-Connecting-IP`. Pairing the per-address limits with the requesting network means someone else hammering your address from their network can't stop you from getting a code on yours; the lockout itself counts only wrong codes. (Anyone who knows your address can still spend its failure budget and pause email-code sign-in for it; the notice mail says so, and Google/GitHub sign-in is unaffected.)

## Routes built in P1

### `POST /api/auth/email/start`

No auth for `purpose:'signin'`. `purpose:'delete'` needs the Bearer token (or the cookie + CSRF token).

```json
{ "email": "jo@example.com", "client": "buddy_desktop", "device_name": "Jo's MacBook Pro", "platform": "darwin-arm64", "purpose": "signin" }
```

- `client`: `'buddy_desktop'` (default) or `'web'`.
- `device_name` (≤ 100 chars) and `platform` (≤ 50) are optional. The mail names them ("This signs in Plexiform for desktop on "Jo's MacBook Pro" (darwin-arm64)") so a phished user can see what they would be approving.
- `purpose`: `'signin'` (default) or `'delete'` (step-up for account deletion). For `'delete'`, `email` and `client` are ignored: the code goes to the signed-in account's own address.

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
- Magic link (web only): the page at `/auth/email` reads the fragment and POSTs `{flow_id, code, via:'link'}`. A browser without the matching `__Host-buddy_flow` cookie gets `428 CONFIRM_REQUIRED {email_masked:"j•••@example.com"}`, and the page asks "Sign in as j•••@example.com?" before re-POSTing with `confirm:true`. A link scanner's GET only loads the page, because the fragment never reaches the server, so it consumes nothing.
- Errors:
  - `400 INVALID_TOKEN`: one generic answer for an unknown, wrong, used, expired or dead flow. After a wrong code it includes `attempts_left`.
  - `428 CONFIRM_REQUIRED`: see the magic-link rule above.
  - `429 RATE_LIMITED`.
  - `400 VALIDATION`: bad `form_factor` or an oversized name.
  - `404 METHOD_DISABLED`: no mailer on this hub.

### `GET /api/account`

Bearer or cookie.

→ `{"user": {…}, "teams": [ {id, name, slug, plan, role, member_id, boards:[{id, name, key_prefix}]} ], "pending_invites": [ {id, team_name, inviter_first_name, role, expires_at} ]}`, plus `csrf_token` for cookie sessions.

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

Body `{"flow_id": "…"}`: a `purpose:'delete'` flow this user started **and verified within the last 5 minutes**, not used before.

The app flow:

1. `start {purpose:'delete'}`
2. the user reads the code from their email
3. `verify {flow_id, code}`
4. `DELETE /api/account {flow_id}`

→ `{"ok": true}`. In one transaction the hub:

- revokes every device token and deletes the web sessions,
- deletes the sign-in identities and pending flows,
- turns the user into a tombstone ("Deleted user", no email),
- removes the user from every team, with the member rows renamed "Deleted user" and their email cleared,
- revokes those members' runner devices.

Cards, comments and journal entries stay with their teams, attributed to "Deleted user". Open sockets close `4401`, and a confirmation mail goes to the old address. Signing in again later with that address creates a new, empty account.

Errors:

- `401 STEP_UP_REQUIRED {max_age_s: 300}`: no fresh verified delete flow.
- `409 CONFLICT {sole_owner_of: [{id, name}]}`: the user is the only owner of a team that has other members.

Teams where the user was the only member are soft-deleted with the account (see `DELETE /api/teams/:id`). Not yet (P5): stopping the user's active runs, purging those teams, and "also erase my comments".

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

All static pages send `Referrer-Policy: no-referrer`.

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

Owner. `{"confirm_slug": "<the team's slug>"}` (`400` if it doesn't match) → `{ok:true, purge_after}`.

Soft delete: from that moment every route for the team, its boards and cards answers `404`, it drops out of `/api/account`, runner devices enrolled in it are revoked (their sockets close `4403`), and browser sockets subscribed to its boards close `4403`. The hard purge 7 days later is P5 (not built); there is no restore route yet.

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

1. **`plexiform://invite/<token>`** first,
2. then the legacy alias **`claudebuddy://invite/<token>`** if the page is still in front 1.2 s later (older builds register only that scheme),

and always shows **"Open in Plexiform"** (the `plexiform://` link) and **"Download Plexiform for Mac"** (`/download`, which redirects to `BOARD_DOWNLOAD_URL`), with the steps: install, open (the app isn't signed by Apple yet: right-click or Control-click it in Applications, choose Open, then Open again), sign in with the invited address, then click the invite link in the email again.

**The app**: register `plexiform://` (and keep `claudebuddy://` as an alias). On `plexiform://invite/<token>`, call preview to show who invited whom, then `POST /api/invites/accept {t}` with the Bearer token. If the user isn't signed in yet, sign in first and keep the token in memory (not on disk) until then.

The invite mail (plain text) carries the team and inviter names, the link, an 8-letter **code** (`XXXX-XXXX`, for typing into the app instead of clicking), the expiry, and "You got this because *name* invited *address*. Ignore it to decline." Names are made safe: no control characters, quotes or angle brackets, one line, ≤ 60 characters, schemes stripped and domains defanged (`evil[.]com`), so the only link in the mail is the hub's.

### Rules

- Only owners and admins invite, as `admin`, `member` or `viewer`, **never above their own role and never as `owner`** (`403 FORBIDDEN`; make someone owner after they join). The inviter's email must be verified (`403 EMAIL_UNVERIFIED`).
- One invite per address per team at a time: a second → `409 CONFLICT {invite_id}` (resend the first instead). An address already in the team → `409 ALREADY_MEMBER {team:{id, name}}`.
- 7 days, single use. Acceptance needs a signed-in user whose **verified** email is the invite's.
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

## Planned, not built (P4): devices as runners

Agreed with the app builder; nothing here exists on the hub yet.

| Method + path | Who | Body | Response |
|---|---|---|---|
| `POST /api/teams/:id/enrol` | member+ (not viewer), Bearer | `{}` | `{enrollment_id, team_id, runner_token}`: enrols this install as a runner in that team |
| `DELETE /api/teams/:id/enrol` | the same install, Bearer | `{}` | `{ok}`: revokes the enrolment and closes that runner socket (`4403`) |

- **Preferred design:** enrolling returns a separate **runner token** bound to one team and one device (stored as a hash, shown once). Revoking the runner never signs the app out, and signing out revokes its runner tokens. Runner sockets authenticate with `Authorization: Bearer <runner_token>` plus `Board-Team: <team_id>`, one socket per team.
- The runner's config becomes `{hub_url, runner_token, team_id, data_dir}` (one per enrolled team), handed over on stdin, never argv or env.
- Token rotation (`prev_token_hash`, the old token valid 5 min) arrives with P4.

## Error codes used here

| Code | HTTP | When |
|---|---|---|
| `VALIDATION` | 400 | bad body |
| `INVALID_TOKEN` | 400 | sign-in flow or code unknown, wrong, used, expired or dead (`attempts_left` after a wrong code); an invite token, id or code that is unknown, used, expired, withdrawn or not yours |
| `UNAUTHENTICATED` | 401 | no, unknown or revoked credential |
| `STEP_UP_REQUIRED` | 401 | `DELETE /api/account` without a fresh verified delete flow (`max_age_s`) |
| `FORBIDDEN` | 403 | cross-origin request, a cookie mutation without a valid `X-CSRF-Token`, or a role that may not do this in a team the user is in |
| `EMAIL_UNVERIFIED` | 403 | creating a team, or inviting, without a verified email |
| `WRONG_ACCOUNT` | 403 | a valid invite token for another address (`email_masked`) |
| `QUOTA_EXCEEDED` | 403 | a plan limit (`resource`, `limit`) |
| `NOT_FOUND` | 404 | unknown route, or a resource (or team header) outside the user's live teams |
| `METHOD_DISABLED` | 404 | an email-code route on a hub without a mailer (D66) |
| `CONFLICT` | 409 | deleting the only owner of a team with members (`sole_owner_of`); several teams and no `X-Board-Team` on `/api/me`; the last owner (`reason:'LAST_OWNER'`); a taken slug; a second pending invite for one address (`invite_id`) |
| `ALREADY_MEMBER` | 409 | inviting, or accepting an invite, for someone already in the team (`team`) |
| `CONFIRM_REQUIRED` | 428 | magic link opened in a different browser (`email_masked`) |
| `RATE_LIMITED` | 429 | see Rate limits (`retry_after_s`) |
