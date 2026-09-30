# Buddy accounts API (hub `BOARD_AUTH=accounts`, P1)

For the desktop app builder. What exists today (P1), and the P2–P4 routes that are planned but **not built yet**. Decisions: CONTRACT.md D50–D58; background: ACCOUNTS-DESIGN.md (where the two differ, this file and D50–D58 win).

## Conventions

- JSON in and out. Every response has header `Board-Protocol: 1`. Mutations need `Content-Type: application/json`.
- Errors: `{"error": {"code": "<CODE>", "message": "…", …extra}}`. The HTTP status comes from the code (table at the end). `429` responses also send `Retry-After: <s>` and `error.retry_after_s`.
- `request_id` (uuid) is optional on the account routes. When present on a mutation, a repeat within 10 minutes replays the first answer (header `Board-Replayed: 1`).
- Timestamps are ISO-8601 UTC strings.

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
| start, per address | 3 / 15 min and 10 / h | **same `200 {flow_id}` answer**, no mail sent; verify on that flow_id → `INVALID_TOKEN` |
| start, per IP | 20 / h | `429` |
| start, whole hub | 500 / h | `429` |
| verify, per IP | 10 / 10 min | `429` |
| verify, per address (every attempt, right or wrong) | 10 / 15 min | `429`: the address is locked out until the bucket refills, even with the right code |
| wrong codes per flow | 5 | the flow dies; `INVALID_TOKEN` from then on |
| new users, per IP | 10 / day | `429` on the verify that would create the user |
| any mutation, per IP | 300 / min | `429` |
| any mutation, per signed-in user or member | 120 / min | `429` |

IPv6 clients are keyed by their /64. Behind cloudflared (`BOARD_TRUST_CF_IP=1`), the client IP is `CF-Connecting-IP`.

## Routes built in P1

### `POST /api/auth/email/start`

No auth for `purpose:'signin'`. `purpose:'delete'` needs the Bearer token (or the cookie + CSRF token).

```json
{ "email": "jo@example.com", "client": "buddy_desktop", "device_name": "Jo's MacBook Pro", "platform": "darwin-arm64", "purpose": "signin" }
```

