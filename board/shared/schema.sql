-- Board hub schema, migration 001 (design §9.2 + rev 3–5 additions + CONTRACT.md decisions).
-- SQLite via node:sqlite (Node ≥ 22.13). The migration runner (migrate.js) turns on
-- foreign_keys and WAL. Timestamps are ISO-8601 UTC strings written by the HUB's own
-- clock (one machine); runner/browser clocks are never stored as comparable instants.
-- JSON columns hold JSON text.

CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE hub_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);   -- hub_epoch, restored_at, fence_bump_applied, run_token_key_id

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  github_id INTEGER NOT NULL,                 -- identity = the person's own GitHub sign-in (via Access); dev stub uses negative ids
  github_login TEXT NOT NULL,
  email TEXT,                                 -- matched against the verified Access JWT email
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  webauthn_pubkeys TEXT,                      -- Phase 2
  created_at TEXT NOT NULL,
  UNIQUE (org_id, github_id),
  UNIQUE (org_id, github_login)
);
CREATE UNIQUE INDEX members_email ON members(org_id, lower(email)) WHERE email IS NOT NULL;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members,
  name TEXT NOT NULL,                         -- "MacBook-Pro" (shown in the sponsor line)
  kind TEXT NOT NULL CHECK (kind IN ('runner','cloud')),
  token_hash TEXT NOT NULL UNIQUE,            -- sha256 hex of the device token; the token itself is shown once
  cf_service_token_id TEXT UNIQUE,            -- one Access service token per device; NULL in dev mode
  last_seq_acked INTEGER NOT NULL DEFAULT 0,  -- outbox: every seq ≤ this is applied
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  canonical_url TEXT NOT NULL,                -- scope.normalizeRemoteUrl() output: host/owner/repo
  short_name TEXT NOT NULL,                   -- "bondly"
  aliases TEXT NOT NULL DEFAULT '[]',         -- JSON array of other remote urls for the same repo
  default_branch TEXT NOT NULL DEFAULT 'main',
  test_patterns TEXT,                         -- JSON array of regex sources for test/build commands
  allowed_domains TEXT,                       -- JSON array; sandbox network allowlist hint (runner policy wins)
  UNIQUE (org_id, canonical_url)
);

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL CHECK (key_prefix GLOB '[A-Z]*' AND length(key_prefix) BETWEEN 1 AND 10),
  next_key INTEGER NOT NULL DEFAULT 1,
  settings TEXT NOT NULL DEFAULT '{}'         -- JSON: {team_context_budget, default_budget_usd, default_max_turns}
);

CREATE TABLE board_repos (
  board_id TEXT NOT NULL REFERENCES boards,
  repo_id TEXT NOT NULL REFERENCES repos,
  PRIMARY KEY (board_id, repo_id)
);

