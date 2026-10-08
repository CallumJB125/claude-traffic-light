# Deploying hub migrations 069, 070 and 071

Owner checklist for shipping `069_capture_pr`, `070_public_api` and `071_event_triggers` to the hub on `bondly-pi`: **staging (port 8788) first, then production (port 8787)**. Nothing here has been run. Every command touches a host, so each is **owner-run, ask-first**. Companion to `docs/CUTOVER.md` (Access to accounts mode) and `board/deploy/pi/README.md`.

Set this once in your shell. The deploy script and every `$PI '...'` line below use it:

```sh
export PI="ssh bondly-pi"
```

## What is being deployed

| Migration | Adds | Risk |
|---|---|---|
| `069_capture_pr.sql` | one nullable column `work_capture_cards.pr` (JSON, at most 600 characters) | Additive. Written only by the desktop's embedded local hub, so the Pi hub never fills it. |
| `070_public_api.sql` | tables `api_tokens`, `webhook_endpoints`, `webhook_deliveries`, plus cross-team guard triggers (see `docs/PUBLIC-API.md`) | Additive, no table rebuild. Webhooks need an encryption key (`BOARD_ENC_KEY` or `BOARD_ENC_KEY_FILE`) on the hub; without one, creating a webhook answers `POLICY_DENIED`. Tokens work without it. |
| `071_event_triggers.sql` | table `event_triggers`, the firing log, guard triggers (see `docs/event-triggers.md`) | Additive. Every rule starts `off`, so nothing fires until an admin switches one on, and `on` needs a 7-day dry run first. |

How migrations run (`board/shared/migrate.js`): the hub applies every file not yet recorded in `schema_migrations` when it **starts**, in version order, each in its own transaction. A failing file rolls back and the hub refuses to start. Gaps in the numbering are normal. Migrations are **forward-only**: old code cannot run against a newer schema. The only rollback is restoring the pre-deploy backup (Section 6).

A migration recorded under a different name than the file the hub ships (a database from another branch) stops the hub before it applies anything. If you see that error, stop and ask; do not edit `schema_migrations`.

## 0. Before you start

- [ ] The tree to deploy is committed on the branch you intend (`deploy.sh` refuses uncommitted `board/`, `src/borrow` or `src/session-router.js`). Note the SHA:
  ```sh
  git -C <repo> rev-parse HEAD
  ```
- [ ] The three migration files are present in that tree:
  ```sh
  ls board/shared/migrations/069_capture_pr.sql board/shared/migrations/070_public_api.sql board/shared/migrations/071_event_triggers.sql
  ```
- [ ] Tests for the board are green on Node 22 (the Pi runs Node 22 or newer):
  ```sh
  cd board && PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test
  ```
- [ ] Pick a quiet time. Production restarts once (a few seconds of downtime) and runners reconnect on their own.
- [ ] Know who can re-run Section 6 if the restore is needed.

## 1. Rehearse the migrations offline (laptop, touches no host)

Proves the three files apply cleanly on top of a real database. Use a copy of a **verified backup**, never the live file. Skip to Section 2 if you have no copy yet and come back after Section 3.

```sh
# from the repo's board/ directory, against a COPY (never the live board.db)
node --input-type=module -e "
import {DatabaseSync} from 'node:sqlite';
import {migrate,currentVersion} from './shared/migrate.js';
const d=new DatabaseSync(process.argv[1]);
console.log('before', currentVersion(d));
console.log('applied', migrate(d,{wal:false}));
console.log('after', currentVersion(d));
" /path/to/copy-of-board.db
```

Expected on a database that is at 068: `applied [ 69, 70, 71 ]` and `after 71`. Run on an empty database it applies everything and ends at `after 71`. The output also includes a harmless Node `ExperimentalWarning: SQLite` line.

## 2. Staging (port 8788)

Staging is a second instance beside production: unit `buddy-hub-staging`, code `/opt/buddy-hub-staging`, data `/var/lib/buddy-hub-staging`, env `/etc/buddy-hub/staging.env`. It never touches production's backup timer. **Never point staging at production's data directory.**

