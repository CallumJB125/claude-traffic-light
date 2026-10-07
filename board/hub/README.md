# Board hub

The board's single process: SQLite state, the browser API, the runner channel
and the reaper. The protocol is fixed by `../CONTRACT.md` and `../shared/`;
this README covers running it.

```
cd board && npm install
BOARD_AUTH=dev BOARD_DEV_SEED=1 BOARD_DEV_REPO=git@github.com:acme/app.git node hub/server.js
curl -s localhost:8787/api/health
```

**Dev auth must never sit behind any proxy or tunnel** (Cloudflare Tunnel, nginx, ssh -R, anything). Through a proxy every request arrives from loopback, so the loopback check proves nothing; the hub refuses `BOARD_AUTH=dev` when `BOARD_PUBLIC_URL` or `BOARD_TUNNEL_PROBE_URL` is set, and dev login additionally needs the secret printed at startup. Anything reachable by anyone else uses `BOARD_AUTH=access`.

**Local auth (`BOARD_AUTH=local`, D35)** is for the hub embedded in the desktop app, run via Electron's `utilityProcess`. Every request (API, static, browser WS) must carry cookie `board_local=<secret>`, a per-launch secret the hub hands its parent over `process.parentPort` as `{type:'board.listening', port, hub_epoch, local_secret}` (a startup error sends `{type:'board.fatal', message}` and exits non-zero). The first start creates org, board "My board" and one email-less owner (`local:<os user>`) that every request maps to. Runners still use device tokens.

Node ≥ 22.13 (unflagged `node:sqlite`). No native dependencies, so it runs as-is on a
Raspberry Pi 5 (arm64). Node 22 prints an `ExperimentalWarning` for SQLite; that's expected.

## How it works

- **One writer per board.** Every change runs in that board's promise queue. A state
  change is always `shared/states.js step()` plus its effects, in one SQLite
  transaction. Sends to runners and browsers happen only after the commit.
- **Clocks.** Runners send ages. The hub converts each age to its own monotonic clock
  at receive time (`performance.now()`). Leases and HB silence live in memory (D11).
  Long timers use persisted hub wall time (`cards.state_since`).
- **Reaper.** Every 1 s, `liveness.timerEvent()` runs for each live card. It also
  sends orphan notifications (N-rules: orphaned ≥ 10 min), recomputes overlaps after
  the 10 s debounce and pushes `lease.tick`.
- **Boot.** Each start gets a new `hub_epoch`, and every live card goes through
  `step(hub_boot)`, which shows it as reconnecting. A card recovers on its runner's
  first HB. Nothing is orphaned until uptime ≥ T_orphan.
- **Restore.** If `BOARD_RESTORE=1` is set, or a `<BOARD_DB>.restored` marker file
  exists, the hub adds 1000 to every fence and starts a new epoch before it accepts
  connections. It deletes the marker afterwards.

## Modules

