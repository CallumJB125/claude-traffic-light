# Cutover runbook: app.plexiform.dev from Access to accounts mode

Operator runbook for switching the production hub from `BOARD_AUTH=access` (Cloudflare Access in front) to `BOARD_AUTH=accounts` (the hub's own Google/GitHub sign-in). Written from `board/deploy/pi/README.md`, `hub.env.example` and the validation in `board/hub/config.js`. Nothing here has been run; every step that touches a host, Cloudflare or Google is **manual / ask-first**.

Host layout (production): unit `buddy-hub`, code `/opt/buddy-hub/board`, env `/etc/buddy-hub/hub.env`, data `/var/lib/buddy-hub` (`board.db`, `client-artifacts/`, `backups/`), hub on `127.0.0.1:8787` behind a Cloudflare Tunnel. `PI` below is the ssh command for the hub host.

Expect a short outage (the restart) plus a window where runners cannot connect: accounts mode rejects every legacy Access-era device token, so each runner must enrol again (step 9).

## 0. Decide before you start

1. **BOARD_SIGNUP policy** (see section "Signup policy" at the end). Default `allowlist`.
2. **Who will be first owner.** Their address must pass the signup policy, or match an unclaimed member row (step 3), or hold a pending invite.
3. **Maintenance window** and who is on hand to re-enable Access if rollback is needed.

## 1. Preconditions (all must hold)

- A fresh, verified paired backup exists (step 2) and has been copied off the host.
- Google (and/or GitHub) OAuth clients exist for `https://app.plexiform.dev`, with these exact redirect URIs registered: `https://app.plexiform.dev/api/auth/oauth/web/google/callback` and `.../web/github/callback` (web clients), plus the desktop clients if the desktop app signs in via the hub. `BOARD_PUBLIC_URL` must be an origin only.
- A real `BOARD_SECRET` (`openssl rand -base64 48`, at least 32 bytes) and an encryption key file `/etc/buddy-hub/enc.key` (`openssl rand -base64 32`, root:buddyhub 0640). The hub refuses to start on any placeholder word (`change-me`, `replace-with`, `example`, `placeholder`).
- Mail, if email codes or invite emails are wanted: SES identity + DKIM verified, out of sandbox for non-verified recipients. Email-code sign-in stays off unless `BOARD_EMAIL_SIGNIN=1`.
- The tree being deployed is committed (`deploy.sh` refuses uncommitted `board/` or `src/borrow`) and its tests are green.
- Staging rehearsal done if at all possible: `TARGET=staging PI="..." board/deploy/pi/deploy.sh` with its own env, port 8788, its own tunnel ingress and data dir. Never share production's data dir.

## 2. Verified backup (ask-first: runs on the host)

```sh
$PI 'sudo -u buddyhub node /opt/buddy-hub/board/deploy/pi/backup.mjs'
# prints {"bundle":"/var/lib/buddy-hub/backups/<stamp>","artifact_count":N}
$PI 'sudo -u buddyhub node /opt/buddy-hub/board/deploy/pi/backup.mjs --verify /var/lib/buddy-hub/backups/<stamp>'
# must print {"verified":true,...}
```

For a code+env+data cutover you may instead take an exact-destination paired snapshot (destination must be a new directory): `... backup.mjs --snapshot /var/lib/buddy-hub/pre-cutover`. Copy the verified bundle off-site (Litestream copies only SQLite, not `client-artifacts/`). Record the bundle path: rollback may need it. Also keep a copy of the current `hub.env` (`sudo cp -p /etc/buddy-hub/hub.env /etc/buddy-hub/hub.env.access`) and note the current `DEPLOYED_SHA` (`cat /opt/buddy-hub/board/DEPLOYED_SHA`).

## 3. List unclaimed Access-era member rows (read-only)

Each member row with no linked account is an implicit invite: whoever signs in with that email can claim it, and it passes the signup allowlist. Review and revoke before the hostname is exposed in accounts mode.

```sh
# the Pi has no sqlite3 CLI; use node:sqlite (read-only)
$PI 'sudo node -e "const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(\"/var/lib/buddy-hub/board.db\",{readOnly:true});console.log(JSON.stringify(d.prepare(\"SELECT email, role, github_login FROM members WHERE user_id IS NULL AND removed_at IS NULL ORDER BY email\").all()))"'
```

If the database predates migration 009 there is no `user_id` column: every active row is unclaimed, and the query errors; use `... WHERE removed_at IS NULL`. Remove rows that should not be able to sign in through the team's normal member-removal path before cutover. The same listing is produced by `scripts/cutover-preflight.mjs --db` (step 4).

## 4. Env diff and preflight

Edit a copy of `/etc/buddy-hub/hub.env` against `board/deploy/pi/hub.env.example`.

| Variable | Access-era | Accounts (required unless noted) |
|---|---|---|
| `BOARD_AUTH` | `access` (or unset, the default) | `accounts` |
| `BOARD_ACCESS_TEAM`, `BOARD_ACCESS_AUD` | set | remove (unused) |
| `BOARD_SECRET` | optional | required, at least 32 bytes, no placeholder. Keep it with the data: changing it signs everyone out |
| `BOARD_PUBLIC_URL` | optional | `https://app.plexiform.dev` (https, origin only for web OAuth, not an example host) |
| `BOARD_BIND` | any | `127.0.0.1` (non-loopback is refused with `BOARD_TRUST_CF_IP`) |
| `BOARD_TRUST_CF_IP` | optional | `1`, required for an exposed hub (hub on loopback behind cloudflared only) |
| `BOARD_ENC_KEY_FILE` (or `BOARD_ENC_KEY`) | maybe | `/etc/buddy-hub/enc.key`, outside the data dir |
| Sign-in method | none | at least one: `BOARD_GOOGLE_CLIENT_ID`+`_SECRET`, `BOARD_GITHUB_CLIENT_ID`+`_SECRET`, `BOARD_GOOGLE_WEB_CLIENT_ID`+`_SECRET`, `BOARD_GITHUB_WEB_CLIENT_ID`+`_SECRET`, or `BOARD_EMAIL_SIGNIN=1` with a mailer. A web client id without its secret (or the reverse) is refused |
| `BOARD_SIGNUP`, `BOARD_SIGNUP_ALLOW` | n/a | `allowlist` plus entries, or `open` (see policy section) |
| `BOARD_TUNNEL_PROBE_URL` | n/a | `https://app.plexiform.dev/api/health` (needs Access gone first, step 7) |
| `BOARD_MAIL_*`, `BOARD_SES_*` | optional | only if mail is wanted: `BOARD_MAIL_PROVIDER=ses` needs region, key id, secret and `BOARD_MAIL_FROM`; stray `BOARD_SES_*` without the provider is refused |
| `BOARD_BOOTSTRAP*` | n/a | leave unset (only seeds an empty DB; the first owner signs in and creates the team, or is an unclaimed row) |
| `BOARD_RESTORE` | n/a | unset (set to `1` once only when restoring) |
| `BOARD_DEV_*`, `BOARD_ACCOUNTS_DEV`, `BOARD_CONSOLE_MAILER` | n/a | must not be set |

Run the preflight from the repo on your laptop against the edited copy, and against a copy of the database if you have one (read-only, no network):

```sh
node scripts/cutover-preflight.mjs /path/to/hub.env.new --db /path/to/board.db.copy
```

It runs the hub's own accounts validation (exit 1 = the hub would refuse to start), then lists risks and unclaimed members. Resolve every `ERROR`; read every `RISK`. Install the file on the host as `/etc/buddy-hub/hub.env` (root:buddyhub 0640). Credentials live only there, never in the repo.

## 5. Deploy (ask-first)

```sh
cd <repo> && git status                      # clean board/ and src/borrow
PI="ssh -i ~/.ssh/<key> <user>@<host>" board/deploy/pi/deploy.sh
```

`deploy.sh` archives `board/` at HEAD, `npm ci --omit=dev`, writes `DEPLOYED_SHA`, moves the old tree to `/opt/buddy-hub/board.prev`, installs units, restarts `buddy-hub` and waits for `/api/health`, then prints the `board-protocol` header. Migrations run at start and are forward-only. If the hub does not start, read `journalctl -u buddy-hub -n 50` (validation errors are fixed texts and never echo secrets) and use rollback.

Then revoke Access-era runner devices (the hub stays up; each runner must re-enrol):

```sh
$PI "sudo -u buddyhub bash -c 'set -a; . /etc/buddy-hub/hub.env; set +a; cd /opt/buddy-hub/board && node hub/admin.js revoke-legacy-devices'"
```

(`hub.env` is root:buddyhub 0640, so `buddyhub` can source it; `admin.js` must load the same configuration as the hub.)

## 6. Local smoke test on the host (before touching Cloudflare)

```sh
$PI 'curl -fsS http://127.0.0.1:8787/api/health'
# {"ok":true,... ,"auth":"accounts",...}  ("mail":{...failing:false} when a mailer is set)
$PI 'curl -fsS http://127.0.0.1:8787/api/auth/methods'
# {"google":true,"github":false,"email":false,"web":{"google":true,"github":false}}  matches what you configured
$PI 'cat /opt/buddy-hub/board/DEPLOYED_SHA'     # equals the sha deploy.sh printed / git rev-parse HEAD
```

## 7. Remove the Cloudflare Access application (MANUAL, ask-first)

An Access login page in front of `/api` breaks sign-in and blocks the tunnel probe. In the Cloudflare Zero Trust dashboard:

1. Zero Trust, Access, Applications: find the application for `app.plexiform.dev`. Note its policies and AUD tag (needed for rollback).
2. Remove or disable it (disable first, if the dashboard offers it, so rollback is one toggle). Check no other Access app or wildcard policy still matches the hostname or `/api/*`.
3. Tunnel ingress stays `app.plexiform.dev` to `http://127.0.0.1:8787`. Do not change DNS.
4. If `BOARD_TUNNEL_PROBE_URL` was left unset, set it now and restart the hub (`sudo systemctl restart buddy-hub`).

## 8. Post-cutover verification

From outside the host (laptop or phone on mobile data):

- `curl -s https://app.plexiform.dev/api/health` returns `ok:true` and `"auth":"accounts"` with no Access redirect or login HTML.
- `curl -s https://app.plexiform.dev/api/auth/methods` shows the configured methods.
- Open `https://app.plexiform.dev/signin`, sign in with a **test account** that passes the policy (an allowlisted address, or a pending invite). Confirm the session works: the board loads, sign out and in again. Confirm an address NOT on the allowlist is refused.
- Deploy sha: `$PI 'cat /opt/buddy-hub/board/DEPLOYED_SHA'` equals the intended commit; `curl -sI https://app.plexiform.dev/api/health | grep -i board-protocol` is present.
- The first owner signs in, claims or creates the team, invites the rest by link or code.
- Re-enrol one runner (desktop app, sign in to the hub) and confirm a card appears and a run connects.
- `journalctl -u buddy-hub -n 100` has no repeated auth or mail errors; the tunnel probe is healthy. The next nightly backup succeeds (`systemctl list-timers buddy-hub-backup.timer`).

## 9. Roll runners forward

Every runner/desktop must sign in again and enrol (legacy device tokens are revoked and rejected). Tell people before the window.

## Rollback (target: under 2 minutes)

Use when the hub will not start, or sign-in does not work and cannot be fixed quickly. Prerequisites kept from step 2: `/opt/buddy-hub/board.prev`, `/etc/buddy-hub/hub.env.access`, and the Access application noted in step 7.

1. Re-enable (or recreate) the Cloudflare Access application for `app.plexiform.dev` with its original policies (manual, ask-first). Do this first if the hostname is exposed without Access.
2. Restore code and env, then restart:
   ```sh
   $PI 'set -e; sudo systemctl stop buddy-hub
     sudo rm -rf /opt/buddy-hub/board.failed && sudo mv /opt/buddy-hub/board /opt/buddy-hub/board.failed
     sudo mv /opt/buddy-hub/board.prev /opt/buddy-hub/board
     sudo cp -p /etc/buddy-hub/hub.env /etc/buddy-hub/hub.env.accounts
     sudo cp -p /etc/buddy-hub/hub.env.access /etc/buddy-hub/hub.env
     sudo systemctl start buddy-hub
     for i in $(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:8787/api/health && break; sleep 0.5; done
     curl -fsS http://127.0.0.1:8787/api/health'
   ```
   The health body shows `"auth":"access"`.
3. **Migrations are forward-only**: the old code cannot run against a schema the new code migrated. If the old code refuses to start (schema newer than code), restore the pre-deploy database instead: stop the hub (and Litestream), stage the verified bundle with `backup.mjs --stage-restore <bundle> <new-dir>`, preserve the failed `board.db` and `client-artifacts/`, swap in BOTH the staged database and artifacts (directories 0700, files 0600, owner `buddyhub`), start once with `BOARD_RESTORE=1` (bumps every card fence; remove the line after the first start). Allow more than 2 minutes for this path.
4. `BOARD_SECRET` and `BOARD_ENC_KEY(_FILE)` must be the values the restored database was written with.
5. If `revoke-legacy-devices` ran, a snapshot from before it restores the old device tokens; that is what rollback to Access mode wants. If you later go forward again, run `revoke-legacy-devices` again after any restore.
6. Verify: `/api/health` (`auth:"access"`), an Access login through the browser, and a runner reconnecting.

## Signup policy: allowlist vs open

`BOARD_SIGNUP` governs who may create a NEW account. Existing accounts always sign in.

- **`allowlist` (recommended, the default).** A new account needs a verified email on `BOARD_SIGNUP_ALLOW` (comma list of `domain:<domain>` and `email:<address>`, lower-case ASCII) or a valid pending invite or an unclaimed member row for that email. Never list a public mail provider as `domain:` (gmail.com etc. admits everyone); use `domain:` only where every mailbox belongs to one of your people. GitHub sign-ups qualify only through an `email:` entry, an invite or an unlinked member row, never a `domain:` entry. The preflight flags public-mail domains.
- **`open`.** Anyone with a Google/GitHub/email account can create an account and a team. Appropriate only for a deliberate public launch: it widens mail volume (`BOARD_MAIL_DAILY_CAP`, half reserved for known accounts), abuse surface and support load.

**Google consent screen caveat.** If the Google OAuth consent screen (Audience) is in **Testing** mode, only the test users listed there (maximum 100) can complete Google sign-in, and their grants expire after 7 days, regardless of `BOARD_SIGNUP`. An `allowlist` person who is not a Google test user fails at Google, not at the hub; `open` does not help either. For anyone outside the test list, publish the app (In production): the basic scopes `openid`, `email`, `profile` need no Google verification. Do not add a logo until ready for brand verification. Decide this before step 8 and add test users in the Google console (manual) if you stay in Testing for a closed beta. GitHub sign-in has no such limit.
