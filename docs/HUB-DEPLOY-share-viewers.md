# Deploying share viewers (ledger 32, hub side)

Owner checklist for shipping `POST /api/interaction/v1/shared/:share_id/view` and `viewers` on `GET /api/interaction/v1/shares` to the hub on `bondly-pi`: **staging (port 8788) first, then production (port 8787)**. Nothing here has been run. Every command touches a host, so each is **owner-run, ask-first**. Companion to `board/deploy/pi/README.md` and `docs/HUB-DEPLOY-069-071.md`.

```sh
export PI="ssh bondly-pi"
```

## What is being deployed

- A route a teammate's desktop calls while a shared session is open, and a `viewers` list on each of the owner's shares.
- **No migration, no table, no protocol bump, no new env var.** Viewers live in hub memory only: a restart forgets them and they come back with the next beat (within 20 s).
- Desktop apps released before this change never send the beat; this hub works with them unchanged. A desktop released after it, talking to a hub without it, gets `404` and stops beating for that hub.
- **Order matters: deploy the hub to production before the desktop release that sends the beat.**

## 0. Before you start

- [ ] The tree is committed on the branch you intend. Note the SHA: `git -C <repo> rev-parse HEAD`
- [ ] Board tests green on Node 22: `cd board && PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test`
- [ ] Note the current production SHA (this is also the rollback target): `$PI 'cat /opt/buddy-hub/board/DEPLOYED_SHA'`

## 1. Staging (8788)

```sh
cd <repo>
TARGET=staging PI="$PI" board/deploy/pi/deploy.sh
```

- [ ] `$PI 'curl -fsS http://127.0.0.1:8788/api/health'` shows `"ok":true`
- [ ] `$PI 'cat /opt/buddy-hub-staging/board/DEPLOYED_SHA'` matches your SHA
- [ ] The route is live. The hub's own test suite already proves that, in accounts mode, a POST here without a token answers `401` and a foreign or unknown share answers `404` (`board/hub/test/interaction-shares.test.js`, "SHARE VIEWERS HOSTILE"; `board/hub/test/tenancy/routes-matrix.test.js`). This check only confirms the deploy took effect: a `404` means the old code is still running, a `401` means the new code is:
  ```sh
  $PI 'curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "content-type: application/json" -d "{\"viewing\":true}" http://127.0.0.1:8788/api/interaction/v1/shared/00000000-0000-4000-8000-000000000000/view'
  ```
  Expect `401`.
- [ ] Journal clean: `$PI 'sudo journalctl -u buddy-hub-staging -n 50 --no-pager'` shows no error or restart loop
- [ ] With two staging accounts in one team: share a session from one, open it on the other; after a few seconds the owner's share list shows the viewer (needs the desktop release, so this step waits for it; the hub alone is checked by the test suite).

## 2. Production (8787)

Only after staging passes.

```sh
cd <repo>
PI="$PI" board/deploy/pi/deploy.sh
```

- [ ] Same three checks as staging, against port 8787 and `/opt/buddy-hub/board/DEPLOYED_SHA`
- [ ] Tell whoever releases the desktop app that the hub is live

## 3. Rollback

There is no schema change, so no restore is needed. Redeploy the previous production SHA you noted in Section 0 (check it out, then run `deploy.sh` again), or restore `/opt/buddy-hub/board.prev` as `deploy.sh` documents. Viewers disappear; nothing else changes.
