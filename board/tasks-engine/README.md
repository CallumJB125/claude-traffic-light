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
  relay-tokens.json     0600, sha256 hashes of the relay tokens and their forced source
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

## Starting it from the desktop (next slice)

Not wired yet. The plan mirrors the embedded hub (`buddy-window/hub-process.js`):

1. Add a small entry, e.g. `board/tasks-engine/utility-entry.js`, that runs
   `startTasksEngine({ dataDir, log })` and reports
   `{type:'tasks.listening', socket, epoch}` over `process.parentPort`; on
   `SIGTERM` it calls `close()` (live runs get the stop recipe and become
   `orphaned`, resumable with `retry`).
2. In `main.js`, start it with `utilityProcess.fork(entry, [], { serviceName, env })`
   through an injected `fork`, the same way `hub-process.js` is supervised
   (restart window, bounded restarts, readiness = the `tasks.listening` message).
   Pass an env built for it (`HOME`, `PATH`, `LANG`, `TMPDIR`): the CLI env
   allowlist is built from it, and it must not carry hub or runner tokens.
3. `dataDir`: a short private dir of its own in the user data folder, e.g.
   `<userData>/tasks`. The API is on `tasks.sock` there (TASKS-CONTRACT §3),
   separate from the runner's control socket.
4. Add `board/tasks-engine/**` to the package `files` and tag the fork line
   with a `privacy-flow` slug documented in `PRIVACY.md`.
5. The UI connects with `tasks-api/client.js` (`connect({ socketPath, tokenPath })`).

Pre-release battle test (manual, not in CI): from inside a real sandboxed
Bash tool of a running task, `nc -U <dataDir>/tasks.sock` (and reading
`tasks.token`) must fail. The settings tests only assert that the sandbox
grants no `allowUnixSockets`; the real sandbox is the proof.

A restart of the engine changes `epoch`; clients get `reset {reason:'epoch'}`
and refetch. Background runs can't be re-adopted (their stdio pipes died with
the old process): a CLI that is still alive is killed (pid + lstart checked)
and its task becomes `orphaned`; nothing restarts on its own.

## What E1 implements

- Methods: all twelve. `act`: `stop`, `pause`, `resume` (`now`, and `reset`
  for a usage-limit pause with a known reset time), `approve`/`deny` (remote
  start and permission prompts), `answer` (plan-first), `message`,
  `takeover`/`handback`, `discard`, `retry`. `actions` lists only these.
- AIs: Claude through `runner/backends/claude.js`; Codex is detected but not
  startable (`AI_UNAVAILABLE`, "not available in Plexiform yet").
- Trust (§3, §9.2): `tasks.token` is the UI/CLI's; relays get scoped `btr_`
  tokens (`relay-tokens.js addRelayToken`) that force their source and can't
  approve, answer, take over or accept a start. `bypass` refused; `mcp` and
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
