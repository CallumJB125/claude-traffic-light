# Team context: contract (v1)

One loop: every AI session on every platform becomes a **WorkRecord**, built automatically on the machine; scrubbed records are published to the team hub as an append-only **activity log**; every teammate's AI reads it back (session-start brief + MCP tools); the hub flags **collisions**; sessions can be **handed off**.

Transport decision: no Kafka. The hub already runs on a Raspberry Pi with SQLite and an SSE bus (`board/hub/bus.js`). The activity log keeps Kafka's useful semantics (append-only, monotonic offset `seq`, consumer resumes from a cursor, retention) on SQLite + SSE. A broker adapter (NATS/Kafka) can sit behind `board/hub/activity/log.js` later; nothing else may depend on SQLite details.

## WorkRecord v1 (built locally, no AI cooperation needed)

```
{ v:1, record_id:"<install_id>:<adapter>:<session_id>", adapter:"claude|codex|gemini|hermes|cursor",
  session_id, install_id, repo_id:string|null,            // repo_id only when the folder is linked to a team repo
  folder:"basename only", title:string<=120, goal:string<=400, summary:string<=1500,
  status:"working|waiting|review|ended|idle|paused_limit",
  files:{edited:[repo-relative paths <=50], read:[<=50]},    // paths only when route.share_files===true
  branch:string|null, started_at, updated_at, rev:int,       // rev increments on every change (idempotent upsert key: record_id+rev)
  cost_usd:number|null, route:"primary|secondary|null",      // from Burst/spend when known
  handover:{available:boolean, written_at}|null }            // never the doc path or contents
```
Source of facts: hooks + `src/handover-transcripts.js` (`factsFrom`), the same facts as the handover doc. Title: explicit `taskTitle` else first words of the latest request (scrubbed), never the folder name alone. All free text goes through `src/scrub.js`. Local-only by default: nothing leaves the Mac unless the repo route has `share_summaries:true` (files additionally need `share_files:true`).

## Hub activity log (`board/hub/activity/`)

- Table `activity_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, team_id, repo_id, record_id, rev, type, payload JSON, created_at)`, table `activity_current(record_id PRIMARY KEY, team_id, repo_id, rev, payload, updated_at)`. New migration after 062. Retention 30 days for events; `activity_current` rows for ended records expire after 7 days.
- `POST /api/activity/v1/events` `{install_id, records:[WorkRecord]}` (runner/device auth as existing routes): idempotent upsert by `record_id` and higher `rev`; appends `record.upsert` or `record.end`. Rejects records for repos the caller's team does not own. Max 50 records / 256 KB.
- `GET /api/activity/v1/feed?repo_id=&after=<seq>&limit=<=200` → `{events, next_seq}`.
- `GET /api/activity/v1/current?repo_id=` → latest record per session.
- `GET /api/activity/v1/stream?after=<seq>` SSE; honours `Last-Event-ID`; heartbeat every 25 s.
- Collisions: hub computes, for `working|waiting` records in the same `repo_id`, overlapping `files.edited`; the feed carries `{type:"collision", repo_id, path, records:[a,b]}` events. Not computed without file paths.
- Team membership gates everything; a record's author is shown by display name already known to the hub.

## Reading it back (every AI)

- `hooks/team-brief.js`: prints ≤1500 characters at supported context boundaries. Claude, Codex lifecycle and Gemini `SessionStart` hooks restore a current brief on start/resume and provider-reported post-compaction starts. Claude `UserPromptSubmit` also refreshes changed shared context before a new turn. Codex/Gemini ordinary-turn injection is not claimed. No hook controls when the provider compacts.
- The brief contains permission-filtered reports for this repository: current work, recently shared summaries/goals, open handovers and reported path overlaps. Shared text is data, not instructions or permission to edit/integrate. Details remain available through the existing memory tools; private transcripts are never injected.
- Each response has an opaque version. After stdout is fully written, a private local receipt stores only that version, its times and `hook_output_written`; agent acknowledgement is explicitly `not_observed`. An ordinary Claude turn can receive bounded changed records since that version; unchanged context is silent. A reset, receipt expiry, app restart or missing version falls back to a current snapshot. A changed context version is not a write lease and does not imply all uncapped records were read by the agent.
- Before and after a brief's hub read, the app resolves current sign-in, linked repo and sharing permission again. Offline, revoked or changed routes produce no cached context. The hook gives up after 800 ms. Claude turn briefs bypass the status-only fast hook, whose stdout is discarded. Hooks remain silent when disabled; no new sharing default is introduced.
- MCP tools in `src/mcp-server.js`: `team_activity({repo?, since_seq?})`, `who_touched({path})`, `team_handover({record_id})` (returns the scrubbed handover the author chose to share), `team_brief()`, `team_memory_search({query, here?, repo?, since?, limit?})`, `team_memory_get({record_id})`.

