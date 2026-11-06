# Agent bus (v1, phase 1: this Mac)

AI tools hand bounded work to each other. A handoff is claimed and started automatically, as a fresh Tasks run, under the receiver's standing policy, and its result comes back to whoever asked. Phase 1 is local only: no hub, no team scope. `board/MESSAGING.md` v1 stays frozen; the deltas are in §6.

## 1. Where it runs

- **Electron main** relays only: `POST /bus` on the signal server (`src/signal-server.js`), token-checked, no browser origin, scrubbed, then forwarded asynchronously over the Tasks socket (`tasks-service.bus`). The session notes ops (`note`, `notes`, `notes_ack`, `notes_pending`, `notified`) are the exception: they go only over the helper's parentPort (`src/tasks-process.js` busMain → `board/tasks-engine/parent-bus.js`) and the socket refuses them. Main never opens `bus.db`, SQLite or a repo path for the bus (`test/bus-main-thread.test.js`).
- **Tasks utilityProcess** owns everything else (`board/tasks-engine/bus/`): `local-log.js` (`bus.db`, 0600, in the engine data dir), `guard.js` (admission), `dispatcher.js` (claim → `engine.createTask` in-process with `source: 'bus'` → result), `pricing.js`.
- **Agents**: interactive sessions use `bus_*` in `mcp-server.js`; bus-started runs get `bus_result` and `bus_handoff` on their per-run task server (`board/mcp/task-tools.js`, handled in `collaboration.js`).

## 2. Envelope (v1)

`{v:1, id, request_id, topic, offset, scope:'local', card_id, repo:{root}, source:{device_id, agent_id, provider, tier, identity_source}, to, kind, handoff_id, body, data, hop, visited, caused_by, created_at, expires_at, grants_execution:false, approval:false}` (`board/shared/bus-schema.js`). One monotonic offset per `bus.db`. Bodies are untrusted text: scrubbed, at most 3200 characters, delivered only inside `frame()` (`board/shared/untrusted-frame.cjs`). Result envelopes are written by the dispatcher (`source.provider: 'bus'`), but `bus_wait`/`bus_read` name the AI that did the work: `from: {provider: 'codex'|'claude', tier: 'run_capability'}` (from `data.provider`, the run's AI) and a frame saying it came from Codex (or Claude) running in Plexiform; a result with no run (expired, never started) is framed as from Plexiform. `from.tier` is what tells a result apart from a session's own messages: `run_capability` is a run Plexiform started, `local_attested` an interactive session; `from.provider` alone can equal the reader's own tool.

| Topic | Kinds | Retention |
|---|---|---|
| `handoff` | `handoff.offer`, `handoff.refused` | 30 d |
| `claim` | `claim.granted`, `claim.denied`, `claim.started`, `claim.released`, `claim.lost` | 30 d |
| `result` | `result.done`, `result.failed`, `result.outcome_unknown`, `result.expired` | 30 d |
| `control` | `control.halt`, `control.resume`, `control.policy_changed`, `control.cap_reached`, `control.card_paused` | 90 d |

Delivery is at-least-once; dedupe by `(source agent, request_id)` (the same request, whatever its state) and by `(card_id or repo, title + brief, requested to)` within an hour; the content dedupe joins only a hand-off still under way or done, never one that failed (stopped included), expired or ended `outcome_unknown`, so a retry with a new `request_id` or another target runs. Exactly one start per handoff: the claim CAS hands out a fence; a stale fence changes nothing and its result is refused. Leases (120 s) are renewed while the run lives; after a restart a granted claim with no task reopens (fence + 1), a started one whose run is gone becomes `outcome_unknown` and is never retried.

## 3. Identity and tiers

| Tier | Who | May |
|---|---|---|
| `local_attested` | holder of the app's local token (an interactive session's MCP) | local handoffs to this Mac only |
| `run_capability` | a bus-started run (per-run socket + token) | `bus_result` for its own fence; one onward `bus_handoff` |
| `person` | hub credential (phase 2) | everything incl. halt and resume |

