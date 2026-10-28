# Deploying per-teammate send allowances (T4d, hub side)

Owner checklist for shipping migration `081_interaction_allowances` and the allowance routes to the hub on `bondly-pi`: **staging (port 8788) first, then production (port 8787)**. Nothing here has been run. Every command touches a host, so each is **owner-run, ask-first**. Companion to `board/deploy/pi/README.md`, `docs/HUB-DEPLOY-069-071.md` and `docs/HUB-DEPLOY-share-viewers.md`.

```sh
export PI="ssh bondly-pi"
```

## What is being deployed

| Change | Detail |
|---|---|
| Migration `081_interaction_allowances.sql` | One new table, `interaction_allowances` (share id, teammate id, grant and expiry times, who granted), one index and two guard triggers. Additive: no table is rebuilt and no existing row is touched. It stores no message text. |
| `PUT` / `DELETE /api/interaction/v1/shares/:share_id/allowances/:user_id` | Only the share owner's host device can grant or stop an allowance (every other caller gets 403/404). Only on a watch share, only for an acting team role (owner, admin, member), 1 to 240 minutes, never longer than the share. |
| `GET /api/interaction/v1/shares` | Every share now carries `allowances: []` (live ones listed). The desktop app uses its presence to know the hub supports this. |
| `GET /api/interaction/v1/shared` | A teammate's row adds `allowance: { expires_at }` while theirs is live. Their `scope` stays `watch`. |
| Relay frames | `share.allowance_until` is added to send and interrupt frames only, and only while an allowance grants them. |
| Proposals | Unchanged, except they now explicitly require a real interact share. |

How migrations run (`board/shared/migrate.js`): the hub applies every file not yet recorded in `schema_migrations` when it **starts**, in version order, each in its own transaction. A failing file rolls back and the hub refuses to start. A migration recorded under a different name than the file the hub ships stops the hub before it applies anything; if you see that error, stop and ask. Do not edit `schema_migrations`.

## Compatibility (so the order of deploys is not a worry)

| Desktop app | Hub | Result |
|---|---|---|
| older | new | Nothing changes. An older app never grants an allowance and reads shares as before. |
| new | **older** | Safe, and inert: the app sees no `allowances` in the share list, shows "Your team hub needs an update before you can allow one teammate to send." and offers nothing. It never calls the new routes. |
| older teammate app | new, allowance live | The teammate's list still says `watch`, so an older app stays watch-only (fail closed). |
| new | new | The feature works. |

The desktop app may therefore ship before or after the hub. Hub first is the tidy order, so the feature is live when people update.

## 0. Before you start

- [ ] The tree is committed on the branch you intend. Note the SHA: `git -C <repo> rev-parse HEAD`
- [ ] `ls board/shared/migrations/081_interaction_allowances.sql` exists in that tree.
- [ ] Board tests green on Node 22: `cd board && PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test`
- [ ] Note the current production SHA (this is also the rollback target): `$PI 'cat /opt/buddy-hub/board/DEPLOYED_SHA'`
- [ ] Pick a quiet time. Production restarts once (a few seconds of downtime) and runners reconnect on their own.

## 1. Staging (8788)

```sh
cd <repo>
TARGET=staging PI="$PI" board/deploy/pi/deploy.sh
```

- [ ] `$PI 'curl -fsS http://127.0.0.1:8788/api/health'` shows `"ok":true`
- [ ] `$PI 'cat /opt/buddy-hub-staging/board/DEPLOYED_SHA'` matches your SHA
- [ ] The migration applied: the journal shows no error and the hub started (a failed migration stops the hub from starting). Optional table check: `$PI 'sqlite3 <staging db path> "select version from schema_migrations order by version desc limit 1"'` shows 081.
- [ ] The route is live. The hub's own tests prove a token-less call is refused and a foreign share is 404 (`board/hub/test/interaction-allowances.test.js`, `board/hub/test/tenancy/routes-matrix.test.js`). This only confirms the deploy took effect: a `404` means the old code is still running, a `401` means the new code is:
  ```sh
  $PI 'curl -s -o /dev/null -w "%{http_code}\n" -X PUT -H "content-type: application/json" -d "{\"expires_in_s\":900}" http://127.0.0.1:8788/api/interaction/v1/shares/00000000-0000-4000-8000-000000000000/allowances/00000000-0000-4000-8000-000000000001'
  ```
  Expect `401`.
- [ ] Journal clean: `$PI 'sudo journalctl -u buddy-hub-staging -n 50 --no-pager'` shows no error or restart loop.
- [ ] With two staging accounts in one team and the new desktop build: share a session watch-only from one, open Share in its thread, choose a time for the other and Allow; the other can send until the time ends. (This step needs the desktop release; the hub alone is covered by the test suite.)

## 2. Production (8787)

Only after staging passes.

```sh
cd <repo>
PI="$PI" board/deploy/pi/deploy.sh
```

- [ ] Same checks as staging, against port 8787 and `/opt/buddy-hub/board/DEPLOYED_SHA`.
- [ ] Tell whoever releases the desktop app that the hub is live.

## 3. Rollback

The migration is additive (one new table that no older code reads). Redeploy the previous production SHA you noted in Section 0 (check it out, then run `deploy.sh` again), or restore `/opt/buddy-hub/board.prev` as `deploy.sh` documents. The table stays in the database, unused; an older hub starts fine with 081 applied. While rolled back, existing allowances simply stop working (fail closed) and the desktop app, which no longer sees `allowances` in the share list, hides Allow and drops what it held. Do not edit `schema_migrations`.
