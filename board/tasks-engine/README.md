# Tasks engine ("Hand it off")

The real engine behind `board/TASKS-CONTRACT.md` (protocol v1). It serves the
same socket API as `tasks-api/mock-server.js`, so the UI, the `buddy` CLI and
the MCP tools use `tasks-api/client.js` against either one unchanged.

```
startTasksEngine({ dataDir, backends?, log?, now?, env?, maxParallel?, acceptFrom?, hbMs? })
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
  runner.sock           0600 (refuses to start over a live socket, a non-socket, or another user's socket)
  tasks.token           0600 btk_…; reused across restarts, replaced if it was loosened or malformed
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
3. `dataDir`: a short private dir in the user data folder, e.g.
   `<userData>/tasks`. Use a dir of its own until the engine moves into the
   runner supervisor: the contract puts the Tasks API on the runner's control
   socket (`BOARD_HOME/runner.sock`, `type` frames vs `method` frames), and two
   processes can't share one socket path.
4. Add `board/tasks-engine/**` to the package `files` and tag the fork line
   with a `privacy-flow` slug documented in `PRIVACY.md`.
5. The UI connects with `tasks-api/client.js` (`connect({ socketPath, tokenPath })`).

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
- Trust (§9.2): `bypass` refused; `mcp` and remote sources clamped to
  `auto-edits`; remote sources forced plan-first and wait for a local accept
  unless `sourceMeta.userId` is in `acceptFrom`.

Not yet: `merge`, `openPr`, `switchAi`, tmux/tab surfaces, task-to-task
messaging tools, `.buddy/claims.json`, approval/ask timeouts, sleep detection,
transient-429 retries, the per-project `bypass` opt-in.