`agent_id` is `<provider>:local:<hash(device, provider, repo)>` or `<provider>:run:<task id>`; the caller never chooses it. Default `accept_tiers = ['person','run_capability']`: interactive sessions cannot reach teammates' Macs.

## 4. Tools

| Tool | Surface | Returns |
|---|---|---|
| `bus_hello {provider}` | interactive | `{agent_id, tier, scope_allowed, policy_summary}`; `policy_summary.repo_enabled` with `repo_reason` + `repo_reason_text` when false, `repo_why` when true (§7.3) |
| `bus_handoff {request_id, to:{provider: any\|claude\|codex\|[list]}, repo?, card_id?, title, brief?, files?, branch?, budget_usd?, ttl_s?}` | interactive | `{handoff_id, state, hop, provider}` or `{reason}` (§7.4) |
| `bus_wait {handoff_id, timeout_s ≤ 120}` | interactive | the framed result, or `{state:'pending'}` |
| `bus_read {topic: handoff\|result, after_offset?, limit ≤ 50}` | interactive | framed events, `next_offset` |
| `bus_status {handoff_id?}` | interactive | the offer → claim → start → result chain; without one, the bus state and `providers` (health, §7.4) |
| `bus_result {request_id, outcome, summary}` | run | recorded; delivered when the run ends |
| `bus_handoff` (no `repo`) | run | as above; tier `run_capability`, hop and visited from the run |

Refusal reasons: `HALTED`, `SPEND_CAP`, `LOOP`, `RATE`, `NOT_MEMBER`, `TIER_NOT_ACCEPTED`, `NO_ELIGIBLE_AGENT`, `NO_LOCAL_CHECKOUT` (both with `repo_reason`), `PROVIDER_UNAVAILABLE` (with `provider`, `retry_at`). The shared names live in `src/bus-contract.js`. No agent tool can post `control` or `claim` or change policy; `halt`, `resume` and `busSetContext` are main's own ops (tray, Preferences, Sessions → Agent bus) and the relay refuses them.

## 5. Guardrails (all refusals, never prompts)