### 2.1 One-time: staging env (skip if it already exists)

```sh
$PI 'sudo test -f /etc/buddy-hub/staging.env && echo exists || echo missing'
```

If missing, create it from `board/deploy/pi/hub.env.example` (root:buddyhub, mode 0640), then set at least:

- `BOARD_PORT=8788`
- its own `BOARD_PUBLIC_URL` (a staging hostname, not `https://app.plexiform.dev`)
- a **different** `BOARD_SECRET` and encryption key from production, so a staging database can never open production's sealed secrets
- `BOARD_SIGNUP=allowlist` with only your own address
- `BOARD_ENC_KEY_FILE` pointing at a staging key file, so webhooks (070) can be exercised

Staging must not hold production's integration credentials, and should have its own tunnel ingress to `127.0.0.1:8788` (or be reached by `ssh -L 8788:127.0.0.1:8788 bondly-pi` for a local browser).

### 2.2 Deploy

```sh
cd <repo>
TARGET=staging PI="$PI" board/deploy/pi/deploy.sh
```

Success ends with a `board-protocol:` header line and `deployed <sha> to buddy-hub-staging (port 8788)`. The script archives `board/` at HEAD, runs `npm ci --omit=dev`, writes `DEPLOYED_SHA`, moves the previous tree to `/opt/buddy-hub-staging/board.prev`, restarts the unit and waits for `/api/health`.

### 2.3 Verify staging

- [ ] Health:
  ```sh
  $PI 'curl -fsS http://127.0.0.1:8788/api/health'
  ```
  Expect `"ok":true`, `"auth":"accounts"` (or the mode the staging env sets) and a `protocol` number.
- [ ] Deployed SHA matches:
  ```sh
  $PI 'cat /opt/buddy-hub-staging/board/DEPLOYED_SHA'
  ```
- [ ] Migrations recorded (read-only):
  ```sh
  $PI 'sudo node -e "const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(\"/var/lib/buddy-hub-staging/board.db\",{readOnly:true});console.log(JSON.stringify(d.prepare(\"SELECT version,name FROM schema_migrations WHERE version>=68 ORDER BY version\").all()))"'
  ```
  Expect `[{"version":68,...},{"version":69,"name":"capture_pr"},{"version":70,"name":"public_api"},{"version":71,"name":"event_triggers"}]`.
- [ ] Journal is clean:
  ```sh
  $PI 'sudo journalctl -u buddy-hub-staging -n 50 --no-pager'
  ```
  No `migration ... failed` and no restart loop.
- [ ] Walk the Section 5 checks against staging (port 8788) before touching production.

Do not continue until every box above is ticked and Section 5 passes on staging.

## 3. Production backup (port 8787, before anything else)

A rollback cannot undo a migration, so the backup is the rollback. Run all of it before deploying.

```sh
# 3.1 Current state, for the record
$PI 'cat /opt/buddy-hub/board/DEPLOYED_SHA'
$PI 'curl -fsS http://127.0.0.1:8787/api/health'

# 3.2 Paired, verified backup (database + client-artifacts)
$PI 'sudo -u buddyhub node /opt/buddy-hub/board/deploy/pi/backup.mjs'
# prints {"bundle":"/var/lib/buddy-hub/backups/<stamp>","artifact_count":N}  -> write the path down
$PI 'sudo -u buddyhub node /opt/buddy-hub/board/deploy/pi/backup.mjs --verify /var/lib/buddy-hub/backups/<stamp>'
# must print {"verified":true,...}

# 3.3 Env file copy, so rollback restores the same configuration
$PI 'sudo cp -p /etc/buddy-hub/hub.env /etc/buddy-hub/hub.env.pre-069'
```