CREATE TABLE runner_repos (                   -- mirror of the runner's LOCAL opt-in (advertise)
  device_id TEXT NOT NULL REFERENCES devices,
  repo_id TEXT NOT NULL REFERENCES repos,
  advertised_at TEXT NOT NULL,
  PRIMARY KEY (device_id, repo_id)
);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards,
  key TEXT NOT NULL,                          -- "BDL-142"
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',              -- the goal (humans only)
  acceptance TEXT,                            -- "Done means" (humans only)
  repo_id TEXT REFERENCES repos,
  base_ref TEXT,
  column_name TEXT NOT NULL DEFAULT 'todo' CHECK (column_name IN ('todo','in_progress','in_review','done')),
  -- NULL = 'todo' in states.js (no run). Column is derived whenever a run state exists.
  run_state TEXT CHECK (run_state IN ('queued','claimed','running','quiet','blocked','parked','suspended',
    'reconnecting','unresponsive','orphaned','handing_over','handed_over','failed','in_review','done')),
  blocked_kind TEXT CHECK (blocked_kind IN ('permission','question','clarify','decision','plan','conflict','loop')),
  fail_kind TEXT CHECK (fail_kind IN ('network','limit','error','budget','stopped','released')),
  fail_reason TEXT,
  stopped_by TEXT REFERENCES members,
  resume_to TEXT CHECK (resume_to IN ('quiet','blocked','claimed')),  -- set on EVERY entry to suspended/reconnecting/unresponsive/orphaned
  pre_reconnect_state TEXT CHECK (pre_reconnect_state IN ('running','quiet','blocked','claimed','suspended','unresponsive','orphaned')),
  handover_target TEXT,                       -- JSON {kind:'queue'|'member'|'self', member_id?}
  handover_provenance TEXT CHECK (handover_provenance IN ('checkpoint_complete','checkpoint_incomplete','takeover')),
  state_since TEXT,                           -- hub wall time of the last run_state change (long timers)
  queued_nudged_at TEXT,                      -- #1a sent for the current queue entry
  orphan_notified_at TEXT,                    -- N-rules orphan notification sent
  labels TEXT NOT NULL DEFAULT '[]',
  fence INTEGER NOT NULL DEFAULT 0,
  active_run_id TEXT,
  parent_card_id TEXT REFERENCES cards,
  budget_cents INTEGER,
  version INTEGER NOT NULL DEFAULT 0,         -- optimistic concurrency for human edits (PATCH)
  external_ref TEXT,
  created_by TEXT NOT NULL REFERENCES members,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (board_id, key),
  CHECK (repo_id IS NOT NULL OR run_state IS NULL),
  CHECK (fail_kind IS NULL OR run_state = 'failed'),
  CHECK (resume_to IS NULL OR run_state IN ('suspended','reconnecting','unresponsive','orphaned')),
  CHECK (pre_reconnect_state IS NULL OR run_state = 'reconnecting'),
  CHECK (blocked_kind IS NULL OR run_state IN ('blocked','parked') OR resume_to = 'blocked'),
  CHECK (run_state IS NULL OR column_name = CASE
    WHEN run_state = 'queued' THEN 'todo'
    WHEN run_state = 'in_review' THEN 'in_review'
    WHEN run_state = 'done' THEN 'done'
    ELSE 'in_progress' END)
);
CREATE INDEX cards_by_board ON cards(board_id, column_name);
CREATE INDEX cards_live ON cards(run_state) WHERE run_state IS NOT NULL AND run_state NOT IN ('done','failed','in_review','handed_over');

CREATE TRIGGER cards_fence_monotonic BEFORE UPDATE OF fence ON cards
  WHEN NEW.fence <= OLD.fence
  BEGIN SELECT RAISE(ABORT, 'fence must strictly increase'); END;

CREATE TABLE card_assignees (
  card_id TEXT NOT NULL REFERENCES cards,
  member_id TEXT NOT NULL REFERENCES members,
  role TEXT NOT NULL CHECK (role IN ('owner','collaborator')),
  PRIMARY KEY (card_id, member_id)
);

-- A Give to Claude request. Idempotency key = request_id (client-generated uuid).
CREATE TABLE dispatches (
  request_id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards,
  dispatched_by TEXT NOT NULL REFERENCES members,
  target_member_id TEXT REFERENCES members,   -- NULL = the dispatcher's own runner
  backend TEXT NOT NULL DEFAULT 'claude_cli' CHECK (backend IN ('claude_cli','codex_cli')),
  needs_confirm INTEGER NOT NULL DEFAULT 0,
  seed TEXT NOT NULL DEFAULT '{}',            -- JSON {from:['handover','answer','review'], answer?, review?}
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','cancelled','declined','superseded')),
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_pending_dispatch_per_card ON dispatches(card_id) WHERE state = 'pending';

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards,
  fence INTEGER NOT NULL,
  device_id TEXT REFERENCES devices,
  on_behalf_of TEXT NOT NULL REFERENCES members,   -- whose machine + account
  dispatched_by TEXT NOT NULL REFERENCES members,
  dispatch_request_id TEXT NOT NULL UNIQUE REFERENCES dispatches(request_id),
  backend TEXT NOT NULL CHECK (backend IN ('claude_cli','codex_cli','interactive','cloud_ma','cloud_gha')),
  -- no auth_mode: the member's CLI decides (subscription or own key); the hub never knows or stores it
  repo_id TEXT NOT NULL REFERENCES repos,
  base_ref TEXT NOT NULL,
  base_sha TEXT,
  branch TEXT,                                     -- board/<KEY>-r<fence>
  planned_paths TEXT NOT NULL DEFAULT '[]',        -- overlap inputs, repo-relative (globs ok)
  touched_paths TEXT NOT NULL DEFAULT '[]',
  snapshot_ref TEXT,                               -- refs/board/<KEY>/r<fence>
  last_snapshot_sha TEXT,
  snapshot_status TEXT CHECK (snapshot_status IN ('pushed','push_failed','held')),
  snapshot_reason TEXT,
  snapshot_at TEXT,
  facts TEXT NOT NULL DEFAULT '{}',                -- JSON facts layer (handover.js mergeHandover input)
  facts_at TEXT,
  status_summary TEXT,                             -- board_update_status (≤140)
  session_ids TEXT NOT NULL DEFAULT '[]',
  resume_session_id TEXT,
  seeded_from_handover INTEGER,                    -- handovers.version used as the seed
  cost_cents INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  UNIQUE (card_id, fence)
);
CREATE UNIQUE INDEX one_active_run_per_card ON runs(card_id) WHERE ended_at IS NULL;