- **Which repos, on this Mac** (`engine.busRepoAllowed`, one rule for admission, the engine and `bus_hello`'s `repo_enabled`), in order:
  1. The repo must be a real local git work tree (`git rev-parse --show-toplevel`, then realpath); anything else is `NO_LOCAL_CHECKOUT`.
  2. Never, whatever else is set: a filesystem root, `$HOME` or a folder holding it, a `DENY_READ` path (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/Library/Keychains`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.claude-traffic-light`) or Plexiform's Tasks data folder.
  3. **Never these** (Preferences `agentBus.exclude`): a folder covers every repo inside it and every linked worktree of the repo it holds (same `git rev-parse --git-common-dir`); a canonical remote covers every checkout of it.
  4. `policy.repos[<realpath|canonical remote>].bus_auto === true` in the engine's `policy.json`: on. It is the only way past step 5. `remote_tasks` never counts for the bus.
  5. Never a protected folder: a dot-folder or `~/Library` under `$HOME` (the same `#protectedFolder` as in-place tasks), for the repo or for its parent folder, where the sibling `*-buddy-<id>` worktree is created.
  6. **Only these** (Preferences `agentBus.repos`), in force only when `agentBus.scope` is `'listed'`: only those repos, and their linked worktrees. Refused as `repo_reason: LISTED_ONLY`.
  7. **Automatic** (`scope: 'auto'`, the default): every git checkout that passed rules 1–5 (owner decision, 6 Nov: everything connects automatically). No session is needed; `agentBus.repos` entries only add (a listed repo answers `repo_why: LISTED`, the rest `AUTO`) and never restrict, so no config migration was needed. A bound caller is judged by the folder main verified; an unbound caller's own `cwd` picks the repo, which is why unverified clients are read-only (D2) and cannot hand off. Main still pushes the session folders it observes, and when a session calls `bus_hello`/`bus_handoff` while the bus is on and running, its repo is remembered in `bus.db` (48 h, at most 100); nothing reads that cache for eligibility any more.
  - Migration (once, on the first Tasks helper start): a saved `agentBus` with no `exclude` key, an empty list and any `policy.json` `bus_auto` key becomes `scope: 'listed'`, so it keeps meaning "only those". Every other config becomes automatic.
  - Repos are resolved only from those sources; no picker. A canonical remote resolves through them. No match: `NO_LOCAL_CHECKOUT`; a checkout that is not on the bus: `NO_ELIGIBLE_AGENT`.
- **Start with no human gate**: `planFirst` is false unless the spec asks; `awaitingConfirm` is false under `bus.auto_accept` (default on) for local scope; no budget dialog. The remote rules still apply: at most `auto-edits`, always a new worktree.
- **Providers**: bus runs start only on Claude or Codex, the backends with an OS sandbox and network off; anything else (Gemini runs `--approval-mode yolo` with no sandbox) is `NO_ELIGIBLE_AGENT`, at admission and again in the engine.
- **Settings**: `policy.json` `bus` and Preferences may both set `enabled`, `auto_accept`, `wall_clock_min` and `caps`; the stricter wins (off, the shorter clock, caps on, the lower cap).
- **Sandbox**: no network. Claude: `allowedDomains: []` whatever the repo allows, WebFetch/WebSearch disallowed, `Bash(git push*)`/`Bash(gh pr*)` as a backup only. Codex: `network.enabled=false`, user config ignored. The network block is the control against push and PR (`allow_pr` false).
- **Wall clock**: every bus run stops after `wall_clock_min` (20, on by default) through the stop recipe.
- **Spend caps** (default **off**; owner decision 2026-10-22): when on, a claim needs `member remaining ≥ reservation` (reservation = `budget_usd`, default $5, per-handoff max $5); Claude runs get `--max-budget-usd`; Codex runs are priced after the run from tokens (`cost_basis: 'estimated'`) and can overshoot their reservation by one run's cost. The reservation is recorded at claim and settled against the day it was made: to the measured cost, or to 0 for a start that fails or an offer that expires (`result.expired`).
- **Loops**: hop = 1 + the highest hop the caller's hop domain (this Mac and the repo of the caller's working folder; never the provider or target repo it declares) consumed (`bus_wait`/`bus_read`) in the last hour; runs inherit their handoff's hop + 1. Refused with `LOOP`: hop > `max_hops` (2), a target already in `visited`, handing straight back to the provider that handed over. A result never triggers a handoff.
- **Rates**: per agent 20 handoffs/h, per Mac 60/h, per card 6 runs/day, per repo 12 runs/day, 3 failures/h on a card or repo pauses it.
- **Kill switch**: tray "Stop agent bus" (shown once an AI has handed off, and while halted) and Sessions → Agent bus set halted, append `control.halt` and stop every `source: 'bus'` task. Halt (or the bus turned off) is checked before every start and again once a start returns, which then stops that run and reopens its claim; a restart only reopens claims, and starting them is left to the dispatcher, which honours halt. Resume is a person's action.
- **Scrubbing**: handoff text in main's relay (`src/scrub.js`, home → `~`); run-originated text (results, onward handoffs) in the utility process (`secret-patterns.mjs` + `packet-text.js`), both before `bus.db`.

## 6. MESSAGING v1 deltas

A bus handoff can start work (MESSAGING "not start-work") under the receiver's `bus.auto_accept`, replacing per-target `automation` with per-repo `bus_auto`. Kept: framing, `grants_execution`/`approval` false, dedupe, `outcome_unknown` never retried, hub-derived hop/visited/caused_by (applied to consumption too), scrubbing, idle-only delivery (the bus never touches a live session). Agent mail to persons stays held for Send.

## 7. Backbone (2026-11-06, BACKBONE-AUDIT-AND-PLAN lane 2)

Shared names: `src/bus-contract.js` (reason enums, tiers, provider health, board-route `why`, trace shape). Other code imports it read-only.

