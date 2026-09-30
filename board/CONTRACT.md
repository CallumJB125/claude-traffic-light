# Board contract (protocol v1)

Status: **LAW** for the four Phase 1 builders (hub, runner, web, board-mcp). 2026-09-30.

Sources, in precedence order:

1. This file and the code in `board/shared/` (pure, tested; `npm run test:shared`).
2. Phase 0 spike results: `../claude-buddy-board-spikes-2026-09-30.md`. They override the design where they conflict.
3. Design rev 5: `../claude-buddy-board-design-2026-09-30.md` (§ numbers below refer to it).

Where 2 or 3 left a choice open, this file decides it. Every such choice is listed in §12 Decisions (D1…). To change the contract: edit this file **and** `shared/protocol.js` (or the relevant shared module) in the same commit, bump `PROTOCOL_VERSION` if the change is not purely additive (§9), and keep `shared/test/protocol.test.js` green. That test fails if a message type, outbox kind, fact kind, error code, MCP tool, hook event, runner command or transition row id exists in code but is not named in this file.

Priorities, in order: **P1 Trust** (a dead agent never looks alive), **P2 No lost work** (handover is continuous, never written at death), **P3 Low admin** (Claude keeps the board current).

---

## 1. Package layout

```
board/
  package.json            ESM ("type":"module"), scripts: test, test:shared
  CONTRACT.md             this file
  shared/                 pure, dependency-free, browser-safe (except migrate.js)
    states.js             card/run state machine: TRANSITIONS + step()
    liveness.js           timers, green predicate, reaper timerEvent(), runner gate G, tick-gap sleep
    fence.js              (epoch, n) fence tokens, branch/ref names
    scope.js              repo scoping, path filter, redaction, THE outbox serializer
    overlap.js            overlap classification + budgeted team-context block
    cardface.js           card face (pill, reason, actions, sponsor) + alerts strip
    handover.js           handover model, patch, merge, markdown render, handoff memory text
    protocol.js           PROTOCOL_VERSION, error codes, message shapes, validate()
    schema.sql            SQLite schema = migration 001
    migrate.js            migration runner + applyRestoreBump (Node only)
    journal.js            append-only journal row kinds + replay() (§15)
    migrations/           002_device_form_factor.sql, 003_journal.sql
    test/                 node --test
  hub/                    board hub (Node ≥ 22.13, node:sqlite, ws). Serves web/ and shared/.
  runner/                 detached supervisor + hook shim + CLI (Node ≥ 22.13, ws)
  web/                    plain ES modules + CSS, no build step, served by the hub
  mcp/                    per-run stdio MCP server (@modelcontextprotocol/sdk)
```

Rules:

- **Imports.** Every package imports shared code by relative path (`../shared/states.js`). The web imports it from the hub at `/shared/*.js` (§5.1). No package imports another non-shared package, with one exception: `runner/` spawns `mcp/server.js` by path.
- **Tests** live in `board/<pkg>/test/*.test.js` and run with `node --test`. `npm test` (in `board/`) runs all of them. Tests use injectable clocks and temp dirs and never touch `~/.claude*`, `~/.codex`, `~/.claude-traffic-light` or the network.
- **Dependencies** (declared in `board/package.json`, installed into `board/node_modules`, never committed): `ws` (hub server + runner client; pure JS, no native addons), `@modelcontextprotocol/sdk` ^1.30 and `zod` ^4 (mcp). Nothing else without amending this file. `shared/` and `web/` stay dependency-free.
- The widget code outside `board/` is untouched. The runner may `createRequire` the widget's `hooks/session-state.js` and `hooks/session-machine.js` (CJS) to write widget session files (§6.10).

## 2. Runtime targets

