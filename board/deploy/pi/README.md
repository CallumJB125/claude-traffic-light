# Deploying the hub on a Raspberry Pi (dogfood)

Topology: hub bound to 127.0.0.1:8787 → Cloudflare Tunnel (remotely managed; ingress
`<host>` → `http://127.0.0.1:8787`) → the internet. The hub runs in **accounts mode** (`BOARD_AUTH=accounts`):
people sign in with Google, GitHub or an emailed code, create or join teams, and runners enrol per team. There is
no Cloudflare Access in front of it, so the hub's own sign-up control (`BOARD_SIGNUP`), rate limits and request
limits are the front door. Nothing listens publicly except through the tunnel. The Access mode this kit used to
describe (`BOARD_AUTH=access`, `BOARD_ACCESS_*`) is legacy and no longer the production setup.

| File | What |
|---|---|
| `buddy-hub.service` | the hub as `buddyhub`, sandboxed; only `/var/lib/buddy-hub` writable |
| `hub.env.example` | `/etc/buddy-hub/hub.env` template (accounts mode, placeholders only; dev auth is refused when a public URL is set) |
| `buddy-hub-backup.{service,timer}` + `backup.mjs` | nightly paired DB + deliverable snapshot, 14 verified bundles kept in `/var/lib/buddy-hub/backups` |
| `add-member.mjs` | legacy (Access mode): seed email-only members on the host before anyone can sign in |
| `deploy.sh` | ship `board/` at HEAD, `npm ci`, install units, restart, health check |

`BOARD_SECRET` is REQUIRED in accounts mode and must be at least 32 bytes (`openssl rand -base64 48`); the hub refuses to start without it. Keep it with the data: changing it signs everyone out.

**Migration 032 paired recovery:** client deliverable bytes live in
`DATA_DIR/client-artifacts/`, outside SQLite. The nightly `backup.mjs` now makes a
consistent live `VACUUM INTO` database snapshot and copies only its referenced
immutable bytes, checking every size and SHA-256. Private bundles contain
`board.db`, `client-artifacts/` and a manifest written last. Missing, modified or
symlink bytes fail the entire backup. Uploads published after the DB snapshot
are excluded; concurrent deletion can fail the snapshot, so retry or pause the
hub during a busy deletion. Retention prunes whole verified bundles together.
Legacy DB-only files and incomplete/corrupt sets are preserved for inspection.

Verify a bundle with `node deploy/pi/backup.mjs --verify /path/to/bundle`.
Prepare a fresh working copy with
`node deploy/pi/backup.mjs --stage-restore /path/to/bundle /path/to/new-directory`.
Preparation never replaces live data. Stop both the hub and Litestream before
swapping **both** the prepared database and artifact directory into `DATA_DIR`,
preserving the failed set first. Restore matching code, environment and secret/
encryption keys, restore service ownership (directories 0700, files 0600), then
start with `BOARD_RESTORE=1` once. Keep the original backup unchanged.
`--snapshot /path/to/new-directory` produces a paired set at an exact destination
for code/environment/data cutovers. All destinations must be new directories.

**Off-site recovery remains a deployment requirement:** Litestream below copies
only SQLite. Copy whole verified bundles to private off-site storage before
enabling production uploads. A DB-only restore cannot recover deliverables;
approval hashes do not replace their original bytes.

## First deploy

1. Host prerequisites: Node ≥ 22, system user `buddyhub`, `/var/lib/buddy-hub` (buddyhub 0700),
   `/opt/buddy-hub` (root 0755), `/etc/buddy-hub` (root:buddyhub 0750).
2. `/etc/buddy-hub/hub.env` from `hub.env.example` (fill every placeholder: a real `BOARD_SECRET`, `BOARD_PUBLIC_URL`,
   the encryption key file, the SES or OAuth values, the sign-up allowlist), mode 0640 root:buddyhub. The credentials
   live only in this file on the host, never in the repo.
3. **Back up before every deploy** (a rollback cannot undo a migration): `sudo -u buddyhub node /opt/buddy-hub/board/deploy/pi/backup.mjs`
   (or let the nightly timer have run); confirm a fresh verified bundle in `/var/lib/buddy-hub/backups`.