### 7.1 Notes reach a working session (G1, owner decision D3)
A note's one-line notice is printed at the recipient's next **PostToolUse** as well as at SessionStart and UserPromptSubmit (`hooks/awareness.js midTurn`, wired in `hooks/set-status.js` for Claude Code and `hooks/emit.js` for Codex lifecycle hooks). The notice prints only for a note set the session was not told yet, at most once every 2 minutes, and never with the body. It uses the same receipt as the turn notice, so main marks the notes `notified` with no one typing. `agentAwareness.midTurnNotices` defaults on; `false` turns it off. Files only, no git: the no-change check stays under 5 ms p95 (`test/awareness-midturn.test.js`).

### 7.2 Notes are on from boot (G2)
`halted() === 'unknown'` (the helper has not answered yet) no longer turns notes off: a note never starts a run. Only a known halt holds notes. Hand-offs still wait for the helper, which refuses while halted. Main asks the helper every 60 s once it is up (`src/agent-bus-main.js`), and never starts it to ask.

### 7.3 `repo_enabled` says why (G3)
`engine.busRepoReason(top)` returns `{allowed, why}` or `{allowed:false, reason}`. Reasons: `EXCLUDED`, `PROTECTED` (also `$HOME` when it is not a checkout), `LISTED_ONLY` (scope `'listed'` only), `NOT_GIT`, `BUS_OFF` (hello only). Allowed reasons: `POLICY`, `LISTED`, `AUTO`, and for an unbound caller `SESSION` or `WORKTREE`. Automatic mode takes every repository, worktrees included, for a caller main bound to a live session (owner decision, 6 Nov). A caller main could not bind (a run handing on, a headless or unverifiable session) has only the folder it reported, so automatic mode still wants a session or task folder in that repository (`NO_SESSION` otherwise), as before. The helper counts every caller as unbound unless main says otherwise over parentPort: main sends each bound caller's `hello` and `bus_handoff` that way (`src/tasks-service.js parentRouted`), and through `tasks.sock`, which any same-user process holding `tasks.token` can reach, neither `bound` nor an origin is read and leaving `unbound` off changes nothing (security review #1). A bound caller is judged by the folder main verified, not the one its MCP process reported. The 6 Nov audit's `repo_enabled:false` was the owner's two-entry list restricting automatic mode; it no longer does. Preferences' hint under the list (`settings.html`, Lane 3) still says the list restricts in automatic mode and needs the new wording.

### 7.3a Unverified clients and Remote Control (D2, owner requirement 6 Nov)
A caller whose MCP server is not a stdio child of a signed Claude Code or Codex process (Gemini CLI, Cursor, VS Code, the Claude desktop app, Hermes, a server an agent started from its shell) is `unverified_client`: `bus_hello` reports that tier and `can: ["peers", "card_personal"]`, and `bus_handoff` is refused (`POLICY_DENIED`) before it reaches the helper. This is decided without reading the caller's environment. A caller under a real Claude or Codex parent that is not a person's session (`HEADLESS`: `claude -p`, the SDK, `codex exec`) is tier `headless` (`can: ["peers"]`), and one that failed a check a genuine session passes (`NOT_OUR_SERVER`, `LISTENING`, `NOT_STDIO`, `INJECTED`, `CWD`, `OWNER`) is `unverified_client`: both have `bus_handoff` refused (`POLICY_DENIED`) in main's relay. A transient miss (no session file yet, a tie, a thread mid-move, a gone parent) stays unbound and the helper's `NO_SESSION` rule decides. A run's own onward hand-off uses its per-run task server, never this path (security review #3). `PLEXIFORM_CLIENT` (Lane 1's MCP entries) is read only from a child that passed the parent, program and stdio checks, and only lowers it (`CLIENT_DECLARED`, never bound). Hermes is placed by the folder it reports, never `~/.hermes` (D7).