| Package | Target | Process model |
|---|---|---|
| hub | Node ≥ 22.13 (unflagged `node:sqlite`), Raspberry Pi 5 arm64, no native deps | One process. One async single-writer queue per board: every state change is `step()` + its effects in **one** SQLite transaction. A 1 s reaper on the hub monotonic clock (`performance.now()`). Listens on `BOARD_BIND:BOARD_PORT` (default `127.0.0.1:8787`) behind Cloudflare Tunnel + Access |
| runner | Node ≥ 22.13, macOS first (Linux works), standalone | Detached supervisor (`spawn(node, [runner/cli.js, 'start'], {detached:true}).unref()` by Buddy later; runnable from a shell now). Spawns the member's own `claude` CLI per run. Talks to the hub over one outbound WSS |
| web | Evergreen browsers, plain ES modules + CSS | Static files served by the hub. No bundler, no framework, no npm deps |
| mcp | Node ≥ 22.13, `@modelcontextprotocol/sdk` stdio server | Spawned by the CLI per run (from the run's `--mcp-config`). Proxies every tool call to the runner over a local socket with the per-run token (§7) |

Clocks: the hub judges every timeout on its **own** monotonic clock at receive time. Runners send **ages** (`*_age_ms`), never instants to be compared. Browsers get `age_ms` and add their own `performance.now()` elapsed. Persisted timestamps are hub wall time (ISO UTC) and are only compared with other hub wall times (D11).

## 3. Shared modules (what builders call)

| Module | Key exports | Used by |
|---|---|---|
| `states.js` | `STATES`, `ACTIVE`, `DARK`, `LIVE`, `PLAN_APPROVAL_LABEL`, `BLOCKED_KINDS`, `FAIL_KINDS`, `RUNNER_FAIL_KINDS`, `TRANSITIONS`, `EVENTS`, `step(card, event, ctx)`, `columnOf`, `toDb`/`fromDb` | hub (authoritative), web (labels/columns) |
| `liveness.js` | all timer constants, `isGreen`, `toolBound`, `hasProgress`, `advanceView`, `timerEvent`, `gate`, `ackAge`, `sleptEstimate`, `reconnectDelay`, `formatAge` | hub (reaper, green), runner (gate, sleep, backoff), web (ageing) |
| `fence.js` | `makeFence`, `isCurrent`, `bump`, `restoreBump`, `formatFence`/`parseFence`, `branchName`, `snapshotRef`, `salvageRef`, `RESTORE_BUMP` | hub, runner |
| `scope.js` | `normalizeRemoteUrl`, `matchRepo`, `scopeOf`, `filterPath`, `redact`, `assertNoForeignBytes`, `serializeOutbound`, `ForeignBytesError`, `CREDENTIAL_PATTERNS` | runner (mandatory, §6.8), hub (normalise repo urls on create) |
| `overlap.js` | `classifyPair`, `computeOverlaps`, `overlapsFor`, `teamContextBlock`, `overlapDelta`, `TEAM_CONTEXT_BUDGET_TOKENS` | hub |
| `cardface.js` | `cardFace(view, {elapsed_ms, connection_lost})`, `sponsorLine`, `alertsFor`, `agentName`, `PILLS` | web (and hub tests) |
| `handover.js` | `SECTIONS`, `AGENT_WRITABLE`, `applyPatch`, `mergeHandover`, `renderMarkdown`, `syncAges`, `howToTakeOver`, `handoffMemoryText` | hub (store/render/seed), web (render JSON form) |
| `protocol.js` | `PROTOCOL_VERSION`, `ERRORS`, `httpStatus`, `WS_CLOSE`, `WS_PATHS`, `SHAPES`, `OUTBOX_SHAPES`, `FACT_KINDS`, `FEED_KINDS`, `OUTBOX_KINDS`, `RPC_METHODS`, `RUNNER_ONLY_RPC`, `MCP_TOOLS`, `MCP_OUTBOX_TOOLS`, `HOOK_EVENTS`, `RUNNER_COMMANDS`, `validate(channel, msg)`, `compatible` | all |
| `journal.js` | `JOURNAL_KINDS`, `CARD_STATE`, `replay(rows)` | hub (writes), tests/replay |
| `migrate.js` | `migrate(db, opts)`, `loadMigrations`, `currentVersion`, `applyRestoreBump` | hub |

## 4. Identity and auth

### 4.1 Members (browsers)

- **Production (`BOARD_AUTH=access`).** Cloudflare Access with GitHub as the only IdP sits in front of the hub. On every HTTP request and WS upgrade the hub verifies the `Cf-Access-Jwt-Assertion` header: RS256 against `https://<BOARD_ACCESS_TEAM>.cloudflareaccess.com/cdn-cgi/access/certs` (cached, refetched on unknown `kid`), `aud` contains `BOARD_ACCESS_AUD`, `exp` in the future. The verified `email` claim maps to `members.email` (case-insensitive) → the member. No match → `403 FORBIDDEN` ("not a member of this board"). Members are created by an admin with GitHub login + email (D4). Verification uses `node:crypto` only.
- **Local dev (`BOARD_AUTH=dev`).** Allowed **only** when the hub is bound to a loopback address; otherwise it refuses to start. `POST /api/dev/login {github_login}` sets cookie `board_dev=<member_id>.<hmac>` (HttpOnly, SameSite=Strict, HMAC with the hub secret). `BOARD_DEV_SEED=1` creates org `dev`, board `DEV` (key prefix `DEV`), members `alice`/`bob` (negative github ids) and repo from `BOARD_DEV_REPO` if set.
- Browsers never hold a token beyond the Access cookie (or the dev cookie). Mutating routes require `Content-Type: application/json` and reject a cross-origin `Origin` header (`403 FORBIDDEN`).

### 4.2 Runners (devices)

- **Enrolment.** A member calls `POST /api/devices {name}` and gets `{device_id, device_token}` once. `device_token` = `bdt_` + base64url(32 random bytes); the hub stores `sha256(token)` hex in `devices.token_hash`. The member runs `board-runner enroll --hub <url> --device <id> --token <token> [--cf-client-id … --cf-client-secret …]`, which writes `~/.board/device.json` (0600).
- **Every runner connection** sends `Authorization: Bearer <device_token>`. In production the runner also sends the device's Access service token (`CF-Access-Client-Id`, `CF-Access-Client-Secret`); Access turns that into a `Cf-Access-Jwt-Assertion` whose `common_name` must equal `devices.cf_service_token_id` of the same device. Revoked device (`revoked_at`) → close `4403`.
- **Run tokens.** On a successful claim the hub mints `run_token` = `brt1.<b64url(JSON{c:card_id,r:run_id,f:fence,e:hub_epoch})>.<b64url(HMAC-SHA256(BOARD_SECRET, payload))>`. The runner passes it to board-mcp and the hook shim (env `BOARD_RUN_TOKEN`), checks it on every local IPC call, and attaches it to every `rpc` and outbox message's run. The hub verifies the HMAC, then that `r`/`c` match an **unended** run and `f` is the card's current fence. So a fence bump kills every token of the old run (T4).
- Hub secrets: `BOARD_SECRET` (env, ≥ 32 bytes) or, if absent, generated once and stored in `hub_meta.k='secret'` (D12).

## 5. Browser ↔ hub

### 5.1 Static

| Path | Serves |
|---|---|
| `GET /` | `web/index.html` |
| `GET /web/*` | `web/` files |
| `GET /shared/*.js` | `shared/` browser-safe modules only: `states`, `liveness`, `fence`, `scope`, `overlap`, `cardface`, `handover`, `protocol` (never `migrate.js`, never `schema.sql`) |

All with `Cache-Control: no-cache` and ETag. Content-Security-Policy: `default-src 'self'; connect-src 'self'; img-src 'self' https://avatars.githubusercontent.com; style-src 'self'; script-src 'self'`.

### 5.2 HTTP API

All JSON. Every response carries header `Board-Protocol: 1`. Errors are `{"error":{"code":"<CODE>","message":"…", …extra}}` with the status from `protocol.ERRORS`. Every mutating request carries a client-generated `request_id` (uuid). The hub remembers `(member_id, request_id) → response` for 10 min and replays it (D8). `dispatch`-like actions are additionally idempotent in the DB via `dispatches.request_id`.

| Method + path | Auth | Body | 200 response | Errors |
|---|---|---|---|---|
| `GET /api/health` | none | — | `{ok, protocol, hub_epoch, uptime_ms, auth:'access'\|'dev'}`. The web offers dev login only when `auth` is `dev` | — |
| `GET /api/me` | member | — | `{member, org, boards:[{id,name,key_prefix}]}` | 401, 403 |
| `POST /api/dev/login` | dev only | `{github_login}` | `{member}` + cookie | 404 when not dev |
| `GET /api/boards/:board_id` | member | — | `Snapshot` (as the WS `snapshot` body) | 404 |
| `POST /api/boards/:board_id/cards` | member (not viewer) | `{request_id, title, body?, acceptance?, repo_id?, base_ref?, labels?, budget_usd?, assignees?}` | `{card: CardView}` | `VALIDATION`, `NOT_FOUND` |
| `GET /api/cards/:card_id` | member | — | `CardDetail` (§5.4) | 404 |
| `PATCH /api/cards/:card_id` | member (not viewer) | `{request_id, version, title?, body?, acceptance?, labels?, assignees?, repo_id?, base_ref?, column?}` | `{card}` | `VERSION_CONFLICT` (stale `version`), `CONFLICT` (column change while a run state exists), `VALIDATION` |
| `POST /api/cards/:card_id/actions/:action` | member | `{request_id, …action args}` | `{card, run_id?}` | from `step()` (§10.1), 404 |
| `POST /api/permission-requests/:id/answer` | member in `approvers` | `{request_id, decision:'allow'\|'deny', scope?:'once'\|'run'}` | `{permission_request, card}` | `ALREADY_ANSWERED` (+`answered_by`), `FORBIDDEN` |
| `POST /api/cards/:card_id/comments` | member | `{request_id, body, for_agent?:bool, reply_to?}` | `{comment}` | `VALIDATION` |
| `GET /api/cards/:card_id/handover?format=json\|md` | member | — | json: `{doc, ages, markdown}`; md: `text/markdown` | 404 |
| `GET /api/cards/:card_id/overlap-preview?target_member_id=` | member | — | `{overlaps:[OverlapView], sponsor:string}` for the Give to Claude dialog | 404 |
| `GET /api/devices` / `POST /api/devices` / `DELETE /api/devices/:id` | member (own devices; admin all) | `{request_id, name}` | list / `{device_id, device_token}` (once) / `{ok}` | `FORBIDDEN` |
| `GET /api/repos` / `POST /api/repos` | member / admin | `{request_id, url, short_name?, default_branch?}` | `{repo}`; `canonical_url = normalizeRemoteUrl(url)` | `VALIDATION` (null canonical) , `CONFLICT` |
| `POST /api/boards/:board_id/repos` | admin | `{request_id, repo_id}` | `{ok}` | — |
| `GET /api/boards/:board_id/journal?after_seq=&limit=` | member (board's org) | — | `{rows:[{seq, board_id, card_id, run_id, at_hub, hub_epoch, actor_kind, actor_id, kind, payload}], next_after_seq}`; this board's rows only, `seq` ascending, `limit` ≤ 1000 (default 200) | 404 |
| `POST /api/members` | admin | `{request_id, github_login, github_id, email, display_name, role}` | `{member}` | `CONFLICT` |

**Actions** (`:action` → `states.js` event; the hub builds `ctx` per §10.2):

| `:action` | Extra body | Event | Notes |
|---|---|---|---|
| `dispatch` | `target_member_id?` (null = me), `backend?` (`claude_cli` only in Phase 1), `budget_usd?` (> 0) | `dispatch` | `budget_usd` becomes the card's cap (`cards.budget_cents`), is checked by `policy_ok`, rides `offer.budget_usd`; the runner passes min(it, local `budget_per_run`) as `--max-budget-usd`. Creates `dispatches` row. `needs_confirm = target ≠ dispatcher ∧ dispatcher ∉ target runner's advertised auto_accept_from` (display only; the runner decides) |
| `cancel` | — | `cancel` | queued only |
| `stop` | — | `stop` | |
| `retry` | `target_member_id?`, `budget_usd?` | `retry` | |
| `take_over` | `confirm?:bool` | `take_over` | `confirm:true` required from suspended/unresponsive (`CONFIRM_REQUIRED` otherwise) |
| `hand_over` | `target:{kind:'queue'\|'member'\|'self', member_id?}` | `hand_over` | |
| `take_over_with_claude` | `target_member_id?`, `budget_usd?` | `redispatch` | from handed_over; `budget_usd` as for `dispatch` |
| `take_over_myself` | — | `take_myself` | from handed_over |
| `request_changes` | `comment` | `request_changes` | comment stored + seeded |
| `approve_done` | — | `approve_done` | |
| `answer` | `ask_id, answer` | `answer` | for `asks` (question/clarify/decision/plan/conflict/loop); permission requests use their own route |

### 5.3 WebSocket `/ws/board`

Read-only push; every mutation goes over HTTP. Frames are JSON text. Server pings every 20 s (WS ping frame); client may send `ping` → `pong`.

Client → hub (`browser→hub` in `protocol.SHAPES`):

- `hello {protocol}` — first frame. Incompatible → `error{code:'PROTOCOL_UNSUPPORTED'}` then close `4426`.
- `subscribe {board_id}` → hub replies `snapshot`, then streams patches for that board. One board per socket in Phase 1 (a second `subscribe` replaces the first).
- `unsubscribe` `{board_id}`, `ping {}`.

Hub → client (`hub→browser`):

- `welcome {protocol, hub_epoch, member}`.
- `snapshot {board_id, board:{id,name,key_prefix,settings}, cards:CardView[], members:[{member_id,name,login,avatar_url}]}`.
- `card.upsert {board_id, card:CardView}` — full replacement of one card's view, sent on any change to it.
- `card.remove` `{board_id, card_id}`.
- `lease.tick` `{card_id, live:LeaseView, state_age_ms}` — at most 1/s/card (`TICK_MAX_RATE_MS`), only for cards in `ACTIVE`, only when something changed or every 5 s.
- `event.append {card_id, event:FeedEvent}`.
- `pong {}`, `error {code, message}`.

When the socket drops, the web shows one banner "Board connection lost: states as of HH:MM:SS" and renders every card with `cardFace(view, {connection_lost:true})`. It never marks cards unresponsive itself. On reconnect it re-subscribes and replaces everything with the new `snapshot`. A changed `hub_epoch` needs nothing special.

**`CardView`** (the one card shape the web renders; `cardface.js` reads exactly these fields):

```
{ id, key, title, labels:[string], column, version,
  run_state,                      // states.js name ('todo' when none)
  blocked_kind, fail_kind, fail_reason, resume_to, fence,
  repo: {id, short_name} | null, base_ref, branch,
  assignee_ids:[member_id], approvers:[member_id],   // approvers of the open permission request, if any
  viewer_can_approve: bool,                          // computed per viewer
  target: {member_id, name, is_viewer, awaiting_confirm, device_name?} | null,   // queued / todo dispatch target
  queue: {runner_online: bool, offline_age_ms} | null,
  run: {id, backend, device_name, owner:{member_id,name}, dispatched_by:{member_id,name}} | null,
  live: LeaseView | null,         // ACTIVE states only
  state_age_ms,                   // time in run_state (hub clock, at send)
  ask: {kind, summary, count, steps?, permission_request_id?, ask_id?} | null,   // ids of the oldest open request/ask: the card face answers in one click
  handover: {version, synced_age_ms} | null,
  handover_target_name, stopped_by_name,
  limit_resets_in_ms,             // failed{limit}: run.failed.resets_in_ms minus the time since the hub received it; else null
  device_kind: 'laptop' | 'desktop' | null,   // the run device's devices.form_factor (runner hello.form_factor)
  overlaps: [OverlapView],
  budget: {spent_usd, cap_usd} | null,
  pr: {number, url, state:'open'|'merged'|'closed', merged_by?, merged_age_ms?} | null,
  evidence: {tests:'pass'|'fail'|'none'|null, verification:'hub_verified'|'self_reported'} | null }

LeaseView  = { hb_age_ms, child_alive, activity_age_ms,
               tool_in_flight: {name, summary, age_ms, bash_timeout_ms?} | null,
               wake_age_ms, post_wake_activity, green }   // green = hub's isGreen at send
OverlapView = { other_card_id, other_key, other_owner, level, kind:'overlapping'|'adjacent', reasons:[..], paths:[..], age_ms }
FeedEvent  = { id, kind, at_age_ms, actor_name?, run_n?, text?, data }  // kind ∈ protocol.FEED_KINDS (below)
```

`FEED_KINDS` = every `states.js` feed effect (incl. `withdrawn`), the hub-recorded `created`, `comment` (a human or agent comment, `data.comment_id`), `progress` (`board_append_progress` / `board_complete` summary, `text`), `evidence`, `plan_declared`, `handover_frozen`, `salvage`, and the displayed fact kinds `file`, `git`, `command`, `plan`, `error`, `subagent`, `message`, `compacted`, `cost`, `session`, `degraded`. Every other `events` row (`activity`, `facts`, `tool_start`/`tool_end`, the raw outbox kinds such as `run.failed`) is internal and never sent. The web has a label for every `FEED_KINDS` entry (`web/test/render.test.js`).

On the card face, an approver (`viewer_can_approve`) of an open permission request gets one-click **Allow** (scope `once`) and **Deny** buttons that call `POST /api/permission-requests/:id/answer` with `ask.permission_request_id` (first answer wins); everyone else opens the drawer.

The hub computes `green` with `liveness.isGreen`; the web recomputes it from ages every second with `cardFace` and shows green only if both agree (D13).

### 5.4 `CardDetail`

```
{ card: CardView, body, acceptance,
  run: {…CardView.run, fence, status_summary, cost_usd, planned_paths, touched_paths, snapshot:{sha,ref,status,reason,age_ms}|null} | null,
  handover: {doc, ages, markdown} | null,
  feed: [FeedEvent] (last 200),
  comments: [{id, author_name, source, trusted, body, for_agent, reply_to, delivered_age_ms, created_age_ms}],
  permission_requests: [{id, tool, input_summary, state, scope, approvers:[member_id], answered_by_name, created_age_ms}],
  asks: [{id, kind, text, options:[string]|null, state, answer, answered_by_name, created_age_ms}],
  evidence: [{id, run_id, kind, ref, summary, result, verification, created_age_ms}],
  overlaps: [OverlapView],
  memories: [{id, kind:'handoff', body, status, created_age_ms}] }
```

Permission request `state`: `open` (answerable) → `allowed` | `denied` (a human answered; `answered_by_name`), `cancelled` (the run ended, or the CLI cancelled the prompt: `approval_cancel`), or `parked` (the run was parked while it was open; still answerable, and the answer requeues the card per row `11`; it becomes `cancelled` once the card leaves `parked`). Ask `state`: `open` → `answered` | `cancelled`. `scope` is `once` | `run` | null.

The web renders handover markdown as **text** (escape everything; only headings, lists, code spans and code blocks are formatted). No HTML from any agent- or human-written field is ever injected.

## 6. Runner ↔ hub

### 6.1 Connection

`wss://<hub>/ws/runner` with the §4.2 headers. Reconnect with `liveness.reconnectDelay(attempt)` (exponential, full jitter, **cap 30 s**). A second connection from the same device replaces the first (old one closed `4409`).

1. Runner → `hello {protocol, device_id, runner_version, outbox_head_seq, runs:[{run_id, card_id, fence, local_state}], form_factor?}` where `local_state` ∈ `running | paused_offline | fenced | ending` and `form_factor` ∈ `laptop | desktop` (battery present; `policy.json` `form_factor` overrides). The hub stores it in `devices.form_factor` (migration 002).
2. Hub → `welcome {protocol, hub_epoch, device_id, member_id, last_seq_acked, allowlist:[{repo_id, canonical_url, aliases}]}`. `allowlist` = every repo on any board the device's member belongs to (the input to `scope.matchRepo`, D14).
3. Runner replays every outbox entry with `seq > last_seq_acked`, in order, as `out` frames (with `delayed:true`), then sends `advertise`, then its first `hb` immediately (not waiting for the 15 s tick).
4. Hub re-sends pending `offer`s for this device and any `cmd` still implied by card state (e.g. `stop` for a run whose card is failed/handed_over).

### 6.2 Runner → hub frames (`runner→hub`)

| Type | Body | Semantics |
|---|---|---|
| `hello` | above | — |
| `advertise` | `{repos:[{repo_id, canonical_url, approvals_from:[member_id], auto_accept_from:[member_id]}]}` | Replaces `runner_repos` for this device. Only repos opted in locally **and** on a board allowlist the runner learned from `welcome`/offers (D14). The hub never opts anyone in |
| `claim` | `{id, card_id, request_id, expected_fence}` | CAS claim (§6.4). Not outboxed; retried with the same `request_id` |
| `decline` | `{card_id, request_id, reason?}` | Owner declined a teammate's dispatch in the local confirm → event `decline` (#`2b`) |
| `hb` | `{seq_hb, mono_ms, wall_ms, slept_ms, runs:[RunHb]}` | Every `HB_MS` = 15 s per device, even with no runs (presence). Not outboxed |
| `host.suspending` | `{runs:[{run_id, card_id, fence}]}` | From Buddy's powerMonitor relay → event `host_suspending` per run. Sent immediately, not outboxed |
| `out` | `{seq, delayed, msg:OutboxMsg}` | Durable outbox entry (§6.5) |
| `rpc` | `{id, method, run_id, card_id, fence, repo_id, run_token, params}` | Needs the hub now; `method` ∈ `RPC_METHODS` (§6.6) |
| `salvage` | `{run_id, card_id, fence, repo_id, kind:'handover'\|'snapshot'\|'note', payload}` | Append-only, **accepts stale fences**, never changes state (§6.9). Built by `serializeOutbound` under the run scope; `repo_id` ≠ the run's → `FORBIDDEN` |

`RunHb = {run_id, card_id, fence, child_alive, tool_in_flight:{name, summary, age_ms, bash_timeout_ms?}|null, last_activity_age_ms, cost_usd, post_wake_activity, wake_age_ms, gate:'open'|'closed', local_state}`. Ages are measured by the runner at send time; the hub converts each to its own monotonic clock as `rx_mono − age`.

### 6.3 Hub → runner frames (`hub→runner`)

| Type | Body | Semantics |
|---|---|---|
| `welcome` | above | — |
| `ack` | `{seq, versions?:[{seq, version}]}` | Cumulative: every outbox seq ≤ `seq` is durably applied (or deduped). Runner may drop them. `versions` gives the hub's handover version for each `handover.write` applied since the last ack (so `board_write_handover` returns a hub-confirmed version) |
| `offer` | `{card_id, key, title, body, repo_id, base_ref, fence, request_id, dispatched_by:{member_id,name}, needs_confirm, labels, budget_usd, max_turns, require_plan_approval, seed}` | Sent to every connected device of the target member that advertised `repo_id`. `fence` = the current fence, to be sent back as `expected_fence`. `seed` = `{handover_md?, answer?, review?, comments?:[…], from_snapshot?:{ref, sha}, prev_run_n?}` |
| `offer.withdrawn` | `{card_id, request_id, reason}` | Cancelled, claimed elsewhere, or card changed |
| `claim.result` | `{re, ok, run_id?, fence?, branch?, snapshot_ref?, run_token?, team_context?:{text,tokens}, error?}` | `ok:false` → `error.code` = `CLAIM_LOST` (lost the CAS or the card is no longer queued), `POLICY_DENIED`, `REPO_NOT_ADVERTISED`. The loser spawns nothing |
| `hb.ack` | `{seq_hb, hub_epoch, runs:[{run_id, fence, current, state, reason?}]}` | **`current:true` is the fence-confirming ack that keeps/reopens gate G.** `current:false` with `reason` `FENCED`\|`RUN_ENDED` → zombie revival (§6.9) |
| `cmd` | `{cmd_id, run_id, card_id, fence, cmd, wait_ms?, reason?}` | `cmd` ∈ `stop`, `park`, `handover_begin`, `interrupt` (§6.7). Idempotent by `cmd_id` |
| `answer` | `{run_id, card_id, fence, ask_id?, permission_request_id?, decision?:'allow'\|'deny', scope?:'once'\|'run', answer?, answered_by:{member_id,name}}` | Deliver to the agent (§7.4). The runner re-checks `answered_by` against its local policy before applying (T1); failing the re-check = deny (fail-closed) + a `message` fact |
| `comment.deliver` | `{run_id, card_id, fence, comments:[{comment_id, author_name, body, created_age_ms}]}` | Trusted @claude comments. Runner acks with outbox `comment.delivered` |
| `context.update` | `{run_id, card_id, fence, team_context:{text,tokens}, delta?, overlap_ids?}` | New team-context block (injected at next SessionStart/UserPromptSubmit) and optional one-time PostToolUse delta (`overlapDelta`) |
| `fenced` | `{run_id, card_id, held_fence, current_fence}` | Explicit fence notice (also implied by `hb.ack current:false`) |
| `rpc.result` | `{re, ok, result?, error?}` | — |
| `error` | `{code, message, re?}` | Non-fatal protocol error |

### 6.4 Claim

1. Offer arrives. The runner checks its **local** `policy.json` (authoritative): repo opted in; dispatcher is the owner, or in `accept_from[repo_id]` (auto-accept), else ask the owner via Buddy (local confirm, T1); concurrency < `max_concurrent`; no `never_auto` label.
2. `claim {id, card_id, request_id, expected_fence}`. The hub runs `step(card, {type:'claim', expected_fence}, ctx)` (#`3`: CAS on `run_state='queued' AND fence=expected`, fence+1, `runs` row, lease). Result → `claim.result`.
3. On `ok`: fetch base ref, create worktree `~/.board/worktrees/<repo_id>/<KEY>-r<fence>` on branch `branchName(KEY, fence)` (from `seed.from_snapshot` when present: fetch `refs/board/<KEY>/*` explicitly, spike 7), write run dir, spawn the CLI (§7.1). The runner itself enforces `T_CLAIM_MS`: no `system/init` + first activity within 120 s → `prep.failed` (#`5`).

### 6.5 Outbox

- Append-only NDJSON log at `~/.board/outbox/<device_id>.ndjson` plus `acked.json` (`{seq}`), written with `writeJsonAtomic`-style rename. `seq` is per device, starts at 1, strictly increasing, never reused (persist the head before sending).
- Every hub-bound message about a run is **constructed from scoped data and serialized only by `scope.serializeOutbound(msg, scope, {requireRepoId:true})`**. The outbox never holds bytes that did not pass it (exit f).
- `delayed:true` when the entry is a replay or was created while disconnected. Delayed `activity` never moves a card (rows `n-activity-delayed`, D3).
- The hub dedupes by `UNIQUE(device_id, seq)` in `events`, applies in seq order, and acks cumulatively. A stale-fence outbox entry is **acked and dropped** (recorded as a `salvage` note event), never retried forever.

`OutboxMsg` kinds (`protocol.OUTBOX_SHAPES`; every one carries `kind, run_id, card_id, fence, repo_id`):

| Kind | Extra | Hub action |
|---|---|---|
| `activity` | `source` (`init`\|`tool_start`\|`assistant`\|`tool_end`\|`mcp`) | `step(activity)` (#`4`, #`7`). Throttled by the runner to ≤ 1 per 5 s per run |
| `facts` | `items:[Fact]` | Merge into `runs.facts`/`touched_paths`, feed, overlap recompute (debounced `OVERLAP_DEBOUNCE_MS`) |
| `run.failed` | `fail_kind` ∈ `RUNNER_FAIL_KINDS`, `reason`, `resets_in_ms?` (`limit`: from the stream's `rate_limit_event.resetsAt`) | `step(run_failed)` (#`22`); `resets_in_ms` feeds `CardView.limit_resets_in_ms` |
| `prep.failed` | `cause` | `step(prep_failed)` (#`5`) |
| `handover.complete` | — | `step(handover_complete)` (#`27b`) — after the final snapshot push + release |
| `snapshot` | `status` (`pushed`\|`push_failed`\|`held`), `sha`, `ref`, `reason` | Update `runs.snapshot_*` (the code layer's "last synced") |
| `handover.write` | `patch` | `handover.applyPatch` → new `handovers` version (`written_by:'claude'`) |
| `progress.append` | `text` (≤ 500) | Feed line |
| `status.update` | `summary` (≤ 140) | `runs.status_summary` |
| `comment.create` | `text`, `reply_to` | Comment with `source:'agent'`, `trusted:1`, `author_run_id` |
| `comment.delivered` | `comment_ids`, `via` (`post_tool_use`\|`stdin`) | "seen by Claude" |

`Fact` items (`protocol.FACT_KINDS`, paths repo-relative via `filterPath`, texts via `redact`): `tool_start {name, summary, bash_timeout_ms}`, `tool_end {name, ok, duration_ms}`, `file {path, op:'edit'|'write'|'read'|'delete'}`, `command {cmd, exit, duration_ms, tail}` (tail ≤ 20 lines, only for commands matching the repo's `test_patterns`), `error {first_line}`, `git {branch, head_sha, commits_ahead, commits_behind}`, `plan {items:[{text,status}]}` (TodoWrite mirror), `subagent {summary}` (≤ 500), `message {text}` (≤ 500, last assistant message clipped), `compacted {}`, `cost` `{cost_usd, num_turns}`, `session` `{session_id, event}`, `degraded {reason}`.

### 6.6 RPC methods

Every `rpc` is verified (run_token, fence current, run unended, `repo_id` matches the run) before the method runs. Offline, the runner answers the caller with `HUB_UNREACHABLE` itself.

| Method | Params | Result | Notes |
|---|---|---|---|
| `board_get_card` | `{key?}` | `{card, acceptance, handover_md, open_asks, comments}` | own card, parent or children only |
| `board_list_cards` | `{column?, mine?}` | `{cards:[{key,title,column,run_state}]}` | same board **and** same repo only |
| `board_ask_human` | `{kind:'question'\|'clarify'\|'decision', text, options?}` | `{ask_id}` | creates `asks` row + `step(block)`; `ONE_OPEN_ASK` if one is open |
| `board_attach_evidence` | `{kind, ref, summary, result?}` | `{evidence_id, verification}` | PR/commit verified via GitHub API → `hub_verified`, else `self_reported` |
| `board_complete` | `{summary, evidence_ids}` | `{state:'in_review'}` | `EVIDENCE_MISSING` unless a `hub_verified` pr or pushed commit **and** a `test_run` or `no_tests_reason` |
| `board_release` | `{reason, requeue}` | `{state}` | #`24` / #`25`; `POLICY_DENIED` when requeue isn't allowed |
| `board_declare_plan` | `{summary, paths, areas?}` | `{overlaps:[…]}` | sets `runs.planned_paths` (repo-relative globs) |
| `board_check_overlap` | `{}` | `{overlaps:[OverlapView], locks:[]}` | same repo only |
| `board_recall` | `{paths?, query?, kinds?}` | `{memories:[…]}` | Phase 1: `handoff` kind only; stale ones labelled |
| `approval` | `{tool_name, input_summary, tool_use_id?}` | `{permission_request_id}` | creates `permission_requests` (approvers = owner, dispatcher, assignees, owner's `approvals_from`) + `step(block{permission})`; the decision arrives later as `answer` |
| `approval_cancel` | `{permission_request_id}` | `{state}` | The CLI cancelled the held prompt (board-mcp → IPC `cancel` → runner). An `open` request of this run becomes `cancelled` and the card gets `step(withdraw)` (rows `9w`/`9wb`/`9wd`: unblocks when nothing else is open); already answered → its state, unchanged. Idempotent. Runner-only (not an MCP tool, like `team_context`) |
| `team_context` | `{}` | `{text, tokens}` | `overlap.teamContextBlock` within the board's `team_context_budget` (default 700) |

### 6.7 Commands and the stop recipe (spikes 1c, 5b–5e)

| `cmd` | Runner does |
|---|---|
| `interrupt` | stdin `{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}`; SIGINT if no `control_response` in 2 s |
| `stop` | **Stop recipe**: interrupt → wait ≤ `INTERRUPT_WAIT_MS` (5 s) → end stdin → SIGTERM → after `STOP_GRACE_MS` (10 s), if the CLI pid **and** its start time (`lstart`) still match: SIGKILL it and `kill -9 -- -<pgid>` every descendant process group (Bash tool trees have their own pgid and reparent to 1). Then snapshot, final facts, exit the run |
| `park` | Stop recipe after asking for a final handover (as `handover_begin` with `wait_ms` 30 s); the hub already bumped the fence, so the final writes go as `salvage` (§6.9, D7) |
| `handover_begin` | Inject "write your final handover now via board_write_handover" at the next tool boundary (PostToolUse `additionalContext`, or a stdin user message if idle), wait ≤ `wait_ms` (90 s) for `board_write_handover`, then stop recipe, snapshot + push, `handover.complete` |

**Terminal state comes from the stream's `result` message** (`subtype`, `total_cost_usd`, `num_turns`, `terminal_reason`, `permission_denials`), never from the Stop hook (Stop does not fire on `error_max_budget_usd`, spike 3). Mapping: `success` after `board_complete` → nothing (hub already moved); `error_max_budget_usd` → `run.failed{budget}`; rate-limit / usage-limit → `run.failed{limit}` (3 backoff retries first for transient 429s); network patterns → `network` (reuse `failureOf()` regexes from `hooks/set-status.js`); anything else, or CLI exit without `result` → `error`. `--max-budget-usd` overshoots by one API call: the budget is soft by one call (spike 8 in "Design changes forced").

### 6.8 Scope and gate (runner obligations)

- `scope.scopeOf({cwd, toplevel, remote_url}, {allowlist, opted_in})` runs before anything about a session is built. `null` → nothing is built (exit f). `allowlist` entries may be canonical (`github.com/o/r`, what the hub stores and sends in `welcome`) or remote URLs; `matchRepo` normalises both. Only allowlist names get this leniency: a session's `remote_url` must be a real network remote.
- **Identity input (D27):** `remote_url` = `git config --get remote.origin.url` (the URL the member configured), not `git remote get-url origin` (which expands `url.<base>.insteadOf`). insteadOf is a local transport rewrite (SSH↔HTTPS, a mirror, a local bare repo in tests); the repo's identity is the name the member gave it. Both are fail-safe: a rewrite to a different host can only make a session *not* match.
- Every path in a fact goes through `filterPath(p, toplevel)`; `null` → the path is dropped. Every free text goes through `redact(text, toplevel)`.
- Gate G is `liveness.gate({ack_age_ms: ackAge(...), fenced, wake})` evaluated on the runner's clocks, where the ack is the last `hb.ack` with `current:true` for that run. Sleep is detected with the tick-gap detector (`sleptEstimate`, 1 s tick) plus Buddy's powerMonitor relay (spike 8: `hrtime` includes sleep on macOS, so Δwall − Δmono is useless). Closing the gate = PreToolUse denies everything + `interrupt` (SIGKILL after 10 s) + local snapshot + `local_state:'paused_offline'`. A 530/1033 from the edge ("origin down") never reopens a closed gate. Only a `current:true` ack does.

### 6.9 Zombie revival and salvage

`hb.ack current:false` (or `fenced`, or an `rpc` answered `FENCED`/`RUN_ENDED`): set `fenced` (PreToolUse denies "this card was taken over"), interrupt then stop recipe, snapshot to `salvageRef(KEY, n)` (push if possible), send `salvage` frames (handover narrative, snapshot ref, note), tell Buddy. **Promotion rule (D7):** the hub records salvage as events; when a salvage `handover`/`snapshot` comes from the card's **most recent** run and no newer run has been claimed, the hub also promotes it to the current handover version / snapshot with provenance `post_fence`. This is how `park`, `stop` and timed-out handovers keep their final narrative.

### 6.10 Local surfaces (runner-internal, for Buddy later)

`~/.board/` (`BOARD_HOME`), dir 0700: `device.json` (0600), `policy.json` (0600, runner-local, authoritative, never synced: `{repos:{repo_id:{opt_in, local_path, allowed_domains, allow_write_extra, bash_allow, max_concurrent, budget_per_run, budget_per_day, share_level, approvals_from}}, accept_from:{repo_id:[member_id]}, backends:{claude:'/path/to/claude'}, never_auto_labels}`), `outbox/`, `ledger.json` (runs: `run_id, card_id, fence, pid, lstart, pgid, worktree, session_id, run_dir`), `run/<run_id>/` (0700: `settings.json`, `mcp.json`, `ipc.sock`), `worktrees/`. Control socket `~/.board/runner.sock` (NDJSON, 0600) for Buddy: `status`, `opt_in`, `confirm_offer {request_id, accept}`, `stop_all` (works with the hub down), `host_suspending`, `host_resumed`.

On supervisor restart: every ledger run whose pid + lstart still match is an orphan → stop recipe → snapshot → `run.failed{error, reason:'supervisor crash'}` (#`22` from any active state incl. unresponsive/orphaned).

Widget session files: the runner writes one session file per run through the widget's own `hooks/session-state.js` into `$CLAUDE_TRAFFIC_LIGHT_HOME/sessions` (default `~/.claude-traffic-light/sessions`), tagged with the card key, so Phase 1 needs no widget change. Tests set `CLAUDE_TRAFFIC_LIGHT_HOME` to a temp dir.

## 7. Runner ↔ CLI, board-mcp and the hook shim

### 7.1 Launch profile (design §3.2.1 as amended by spikes 2–5)

```
<claude> -p \
  --input-format stream-json --output-format stream-json --verbose \
  --session-id <uuid v4> \
  --setting-sources "" \
  --settings <run_dir>/settings.json \
  --strict-mcp-config --mcp-config <run_dir>/mcp.json \
  --tools "Read,Edit,Write,Glob,Grep,Bash,TaskCreate,TaskUpdate,TaskList,TaskGet,Task" \
  --disallowedTools "WebFetch" "WebSearch" "Bash(git push --force*)" "Bash(git push -f*)" "Bash(git push * +*)" \
     "Read(~/.ssh/**)" "Read(~/.aws/**)" "Read(~/.config/gh/**)" "Read(~/.claude/**)" "Read(~/.claude.json)" \
     "Read(~/.claude-traffic-light/**)" "Read(~/.codex/**)" "Read(~/Library/Keychains/**)" \
     <for T in Read Edit Write:> "T(~/.board/*.json)" "T(~/.board/run/**)" "T(~/.board/outbox/**)" \
  --permission-mode acceptEdits \
  --permission-prompt-tool mcp__board__approval \
  --max-budget-usd <card budget> --max-turns <card max turns> \
  --append-system-prompt <board brief + trusted CLAUDE.md/.claude/rules from the TRUSTED checkout>
```

- `cwd` = the worktree. Resume (Phase 2 / plan approval) = `--resume <session_id>` **with the same isolation flags** (spike 5a).
- **Tools (CLI 2.1.285).** `TodoWrite` is not a tool in `-p` mode any more: with it in `--tools`, `system/init` lists only `Task, Bash, Edit, Glob, Grep, Read, Write` (+ `mcp__board__*`). The task list is `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet`; `Task` is the subagent tool. The `plan` fact mirrors `TaskCreate {subject}` / `TaskUpdate {taskId, status, subject?}` (and still `TodoWrite {todos}` for older CLIs).
- **BOARD_HOME rules.** Worktrees live in `BOARD_HOME/worktrees/`, so only the runner's private files are denied: `*.json` (device token, policy, ledger), `run/**` (run tokens, API key file) and `outbox/**`, both as permission rules and as sandbox `denyRead`. A non-default `BOARD_HOME` uses absolute rules (`Read(//abs/home/run/**)`, sandbox `denyRead: ["/abs/home/run", …]`).
- **Env is an allowlist (D15) with no secret in it (D26):** `HOME USER LOGNAME PATH TMPDIR LANG LC_* TZ`, proxy/CA vars if set (`HTTP(S)_PROXY NO_PROXY NODE_EXTRA_CA_CERTS`), plus `TERM=dumb`, `SHELL=/bin/sh`, `ZDOTDIR=<run_dir>/shell` (empty), `BASH_ENV=` and `ENV=` unset, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `MCP_TOOL_TIMEOUT=2100000`, `BOARD_RUN_SOCKET`, `BOARD_SUPERVISOR_PID`, `BOARD_SUPERVISOR_LSTART`. **Not** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` (it forces permission mode `default`, D26), **not** `BOARD_RUN_TOKEN` (the hook shim reads `<run_dir>/hook.token`, 0600; board-mcp gets it in `mcp.json`'s server `env`, which only the MCP server process sees), **not** `ANTHROPIC_API_KEY` (when the member has one, the runner writes it to `<run_dir>/api.key`, 0600, and `settings.json` sets `"apiKeyHelper": "/bin/cat '<run_dir>/api.key'"`). Everything the CLI has in its env, sandboxed Bash can read.
- **Gap A (shell snapshot) must be neutralised** (spike 2, change 7): with the env above, the runner's integration test asserts that `alias` and `type rm` inside the Bash tool show no user aliases/functions; a run where the first Bash tool shows user aliases is failed with `run.failed{error, reason:'shell_isolation'}`. Gap B (transcripts in `~/.claude/projects`) is accepted.
- Mid-run input = one stdin line `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]},"parent_tool_use_id":null,"session_id":""}` (spike 1b). Idle between turns is normal; EOF ends the process (spike 1d).

`settings.json`:

```json
{
  "apiKeyHelper": "/bin/cat '<run_dir>/api.key'",        // only when the member uses an API key
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": ["Read", "Edit", "Write", "Glob", "Grep", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "Task", "mcp__board",
              "Bash(git add *)", "Bash(git commit *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)",
              "Bash(git rev-parse*)", "Bash(git branch*)", "…repo policy bash_allow"]
  },
  "sandbox": {
    "enabled": true, "failIfUnavailable": true, "autoAllowBashIfSandboxed": true, "allowUnsandboxedCommands": false,
    "filesystem": {
      "allowWrite": ["<worktree>", "<TMPDIR>", "~/.npm", "~/.cache", "~/Library/Caches", "~/Library/pnpm", "~/.yarn", "…policy allow_write_extra"],
      "denyRead": ["~/.ssh", "~/.aws", "~/.config/gh", "~/Library/Keychains", "~/.claude", "~/.claude.json", "~/.codex", "~/.claude-traffic-light",
                   "~/.board/device.json", "~/.board/policy.json", "~/.board/ledger.json", "~/.board/outbox", "~/.board/run"]
    },
    "network": { "allowedDomains": ["…policy allowed_domains ∪ repo allowed_domains"], "strictAllowlist": true }
  },
  "hooks": {
    "SessionStart":       [{ "hooks": [{ "type": "command", "command": "<node> <board>/runner/hook-shim.js start", "timeout": 10 }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "<node> <board>/runner/hook-shim.js prompt", "timeout": 10 }] }],
    "PreToolUse":         [{ "matcher": "*", "hooks": [{ "type": "command", "command": "<node> <board>/runner/hook-shim.js pre", "timeout": 30 }] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "<node> <board>/runner/hook-shim.js post", "timeout": 10 }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "<node> <board>/runner/hook-shim.js postfail", "timeout": 10 }] }],
    "PreCompact":         [{ "hooks": [{ "type": "command", "command": "<node> <board>/runner/hook-shim.js precompact", "timeout": 30 }] }],
    "Stop":               [{ "hooks": [{ "type": "command", "command": "<node> <board>/runner/hook-shim.js stop", "timeout": 10 }] }],
    "StopFailure":        [{ "hooks": [{ "type": "command", "command": "<node> <board>/runner/hook-shim.js stopfail", "timeout": 10 }] }],
    "SubagentStop":       [{ "hooks": [{ "type": "command", "command": "<node> <board>/runner/hook-shim.js substop", "timeout": 10 }] }]
  }
}
```

`mcp.json`: `{"mcpServers":{"board":{"type":"stdio","command":"<node>","args":["<board>/mcp/server.js"],"env":{"BOARD_RUN_SOCKET":"…","BOARD_RUN_TOKEN":"…"}}}}`. `<node>` is `process.execPath` of the supervisor (absolute), so no PATH lookup is involved.

### 7.2 Local IPC (runner ⇄ board-mcp and hook shim)

- Transport: Unix domain socket `<run_dir>/ipc.sock` (run dir 0700, socket 0600). Windows (later): named pipe `\\.\pipe\board-<run_id>-<random>`. One socket per run.
- Framing: NDJSON, one JSON object per line, UTF-8, max 1 MiB per line.
- Every request carries `id` (string, unique per connection) and `token` (= `BOARD_RUN_TOKEN`). The runner compares the token with the run's token in constant time; mismatch → `{ok:false, error:{code:'BAD_RUN_TOKEN'}}` and the connection is closed.
- Requests (`ipc→runner` in `protocol.SHAPES`):
  - `hello {id, token}` → `{id, ok:true, result:{run_id, card_id, key, fence, repo_id, tools:[…MCP_TOOLS]}}`.
  - `tool` `{id, token, name, args}` → `{id, ok, result|error}`. `name` ∈ `MCP_TOOLS`.
  - `hook` `{id, token, event, payload}` → `{id, ok, result:{stdout:object, exit_code}}`. `event` ∈ `HOOK_EVENTS`; `payload` is the CLI's hook stdin JSON.
  - `cancel` `{id, token, re}` → `{id, ok:true, result:{}}`. board-mcp sends it when the CLI cancels a call it is holding (`re` = that call's request id). For a held `approval` the runner answers the held call with deny and sends rpc `approval_cancel` so the request is withdrawn on the hub.
- Responses: `{id, ok:true, result}` or `{id, ok:false, error:{code, message}}` with codes from `protocol.ERRORS` (`GATE_CLOSED`, `HUB_UNREACHABLE`, `OUT_OF_SCOPE`, `FENCED`, `VALIDATION`, …).

### 7.3 board-mcp tool surface (Phase 1)

Server name `board`, stdio, one per run. Each tool forwards `tool {name, args}` over IPC and returns `result` as a single JSON text content block; an IPC `error` becomes an MCP tool error (`isError:true`) whose text is `"<code>: <message>"`. Read-only tools carry `annotations.readOnlyHint: true`. No other tools exist: no heartbeat, move, assign, done, policy, budget, credentials or other repos' cards (§10).

| Tool | Input (zod) | Output | Runner routing |
|---|---|---|---|
| `board_get_card` | `{key?: string}` | card, acceptance, handover_md, open asks, trusted comments | rpc |
| `board_list_cards` | `{column?: enum, mine?: bool}` | `{cards}` | rpc |
| `board_update_status` | `{summary: string ≤ 140}` | `{ok, queued?}` | outbox `status.update` |
| `board_append_progress` | `{text: string ≤ 500}` | `{ok, queued?}` | outbox `progress.append` |
| `board_write_handover` | `{patch: {plan?, done?, hypothesis?, dead_ends?, next?, questions?}}` | `{version}` or `{queued:true}` | outbox `handover.write`; waits ≤ 5 s for the `ack`, whose `versions` carry the **hub's** handover version. No ack in time (or offline) → `{queued:true}`. Only `AGENT_WRITABLE` keys (VALIDATION otherwise). Also triggers a code snapshot (§7.2 design) |
| `board_ask_human` | `{kind: 'question'\|'clarify'\|'decision', text, options?: string[]}` | `{ask_id}` | rpc; the answer arrives at the next boundary (§7.4) |
| `board_comment` | `{text, reply_to?}` | `{ok, queued?}` | outbox `comment.create` |
| `board_attach_evidence` | `{kind: evidence kind, ref, summary, result?: 'pass'\|'fail'}` | `{evidence_id, verification}` | rpc |
| `board_complete` | `{summary, evidence_ids: string[]}` | `{state:'in_review'}` | rpc; on success the runner ends the run after the turn |
| `board_release` | `{reason, requeue: bool}` | `{state}` | rpc; final handover + snapshot first |
| `board_declare_plan` | `{summary, paths: string[], areas?: string[]}` | `{overlaps}` | rpc |
| `board_check_overlap` | `{}` | `{overlaps, locks}` | rpc |
| `board_recall` | `{paths?, query?, kinds?}` | `{memories}` | rpc |
| `approval` | the CLI's permission-prompt payload `{tool_name, input, tool_use_id?}` | text `{"behavior":"allow","updatedInput":<input>}` or `{"behavior":"deny","message":"…"}` | runner: redact → rpc `approval` → hold the call open until `answer` (or park/stop/fence → deny). "Allow for this run" (`scope:'run'`) lets the runner auto-allow later requests with the same tool and, for Bash, the same first command word. Called by the model directly, it can only create an ask, never allow |

The runner redacts every text argument (`redact`) and builds every hub-bound message through `serializeOutbound` before it leaves (§6.5).

### 7.4 Hook shim (`runner/hook-shim.js <event>`)

- Reads the hook JSON from stdin and forwards `hook {event, payload}` over IPC. Prints `result.stdout` (JSON) and exits with `result.exit_code`.
- **Dead-man check first** (spike change 2): if `BOARD_SUPERVISOR_PID` is not alive or its start time ≠ `BOARD_SUPERVISOR_LSTART`, or the socket is unreachable, or IPC fails/times out: for `pre` print `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"board supervisor unavailable"}}` and exit 0 (exit 2 with the reason on stderr if even that fails). Every other event exits 0 silently. **Fail-closed for `pre`, fail-quiet for the rest.**

What the runner answers per event (the facts go to the outbox, §6.5):

| `event` | CLI hook | Runner does | stdout |
|---|---|---|---|
| `start` | SessionStart (`startup`, `compact`, `resume`) | mark "not degraded"; `startup` on a seeded run → seed (handover + card + "you are run rN; rN-1 ended …") + team context; `compact` → re-inject the current handover | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}` |
| `prompt` | UserPromptSubmit | team-context block (≤ budget) | `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}` |
| `pre` | PreToolUse | gate G (wait ≤ `wait_ms` on `await_ack`), fenced check, path confinement of Read/Glob/Grep/Edit/Write/NotebookEdit to the worktree after realpath, deny `git push` to anything but `origin board/<KEY>-r<n>`; record `tool_in_flight` (+ Bash timeout) | deny object, or `{}` to proceed |
| `post` | PostToolUse | facts (`tool_end`, `file`, `command`, `git`, `plan` from TaskCreate/TaskUpdate/TodoWrite); pending trusted comments; one-time overlap delta; narrative nudge when > 10 min or > 25 calls old; handover_begin injection; code snapshot at a quiescent point | `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}` or `{}` |
| `postfail` | PostToolUseFailure | `error` fact | same shape as `post` |
| `precompact` | PreCompact | snapshot; `compacted` fact | `{}` |
| `stop` | Stop | if the agent is stopping without `board_complete`/`board_ask_human`/`board_release`: remind it (not a terminal signal) | `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"…"}}` or `{}` |
| `stopfail` | StopFailure | `error` fact only (terminal state comes from `result`, §6.7) | `{}` |
| `substop` | SubagentStop | `subagent` fact (500 chars) | `{}` |

A missing `start` within `DEGRADED_NO_SESSIONSTART_MS` (30 s) of spawn → `degraded` fact; the gate then relies on supervisor signals (design §6).

**Answer delivery** (design §3.7): mid-turn at the next tool boundary via `post` `additionalContext`; when the agent is idle or blocked, as a stdin user message. The runner reports `comment.delivered` with `via`.

## 8. Errors

Codes and HTTP statuses: `protocol.ERRORS`.

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION` | 400 | Bad body/frame/argument |
| `UNAUTHENTICATED` | 401 | No/invalid Access JWT, dev cookie or device token |
| `FORBIDDEN` | 403 | Authenticated but not allowed (viewer, not an approver, cross-origin) |
| `POLICY_DENIED` | 403 | Hub or runner policy refuses (never_auto, budget, requeue, plan kind) |
| `NOT_FOUND` | 404 | — |
| `ILLEGAL_TRANSITION` | 409 | `step()` has no row for (state, event) |
| `FENCED` | 409 | Stale fence (runner write, token) |
| `CONFLICT` | 409 | Unique constraint (second active run, human column move under a run) |
| `VERSION_CONFLICT` | 409 | Card `version` stale on PATCH |
| `ALREADY_ANSWERED` | 409 | First answer won; body has `answered_by` |
| `CLAIM_LOST` | 409 | Claim CAS lost (hub maps `step` FENCED/ILLEGAL on claim to this) |
| `ONE_OPEN_ASK` | 409 | A card may have one open ask |
| `RUN_ENDED` | 410 | Write for an ended run (non-salvage) |
| `PAYLOAD_TOO_LARGE` | 413 | > 1 MiB frame/body |
| `EVIDENCE_MISSING` | 422 | `board_complete` guard |
| `NO_REPO` | 422 | Dispatch of a card without `repo_id` |
| `REPO_NOT_ADVERTISED` | 422 | Claim by a device that didn't advertise the repo |
| `BUDGET_EXCEEDED` | 422 | Card/day budget exhausted |
| `PROTOCOL_UNSUPPORTED` | 426 | Version mismatch |
| `CONFIRM_REQUIRED` | 428 | Take over of suspended/unresponsive without `confirm:true` |
| `RATE_LIMITED` | 429 | — |
| `INTERNAL` | 500 | — |
| `BOOT_GRACE`, `TUNNEL_DOWN` | (503) | Hub-internal guard results from `step()`; the reaper just retries next tick. Never sent to clients |
| `OUT_OF_SCOPE`, `GATE_CLOSED`, `HUB_UNREACHABLE`, `BAD_RUN_TOKEN` | — | Runner-local; returned to board-mcp/shim/CLI, never sent by the hub |

WS close codes (`protocol.WS_CLOSE`): `4000` hub shutting down (reconnect), `4401` unauthenticated, `4403` revoked device, `4409` replaced by a newer connection of the same device, `4426` protocol unsupported (do not reconnect until upgraded).

## 9. Versioning

- `PROTOCOL_VERSION = 1` (integer). Sent in `hello` (both WS channels), `welcome`, and the `Board-Protocol` HTTP header.
- **Additive** changes (a new optional field, a new message type that old peers can ignore, a new fact kind the hub stores generically) do **not** bump the version. Receivers ignore unknown **fields**. An unknown **type** gets a non-fatal `error{code:'VALIDATION'}` reply and is otherwise ignored.
- Removing or renaming a field, changing its meaning, or changing a state-machine edge a peer relies on bumps the version. The hub accepts exactly its own version (`compatible()`); mismatch → close `4426` / HTTP `426`.
- Schema changes are new files in `shared/migrations/NNN_name.sql`; applied migrations are never edited.

## 10. State machine (design §4, `shared/states.js`)

`step(card, event, ctx)` returns `{ok, card, effects, rule, from, to}` or `{ok:false, error:{code,message}, rule?}`. It never throws on bad input and never mutates `card`. The hub persists `toDb(result.card)` and executes `effects` **in the same transaction**. `todo` is stored as `run_state NULL`.

### 10.1 Rows (ids match design §4.1; letters are sub-cases; `n-*` are documented no-ops)

| id | from → to | event (source) | guard / notes |
|---|---|---|---|
| `1` | todo → queued | `dispatch` (human) | `request_id`; `has_repo`, `can_write`, `policy_ok`; duplicate request id → `return_existing` |
| `1a` | queued → queued | `queue_nudge` (timer) | no eligible runner online 10 min; notify dispatcher once |
| `2` | queued → todo | `cancel` (human) | `can_cancel` |
| `2b` | queued → todo | `decline` (runner frame) | target member declined locally |
| `3` | queued → claimed | `claim` (runner) | CAS `expected_fence`; fence+1; `repo_advertised`, `runner_accepts`, `no_active_run` |
| `4` | claimed → running | `activity` (runner) | not `delayed` |
| `5` | claimed → queued | `prep_failed` (runner) | fence+1 |
| `5a` | claimed → unresponsive | `hb_timeout` (timer) | DARK, resume_to=claimed (lid-close during claimed is intentionally not suspended) |
| `5b` | unresponsive → queued | `claim_timeout` (timer) | resume_to=claimed and T_claim since claim; fence+1 |
| `6` | running → quiet | `quiet_timeout` (timer) | `!hasProgress` |
| `7` | quiet → running | `activity` (runner) | not `delayed` |
| `8` | running/quiet/blocked → blocked | `block` (hub, from `board_ask_human`/`approval` rpc) | kind ∈ BLOCKED_KINDS; `plan` needs `require_plan_approval`; notify |
| `9` | blocked → running | `answer` (human) | `can_answer`; no asks/requests left open |
| `9b` | blocked → blocked | `answer` (human) | more still open |
| `9d` | dark (resume_to=blocked) → same | `answer` (human) | D6: resume_to → quiet if nothing left open |
| `9w` | blocked → running | `withdraw` (runner rpc `approval_cancel`) | nothing else open |
| `9wb` | blocked → blocked | `withdraw` (runner rpc) | more still open |
| `9wd` | dark (resume_to=blocked) → same | `withdraw` (runner rpc) | resume_to → quiet if nothing left open |
| `10` | blocked → parked | `park_timeout` (timer) | oldest open ask ≥ T_park; fence+1; `park` command; notify once |
| `11` | parked → queued | `answer` (human) | fence+1; seed handover + answer |
| `12` | running/quiet/blocked → suspended | `host_suspending` (runner) | DARK |
| `13` | suspended → RECOVER | `hb` (runner) | lease_mark_wake |
| `14` | running/quiet/blocked → unresponsive | `hb_timeout` (timer) | DARK |
| `15` | unresponsive → RECOVER | `hb` (runner) | |
| `16` | unresponsive → orphaned | `orphan_timeout` (timer) | not `BOOT_GRACE` (uptime < T_orphan), not `TUNNEL_DOWN`; notify after 10 min; freeze handover |
| `17` | suspended → orphaned | `suspend_timeout` (timer) | asleep > 8 h |
| `18` | orphaned → RECOVER | `hb` (runner) | relabel orphan ("was asleep"), cancel pending notify |
| `19` | running/quiet/blocked/claimed/suspended/unresponsive/orphaned → reconnecting | `hub_boot` (system) | pre_reconnect_state := from; DARK |
| `19r` | reconnecting → reconnecting | `hub_boot` (system) | D5: keeps the original pre_reconnect_state |
| `19h` | handing_over → handing_over | `hub_boot` (system) | D5: restart the 3-min timer |
| `20` | reconnecting → RECOVER | `hb` (runner) | first HB of the new epoch |
| `21` | reconnecting → suspended / unresponsive | `reconnect_timeout` (timer) | suspended iff pre_reconnect_state=suspended |
| `22` | any ACTIVE → failed{kind} | `run_failed` (runner outbox) | kind ∈ network/limit/error/budget; notify |
| `23` | any ACTIVE / parked → failed{stopped} | `stop` (human) | `can_stop`; fence+1; notify |
| `24` | running/quiet/blocked → queued | `release{requeue:true}` (runner rpc) | `policy_allows_requeue`; fence+1 |
| `25` | running/quiet/blocked → failed{released} | `release{requeue:false}` (runner rpc) | notify |
| `26` | failed → queued | `retry` (human) | new `request_id`; fence+1 |
| `27` | failed/orphaned/parked → handed_over | `take_over` (human) | `can_write`; fence+1; handoff memory |
| `27a` | running/quiet/blocked → handing_over | `hand_over` (human) | `can_hand_over`; target queue/member/self; `handover_begin` |
| `27b` | handing_over → handed_over | `handover_complete` (runner) | fence+1; provenance checkpoint_complete; follow-up per target |
| `27c` | handing_over → handed_over | `handover_timeout` (timer, 3 min) | provenance checkpoint_incomplete |
| `27d` | handing_over → handed_over | `hb_timeout` (timer) | provenance checkpoint_incomplete |
| `28` | unresponsive/suspended → handed_over | `take_over` (human) | `confirmed` else `CONFIRM_REQUIRED`; fence+1 |
| `29` | handed_over → queued | `redispatch` (human or follow-up) | `request_id` |
| `30` | handed_over → todo | `take_myself` (human or follow-up) | assign the taker |
| `31` | running/quiet → in_review | `complete` (runner rpc) | `evidence_ok` (D7b: quiet allowed) |
| `32` | in_review → queued | `request_changes` (human) | fence+1; seed handover + review |
| `33` | in_review → todo | `pr_closed` (system, merge poll) | note, no auto re-dispatch |
| `34` | in_review → done | `pr_merged` (system, merge poll) | |
| `34b` | in_review → done | `approve_done` (human) | an agent (`by_run`) can never approve |
| `n-hb` | live → same | `hb` | fenced: a stale HB → FENCED → `hb.ack current:false` |
| `n-activity` | running/blocked/handing_over/dark → same | `activity` | only `hb` recovers a dark card |
| `n-activity-delayed` | claimed/quiet → same | `activity{delayed}` | replayed facts never make a card green |
| `n-suspend-claimed` | claimed/handing_over/suspended → same | `host_suspending` | |

Anything else → `ILLEGAL_TRANSITION`. Runner events with a stale `fence` → `FENCED` before any guard runs.

### 10.2 `ctx` the hub must supply

`has_repo`, `can_write` (member role ≥ member), `policy_ok` (no `never_auto` label, card/day budget left), `needs_confirm`, `can_cancel` (dispatcher, assignee or admin), `is_target_member`, `repo_advertised`, `runner_accepts` (true when the runner claims; it has already applied local policy), `no_active_run`, `can_answer` (asks: dispatcher/assignee/owner; permission: in `approvers`), `open_asks_remaining` (open asks + open permission requests **after** this answer), `require_plan_approval` (the card has the label `plan-approval` = `states.PLAN_APPROVAL_LABEL`; also sent as `offer.require_plan_approval`), `can_stop` (dispatcher, assignee, run owner or admin), `policy_allows_requeue`, `can_hand_over` (owner, dispatcher or assignee), `confirmed` (`confirm:true` in the body), `evidence_ok`, `hub_uptime_ms`, `tunnel_ok` (self-probe healthy), `duplicate_request`. Missing booleans are false (fail-closed).

### 10.3 Effects the hub must execute (same transaction unless noted)

| Effect | Hub obligation |
|---|---|
| `fence_bump {from,to}` | Already applied to `card.fence`; the DB trigger enforces monotonicity |
| `release_path_locks` | `DELETE FROM path_locks WHERE run_id = <active run>` |
| `dispatch_create {request_id, target_member_id, needs_confirm}` | Insert `dispatches` (pending); mark older pending ones `superseded` |
| `dispatch_cancel {reason}` | Mark the pending dispatch cancelled/declined; `offer.withdrawn` to runners (after commit) |
| `offer_to_runners` | After commit: send `offer` to eligible connected devices; if none, the queue nudge timer runs |
| `run_create` / `lease_create` | Insert `runs` (fence = new fence, branch, snapshot_ref) and `leases` (hub_epoch); `cards.active_run_id` |
| `lease_release` | Delete the lease; `cards.active_run_id = NULL` |
| `run_end {reason}` | `runs.ended_at/end_reason`; open asks/permission requests of the run → `cancelled` (or `parked` for park) |
| `runner_command {cmd, fence, wait_ms?}` | After commit: send `cmd` to the run's device (queued for reconnect if offline) |
| `deliver_answer` | After commit: send `answer` to the run's device (or hold it for recovery/seed) |
| `notify {rule, to}` | Push to dispatcher + assignees now (web alerts in Phase 1; widget/Telegram later) |
| `notify_after {rule:'orphaned', after_ms}` | Fire only if still orphaned after `after_ms` (reaper checks `state_since` + `orphan_notified_at`) |
| `notify_cancel {rule}` | Clear the pending orphan notification |
| `mark_nudged` | `cards.queued_nudged_at` |
| `handover_freeze` | Record the latest handover/snapshot versions with provenance `frozen` (nothing new is written) |
| `seed {from:[…]}` | Attach handover markdown (+ answer / review comment) and `from_snapshot` to the new dispatch's `seed` |
| `memory_write {kind:'handoff', provenance}` | Insert a `memories` row with `handoffMemoryText(...)` |
| `lease_mark_wake` | `leases.woke_at = now`, `post_wake_activity = 0` (green needs fresh activity) |
| `relabel_orphan` | Relabel the orphan feed event "was asleep …" |
| `restart_state_timer` | `cards.state_since = now` |
| `follow_up {event}` | After commit, run `event` through the same queue as a system action (redispatch/take_myself) |
| `assign {member_id, role}` | Upsert `card_assignees` |
| `feed {kind, …}` | Insert an `events` row; broadcast `event.append` |
| `state_changed {from,to,column}` | `cards.state_since = now`, `column_name`, `version+1`; broadcast `card.upsert` |
| `return_existing` | Respond with the existing run/dispatch; no write |

## 11. Timers (all in `shared/liveness.js`; never hard-code them elsewhere)

| Constant | Value | Where |
|---|---|---|
| `HB_MS` | 15 s | runner HB cadence |
| `TTL_MS` | 45 s | lease TTL → unresponsive |
| `T_QUIET_MS` | 6 min | running → quiet |
| `T_ORPHAN_MS` | 5 min | unresponsive → orphaned; hub boot grace |
| `GATE_G_MS` | 4 min | runner offline gate |
| `T_PARK_MS` | 30 min | blocked → parked |
| `T_SUSPEND_MS` | 8 h | suspended → orphaned |
| `T_CLAIM_MS` | 120 s | claimed → running budget |
| `RECONNECT_CAP_MS` | 30 s | runner backoff cap |
| `T_HANDOVER_MS` / `HANDOVER_WAIT_MS` | 3 min / 90 s | handing_over cap / final-handover wait |
| `ORPHAN_NOTIFY_MS` | 10 min | N-rules |
| `QUEUE_NUDGE_MS` | 10 min | #1a |
| `SHORT_WAKE_WAIT_MS` | 20 s | offline rule 5 |
| `INTERRUPT_WAIT_MS` / `STOP_GRACE_MS` | 5 s / 10 s | stop recipe |
| Bash bound | timeout (default 2 min, max 10 min) + 30 s; other tools 10 min | `toolBound` |
| `SLEEP_TICK_MS` / `SLEEP_GAP_THRESHOLD_MS` | 1 s / 5 s | tick-gap sleep detector |
| `OVERLAP_DEBOUNCE_MS` | 10 s | overlap recompute |
| `NARRATIVE_NUDGE_MS` / `NARRATIVE_NUDGE_CALLS` | 10 min / 25 | handover nudges |
| `DEGRADED_NO_SESSIONSTART_MS` | 30 s | degraded flag |

The reaper calls `timerEvent(snapshot)` for each card every second and feeds a non-null result to `step()`. Guard failures `BOOT_GRACE`/`TUNNEL_DOWN` are silent (retry next tick).

## 12. Decisions

- **D1 ESM everywhere in `board/`.** `"type":"module"`, so shared modules load unchanged in the browser. The widget's CJS modules are reached with `createRequire`.
- **D2 Hub node:sqlite, Node ≥ 22.13.** Unflagged there (added 22.5 behind a flag). Design §9.1 said `better-sqlite3`; the brief forbids native deps, so `node:sqlite` it is.
- **D3 Only `hb` recovers a dark card; `activity` never does.** Delayed (replayed) activity never moves a card. Green after any recovery needs fresh, non-delayed activity (Power Nap guard, exit c).
- **D4 Member identity = verified Access email → `members.email`.** Members are pre-registered by an admin with GitHub login + id + email. The GitHub id isn't read from Access claims in Phase 1: the claim shape is unverified (S3). Revisit after S3.
- **D5 Double boot keeps `pre_reconnect_state`; `handing_over` rides through a boot** with its 3-min timer restarted (rows `19r`, `19h`).
- **D6 Answers while dark are stored, not refused** (row `9d`). resume_to drops to `quiet` when nothing is left open, so a recovered card doesn't show a stale "Needs you".
- **D7 Park, stop and timed-out handovers bump the fence immediately** (§5.3 law: every stop/park/takeover bumps). The run's final narrative and snapshot come in through the **salvage lane**, and are promoted to current when they come from the card's most recent run (§6.9). **D7b** `complete` is allowed from `quiet` as well as `running` (the MCP call is itself activity).
- **D8 Idempotency.** Every mutating HTTP call and every claim carries a `request_id`. Dispatch-like actions are idempotent in the DB (`dispatches.request_id`); other actions via a 10-min `(member, request_id)` response cache.
- **D9 Handover `done` prepends, other sections replace** (newest first, 50 entries). `plan` may be markdown or `[{text,status}]`; the newer of the narrative plan and the TodoWrite mirror wins.
- **D10 Fence token = `{n, epoch}`; only `n` decides.** Epoch tells the runner a hub restart happened. The DB stores the integer; restore = +1000 and a new epoch (`applyRestoreBump`).
- **D11 Long timers use persisted hub wall time** (`cards.state_since`, same machine). HB TTL and orphan silence use in-memory hub monotonic time, and restart with the process (covered by boot grace).
- **D12 One hub secret** (env `BOARD_SECRET` or generated into `hub_meta`) signs run tokens and dev cookies.
- **D13 Green is computed twice:** by the hub at send time and by the web from aged values each second. It shows only if both agree (`cardFace` uses the aged values; `LeaseView.green` is the hub's value).
- **D14 A runner advertises only repos that are both opted in locally and on a board allowlist.** The allowlist comes in `welcome.allowlist` and is refreshed by a new `welcome`-shaped push only on reconnect in Phase 1 (admins adding a repo take effect on the runner's next connect).
- **D15 CLI env is an allowlist** plus the isolation variables (§7.1). This neutralises shell-snapshot Gap A and keeps unrelated secrets in the member's env off the run.
- **D16 Interrupt is the stream-json `control_request` (spike 1c), SIGINT only as a fallback.** Stop follows the spike's SIGTERM-tree recipe.
- **D17 One device-level HB carries all runs.** The hub answers `hb.ack` per run; `current:true` is the only thing that reopens gate G.
- **D18 The browser WS is read-only push; all mutations go over HTTP.** Simpler auth, CSRF and idempotency.
- **D19 A run row is created at claim, not at dispatch.** The dispatch lives in `dispatches` (at most one pending per card), so `runs.fence` is always the claimed fence and `UNIQUE(card_id, fence)` holds.
- **D20 `asks` is a separate table from `permission_requests`,** with one open ask per card enforced by a partial unique index. Permission requests may stack ("2 req").
- **D21 Codex is Phase 1.5.** `backend` accepts `codex_cli` in the schema, but the Phase 1 hub dispatches only `claude_cli` (`VALIDATION` otherwise).
- **D22 `approval` holds the MCP call open until answered.** Hence `MCP_TOOL_TIMEOUT=2100000` (35 min > T_park). The runner builder must verify the CLI honours it; if not, it chunks the wait and re-prompts, and records the finding here.
- **D23 Git allow rules.** Explicit `Bash(git add *)`/`Bash(git commit *)`… allow rules (spike 4b). Everything else outside the sandbox goes to `approval`.
- **D24 Pushes are allowed only to `origin board/<KEY>-r<n>` and the snapshot/salvage refs (supervisor-only).** Enforced by the `pre` hook as well as `--disallowedTools`.
- **D25 Web renders agent/human text as text.** No HTML injection path exists.
- **D26 No `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`; no secret in the CLI env instead (low admin + credential isolation).** CLI 2.1.285 with `SCRUB=1` forces permission mode `default` ("allowed_non_write_users hardening") and strips `*TOKEN*` vars from hook env. Evidence, two real `claude --model haiku` runs through the full profile against a fake hub, same six Bash commands (`ls`, `node --version`, `npm test`, `echo … > probe.txt && cat probe.txt`, `env | cut …`, `git status --short`), 2026-09-30:
  - **SCRUB=1** ($0.036): `system/init.permissionMode = "default"`. `ls`, `node --version` and `git status` ran (read-only, or the explicit git allow rule); `npm test`, the redirect and the `env` pipeline each went to `mcp__board__approval`, i.e. **3 of 6 routine sandboxed commands would have waited for a human**. So (a) `sandbox.autoAllowBashIfSandboxed` does **not** auto-allow under the forced `default` mode. (b) Explicit allow rules do work per command (the `Bash(git …)` rules), but every build/test/redirect/pipe shape would need one: an endless per-repo list, rejected. Bash saw no `BOARD_RUN_TOKEN`.
  - **SCRUB unset** ($0.053): `permissionMode = "acceptEdits"`, **0 approvals**, all six ran sandboxed, and a sandboxed `git commit` passed. (c) What SCRUB bought: Bash's `env` then listed `BOARD_RUN_TOKEN` (and the CLI's own `CLAUDE_CODE_MESSAGING_TOKEN`). So the fix is to keep secrets out of the env, not to scrub it: the run token moved to `<run_dir>/hook.token` (hook shim) and `mcp.json` (board-mcp only); `ANTHROPIC_API_KEY` moved to `apiKeyHelper` + `<run_dir>/api.key`; the private `BOARD_HOME` files are sandbox `denyRead` and disallowed for Read/Edit/Write. The env allowlist (D15) had no other secret. Residual: `CLAUDE_CODE_MESSAGING_TOKEN` is visible to Bash (the CLI's own local socket token, not a member credential). `apiKeyHelper` is unit-tested but not yet exercised live (the test member uses a subscription login).
- **D27 Repo identity = the configured origin URL** (`git config --get remote.origin.url`), not `git remote get-url` (§6.8). Deviation from design §9.4 #1, which named `get-url`: insteadOf is a local transport rewrite, and the member's configured name is the identity. Tests and the e2e harness rely on it (a bare remote reached through `insteadOf`).
- **D29 (P-1) One append-only journal, written in the same transaction as every mutation** (§15). Lean: no hash chain, no blob store, no bus cursors yet; comment bodies are not copied into it. Migration numbered 003 (002 was already taken by the device form factor).
- **D28 Plan approval is the card label `plan-approval`** (`states.PLAN_APPROVAL_LABEL`); the hub derives `ctx.require_plan_approval` and `offer.require_plan_approval` from it.

## 13. Phase 1 exit criteria → tests

`[x]` = exists and passes in `shared/test`. `[ ]` = integration test the named builder **must** add (the filename is part of the contract). Hub and runner tests use injectable clocks (`{mono(), wall()}`), a fake runner/hub WS peer, a fake GitHub, and a **fake `claude`** (`runner/test/fixtures/fake-claude.js`, which replays recorded stream-json and honours stdin `control_request` / user messages / EOF / signals).

| Exit | Shared (unit) | Integration (must add) |
|---|---|---|
| (a) Give to Claude → green ≤ 60 s → In review with hub-verified PR + tests → Done on merge, zero manual moves | `states.test.js` rows `1`,`3`,`4`,`31`,`34`; `liveness.test.js` green predicate; `cardface.test.js` design copy | `hub/test/exit-a-dispatch-to-done.test.js` (fake runner + fake GitHub merge poll); `runner/test/claim-spawn.test.js` (fake-claude reaches `activity` < 60 s on the fake clock) |
| (b) `kill -9` CLI → red ≤ 1 s; narrative ≤ 10 min old with "last synced" | row `22`; `handover.test.js` "last synced" | `runner/test/exit-b-kill-cli.test.js` (child exit → `run.failed` sent < 1 s); `hub/test/exit-b-failed.test.js` (failed + notify + handover ages in CardDetail) |
| (c) Lid close → suspended, never green; wake → grey until activity | rows `12`,`13`, `n-activity`; RECOVER-never-running; `cardface` exit (c) | `hub/test/exit-c-suspend-wake.test.js` |
| (d) Take over on a second laptop continues from the pushed snapshot ref | rows `27`,`28`,`29`; `handover.howToTakeOver` | `runner/test/exit-d-takeover-seed.test.js` (bare-remote git fixture; fetches `refs/board/KEY/*`, branches from the snapshot) |
| (e) Revived first laptop is fenced; salvage attached | FENCED tests; `fence.test.js` | `runner/test/exit-e-zombie.test.js` (hb.ack current:false → deny + stop + salvage ref); `hub/test/exit-e-salvage.test.js` (stale fence acked, salvage stored/promoted per D7) |
| (f) Non-repo session / out-of-repo paths → zero bytes at the outbox serializer | `scope.test.js` exit (f) | `runner/test/exit-f-zero-bytes.test.js` (spy on the socket + outbox file: a non-scoped session and a `cd ..` path produce 0 bytes) |
| (g) Pi reboot < 4 min orphans nothing; agents keep working | rows `19`,`20`,`21`; `liveness.test.js` exit (g) | `hub/test/exit-g-reboot.test.js` (reopen same DB, new epoch, fake clock +3 min); `runner/test/gate-origin-down.test.js` (530 < G keeps the gate open) |
| (h) Partitioned runner blocks tools + interrupts before orphaned; taken-over runner never resumes in a later Pi outage | `liveness.test.js` gate + exit (h); `GATE_G_MS < T_ORPHAN_MS` | `runner/test/exit-h-partition.test.js` (fake clock: `pre` denies and `interrupt` sent at G < T_orphan; ack 30 min old + 530 → stays closed) |
| (i) Blocked keeps "Needs you" through sleep, partition, hub restart | `states.test.js` exit (i) | `hub/test/exit-i-blocked-survives.test.js` |
| (j) No personal MCP/hooks/plugins in `system/init`; no credential in any hub-bound byte | `scope.test.js` exit (j) (every `CREDENTIAL_PATTERNS` kind) | `runner/test/exit-j-launch-profile.test.js` (argv/env/settings/mcp.json snapshot incl. env allowlist); `runner/scripts/check-isolation.sh` (manual, real CLI: asserts `system/init` tools/mcp_servers = ours only, and no user aliases in Bash) |
| (k) Two runs on the same file show the overlap on both cards and in agent context ≤ 30 s | `overlap.test.js` exit (k) | `hub/test/exit-k-overlap.test.js` (two fake runners; both `card.upsert` overlaps and both `context.update` within debounce + 1 tick) |
| (l) Hand over → "Handing over · waiting for checkpoint" → handover ≤ 3 min with handoff memory; teammate approval first-wins, second rejected | rows `27a`–`27d`; `schema.test.js` exit (l); `cardface` handing_over copy | `hub/test/exit-l-handover-approvals.test.js`; `runner/test/approval-recheck.test.js` (answerer not in local policy → deny) |

Also required: `mcp/test/tools.test.js` (every `MCP_TOOLS` entry listed, schemas reject bad input, IPC token sent, `approval` output format) and `web/test/render.test.js` (pure render helpers over `cardFace`, run with `node --test` against the exported functions; no DOM framework).

## 14. Conventions

- Ids: `crypto.randomUUID()` for rows; card keys `<key_prefix>-<n>` from `boards.next_key`.
- JSON over the wire uses `snake_case` field names, as in the DB.
- Money: cents (integer) in the DB, USD (number) on the wire.
- Every file a builder writes under `~/.board` is created 0600 (dirs 0700) and written atomically (temp + rename).
- No `console.log` debugging left behind; the hub and runner log JSON lines to stderr (`{t, level, msg, …}`) and never log tokens, run tokens, device tokens or card bodies at `info`.

## 15. Journal (P-1, D29)

`journal` (migration 003) is the append-only record of every mutation: `{seq, board_id, card_id?, run_id?, at_hub, hub_epoch, actor_kind:'member'|'runner'|'system', actor_id, kind, payload}`. Triggers `RAISE(ABORT)` on UPDATE and DELETE. Every row is written by `hub.journal()` **in the same transaction** as the change it records. `events` stays the UI feed; the journal is the record of truth for replay (and later the bus, webhooks and time travel).

| `kind` | Written by | `payload` |
|---|---|---|
| `card.create` | `POST …/cards` | `{key, title, body, acceptance, repo_id, base_ref, labels, budget_cents, column_name, assignees, request_id}` |
| `card.update` | `PATCH /api/cards/:id` (every changed field), dispatch `budget_usd` | `{fields:{name:[before, after]}, request_id}` |
| `card.transition` | `hub.apply()` for every applied `step()` (not the pure no-ops, e.g. `n-hb`) | `{rule, event, from, to, state:{CARD_STATE after}, effects:[type]}`; `actor_kind` from `states.EVENTS` (human → member, runner → runner/device, timer/system → system) |
| `run.create` | claim (`run_create` effect) | `{fence, device_id, branch, snapshot_ref, dispatch_request_id}` |
| `run.snapshot` | outbox `snapshot`, promoted salvage snapshot | `{status, sha, ref, provenance?}` |
| `ask.create` / `ask.answer` | `board_ask_human` rpc / `answer` action | `{ask_id, kind}` / `{ask_id, by}` |
| `permission.create` / `permission.answer` / `permission.cancel` | `approval` rpc / answer route / `approval_cancel` rpc | `{permission_request_id, tool}` / `{…, decision, scope}` / `{permission_request_id}` |
| `handover.version` | every `handovers` insert | `{version, written_by, provenance}` |
| `evidence.create` | `board_attach_evidence` | `{evidence_id, kind, ref, verification, result}` |
| `plan.declare` | `board_declare_plan` | `{paths}` |
| `comment.create` | web and agent comments | `{comment_id, source, for_agent}` (no body) |
| `feed.relabel` | `relabel_orphan` effect | `{event_id, relabel}` |
| `hub.restore_bump` | boot with restore (`board_id` NULL) | `{bump}` |

`journal.replay(rows)` rebuilds every card's `CARD_STATE` + title/labels/budget/repo from `card.create`, `card.update`, `card.transition` and `hub.restore_bump` alone. Tests: `hub/test/journal.test.js` (triggers, coverage, API, restore) and the e2e chaos run (`test/e2e/`), which replays the journal and compares it with the live `cards` table.

The orphan relabel no longer rewrites an `events` row: `relabel_orphan` appends an internal `orphan_relabel` event `{event_id, relabel}` that `feedEvent` joins onto the orphaned line.
