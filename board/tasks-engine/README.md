# Tasks engine ("Hand it off")

The real engine behind `board/TASKS-CONTRACT.md` (protocol v1). It serves the
same socket API as `tasks-api/mock-server.js`, so the UI, the `buddy` CLI and
the MCP tools use `tasks-api/client.js` against either one unchanged.

```
startTasksEngine({ dataDir, backends?, log?, now?, env?, maxParallel?, retentionDays?, retentionMax?, hbMs? })
  → { socketPath, tokenPath, token, epoch, tasks, engine, close({ leaveRuns? }) }
```

| File | What it does |
|---|---|
| `index.js` | `startTasksEngine`: private data dir, store, engine, transport |
| `transport.js` | unix socket (0600 in the 0700 data dir), token (`tasks.token`, 0600), NDJSON ≤ 1 MiB, schema validation, subscribe replay / reset / lagged, hb green lease push |
| `engine.js` | tasks, states, events (seq), faces, `act`, scheduling, runs through the runner's backends |
| `store.js` | append-only `store/tasks.jsonl` + `store/events.jsonl`, torn-line safe, compacted to the 10 000-event ring |

## Data dir layout

```
<dataDir>/              0700, must not be a symlink or another user's dir
  tasks.sock            0600 (refuses to start over a live socket, a non-socket, or another user's socket)
  tasks.token           0600 btk_…; reused across restarts, replaced if it was loosened or malformed
  relay-tokens.json     0600, sha256 hashes and bound source/sender/parent of relay tokens
  policy.json           optional, written by the UI: {accept_from:[userId], repos:{<path|canonical>:{remote_tasks:true}}}
  store/                tasks.jsonl, events.jsonl (0600)
  mesh/<taskId>.ndjson  human messages (tasks-api/mesh.js MessageStore)
  run/<taskId>/         per-run dir: settings.json, mcp.json, hook.token, ipc.sock, shell/
```

Worktrees live next to the repo (`<repo>-buddy-<id>`, branch `buddy/<slug>-<id>`),
never inside the data dir, and the whole data dir is denied to the agent
(sandbox `denyRead` + `Read/Edit/Write` disallow rules + the PreToolUse
confinement to the worktree). Keep `dataDir` short: `run/<taskId>/ipc.sock`
must fit in 103 bytes. A too-long path fails the task with a fixed reason; a
too-long `runner.sock` path refuses to start (`SOCKET_PATH_TOO_LONG`).

## Starting it from the desktop

Opening the sidebar Tasks page or Tasks window lazily starts
`board/tasks-engine/utility-entry.js` under `src/tasks-process.js`. The helper
uses the private `<userData>/tasks` folder and detects only Codex by default;
opening the page does not invoke Claude. The backend registry still supports
explicit provider integrations. The service reads its private token and
connects through the real socket. Packaged builds never use the mock service.

1. The small entry `board/tasks-engine/utility-entry.js` runs
   `startTasksEngine({ dataDir, log })` and reports
   `{type:'tasks.listening', socket, epoch}` over `process.parentPort`; on
   `SIGTERM` it calls `close()` (live runs get the stop recipe and become
   `orphaned`, resumable with `retry`).
2. `main.js` starts it with `utilityProcess.fork(entry, [], { serviceName, env })`
   through an injected `fork`, the same way `hub-process.js` is supervised
   (restart window, bounded restarts, readiness = the `tasks.listening` message).
   Pass an env built for it (`HOME`, `PATH`, `LANG`, `TMPDIR`): the CLI env
   allowlist is built from it, and it must not carry hub or runner tokens.
3. `dataDir`: a short private dir of its own in the user data folder, e.g.
   `<userData>/tasks`. The API is on `tasks.sock` there (TASKS-CONTRACT §3),
   separate from the runner's control socket.
4. `board/tasks-engine/**` and `board/tasks-api/**` ship in package `files`;
   the fork and Codex invocation are documented in `PRIVACY.md`.
5. The UI connects with `tasks-api/client.js` (`connect({ socketPath, tokenPath })`).

Pre-release battle test (manual, not in CI): from inside a real sandboxed
Bash tool of a running task, `nc -U <dataDir>/tasks.sock` (and reading
`tasks.token`) must fail. The settings tests only assert that the sandbox
grants no `allowUnixSockets`; the real sandbox is the proof.

A restart of the engine changes `epoch`; clients get `reset {reason:'epoch'}`
and refetch. Background runs can't be re-adopted (their stdio pipes died with
the old process): a CLI that is still alive is killed (pid + lstart checked)
and its task becomes `orphaned`; nothing restarts on its own. Closing a Tasks
window leaves the helper running. Quitting the app gracefully stops active
runs, which can be retried after restarting; a utilityProcess does not outlive
Electron. The UI states this explicitly.

## What E1 implements

- Methods: all twelve. `act`: `stop`, `pause`, `resume` (`now`, and `reset`
  for a usage-limit pause with a known reset time), `approve`/`deny` (remote
  start and permission prompts), `answer` (plan-first), `message`,
  `takeover`/`handback`, `discard`, `retry`. `actions` lists only these.
- AIs: Codex exec (CLI 0.159+) through `runner/backends/codex.js`, using its
  existing login, JSON events and session resume. Other registered providers
  retain their explicit integrations. Codex's workspace sandbox blocks command
  network access, Unix sockets and private auth/engine files, ignores config
  and rules, and makes trusted instruction files and git config/hooks read only.
  Plan approval resumes the real session under the permitted editable profile;
  a child capped to `plan` stays read only, even after its plan is approved.
  Codex has no native spend cap, interactive approvals or hooks; asking for
  those capabilities fails before spawn. User messages sent mid-turn are
  queued for the next turn, rather than claiming live steering.
- Trust (§3, §9.2): `tasks.token` is the UI/CLI's; relays get scoped `btr_`
  tokens (`relay-tokens.js addRelayToken`) that bind their source and verified sender
  (`userId`), or require their active parent session (`parentSessionId` for MCP).
  MCP reads/actions/pushes stay on that parent and its children; other sources
  need explicit task grants or creation repos, and own only their created tasks.
  Grants expire (24h default) and revoke per token/source; queued actions and
  live pushes recheck authority. Relays cannot impersonate local-user messages,
  approve, answer, take over, accept a start or set device limits. `bypass` refused; `mcp` and
  remote sources clamped to `auto-edits` (spin-offs also to the parent's level,
  in the parent's repo); remote work needs `policy.json`
  `repos[<path|canonical>].remote_tasks: true`, is forced plan-first and waits
  for a local accept unless the sender is in `policy.json accept_from`.
- Limits: `maxParallel` ≤ 8, 100 waiting tasks per source, `listTasks` paged,
  finished tasks pruned after 30 days / beyond the newest 500, per-task package
  caches (global caches are not writable).

Not yet: `merge`, `openPr`, `switchAi`, tmux/tab surfaces, task-to-task
messaging tools, `.buddy/claims.json`, approval/ask timeouts, sleep detection,
transient-429 retries, the per-project `bypass` opt-in.
