# Agent bus (v1, phase 1: this Mac)

AI tools hand bounded work to each other. A handoff is claimed and started automatically, as a fresh Tasks run, under the receiver's standing policy, and its result comes back to whoever asked. Phase 1 is local only: no hub, no team scope. `board/MESSAGING.md` v1 stays frozen; the deltas are in §6.

## 1. Where it runs

- **Electron main** relays only: `POST /bus` on the signal server (`src/signal-server.js`), token-checked, no browser origin, scrubbed, then forwarded asynchronously over the Tasks socket (`tasks-service.bus`). Main never opens `bus.db`, SQLite or a repo path for the bus (`test/bus-main-thread.test.js`).
- **Tasks utilityProcess** owns everything else (`board/tasks-engine/bus/`): `local-log.js` (`bus.db`, 0600, in the engine data dir), `guard.js` (admission), `dispatcher.js` (claim → `engine.createTask` in-process with `source: 'bus'` → result), `pricing.js`.
- **Agents**: interactive sessions use `bus_*` in `mcp-server.js`; bus-started runs get `bus_result` and `bus_handoff` on their per-run task server (`board/mcp/task-tools.js`, handled in `collaboration.js`).

## 2. Envelope (v1)

`{v:1, id, request_id, topic, offset, scope:'local', card_id, repo:{root}, source:{device_id, agent_id, provider, tier, identity_source}, to, kind, handoff_id, body, data, hop, visited, caused_by, created_at, expires_at, grants_execution:false, approval:false}` (`board/shared/bus-schema.js`). One monotonic offset per `bus.db`. Bodies are untrusted text: scrubbed, at most 3200 characters, delivered only inside `frame()` (`board/shared/untrusted-frame.cjs`).

| Topic | Kinds | Retention |
|---|---|---|
| `handoff` | `handoff.offer`, `handoff.refused` | 30 d |
| `claim` | `claim.granted`, `claim.denied`, `claim.started`, `claim.released`, `claim.lost` | 30 d |
| `result` | `result.done`, `result.failed`, `result.outcome_unknown` | 30 d |
| `control` | `control.halt`, `control.resume`, `control.policy_changed`, `control.cap_reached`, `control.card_paused` | 90 d |

Delivery is at-least-once; dedupe by `(source agent, request_id)` and by `(card_id or repo, title + brief)` within an hour. Exactly one start per handoff: the claim CAS hands out a fence; a stale fence changes nothing and its result is refused. Leases (120 s) are renewed while the run lives; after a restart a granted claim with no task reopens (fence + 1), a started one whose run is gone becomes `outcome_unknown` and is never retried.

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
| `bus_hello {provider}` | interactive | `{agent_id, tier, scope_allowed, policy_summary}` |
| `bus_handoff {request_id, to:{provider}, repo?, card_id?, title, brief?, files?, branch?, budget_usd?, ttl_s?}` | interactive | `{handoff_id, state, hop}` or `{reason}` |
| `bus_wait {handoff_id, timeout_s ≤ 120}` | interactive | the framed result, or `{state:'pending'}` |
| `bus_read {topic: handoff\|result, after_offset?, limit ≤ 50}` | interactive | framed events, `next_offset` |
| `bus_status {handoff_id?}` | interactive | the offer → claim → start → result chain |
| `bus_result {request_id, outcome, summary}` | run | recorded; delivered when the run ends |
| `bus_handoff` (no `repo`) | run | as above; tier `run_capability`, hop and visited from the run |

Refusal reasons: `HALTED`, `SPEND_CAP`, `LOOP`, `RATE`, `NOT_MEMBER`, `TIER_NOT_ACCEPTED`, `NO_ELIGIBLE_AGENT`, `NO_LOCAL_CHECKOUT`. No agent tool can post `control` or `claim` or change policy; `halt`, `resume` and `busSetContext` are main's own ops (tray, Preferences, Sessions → Agent bus) and the relay refuses them.

## 5. Guardrails (all refusals, never prompts)

- **Opt-in per repo, on this Mac**: `policy.repos[<realpath|canonical remote>].bus_auto === true` in the engine's `policy.json`, or the repo listed in Preferences → Advanced → Agent bus. `remote_tasks` never counts for the bus. Repos are resolved only from those keys and folders already registered as task folders; no picker. No match: `NO_LOCAL_CHECKOUT`.
- **Start with no human gate**: `planFirst` is false unless the spec asks; `awaitingConfirm` is false under `bus.auto_accept` (default on) for local scope; no budget dialog. The remote rules still apply: at most `auto-edits`, always a new worktree.
- **Sandbox**: no network. Claude: `allowedDomains: []` whatever the repo allows, WebFetch/WebSearch disallowed, `Bash(git push*)`/`Bash(gh pr*)` as a backup only. Codex: `network.enabled=false`, user config ignored. The network block is the control against push and PR (`allow_pr` false).
- **Wall clock**: every bus run stops after `wall_clock_min` (20, on by default) through the stop recipe.
- **Spend caps** (default **off**; owner decision 2026-10-22): when on, a claim needs `member remaining ≥ reservation` (reservation = `budget_usd`, default $5, per-handoff max $5); Claude runs get `--max-budget-usd`; Codex runs are priced after the run from tokens (`cost_basis: 'estimated'`) and can overshoot their reservation by one run's cost.
- **Loops**: hop = 1 + the highest hop the caller's hop domain consumed (`bus_wait`/`bus_read`) in the last hour; runs inherit their handoff's hop + 1. Refused with `LOOP`: hop > `max_hops` (2), a target already in `visited`, handing straight back to the provider that handed over. A result never triggers a handoff.
- **Rates**: per agent 20 handoffs/h, per Mac 60/h, per card 6 runs/day, per repo 12 runs/day, 3 failures/h on a card or repo pauses it.
- **Kill switch**: tray "Stop agent bus" (shown once an AI has handed off, and while halted) and Sessions → Agent bus set halted, append `control.halt` and stop every `source: 'bus'` task; resume is a person's action.
- **Scrubbing**: handoff text in main's relay (`src/scrub.js`, home → `~`); run-originated text (results, onward handoffs) in the utility process (`secret-patterns.mjs` + `packet-text.js`), both before `bus.db`.

## 6. MESSAGING v1 deltas

A bus handoff can start work (MESSAGING "not start-work") under the receiver's `bus.auto_accept`, replacing per-target `automation` with per-repo `bus_auto`. Kept: framing, `grants_execution`/`approval` false, dedupe, `outcome_unknown` never retried, hub-derived hop/visited/caused_by (applied to consumption too), scrubbing, idle-only delivery (the bus never touches a live session). Agent mail to persons stays held for Send.
