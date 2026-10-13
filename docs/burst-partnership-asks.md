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

## 8. An embeddable dashboard

Plexiform now shows your dashboard inside its own window (a Usage optimiser page), loaded top-level in a sandboxed view of its own, because `X-Frame-Options: DENY` and `frame-ancestors 'none'` rule out an iframe. It works today by injecting CSS and reading the menu from the page, which is brittle. In rough priority order:

1. **`?embed=1`.** A mode that hides the `<header>` and `<aside class="side">` and drops the outer padding, so we do not hide them from outside.
2. **A stable, documented contract for theming.** A list of the CSS custom properties we may override (today: `--bg --panel --panel-2 --border --text --muted --faint --accent --ok --ok-bg --pass --pass-bg --warn --warn-bg --bad --bad-bg --mono --radius --head-bg --thead-bg --shadow --pc-a --pc-b --pc-c --pcs-saved --pcs-cost --grid`) and of the section ids the menu points at (`data-target` values such as `cards`, `sec-models`, `sec-compaction`), with a promise to rename them only with a deprecation note.
3. **Deep links.** `/#sec-models` (hash) and a `postMessage({ type: 'burst:goto', section: 'sec-models' })` listener, plus a read-only `postMessage` reply listing the sections (id, label, group), so an embedder does not parse your markup.
4. **Permission to be embedded by us.** A documented way to be loaded in a first-party webview: for example `Cross-Origin-Embedder-Policy`/frame policy that allows a named embedder, or an `embed=1`-only relaxation (`frame-ancestors` limited to a registered origin). Until then Plexiform keeps loading it top-level and refuses everything but your origin.

## 9. Avoiding duplicate work between us

1. **Plan utilisation (5h / 7d) in `/api/state` or `/api/v1/status`**, with the reset time, so we do not read the last replies' rate-limit headers from `/api/responses`.
2. **Who shows a notice.** A per-notice `shown_by` (`band`, `overlay`, `none`) in `notices.json`, or a client-claim call, so Plexiform and your overlay never both show the same event.
3. **Coordination status per repo.** "Active for repo X" in `/api/coordination`, so we can hide our own same-working-tree warning when yours is enforcing.
4. **Spend alerts.** `alert_daily_spend_usd` readable through `/api/settings`, and an option to defer spend alerts to an external budget owner.
5. **SessionStart briefings.** A machine-readable marker that context was already injected (or a shared size budget), so several SessionStart hooks do not stack briefings.

## What we promise in return

The embedded dashboard runs with no preload and no access to Plexiform's data, and can reach nothing but Burst's own address. Only GET requests from an allow-list (plus `POST /api/upgrade` on an explicit Update click). We never proxy `/api/secondary-key`, never expose raw admin access to a renderer or any remote, and show your README's "What it changes on your Mac" text before every action.