CREATE TABLE leases (                              -- at most one lease per card
  card_id TEXT PRIMARY KEY REFERENCES cards,
  run_id TEXT NOT NULL REFERENCES runs,
  fence INTEGER NOT NULL,
  device_id TEXT REFERENCES devices,
  hub_epoch TEXT NOT NULL,                         -- epoch of the last HB
  last_hb_at TEXT,                                 -- persisted for display; expiry is judged in memory on the hub monotonic clock
  last_activity_at TEXT,
  tool_in_flight TEXT,                             -- JSON {name, summary, bash_timeout_ms}
  tool_bound_ms INTEGER,
  child_alive INTEGER,
  woke_at TEXT,
  post_wake_activity INTEGER,
  suspended_at TEXT,
  disconnected_at TEXT
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  run_id TEXT,
  fence INTEGER,
  device_id TEXT,
  seq INTEGER,                                     -- runner outbox seq (NULL for hub/human events)
  kind TEXT NOT NULL,                              -- feed kinds (states.js feed effects) + fact kinds + 'salvage'
  payload TEXT NOT NULL,
  actor TEXT,                                      -- member id for human actions
  at_hub TEXT NOT NULL,
  delayed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (device_id, seq)
);
CREATE INDEX events_by_card ON events(card_id, id);