- [ ] Bundle path recorded: `____________________`
- [ ] `--verify` printed `"verified":true`
- [ ] Bundle copied off the Pi (Litestream copies only SQLite, not `client-artifacts/`)
- [ ] Previous `DEPLOYED_SHA` recorded: `____________________`
- [ ] Current schema version recorded (read-only):
  ```sh
  $PI 'sudo node -e "const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(\"/var/lib/buddy-hub/board.db\",{readOnly:true});console.log(d.prepare(\"SELECT MAX(version) v FROM schema_migrations\").get().v)"'
  ```
  Expect 68 if 069 to 071 are all pending. If it already shows 69 or 70, only the later files will apply; that is fine.

Optional rehearsal on real data: stage the bundle with `backup.mjs --stage-restore <bundle> <new-dir>` (a new directory), copy the staged `board.db` off the Pi and run the Section 1 command against that copy. Do not start a hub on a copy of production data with production's secrets.

## 4. Production deploy (port 8787)

```sh
cd <repo>
git status                       # board/ clean
PI="$PI" board/deploy/pi/deploy.sh
```

This restarts `buddy-hub`. Migrations 069, 070, 071 apply during that start. The script waits for `/api/health` and prints the `board-protocol:` header.

If the script reports the hub did not come up: go straight to Section 6.

## 5. What to verify (run on staging first, then production)

Use port 8788 for staging and 8787 for production. Replace `$PORT`.

### 5.1 Hub and schema

- [ ] `curl -fsS http://127.0.0.1:$PORT/api/health` returns `ok:true` and `"auth":"accounts"`; `mail` shows `failing:false` if mail is configured.
- [ ] `curl -sI http://127.0.0.1:$PORT/api/health | grep -i board-protocol` is present.
- [ ] `DEPLOYED_SHA` equals the SHA you meant to ship.
- [ ] `schema_migrations` lists 69 `capture_pr`, 70 `public_api`, 71 `event_triggers` (same read-only query as 2.3, with the production data path `/var/lib/buddy-hub/board.db`).
- [ ] `journalctl -u buddy-hub -n 50` (or `buddy-hub-staging`) shows no errors.
- [ ] Production only: the public URL answers, `curl -fsS https://app.plexiform.dev/api/health` returns `ok:true`. The cloudflared tunnel is untouched by this deploy; if it is down, restart it per `docs/CUTOVER.md`.
- [ ] Production only: backup timer still active: `$PI 'systemctl is-active buddy-hub-backup.timer'` prints `active`.

### 5.2 Existing behaviour is unchanged

- [ ] Sign in to the web app with a known account; the board loads and cards show.
- [ ] A runner reconnects (cloud runner or a desktop runner) without re-enrolling.
- [ ] Open a card, add a comment, see it appear.

### 5.3 069 (capture PR)

- [ ] Nothing visible changes on the Pi. `work_capture_cards` has a `pr` column:
  ```sh
  $PI 'sudo node -e "const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(\"/var/lib/buddy-hub/board.db\",{readOnly:true});console.log(d.prepare(\"SELECT name FROM pragma_table_info(\x27work_capture_cards\x27) WHERE name=\x27pr\x27\").all())"'
  ```
  Expect `[ { name: 'pr' } ]`. Existing captured cards still list (their `pr` is `NULL`).

### 5.4 070 (public API and webhooks)

As a team owner or admin, in the web app: **Integrations, API and webhooks** (see `docs/PUBLIC-API.md`).

- [ ] Create a token with `read:boards`. The token (`plx_pat_...`) shows once; copy it.
- [ ] Read with it:
  ```sh
  curl -fsS -H "Authorization: Bearer plx_pat_..." http://127.0.0.1:$PORT/api/public/v1/boards
  ```
  Expect `{"boards":[...]}` and a `Plexiform-Api-Version: 1` header (add `-i` to see it).
- [ ] The same token without a header, or a wrong token, answers `401`. A scope it lacks (`GET /boards/:id/cards` with only `read:boards`) answers `403` with `"reason":"SCOPE"`.
- [ ] Revoke the token in the panel; the same curl now answers `401`.
- [ ] Webhooks (needs the encryption key): register an `https` endpoint you control (a temporary receiver such as a request-bin you own). If the hub has no key, expect `POLICY_DENIED` mentioning `BOARD_ENC_KEY`; that is correct, not a failed deploy, but then webhooks are unavailable until the key is set.
- [ ] Delete the test token and endpoint afterwards.