Claude Code Remote Control: `claude --remote-control` is the ordinary CLI (entrypoint `cli`). A session the `claude remote-control` server starts for the phone or claude.ai runs on this Mac with `--print`, so its entrypoint is `sdk-cli`, and Claude marks it `CLAUDE_CODE_ENVIRONMENT_KIND=bridge` (Claude Code 2.1.319). Both are a person's session (`hooks/awareness.js claudeInteractive`, also in `set-status.js` and the caller binding), the bridge one only while its claude process's own parent is the `claude remote-control` server (`ps` argv; in the caller binding also a signed claude): every process a bridge session starts inherits `CLAUDE_CODE_ENVIRONMENT_KIND=bridge`, so a `claude -p` from its Bash tool is headless (security review #4): listed, bound, sent notes, given mid-turn notices through hook output (which the remote client shows), and handed their results. Nothing waits on a local key press. Plain `claude -p` and the SDK stay headless. Plexiform's own remote control and relay sessions (`remote: true`) are another device's and never local peers, as before.

### 7.4 Provider health and fallback (G4, owner decision D4)
`bus/provider-health.js` keeps one circuit breaker per provider in `bus.db` state, shaped as `{provider, state: closed|open|half_open, reason: QUOTA|AUTH|MISSING|CRASH, retry_at, since, failures}`.
- A run that fails with `limit` opens it as `QUOTA`, with `retry_at` from the provider's own "try again at/in …" text; else after an hour.
- `auth` opens it as `AUTH` (30 min). A start refused `AI_UNAVAILABLE` opens it as `MISSING` (10 min).
- `provider`/`network` failures open it as `CRASH` after 3 in a row (5 min). A task's own `error` never counts.
- Past `retry_at` it is half open: runs start, and the next provider failure re-opens it.

A hand-off naming an open provider is refused at once: `PROVIDER_UNAVAILABLE {provider, retry_at, provider_reason}`.
- `to.provider` is `any` (the default from `bus_handoff`), one provider, or a list. A list is tried in the caller's order but only over AIs in the person's fallback order; one left out of it is never tried (`["codex"]` with Codex not in the order is `PROVIDER_UNAVAILABLE`, security review #5). A single named provider is the caller's explicit pick and is not limited by the order.
- `any` and lists use the person's order (`agentBus.fallbackOrder`, default claude → codex → gemini, filtered to the providers that can take bus runs) and skip open breakers.
- If a run asked that way fails for `QUOTA`, `AUTH` or `MISSING`, the dispatcher posts it once to the next provider: same hop, `caused_by` and `data.fallback_of` set, same caps. The first result's `data.fallback` names the new hand-off.
- `agentBus.fallback: false` is the one switch that turns this off.
- A breaker opens on a hand-off run's failure (`failKind`), on its park (`parkReason: limit` → `QUOTA` until the run's own `limitResetAt`, `auth` → `AUTH`), and on any other task of this Mac's that parks on its usage limit. A hand-off result for a provider failure carries `reason: PROVIDER_UNAVAILABLE`, `provider_reason` and `retry_at` (also in `bus_wait`).
- `bus_status` lists every provider's breaker; `buddy_health` turns it into the `bus-providers` row ("Codex is out of its usage quota until …").

### 7.5 Results come back (G5)
Main passes the verified asker (`caller.origin = {key, handle, board?}`) on a hand-off, and the offer keeps it. When the hand-off ends (`done`, `failed`, `expired`, `outcome_unknown`), the dispatcher writes one note from `plexiform` to that session (`notes.system`, one per hand-off and recipient, 24 h). The note is one line of outcome with the `handoff_id`, the start of the summary, and a pointer to `bus_wait`; it is read framed like any note.
- The notice reads "N hand-off results waiting".
- A run that stops for its person (a tool approval, `blockedKind: permission`; a plan to approve, `plan`) sends the asker one more note from `plexiform` on the same path: `Hand-off <id>: <AI> running in Plexiform is waiting for your person to get a step approved (Needs you in Plexiform)…`. It names only the `handoff_id` and the AI, never the title, brief, tool input or a path; one per blocking ask (keyed by its approval or ask id), traced as `returned` with `reason: BLOCKED`.
- If the asker has ended, main shows and reads the result for the newest live session in the same repo; otherwise it stays on the asker's key until it expires, and on the card through `bus_read`. In detail (`src/agent-awareness.js`, successors):
  - The successor is picked again with every roster: among live, non-wrapped sessions with notes on whose `repo_key` equals the ended asker's, the one that started last. Main remembers each session's `repo_key` past its end (at most 300 keys), so an asker it never saw in a roster has no successor.
  - Only Plexiform's own result notes pass on (`from: plexiform`, `isSystemNotice`); a peer's `bus_note` to the ended session never does and expires on its key.
  - The successor's notice counts them with its own; its `bus_notes` (no `note_id`, not `status`) reads up to 5 in all, each read and acknowledged under the ended session's key, so the helper's read receipts stay per recipient.
- Main syncs notes every 15 s for 30 min after a hand-off.

The origin (which session the result note goes to) reaches the helper only over its parentPort, which only main holds: `tasks-service` sends a hand-off carrying `caller.origin` through `busMain` once the socket is up and has the bus context, and `engine.bus` drops an origin that arrives over `tasks.sock`, so no same-user process can aim a result note at a session. The same holds for `bound`: through the socket every caller is unbound (security review #1), so main sends every bound caller's `hello` and hand-off over parentPort, origin or not. A trace id is accepted on either channel. Over parentPort a hand-off's refusal keeps its wording; the note ops still return a code only.

### 7.6 Which board (G8)
`src/work-capture.js routeBoard`: the first rule that matches wins, and every answer carries `why` (`BOARD_WHY`).
1. Marked personal: `none`, `personal_mark`.
2. `inherited`: the hand-off's board (main puts the asker's route key on the hand-off as `origin.board`; it reaches the run as `sourceMeta.originBoard`, and `bus_card_add` takes it as `origin_board`).
3. One linked team board: `linked_repo`.
4. Several: the person's default (`repo_default`); with none, My board with the pick-board chip (`choose`). Not a refusal.
5. Not linked: My board, `no_link_suggested` when a linked repo shares its GitHub org, else `no_link`.
6. No repo: My board, `no_repo`.
7. Catalog incomplete (hub offline): My board with `pending_route`, `why: deferred`. The card is re-routed when a complete catalog arrives: a team card is made, and the My board copy is closed with one line saying it moved.

A hand-off run is carded from the moment the engine creates it: the engine's work rows (`onWork`, the same path as the person's own tasks, `src/wrapped-work.js`) include `source: 'bus'` tasks with `handoff: true` and the asker's `originBoard` when it has a team board, so rule 2 puts the card there; otherwise the repo rules apply (My board by default). The hand-off's title is an AI's: it is shown on My board only, and a team card reads "<AI> · <folder>" like an untitled task. The route key stays in main and the Tasks helper; offers and bus.db carry no board.

### 7.7 Trace (G11)
`src/bus-trace.js` appends one JSONL line per bus op, shaped `{t, trace_id, span, op, from_handle, to, provider, repo_key_hash, result, reason, ms, ref}`. The file is 0600 and rotates at 5 MB. Every field passes a closed pattern, so no body, brief, title, path or CLI text can be written.
- One file, `<Plexiform data>/bus-trace.jsonl` (`~/.claude-traffic-light`), with two writers appending to it. Main writes the ops it answers: `peers`, `note`, `notes`, `card`, `notified`. The Tasks helper writes `hello`, `handoff`, `read`, `wait`, `status`, `halt`, `resume`, each hand-off's `claim`, `start`, `result` and `returned`, and `breaker` changes. `utility-entry.js` passes it the path as `busTraceFile`. A writer re-reads the real size before it rotates, so neither moves a file the other just rotated. Before this change the helper wrote `<Plexiform app support>/tasks/bus-trace.jsonl`; that older file is no longer written.
- A hand-off's lines share the `trace_id` main minted.