- `client`: `'buddy_desktop'` (default) or `'web'`.
- `device_name` (≤ 100 chars) and `platform` (≤ 50) are optional. The mail names them ("This signs in Buddy for desktop on "Jo's MacBook Pro" (darwin-arm64)") so a phished user can see what they would be approving.
- `purpose`: `'signin'` (default) or `'delete'` (step-up for account deletion). For `'delete'`, `email` and `client` are ignored: the code goes to the signed-in account's own address.

→ `200 {"flow_id": "<24 chars>", "expires_in": 600}`. The answer is the same whether or not an account exists, and whether or not the per-address limit silently dropped the mail.

The mail holds a 6-digit code, valid for 10 minutes and one use, with "Never share this code…". A `web` sign-in mail also carries a magic link `https://<hub>/auth/email#f=<flow_id>&c=<code>`. Desktop mails have no link: the user types the code into the app. At most 3 flows per address are live at once; a 4th kills the oldest.

For `client:'web'` the response also sets `__Host-buddy_flow` (10 min). That cookie binds the magic link to this browser.

Errors: `400 VALIDATION` (bad email, bad client), `401 UNAUTHENTICATED` (a delete flow while signed out), `429 RATE_LIMITED`.

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

### `GET /api/account`

Bearer or cookie.

→ `{"user": {…}, "teams": [ {id, name, slug, role, member_id, boards:[{id, name, key_prefix}]} ], "pending_invites": []}`, plus `csrf_token` for cookie sessions.

- `teams` has one entry per live membership, sorted by name.
- `slug` is `null` for teams created by the legacy paths (seed/bootstrap) until P2.
- `pending_invites` stays `[]` until P3; from then on it lists invites for the user's **verified** email.

`401 UNAUTHENTICATED` without a valid credential.

### `GET /api/me`

Kept for the existing web board. In accounts mode it returns `/api/account`'s fields plus the legacy `{member, org, boards}` of the chosen team:

- the team named by header `Board-Org` or `?org=`,
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

Not yet (P5): stopping the user's active runs, deleting teams where they were the only member, and "also erase my comments".

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
| `GET /invite` | static invite landing page (placeholder until P3, see below) |

All static pages send `Referrer-Policy: no-referrer`.

## Planned, not built (P2–P4)

The shapes below are the plan agreed with 70. They may still change; nothing here exists on the hub yet.

### P2: teams and members

| Method + path | Who | Body | Response |
|---|---|---|---|
| `POST /api/teams` | any signed-in user with a verified email | `{name}` | `{team:{id, name, slug}, board}`: the creator becomes owner, and one board is created |
| `GET /api/teams/:id/members` | member+ (emails only for admins) | — | `{members:[{member_id, user_id, display_name, role, joined_at, email?}]}` |
| `PATCH /api/teams/:id/members/:mid` | admin (owner changes: owner only) | `{role}` | `{member}` |
| `DELETE /api/teams/:id/members/:mid` | admin, or yourself (leave) | `{}` | `{ok}`: their sockets on that team close `4403` |

### P3: invites

One universal link: `https://<hub>/invite#<token>`. The token sits in the **fragment**, so it never reaches server logs or `Referer`.

- The hub serves a public static landing page at `/invite` (already served, as a placeholder). Its JS reads the fragment, calls `POST /api/invites/preview {t}`, and then offers:
  - **"Open in Buddy"** → `claudebuddy://invite/<token>`,
  - **"Download Buddy for Mac"**.
- The app handles `claudebuddy://invite/<token>` by calling preview and then accept with its Bearer token.

| Method + path | Who | Body | Response |
|---|---|---|---|
| `GET /api/teams/:id/invites` | admin | — | `{invites:[{id, email, role, expires_at, created_by_name}]}` (never tokens) |
| `POST /api/teams/:id/invites` | admin | `{email, role}` | `{invite, link}`: `link` = `https://<hub>/invite#<token>`, shown once |
| `DELETE /api/teams/:id/invites/:iid` | admin | `{}` | `{ok}` |
| `POST /api/invites/preview` | **no auth**, rate limited per IP | `{t}` | `{team_name, inviter_first_name, role}` only, **never the invitee's email**. One generic `INVALID_TOKEN` for an invalid, expired or used token. POST, never GET with the token in the URL |
| `POST /api/invites/accept` | Bearer or cookie; the invite's email must be one of the user's **verified** addresses | `{t}` | `{team, member}` |

`GET /api/account.pending_invites` then lists invites addressed to the user's verified email.

### P4: devices as runners

| Method + path | Who | Body | Response |
|---|---|---|---|
| `POST /api/teams/:id/enrol` | member+, Bearer | `{}` | enrols this user_device as a runner in that team (design §6.4). Runners then open one `/ws/runner` per team with the same `bdt_` Bearer token and header `Board-Team: <team_id>` |

Token rotation (`prev_token_hash`, old token valid 5 min) arrives with P4.

## Error codes used here

| Code | HTTP | When |
|---|---|---|
| `VALIDATION` | 400 | bad body |
| `INVALID_TOKEN` | 400 | sign-in flow or code unknown, wrong, used, expired or dead (`attempts_left` after a wrong code) |
| `UNAUTHENTICATED` | 401 | no, unknown or revoked credential |
| `STEP_UP_REQUIRED` | 401 | `DELETE /api/account` without a fresh verified delete flow (`max_age_s`) |
| `FORBIDDEN` | 403 | cross-origin request, or a cookie mutation without a valid `X-CSRF-Token` |
| `NOT_FOUND` | 404 | unknown route, or a resource outside the user's teams |
| `CONFLICT` | 409 | deleting the only owner of a team with members (`sole_owner_of`); several teams and no `Board-Org` on `/api/me` |
| `CONFIRM_REQUIRED` | 428 | magic link opened in a different browser (`email_masked`) |
| `RATE_LIMITED` | 429 | see Rate limits (`retry_after_s`) |
