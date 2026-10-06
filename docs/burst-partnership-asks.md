# Asks for the Claude Burst maintainer

Hi, and thank you for Burst. Plexiform (a desktop app that shows what your AI coding sessions are doing) has a Settings card that detects Burst, shows its state and lets a user turn it on or off with consent. We built it against v0.19.0 using only the loopback admin API and your own scripts, with no fork. A few small additions on your side would make that integration safer and less brittle. Everything below is a request, in rough priority order, and we are glad to help with any of it.

## 1. A versioned status contract

`GET /api/v1/status`, with a schema doc and a deprecation policy. Today we read `/api/state`, whose shape changes per release.

```json
{ "api": 1, "version": "0.19.0", "instance_id": "9f3c1e0a-...", "mode": "base-url",
  "active": true, "route": "PRIMARY", "until": null, "secondary_ready": true, "limit_near": false }
```

## 2. A handshake proof

The admin API has no authentication, so anything on :7788 can pose as Burst. Today we check that the listener is the `ninja.andrewbaker.claude-burst` LaunchAgent and that the executable is `~/.local/bin/claude-burst`, which is fragile. A per-install random `instance_id` stored at `~/.config/claude-burst/instance` (mode 0600) and echoed in `/api/v1/status` lets a client prove it is talking to the process that owns that file.

## 3. An events stream

`GET /api/v1/events` (SSE), so we stop polling:

```
event: route.failover
data: {"from":"primary","to":"secondary","until":"2026-10-06T14:05:00Z"}
```

Suggested events: `route.failover`, `route.recovered`, `limit.near`, `limit.reached` (with `session`), `compaction.done` (with `session`), `handover.written` (with `root`).

## 4. A CLI that works when the gateway is down

`claude-burst status --json` and `claude-burst version --json`, so an app can detect Burst and its mode when the admin port is silent.

## 5. Install without Terminal for base-url mode

Base-url mode needs no root. `claude-burst install --mode base-url --yes --repo <dir>` with machine-readable progress (JSON lines) would let us avoid a Terminal window for that mode. Transparent mode can stay a Terminal flow.

## 6. A documented uninstall contract

`install.sh uninstall --json` printing what was removed and what was kept, and documented exit codes for `burst-off` (for example 0 = out of the path, 1 = partially, 2 = nothing to do).

## 7. Session to repo, and per-session compaction state

Include the repo you already resolve internally (`repos.go`) in `/api/v1/usage` rows, and expose per-session compaction state:

```json
{ "session": "abc123", "repo": "plexiform", "provider": "together", "usd": 0.42 }
```

## What we promise in return

Only GET requests from an allow-list (plus `POST /api/upgrade` on an explicit Update click). We never proxy `/api/secondary-key`, never expose raw admin access to a renderer or any remote, and show your README's "What it changes on your Mac" text before every action.