4. From the laptop: `PI="ssh …" board/deploy/pi/deploy.sh`.
5. Tunnel: install the tunnel token and run cloudflared as a service. **Remove the Cloudflare Access application from
   the hostname at cutover**: an accounts hub has no Access in front of it (an Access login page in front of `/api`
   breaks the app's sign-in, and `BOARD_TUNNEL_PROBE_URL` must reach `/api/health` directly).
   Before exposing the hostname, list the Access-era member rows no account has claimed yet:
   `sqlite3 /var/lib/buddy-hub/board.db "SELECT email FROM members WHERE user_id IS NULL AND removed_at IS NULL"`.
   Each unlinked Access-era row can sign up (it counts as an invite): review or revoke each one before exposure.
6. First account: sign in in the Plexiform app (Google, GitHub or an emailed code) with an address on `BOARD_SIGNUP_ALLOW`,
   create the team there, and invite the rest by link/code. (`BOARD_BOOTSTRAP*` is only for seeding a team on an empty
   DB; remove the lines after the first start.)
7. Smoke test: `curl -s http://127.0.0.1:8787/api/health` on the host (`ok:true`, `auth:"accounts"`, `mail:{last_error_at:null,…}`);
   then from a phone on mobile data: the sign-in page loads over https and an allowlisted address receives a code.
   In the SES sandbox only verified addresses receive codes.

## Staging beside production

`TARGET=staging PI="ssh …" board/deploy/pi/deploy.sh` deploys a second instance: unit `buddy-hub-staging`,
code in `/opt/buddy-hub-staging`, data in `/var/lib/buddy-hub-staging`, env `/etc/buddy-hub/staging.env`
(create it from `hub.env.example`; set `BOARD_PORT=8788`, its own `BOARD_PUBLIC_URL`, and never share the
production data dir). It never touches production's backup timer. Point a separate tunnel ingress at
`127.0.0.1:8788`. Any of `UNIT APP_ROOT ENV_FILE DATA_DIR PORT` can be overridden.

Rollback: `deploy.sh` keeps the previous tree at `/opt/buddy-hub/board.prev`; move it back and
restart. Restore a verified paired snapshot by stopping the hub and Litestream, preserving the failed data, replacing both `board.db` and `client-artifacts/`, and starting with
`BOARD_RESTORE=1` once (after a restore the hub bumps every card's fence so nothing that was live before can write over
the restored state). After migration 032, restore the paired `client-artifacts/`
directory before starting the hub; its startup cleanup removes files absent from
the restored database, so keep the original backup separate from the working copy.

Rollback caveats: (1) migrations are forward-only: the old code cannot run against a newer schema, so a rollback after a
migration needs the pre-deploy backup restored too (step 3 above). (2) `node hub/admin.js revoke-legacy-devices` (the
accounts cutover: it revokes every old runner device) stores its revocation in the database. Restoring a snapshot from before that command can restore legacy device tokens. Keep Cloudflare Access in front while rolling back to Access mode. Accounts mode rejects legacy token types; before exposing an accounts hub after any restore, run `revoke-legacy-devices` again. Runners must enrol again for accounts mode.
(3) `BOARD_SECRET` and `BOARD_ENC_KEY(_FILE)` must be the same ones the database was written with.

Off-site backups: Litestream streams `/var/lib/buddy-hub/board.db` to the R2 bucket `plexiform-hub-backups`
(1 s sync; root-only config at `/etc/litestream.yml`, set up by the operator). The nightly snapshot stays as a second copy.

Restore from Litestream (hub host lost or DB damaged):
1. `systemctl stop buddy-hub`; move the damaged `board.db*` aside (never delete it).
2. `litestream restore -config /etc/litestream.yml -o /var/lib/buddy-hub/board.db /var/lib/buddy-hub/board.db`
   (add `-timestamp <RFC3339>` for point-in-time); `chown buddyhub:buddyhub`, `chmod 600`.
3. Start the hub ONCE with `BOARD_RESTORE=1` in `hub.env`. It bumps every card's fence by 1000 and starts a new
   epoch, so any runner or card that was live before the restore cannot write over the restored state. Remove
   the line after the first start.
4. Check `/api/health` and the journal tail. Runners reconnect on their own.