CREATE TABLE handovers (                           -- narrative layer versions
  card_id TEXT NOT NULL REFERENCES cards,
  version INTEGER NOT NULL,
  run_id TEXT,
  fence INTEGER,
  sections TEXT NOT NULL,                          -- JSON narrative (handover.js applyPatch output)
  written_by TEXT NOT NULL CHECK (written_by IN ('claude','human','postmortem','system')),
  provenance TEXT,                                 -- NULL | 'post_fence' (promoted salvage) | 'frozen'
  created_at TEXT NOT NULL,
  PRIMARY KEY (card_id, version)
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards,
  author_member_id TEXT REFERENCES members,
  author_run_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('web','widget','agent','linear','github')),
  trusted INTEGER NOT NULL,
  body TEXT NOT NULL,
  for_agent INTEGER NOT NULL DEFAULT 0,
  reply_to TEXT REFERENCES comments,
  delivered_at TEXT,
  delivered_run_id TEXT,
  created_at TEXT NOT NULL,
  anchor_kind TEXT NOT NULL DEFAULT 'card' CHECK (anchor_kind IN ('card','event','file_range','diff_hunk')),  -- 1.5/2
  anchor TEXT,                                     -- JSON: {event_id} | {path,line_start,line_end,commit,content_hash} | {snapshot_ref,hunk_hash}
  plan_step_id TEXT,                               -- Phase 2
  CHECK (author_member_id IS NOT NULL OR author_run_id IS NOT NULL)
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('pr','commit','test_run','screenshot','log','url','no_tests_reason')),
  ref TEXT NOT NULL,
  summary TEXT,
  result TEXT CHECK (result IN ('pass','fail')),   -- test_run only
  verification TEXT NOT NULL CHECK (verification IN ('hub_verified','self_reported')),
  verified_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE asks (                                -- board_ask_human (one open ask per card)
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs,
  card_id TEXT NOT NULL REFERENCES cards,
  kind TEXT NOT NULL CHECK (kind IN ('question','clarify','decision','plan','conflict','loop')),
  text TEXT NOT NULL,
  options TEXT,                                    -- JSON array
  state TEXT NOT NULL CHECK (state IN ('open','answered','cancelled')),
  answer TEXT,
  answered_by TEXT REFERENCES members,
  answered_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_open_ask_per_card ON asks(card_id) WHERE state = 'open';

CREATE TABLE permission_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs,
  card_id TEXT NOT NULL REFERENCES cards,
  tool TEXT NOT NULL,
  input_summary TEXT NOT NULL,                     -- redacted, ≤ 300 chars
  state TEXT NOT NULL CHECK (state IN ('open','allowed','denied','parked','cancelled')),
  scope TEXT CHECK (scope IN ('once','run')),      -- 'run' = "Allow for this run"
  approvers TEXT NOT NULL,                         -- JSON member ids allowed to answer
  answered_by TEXT REFERENCES members,
  answered_at TEXT,
  created_at TEXT NOT NULL
);
-- first answer wins: UPDATE permission_requests SET state=?, answered_by=?, answered_at=? WHERE id=? AND state='open'

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  repo_id TEXT NOT NULL REFERENCES repos,
  kind TEXT NOT NULL CHECK (kind IN ('decision','convention','gotcha','handoff')),
  body TEXT NOT NULL CHECK (length(body) <= 1200),
  path TEXT, line_start INTEGER, line_end INTEGER, commit_sha TEXT,   -- pin; path NULL = repo-wide
  card_id TEXT REFERENCES cards,
  author_member_id TEXT REFERENCES members,
  author_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','archived')),
  stale_reason TEXT,
  supersedes TEXT REFERENCES memories,
  reviewed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (author_member_id IS NOT NULL OR author_run_id IS NOT NULL)
);
CREATE INDEX memories_by_path ON memories(repo_id, path) WHERE status != 'archived';

CREATE TABLE path_locks (                          -- advisory, exact repo-relative path (Phase 1.5)
  repo_id TEXT NOT NULL,
  path TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs,
  fence INTEGER NOT NULL,
  reason TEXT,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, path)                      -- released when the run ends or its fence is bumped (same txn)
);

CREATE TABLE plan_steps (                          -- Phase 2
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  paths TEXT NOT NULL DEFAULT '[]',
  owner_member_id TEXT,
  owner_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','skipped')),
  started_at TEXT, done_at TEXT,
  UNIQUE (card_id, idx)
);

CREATE TABLE budgets (
  scope TEXT NOT NULL CHECK (scope IN ('org','board','repo','member','card')),
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('run','day','month')),
  cap_cents INTEGER NOT NULL,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, scope_id, period)
);

CREATE TABLE trust_policy (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards,
  repo_id TEXT,
  label TEXT,
  rule TEXT NOT NULL CHECK (rule IN ('never_auto','require_plan_approval','require_second_approver','max_budget')),
  value TEXT,
  edited_by TEXT NOT NULL,
  edited_at TEXT NOT NULL
);

CREATE TABLE overlaps (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  run_a TEXT NOT NULL REFERENCES runs,
  run_b TEXT NOT NULL REFERENCES runs,
  level TEXT NOT NULL CHECK (level IN ('high','medium','low')),
  reason TEXT NOT NULL CHECK (reason IN ('same_file','same_branch','locked_path','same_dir','planned_paths','lockfile','migrations','text')),
  paths TEXT NOT NULL DEFAULT '[]',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  injected_a_at TEXT,
  injected_b_at TEXT,
  resolved_at TEXT,
  CHECK (run_a < run_b),
  UNIQUE (run_a, run_b, reason)
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  at TEXT NOT NULL
);
