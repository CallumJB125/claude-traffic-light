# Deploying the hub on a Raspberry Pi (dogfood)

Topology: hub bound to 127.0.0.1:8787 → Cloudflare Tunnel (remotely managed; ingress
`<host>` → `http://127.0.0.1:8787`, Access enforced at the tunnel) → Cloudflare Access
(One-time PIN email IdP, allow policy = member emails only). Nothing listens publicly.

| File | What |
|---|---|
| `buddy-hub.service` | the hub as `buddyhub`, sandboxed; only `/var/lib/buddy-hub` writable |
| `hub.env.example` | `/etc/buddy-hub/hub.env` template (Access mode; dev auth is refused when a public URL is set) |
| `buddy-hub-backup.{service,timer}` + `backup.mjs` | nightly `VACUUM INTO` snapshot, 14 kept, in `/var/lib/buddy-hub/backups` |
| `add-member.mjs` | seed email-only members on the host before anyone can sign in |
| `deploy.sh` | ship `board/` at HEAD, `npm ci`, install units, restart, health check |

`BOARD_SECRET` is not needed: the hub generates one on first start and keeps it in the data dir.

## First deploy

1. Host prerequisites: Node ≥ 22, system user `buddyhub`, `/var/lib/buddy-hub` (buddyhub 0700),
   `/opt/buddy-hub` (root 0755), `/etc/buddy-hub` (root:buddyhub 0750).
2. `/etc/buddy-hub/hub.env` from `hub.env.example`, mode 0640 root:buddyhub.
3. From the laptop: `PI="ssh …" board/deploy/pi/deploy.sh`.
4. Seed the rest of the team:
   `sudo -u buddyhub node /opt/buddy-hub/board/deploy/pi/add-member.mjs a@x.com b@y.com`,
   then delete the `BOARD_BOOTSTRAP*` lines from hub.env and restart.
5. Tunnel: install the tunnel token and run cloudflared as a service.
6. Verify from outside the tailnet (a phone on mobile data): unauthenticated → blocked at the
   Cloudflare edge; an allowed email → one-time PIN → board.

## Staging beside production

`TARGET=staging PI="ssh …" board/deploy/pi/deploy.sh` deploys a second instance: unit `buddy-hub-staging`,
code in `/opt/buddy-hub-staging`, data in `/var/lib/buddy-hub-staging`, env `/etc/buddy-hub/staging.env`
(create it from `hub.env.example`; set `BOARD_PORT=8788`, its own `BOARD_PUBLIC_URL`, and never share the
production data dir). It never touches production's backup timer. Point a separate tunnel ingress at
`127.0.0.1:8788`. Any of `UNIT APP_ROOT ENV_FILE DATA_DIR PORT` can be overridden.

Rollback: `deploy.sh` keeps the previous tree at `/opt/buddy-hub/board.prev`; move it back and
restart. Restore a snapshot by stopping the hub, copying it over `board.db` and starting with
`BOARD_RESTORE=1` once.

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
