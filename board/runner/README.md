# Board runner

The detached supervisor on each member's machine. It holds one outbound WSS to the
hub, claims offers under the local trust policy, and runs the member's own `claude`
CLI per run inside the isolation profile. The protocol is fixed by `../CONTRACT.md`
and `../shared/`; this README covers running it.

```
cd board && npm install
node runner/cli.js enroll --hub https://board.example.com --device <id> --token <bdt_…>
node runner/cli.js opt-in <repo_id> --path ~/code/app      # policy.json (runner-local, authoritative)
node runner/cli.js start                                    # detached; log in ~/.board/runner.log
node runner/cli.js status | stop-all | confirm <request_id> yes|no
```

`BOARD_HOME` overrides `~/.board`. `BOARD_MCP_SERVER` overrides the board MCP server
path (default `board/mcp/server.js`). Buddy later spawns `cli.js start --foreground`
itself and talks NDJSON on `~/.board/runner.sock` (`status`, `subscribe`, `opt_in`,
`confirm_offer`, `stop_all`, `host_suspending`, `host_resumed`).

## Under the desktop app (D37)

The app runs `runner/app-entry.js` as an Electron `utilityProcess` (never `cli.js`,
never detached: the app is the supervisor). No device file and no env secret is read;
the app posts the config over `process.parentPort`:

```
app → runner  {type:'runner.config', hub_url, device_id, device_token, cf_client_id?, cf_client_secret?, data_dir}
runner → app  {type:'runner.ready'}
runner → app  {type:'runner.status', state:'connected'|'backoff'|'unauthenticated'|'revoked'|'unavailable'|'stopping', detail?}
runner → app  {type:'runner.fatal', message}          then exit 2 (bad config) / 1 (startup failed)
runner → app  {type:'runner.stopped', parked, orphaned} then exit 0 (after SIGTERM/SIGINT)
app → runner  {type:'runner.presence', enabled, sessions:[{session_id, agent, cwd, state, since, summary?}]}   since: ISO-8601, ≤ 40 chars
```

`data_dir` (absolute) takes the place of `BOARD_HOME`. The token and the Access
service-token pair live only in memory and only in the WS connect headers; they never
reach a log line. SIGTERM (or SIGINT) parks every live run instead of orphaning it: the
agent gets the final-handover prompt (10 s window), then the stop recipe, a pushed snapshot
to `refs/board/<KEY>/r<fence>`, and `board_release{requeue:true}` at the run's fence, so the
card goes back to the queue with its handover. New offers are ignored meanwhile. After at
most 25 s the runner posts `runner.stopped` and exits 0; a run that could not be parked (hub
unreachable, release refused, budget spent) stays in the ledger and the next start treats it
as an orphan (stop recipe, snapshot, `run.failed{supervisor crash}`).

Team presence (`runner.presence`) is off until the app enables it. Each session's `cwd`
is mapped to its repo's configured origin; sessions in repos that are not on one of the
member's boards are dropped. The hub gets `{hashed session_id, agent, repo_id, branch,
state, since, redacted summary ≤ 120}` in a `presence` frame, on change at most every
5 s and every 60 s as a keepalive. `enabled:false` sends one empty frame so the hub
clears it at once.

## Modules

| File | Role |
|---|---|
| `cli.js` | enroll / start / status / stop-all / opt-in / confirm |
| `supervisor.js` | Hub WS (hello/welcome/replay, backoff ≤ 30 s, origin-down), HB every 15 s, tick-gap sleep + powerMonitor, offers → claim, run spawn/resume, ledger + orphan recovery, control socket |
| `run.js` | One run: gate G, facts, hook answers, board tools, approvals (T1 re-check), delivery, snapshots, stop/park/handover, fencing + salvage, terminal state from the stream `result` |
| `backends/claude.js` | Spawn with the launch profile, stream-json parser, stdin injection, `control_request` interrupt, the stop recipe |
| `backends/codex.js` | Phase 1.5 interface stub |
| `launch.js` | Pure builders: argv, allowlisted env, `settings.json`, `mcp.json`, brief |
| `hook-shim.js` | The CLI hook command: dead-man check, forward over IPC, fail-closed for `pre` |
| `ipc.js` | Per-run unix socket (0600, NDJSON ≤ 1 MiB, constant-time token check, `cancel`) |
| `outbox.js` | Durable NDJSON outbox, per-device seq; stores only `serializeOutbound` bytes |
| `git.js` | Scope inputs, worktree per run, snapshot via private `GIT_INDEX_FILE` + secret scan + size cap |
| `procs.js` | pid + lstart identity, process table, tree kill |
| `policy.js` | Offer decision, advertise set, approval answerer re-check |
| `app-entry.js` | Desktop-app entry (D37a): config over `parentPort`, ready/status/fatal replies, SIGTERM → park live runs, exit 0 |
| `presence.js` | Team presence reporter (D37b): cwd → repo, default deny, hashing, redaction, throttle + keepalive |

## Tests

`npm test` (in `board/`) runs `runner/test/*.test.js` against a fake hub and
`test/fixtures/fake-claude.js`; no network, no Claude spend, temp dirs under `/tmp`
(unix socket paths must stay < 104 bytes).

`runner/scripts/check-isolation.sh` (= `node runner/scripts/smoke-real.js`) runs the
member's real `claude --model haiku` once through the whole profile against a fake hub
and a temp repo (budget-capped, ≈ $0.04). Not part of `npm test`.
