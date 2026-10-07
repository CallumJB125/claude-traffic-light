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

- `hooks/team-brief.js` (SessionStart, all adapters that support context injection): prints ≤1500 chars: who is working on what in this repo, last 5 changes, open handovers, collisions. Silent and fast (<1 s, 800 ms hub timeout) when offline, unlinked or sharing is off.
- MCP tools in `src/mcp-server.js`: `team_activity({repo?, since_seq?})`, `who_touched({path})`, `team_handover({record_id})` (returns the scrubbed handover the author chose to share), `team_brief()`.
- The desktop subscribes to the stream while the app is open and shows live state and collision alerts.

## Handoff

`continue_with_another_ai` (existing board action) seeds a new session from the WorkRecord + shared handover via `src/session-router.js` `suggest()`. A human can hand a record to a teammate: the hub marks it `handoff_requested` and the teammate's brief lists it.