### 5.5 071 (event triggers)

As a team owner or admin, using the API described in `docs/event-triggers.md` (routes under `/api/triggers`, with your signed-in session):

- [ ] `GET /api/triggers` returns `{triggers:[], events, actions, dry_run_days, ...}`.
- [ ] Create a rule (for example `card.moved_to_review` with `add_comment`). It comes back with `"mode":"off"`.
- [ ] Switching it straight to `on` is refused (needs a 7-day dry run). Switching to `dry_run` is accepted.
- [ ] Move a card on staging into Review; `GET /api/triggers/activity` shows a `would` firing, and no comment is added to the card.
- [ ] Delete the test rule. Do **not** switch any rule `on` on production as part of this deploy.

## 6. Rollback

Decide fast: the longer the new code runs, the more data is written under the new schema.

### 6.1 The hub starts but misbehaves (code problem, schema fine)

Because 069 to 071 only add things, the old code can often run on the new schema, but this is **not guaranteed** and the old code is not tested against it. Try it first only if the old tree is intact:

```sh
$PI 'set -e; sudo systemctl stop buddy-hub
  sudo rm -rf /opt/buddy-hub/board.failed && sudo mv /opt/buddy-hub/board /opt/buddy-hub/board.failed
  sudo mv /opt/buddy-hub/board.prev /opt/buddy-hub/board
  sudo systemctl start buddy-hub
  for i in $(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:8787/api/health && break; sleep 0.5; done
  curl -fsS http://127.0.0.1:8787/api/health'
```

(`deploy.sh` keeps only one `board.prev`: the tree from the deploy before this one. Use this only if you have not deployed again since.) If the old code refuses to start because the schema is newer, use 6.2.

### 6.2 The hub does not start, or data is wrong (restore the backup)

This returns the database to its state at the Section 3 backup. **Anything written since is lost.**

1. Stop the hub (and Litestream, if running): `$PI 'sudo systemctl stop buddy-hub'`.
2. Put the old code back (6.1 steps `mv board board.failed` and `mv board.prev board`), and restore the env if you changed it: `sudo cp -p /etc/buddy-hub/hub.env.pre-069 /etc/buddy-hub/hub.env`.
3. Stage the verified bundle into a new directory:
   ```sh
   $PI 'sudo -u buddyhub node /opt/buddy-hub/board/deploy/pi/backup.mjs --stage-restore /var/lib/buddy-hub/backups/<stamp> /var/lib/buddy-hub/restore-<stamp>'
   ```
4. Preserve the failed `board.db` and `client-artifacts/` (move them aside, never delete), then swap in **both** the staged database and the staged artifacts. Directories 0700, files 0600, owner `buddyhub`.
5. Start once with `BOARD_RESTORE=1` in `hub.env` (bumps every card fence); remove that line after the first successful start. Allow more than 2 minutes for this start.
6. `BOARD_SECRET` and the encryption key must be the values the restored database was written with.
7. Re-run Section 5.1 and 5.2. Expect `schema_migrations` back at its Section 3 value.

Full detail: `docs/CUTOVER.md`, section "Rollback", and `board/deploy/pi/README.md`.

### 6.3 Staging rollback

Staging holds no real data. Rebuild it: stop `buddy-hub-staging`, remove `/var/lib/buddy-hub-staging/board.db*`, redeploy with `TARGET=staging`.

## 7. After production

- [ ] Section 5 passed on production.
- [ ] Keep the Section 3 bundle until the next nightly bundle has verified and a day has passed with no problems.
- [ ] Record the SHA and time in the handover notes.
- [ ] Remove `/etc/buddy-hub/hub.env.pre-069` once you no longer need the rollback.
- [ ] Event triggers stay `off` until an admin deliberately starts a dry run.
