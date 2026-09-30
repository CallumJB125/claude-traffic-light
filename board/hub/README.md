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
| `BOARD_AUTH` | `access` | `access` (Cloudflare Access JWT), `dev` (cookie stub, loopback bind only; startup fails otherwise), `local` (the hub embedded in the desktop app, D35: `BOARD_BIND` must be `127.0.0.1`, `::1` or `localhost`, and `BOARD_PUBLIC_URL`, `BOARD_TUNNEL_PROBE_URL` and `BOARD_DEV_SEED` must be unset) or `accounts` (the hub's own email-code sign-in, desktop device tokens and web sessions, D51–D58, `ACCOUNTS-API.md`: needs `BOARD_SECRET`, and off a loopback bind an https `BOARD_PUBLIC_URL` plus `BOARD_RESEND_API_KEY` and `BOARD_MAIL_FROM`) |
| `BOARD_LOCAL_SECRET` | random per start | With `BOARD_AUTH=local`, **tests only**: the `board_local` cookie value (≥ 32 bytes). Unset: 32 random bytes (hex) per launch, sent only in the parentPort `board.listening` message, never logged or printed |
| `BOARD_ACCESS_TEAM` | — | Access team name: certs at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. Required for `access` |
| `BOARD_ACCESS_AUD` | — | The Access application AUD tag. Required for `access` |
| `BOARD_SECRET` | generated | ≥ 32 bytes. Signs run tokens and dev cookies. If unset, a secret is generated once and stored in `hub_meta` |
| `BOARD_PUBLIC_URL` | — | Public origin, e.g. `https://board.example.com`. Accepted as a same-origin `Origin` for mutations and WS upgrades |
| `BOARD_TRUST_CF_IP` | off | `accounts` only, loopback bind only: take the client IP for rate limits from `CF-Connecting-IP` (cloudflared on the same host) |
| `BOARD_RESEND_API_KEY` | — | `accounts`: Resend API key (sending access) for sign-in codes; removed from the environment once read. Unset: codes are printed to stderr (loopback bind only) |
| `BOARD_MAIL_FROM` | — | `accounts` with Resend: the From address, e.g. `Plexiform <signin@mail.example.com>` |
| `BOARD_DOWNLOAD_URL` | — | `accounts`: https URL of the desktop app download. `/download` (the invite page's "Download Plexiform for Mac" button) redirects there; unset → `404` |
| `BOARD_DEV_LOGIN_SECRET` | random per start | With `BOARD_AUTH=dev`: the secret `/api/dev/login` requires in the `Board-Dev-Secret` header (≥ 16 bytes). Unset: a fresh one is generated and printed to stderr at startup as `http://<bind>:<port>/#dev_secret=…` (the web keeps it for the tab) |
| `BOARD_DEV_SEED` | off | `1`: create org `dev`, board `DEV`, members `alice` (owner) and `bob`. Only with `BOARD_AUTH=dev` |
| `BOARD_DEV_REPO` | — | With `BOARD_DEV_SEED`: a git remote to add as the DEV board's repo |
| `BOARD_BOOTSTRAP` | — | `email` (Access one-time PIN, no GitHub identity) or `github_login,github_id,email`: on a DB with no members, create the org, a board and this owner |
| `BOARD_BOOTSTRAP_BOARD` | `Team:BRD` (`Me:ME` with `BOARD_AUTH=local`) | `Name:KEYPREFIX` for the bootstrap board. Under `local` the org takes the name, the board is always "My board" and takes the prefix |
| `BOARD_RESTORE` | off | `1`: apply the restore fence bump (+1000, new epoch) at boot. A `<BOARD_DB>.restored` marker does the same |
| `BOARD_TUNNEL_PROBE_URL` | — | Public URL of `/api/health`, probed every `BOARD_TUNNEL_PROBE_MS`. It counts as healthy only when the answer has the `Board-Protocol` header, so give `/api/health` an Access **Bypass** policy. While the probe fails, orphaning is suspended. Unset: the tunnel is assumed healthy |
| `BOARD_TUNNEL_PROBE_MS` | `15000` | Probe interval |
| `BOARD_GITHUB_TOKEN` | — | Read-only token (fine-grained: Pull requests + Contents read). Enables PR/commit verification and the Done merge poll. Unset: evidence stays `self_reported` and no auto-Done |
| `BOARD_GITHUB_API` | `https://api.github.com` | GitHub API base URL |
| `BOARD_GITHUB_POLL_MS` | `60000` | Merge poll interval for in-review cards |
| `BOARD_WEB_DIR` | `board/web` | Static web root (`/` → `index.html`, `/web/*`) |
| `BOARD_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |
| `BOARD_SHUTDOWN_GRACE_MS` | `5000` | How long a graceful shutdown waits for WS close handshakes and queued writes |

## Cloudflare Access

- Browsers: the hub verifies `Cf-Access-Jwt-Assertion` on every request and WS
  upgrade (RS256, `aud`, `exp`, `iss`) and maps the `email` claim to `members.email`.
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

## Additive routes (not in CONTRACT §5.2)

- `GET /api/boards/:board_id/alerts` → `{alerts: cardface.alertsFor(viewer, cards), notifications}`
  (the viewer's recent N-rule notifications; delivery channels come later).
- `POST /api/devices` also accepts `cf_service_token_id`.

## Tests

`npm test` in `board/`, or `node --test "hub/test/*.test.js"`. The tests use an
in-process hub (fake clock, temp DB, fake GitHub), fake runners and browsers over
real WebSockets on 127.0.0.1, and never touch `~`.