| File | Role |
|---|---|
| `server.js` | Entry point: config, listen, SIGTERM/SIGINT → graceful shutdown |
| `admin.js` | Operator tools (accounts mode, on the hub host): `delete-user <email>`, `delete-team <slug>` without a step-up (ACCOUNTS-API.md `DELETE /api/account`); `revoke-legacy-devices` for the accounts cutover |
| `app.js` | Wiring: DB → Hub → HTTP/WS → timers (reaper, merge poll, tunnel probe) → close |
| `config.js` | Env → config, validation (dev auth only on loopback) |
| `db.js` | `node:sqlite` wrapper (WAL, savepoint-nested `tx`, bind sanitising), `HubError` |
| `hub.js` | Core: queues, `apply()` = step + effects, reaper, leases, offers, overlaps, handover, notifications, merge poll |
| `views.js` | CardView / LeaseView / Snapshot / CardDetail read models |
| `api.js` | HTTP API operations (cards, actions → step, approvals first-wins, comments, devices, repos, members) |
| `http.js` | Router, auth (Access JWT / dev cookie), CSRF guards, request_id replay cache, static files, WS upgrade |
| `ws-board.js` | `/ws/board` browser push |
| `ws-runner.js` | `/ws/runner`: hello/replay, advertise, claims, HB acks, outbox, RPC dispatch, salvage |
| `rpc.js` | Runner RPC methods, run-token verification |
| `auth.js` | Access JWKS verifier, dev cookie, device + run tokens |
| `github.js` | Read-only GitHub client (PR / commit lookups) |
| `seed.js` | `BOARD_DEV_SEED` fixture and `BOARD_BOOTSTRAP` first admin |
| `log.js` | JSON-line logger to stderr |

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `BOARD_BIND` | `127.0.0.1` | Listen address. Keep it on loopback behind Cloudflare Tunnel |
| `BOARD_PORT` | `8787` | Listen port. `0` picks a free port; the log (and `board.listening`, below) reports the real one |
| `BOARD_DATA_DIR` | `board/hub/data` (gitignored) | Directory for the DB (created if missing) |
| `BOARD_DB` | `$BOARD_DATA_DIR/board.db` | SQLite file (WAL: `board.db-wal`, `board.db-shm` next to it) |
| `DB_SIZE_MAX_MB` | off | Optional positive whole MiB. Metadata-only DB plus WAL pressure check on startup, reaper and admission (at most once per minute). Over the limit or unknown storage pauses new accounts, teams, cards and comments in every mode; a valid sample below 90% resumes them. Existing sign-ins, edits, deletions and observed runner outcomes remain available. Approximate pressure admission, not a hard disk capacity limit. Direct loopback health requests without proxy headers show only `storage.paused`; public health omits it. |
| `BOARD_AUTH` | `access` | `access` (Cloudflare Access JWT), `dev` (cookie stub, loopback bind only; startup fails otherwise), `local` (the hub embedded in the desktop app, D35: `BOARD_BIND` must be `127.0.0.1`, `::1` or `localhost`, and `BOARD_PUBLIC_URL`, `BOARD_TUNNEL_PROBE_URL` and `BOARD_DEV_SEED` must be unset) or `accounts` (the hub's own sign-in, desktop device tokens and web sessions, D51–D58, D66, `ACCOUNTS-API.md`: needs `BOARD_SECRET` and a `BOARD_PUBLIC_URL` (a loopback bind may do without only with `BOARD_ACCOUNTS_DEV=1`); once exposed (a public URL off loopback, or `BOARD_TUNNEL_PROBE_URL`) it needs an https URL, `BOARD_TRUST_CF_IP=1` and a sign-in method (a configured Google or GitHub client, `BOARD_SIGNIN_METHODS`, or a mailer for email codes), and refuses the console mailer) |
| `BOARD_LOCAL_SECRET` | random per start | With `BOARD_AUTH=local`, **tests only**: the `board_local` cookie value (≥ 32 bytes). Unset: 32 random bytes (hex) per launch, sent only in the parentPort `board.listening` message, never logged or printed |
| `BOARD_ACCESS_TEAM` | — | Access team name: certs at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. Required for `access` |
| `BOARD_ACCESS_AUD` | — | The Access application AUD tag. Required for `access` |
| `BOARD_SECRET` | generated | ≥ 32 bytes. Signs run tokens and dev cookies. If unset, a secret is generated once and stored in `hub_meta`. Removed from the environment once read, never in a dump of the config |
| `BOARD_PUBLIC_URL` | — | Public origin, e.g. `https://board.example.com`. Accepted as a same-origin `Origin` for mutations and WS upgrades |
| `BOARD_TRUST_CF_IP` | off | `accounts` only, loopback bind only: take the client IP for rate limits from `CF-Connecting-IP` (cloudflared on the same host). Required once the hub is exposed |
| `BOARD_SIGNIN_METHODS` | — | `accounts`, optional: comma list `google`, `github` (D66). Since D76 `GET /api/auth/methods` reports the providers whose client id and secret are set, and a configured provider is a sign-in method on its own; this list still counts as one for the exposure check |
| `BOARD_SIGNUP` | `allowlist` | `accounts`: who may make a new account (D104). `allowlist`: only verified addresses `BOARD_SIGNUP_ALLOW` lists, invited addresses and unlinked member rows (`BOARD_BOOTSTRAP`); `open`: any verified address. Existing accounts are never affected |
| `BOARD_SIGNUP_ALLOW` | — | `accounts` with `allowlist`: comma list of `domain:<domain>` (that exact domain, no sub-domains; email codes and authoritative Google accounts only, never GitHub, whose verified primary can be years old) and `email:<address>` (any sign-in method), case-insensitive, at most 8192 characters and 256 entries; a bad entry stops start-up with a text that never repeats the list. Empty: invite-only (one warning at start-up). Never logged; removed from the environment once read |
| `BOARD_GOOGLE_CLIENT_ID` | — | `accounts`: the Google OAuth *Desktop* client id. With `BOARD_GOOGLE_CLIENT_SECRET`, turns on Google sign-in and the Google re-authentication step-up (D76–D78) |
| `BOARD_GOOGLE_CLIENT_SECRET` | — | `accounts`: that client's secret. Removed from the environment once read |
| `BOARD_GITHUB_CLIENT_ID` | — | `accounts`: the GitHub OAuth App client id (callback `http://127.0.0.1/callback`, device flow off). With `BOARD_GITHUB_CLIENT_SECRET`, turns on GitHub sign-in and step-up (D76–D78) |
| `BOARD_GITHUB_CLIENT_SECRET` | — | `accounts`: that app's client secret. Removed from the environment once read |
| `BOARD_GOOGLE_WEB_CLIENT_ID` / `BOARD_GOOGLE_WEB_CLIENT_SECRET` | — | `accounts`: separate Google **Web application** client; exact callback `<BOARD_PUBLIC_URL>/api/auth/oauth/web/google/callback`. Requires paired values and an origin-only public URL. Secret is non-enumerable and removed from the environment after reading |
| `BOARD_GITHUB_WEB_CLIENT_ID` / `BOARD_GITHUB_WEB_CLIENT_SECRET` | — | `accounts`: separate GitHub OAuth app; exact callback `<BOARD_PUBLIC_URL>/api/auth/oauth/web/github/callback` with callback wildcards disabled. Same paired-value/origin/secret rules |
| `BOARD_ACCOUNTS_DEV` | off | `accounts`, loopback bind only: allow running with no `BOARD_PUBLIC_URL` (a local try-out and tests) |
| `BOARD_RESEND_API_KEY` | — | `accounts`, optional: Resend API key (sending access); with it the hub mails email sign-in codes and invites. Removed from the environment once read. Unset: no mailer, `/api/auth/email/*` answer `404 METHOD_DISABLED` and invites are shared by the inviter (D66) |
| `BOARD_MAIL_PROVIDER` | — | `accounts`, optional: `resend` or `ses`. Unset: Resend when `BOARD_RESEND_API_KEY` is set, else no mailer. Anything else, a provider without its settings, a `BOARD_SES_*` variable (`BOARD_SES_FROM_FORMAT` included) without `ses`, or `ses` together with `BOARD_RESEND_API_KEY`, refuses to start (D66 addendum) |
| `BOARD_SES_REGION` | — | With `ses`: the SES region, e.g. `af-south-1` (`^[a-z]{2}(-[a-z]+)+-[0-9]$`). Mail goes only to `https://email.<region>.amazonaws.com` |
| `BOARD_SES_ACCESS_KEY_ID` | — | With `ses`: the IAM access key id (`^[A-Z0-9]{16,128}$`) |
| `BOARD_SES_SECRET_ACCESS_KEY` | — | With `ses`: its secret (1–256 printable characters). Removed from the environment once read, never logged or serialised |
| `BOARD_SES_SESSION_TOKEN` | — | With `ses`, optional: a session token for temporary credentials (sent as `x-amz-security-token`). Never refreshed: sends fail with `ExpiredToken` once it expires. Removed from the environment once read |
| `BOARD_SES_FROM_FORMAT` | `display` | With `ses`: `display` sends `BOARD_MAIL_FROM` as given (`Name <addr>`, the name plain ASCII or RFC 2047 words, or a quoted string without quotes or backslashes inside); `bare` sends only the address inside the angle brackets |
| `BOARD_CONSOLE_MAILER` | off | `accounts`, loopback bind and not exposed only: print mails to stderr instead (a local try-out) |
| `BOARD_AUTH_FAIL_BUDGET` | `20` | `accounts`: wrong email codes per address per 24 h before it is locked out (the lockout doubles on each exhaustion, up to 24 h); 1–100 |
| `BOARD_MAIL_DAILY_CAP` | `2000` | `accounts`: sign-in, invite and notice mails the hub sends per day, all addresses together, at most half of them to addresses without an account; over it, sign-in starts are silent and invites are not mailed |
| `BOARD_MAIL_FROM` | — | `accounts` with Resend or SES: the From address, one line, e.g. `Plexiform <signin@mail.example.com>` |
| `BOARD_DOWNLOAD_URL` | — | `accounts`: https URL of the desktop app download. `/download` (the invite page's "Download Plexiform for Mac" button) redirects there; unset → `404` |
| `BOARD_BILLING_PROVIDER` | — | `accounts`: `stripe` turns on paid plans (`board/hub/billing/`): `/billing`, `POST /api/billing/checkout`, `/api/billing/portal`, `/api/teams/:id/billing/*` and the signed webhook `POST /api/billing/webhook`. Needs `BOARD_PUBLIC_URL`. Unset → billing routes answer `METHOD_DISABLED` and the webhook is 404. See `docs/BILLING-RUNBOOK.md` (owner-gated setup) |
| `BOARD_BILLING_API_KEY` | — | With a provider: its secret API key. Hidden from logs and dumps; removed from the environment at start |
| `BOARD_BILLING_WEBHOOK_SECRET` | — | With a provider: the webhook signing secret (HMAC; deliveries outside a 5-minute timestamp window are refused). Hidden; removed from the environment at start |
| `BOARD_BILLING_PRICE_PLUS_MONTH`, `_PLUS_YEAR`, `_TEAM_MONTH`, `_TEAM_YEAR` | — | The provider's price ids for Plus monthly/yearly and Team per-seat monthly/yearly. An unset one is not offered |
| `BOARD_ENTITLEMENT_KEY_FILE` | — | `accounts`: an Ed25519 private key (PKCS#8 PEM, mode 0600) made by `node board/hub/scripts/gen-entitlement-key.mjs --out <file>`. `GET /api/entitlement` signs the desktop's plan token with it (exp = paid period end + 14 days). Unset → that route answers `METHOD_DISABLED` |
| `BOARD_DEV_LOGIN_SECRET` | random per start | With `BOARD_AUTH=dev`: the secret `/api/dev/login` requires in the `Board-Dev-Secret` header (≥ 16 bytes). Unset: a fresh one is generated and printed to stderr at startup as `http://<bind>:<port>/#dev_secret=…` (the web keeps it for the tab) |
| `BOARD_DEV_SEED` | off | `1`: create org `dev`, board `DEV`, members `alice` (owner) and `bob`. Only with `BOARD_AUTH=dev` |
| `BOARD_DEV_REPO` | — | With `BOARD_DEV_SEED`: a git remote to add as the DEV board's repo |
| `BOARD_BOOTSTRAP` | — | `email` (Access one-time PIN, no GitHub identity) or `github_login,github_id,email`: on a DB with no members, create the org, a board and this owner |
| `BOARD_BOOTSTRAP_BOARD` | `Team:BRD` (`Me:ME` with `BOARD_AUTH=local`) | `Name:KEYPREFIX` for the bootstrap board. Under `local` the org takes the name, the board is always "My board" and takes the prefix |
| `BOARD_RESTORE` | off | `1`: apply the restore fence bump (+1000, new epoch) at boot. A `<BOARD_DB>.restored` marker does the same |
| `BOARD_TUNNEL_PROBE_URL` | — | Public URL of `/api/health`, probed every `BOARD_TUNNEL_PROBE_MS`. It counts as healthy only when the answer has the `Board-Protocol` header, so behind Cloudflare Access (`BOARD_AUTH=access`) give `/api/health` an Access **Bypass** policy; an accounts hub has no Access application in front of it at all (remove it at cutover). While the probe fails, orphaning is suspended. Unset: the tunnel is assumed healthy |
| `BOARD_TUNNEL_PROBE_MS` | `15000` | Probe interval |
| `BOARD_GITHUB_TOKEN` | — | Read-only token (fine-grained: Pull requests + Contents read). Enables PR/commit verification and the Done merge poll. A PR only counts when it is a same-repo PR from the run branch into the run's base branch (D90); forks and retargeted PRs stay `self_reported` and never move the card. Unset: evidence stays `self_reported` and no auto-Done |
| `BOARD_GITHUB_API` | `https://api.github.com` | GitHub API base URL |
| `BOARD_GITHUB_POLL_MS` | `60000` | Merge poll interval for in-review cards |
| `BOARD_WEB_DIR` | `board/web` | Static web root (`/` → `index.html`, `/web/*`) |
| `BOARD_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |
| `BOARD_SHUTDOWN_GRACE_MS` | `5000` | How long a graceful shutdown waits for WS close handshakes and queued writes |
| `BOARD_WEBHOOK_READ_MS` | `3000` | How long an integration webhook's body may take to arrive before it is cut with 408 (it is read before the signature is checked) |

**Placeholders (accounts mode).** The hub refuses to start while `BOARD_SECRET`, `BOARD_ENC_KEY`, the text of `BOARD_ENC_KEY_FILE`, `BOARD_ENC_KEY_PREVIOUS`, `BOARD_SES_ACCESS_KEY_ID`, `BOARD_SES_SECRET_ACCESS_KEY`, `BOARD_SES_SESSION_TOKEN`, `BOARD_RESEND_API_KEY`, `BOARD_GOOGLE_CLIENT_SECRET`, `BOARD_GITHUB_CLIENT_SECRET`, `BOARD_GOOGLE_WEB_CLIENT_SECRET`, `BOARD_GITHUB_WEB_CLIENT_SECRET` or `BOARD_GITHUB_TOKEN` (each only when set) contains `change-me`, `replace-with`, `example` or `placeholder` (any case), while `BOARD_PUBLIC_URL` names `example.com`, `example.org` or `example.net` (or a host under them), or while a `BOARD_SIGNUP_ALLOW` entry is on one of those domains. The error names the variable, never its value. Other modes are unchanged.

### Request limits (D105)

Fixed, no environment variable: the whole request within 30 s, its headers within 15 s, keep-alive idle 120 s (longer than cloudflared's 90 s idle pool, so the tunnel always closes an idle origin connection first and never reuses one the hub is closing); an answer given before a body was read says `Connection: close`; on `/api` the credential is checked before any body is read, a body is at most 1 MiB on card routes and 64 KiB elsewhere, and must arrive within 20 s (408). The webhook ingress keeps its own limits (`BOARD_WEBHOOK_READ_MS`). Tests override the numbers through `config.requestLimits` (`hub/http.js` `REQUEST_LIMITS`).

## Cloudflare Access

- Browsers: the hub verifies `Cf-Access-Jwt-Assertion` on every request and WS
  upgrade (RS256, `aud`, `exp`, `iss`) and maps the `email` claim to `members.email`.
- Integrations (D42): give exactly `POST /integrations/*/webhook` and
  `GET /integrations/*/callback` an Access **Bypass** policy. Providers can't sign
  in; the webhook signature and the signed OAuth `state` are their auth. Nothing
  else under `/integrations/` or `/api/` may bypass.
- Runners: a device is created with `POST /api/devices {name, cf_service_token_id}`.
  `cf_service_token_id` is the Access service token's Client ID. Connections must carry
  `Authorization: Bearer <device_token>` and an Access assertion whose `common_name`
  equals that id.

## Litestream

The DB is a single file in WAL mode with `synchronous=NORMAL` and `busy_timeout=5000`.
The hub never checkpoints with TRUNCATE itself, so Litestream can replicate
`$BOARD_DB` directly:

```yaml
dbs:
  - path: /srv/board/data/board.db
    replicas:
      - url: s3://bucket/board
```

To restore: stop the hub, run `litestream restore -o /srv/board/data/board.db s3://bucket/board`,
`touch /srv/board/data/board.db.restored`, then start the hub. The marker triggers
the +1000 fence bump, so a zombie runner holding a pre-restore fence is always FENCED.

## Sending mail with Amazon SES (operator note)

Set `BOARD_MAIL_PROVIDER=ses`, `BOARD_SES_REGION`, `BOARD_SES_ACCESS_KEY_ID`,
`BOARD_SES_SECRET_ACCESS_KEY`, `BOARD_MAIL_FROM` (and `BOARD_SES_SESSION_TOKEN` only
for temporary credentials; `BOARD_SES_FROM_FORMAT` if needed, below). The hub signs
its own requests (SigV4, no AWS SDK) and talks only to `email.<region>.amazonaws.com`.

- The credentials go in the hub's environment file on the hub host (mode 600),
  never in the repository, a compose file that is committed, or a ticket.
- The supported setup is a long-lived IAM user access key allowed only
  `ses:SendEmail` on the sending identity's ARN
  (`arn:aws:ses:<region>:<account>:identity/<domain>`), with a
  `ses:FromAddress` condition naming the From address. The hub never refreshes
  a `BOARD_SES_SESSION_TOKEN`: with temporary (STS) credentials every send fails
  with `SES answered 403 (ExpiredToken)` once they expire, until the operator
  sets fresh ones and restarts the hub.
- Addresses are ASCII only (SES's own rule): a recipient with a non-ASCII
  character, a quoted local part, a comment or an address literal gets no mail,
  and the person signing in sees the same answer as anyone else.
- The sender domain needs a verified SES identity in that region, with its DKIM
  CNAME records published in DNS.
- A new SES account starts in the sandbox: it sends only to verified addresses and
  at most 200 mails a day. Production access needs a request to AWS. The hub's own
  `BOARD_MAIL_DAILY_CAP` still applies on top.
- If the first real send fails with `SES answered 403 (AccessDenied)` in
  the log, the IAM `ses:FromAddress` condition may want the bare address: set
  `BOARD_SES_FROM_FORMAT=bare` and restart the hub.
- A failed send is logged as `sign-in mail failed` (or `invite mail failed`, …)
  with `mailer: "ses"` and a fixed `err` text: `SES answered <status>`, plus a
  short tag such as `(MessageRejected)`, `(MailFromDomainNotVerified)`,
  `(AccountSuspended)`, `(SendingPaused)`, `(Throttling)` or `(TooManyRequests)`
  when SES names one; `(RequestExpired)` means the hub host's clock is off by
  more than a few minutes; `SES request timed out`; `SES request failed`;
  `SES answer was not understood`. Never the
  address, SES's message text, a header or a credential. The person signing in
  sees the same answer either way (the code just does not arrive).

**Checking the mailer without the logs.** A sign-in email is sent in the background after the hub has already answered "started" (the same answer for every address), so a broken mailer shows the person "Check your email" and nothing arrives. `GET /api/health` on a hub with a mailer carries `mail: {last_error_at, failing}`: the time a send last failed (any sign-in, invite or notice mail), `null` if none has since the hub started, and `failing: true` once 5 sends in a row have failed, until one succeeds. While it is true `/api/auth/methods` says `email: false`, so the web and the app stop offering email codes (the email routes stay open for anyone mid-flow). It never says to whom or why; the reason is in the log line `sign-in mail failed` (a fixed error text, no address). A smoke test sends one real sign-in mail and checks that `last_error_at` did not move. With SES in the sandbox only verified addresses and domains receive mail, so a send to anyone else is accepted by the hub and refused by SES: it shows up here and in the log, not in the person's inbox.

## Deleting accounts and teams without a mailer

Deleting an account or a team needs a step-up: an email code (a mailer) or a
Google/GitHub re-authentication (a configured provider). A `BOARD_AUTH=accounts` hub
with neither logs a warning at start, and the operator erases on the hub host, with
the hub's environment:

```sh
node hub/admin.js delete-user <email>
node hub/admin.js delete-team <slug>
```

The same transaction as `DELETE /api/account` / `DELETE /api/teams/:id`, without the
step-up (audit `by: "operator"`). It opens the database directly: stop the hub
first, or rely on its 5 s `busy_timeout`.

## Accounts an invite let in (sign-up `allowlist`)

While `BOARD_SIGNUP=allowlist`, an account that only an invite let in may join teams but
not create one (D104, `users.signup_via = 'invite'`); it stays that way (nothing promotes
it). To see who they are:

```sh
sqlite3 /var/lib/buddy-hub/board.db "SELECT primary_email, created_at FROM users WHERE signup_via = 'invite' AND deleted_at IS NULL"
```

## Cutover to `BOARD_AUTH=accounts`: runner credentials

In accounts mode runners connect only with an enrolment's runner token (`brt_…`,
`POST /api/teams/:id/enrol`, CONTRACT D79–D81). Device tokens minted the old way
(`POST /api/devices` under Access or dev, or by `board-runner enroll`) are refused
with `4401`, and accounts mode does not serve `POST /api/devices`. When switching a
hub to accounts, after the first start on the new version (migrations applied),
revoke the old runner devices so none is left live in the table:

```sh
node hub/admin.js revoke-legacy-devices
# → {"ok":true,"revoked":N,"already_revoked":M,"enrolled_kept":K}
```

It sets `revoked_at` on every device whose token hash is not an enrolment's, writes an
`audit` row (`device.revoke_legacy`, by the operator) and prints the counts. It runs
only against a `BOARD_AUTH=accounts` configuration. Each person then enrols their
install from the app (one enrolment per team).

## Additive routes (not in CONTRACT §5.2)

- `GET /api/boards/:board_id/alerts` → `{alerts: cardface.alertsFor(viewer, cards), notifications}`
  (the viewer's recent N-rule notifications; delivery channels come later).
- `POST /api/devices` also accepts `cf_service_token_id`.

## Tests

`npm test` in `board/`, or `node --test "hub/test/*.test.js"`. The tests use an
in-process hub (fake clock, temp DB, fake GitHub), fake runners and browsers over
real WebSockets on 127.0.0.1, and never touch `~`.