## Team memory (`board/hub/activity/memory.js`, migration 064)

"Has anyone in the team already done or decided X?" An FTS5 index (`memory_docs` + `memory_fts`) over the current WorkRecords: title, goal, summary, files, branch, author display name, repo name, and the handover text the author shared. `ActivityLog.putCurrent` upserts it by `record_id` in the same transaction; `sweep` and `forgetUser` remove rows by the `activity_current` rules (ended 7 days, any 30, deleted teams and accounts). Every field is scrubbed again (`cleanPacketText` + `redactSecrets`) before it is indexed; transcripts are never indexed.

- `GET /api/teams/:team_id/memory/v1/search?q=&repo_id=&since=&limit=` → `{team_id, repo_id, results:[{record_id, repo, author, title, goal, summary, status, branch, files, snippet, score, handover_shared, …}], note}`. bm25 ranked (title ≫ goal > summary/files/handover > branch/author/repo); words are ORed phrases, the last a prefix; `q` 2–200 chars, `limit` ≤ 50, `since` a date or ISO time on the hub's receive time. Bucket `memory_read_user` (60/min).
- `GET /api/teams/:team_id/memory/v1/records/:record_id` → `{record:{…, handover, handover_at}, note}`.
- Authority: a live device or session sign-in, a current member of `:team_id` (viewers included), `repo_id` owned by that team, and only records whose repo the team still owns. Anything else is 404.
- Desktop: the Search everything page's "Team memory" source asks every signed-in team that shares summaries (`TeamActivity.memoryPage`), labelled by team, off when signed out or sharing is off. The MCP tools go through the local signal server like the other `team_*` tools.
- The desktop subscribes to the stream while the app is open and shows live state and collision alerts.

## Handoff

`continue_with_another_ai` (existing board action) seeds a new session from the WorkRecord + shared handover via `src/session-router.js` `suggest()`. A human can hand a record to a teammate: the hub marks it `handoff_requested` and the teammate's brief lists it.

## Local awareness (this Mac only; `src/agent-awareness.js`, `hooks/awareness.js`)

Separate from the team brief: no hub, no network. Main writes `~/.claude-traffic-light/awareness/roster.json` (0600, folder 0700) from the interactive sessions it already tracks, debounced to 1 s and rewritten every 2 minutes as a heartbeat. Hooks never call the app for it.

- **Who is listed.** A Claude Code or Codex session that is interactive (Claude: `CLAUDE_CODE_ENTRYPOINT=cli`; Codex: the rollout's `session_meta` says a person's thread in the TUI or desktop app) and verified (an event since the app started; its recorded pid is a real `claude` or `codex` binary, by `lsof`; for Claude, that process sits in the recorded folder or one above it). `claude -p`, the SDK, `codex exec`, sub-agents, Plexiform's own runs and anything unknown are never listed and get nothing. Three or more of one tool started in one repo within 60 s show as one line to everyone else.
- **What is listed.** Handle (`<tool>-<folder≤16>-<4 hex>`), tool, folder and branch as short `[A-Za-z0-9._/-]` labels, coarse status. Branches only for a peer in the viewer's repo. Never prompt, title, summary, transcript or note text.
- **Never shown.** The one rule `hooks/repo-scope.js` shared with the agent bus (`busRepoAllowed`): a root, `$HOME`, Plexiform's data folders, a deny path, a protected folder, or a folder, linked worktree or canonical remote on the "never these" list. Unresolved means excluded. Such a session's entry is only `{allowed:false}`, its folder is left out of `GET /status` and `buddy_sessions`, and the hook also checks hashed excluded roots above its cwd.
- **When it is printed.** One output per hook, awareness first, then the team brief, each in its own cap (awareness ≤ 1,400 characters, roster block ≤ 1,000 and 8 lines). Claude Code: `SessionStart` and `UserPromptSubmit`, as a `system` message. Codex: lifecycle `SessionStart` and `UserPromptSubmit` from inside `emit.js` (the installed handlers are unchanged, so Codex's hook trust holds), as a `developer` message. Gemini CLI: `SessionStart`. A start, resume, clear or compact always restores it; a turn prints only when this viewer's view changed (membership, tool, folder, same-repo branch, group size), or once after 15 minutes when only a status changed. Receipts record that stdout was written, never that the AI read it.
- **Silence.** No `port` file, a roster older than 5 minutes, a malformed roster, awareness off, an excluded or headless session, or (at a first `SessionStart` the app has not classified yet) a folder the hook's own 300 ms check cannot clear.
- **No tools named yet.** The roster names no bus tool until the bus MCP profile is registered for that viewer (a later step).
