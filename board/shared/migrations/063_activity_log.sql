-- Team activity log (docs/TEAM-CONTEXT-CONTRACT.md, board/hub/activity/).
-- Append-only events with a monotonic seq every reader resumes from, plus the
-- latest WorkRecord per session. Payloads are the desktop's scrubbed
-- WorkRecords: titles, goals, summaries and repo-relative paths only when the
-- repo's sharing settings allowed them, never transcripts or handover text.
-- Retention (activity/log.js sweep): events 30 days; current rows of ended
-- records 7 days after their last update, any other record 30 days.
-- Additive: no table rebuild. Version 063 (062 is sync).

CREATE TABLE activity_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  record_id TEXT NOT NULL CHECK (length(record_id) <= 300),
  rev INTEGER NOT NULL CHECK (rev >= 0),
  type TEXT NOT NULL CHECK (type IN ('record.upsert', 'record.end', 'collision')),
  author_user_id TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(payload) <= 16384),
  created_at TEXT NOT NULL
);
CREATE INDEX activity_events_team ON activity_events(team_id, seq);
CREATE INDEX activity_events_repo ON activity_events(repo_id, seq);
CREATE INDEX activity_events_created ON activity_events(created_at);

CREATE TABLE activity_current (
  record_id TEXT PRIMARY KEY CHECK (length(record_id) <= 300),
  team_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  rev INTEGER NOT NULL CHECK (rev >= 0),
  status TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(payload) <= 16384),
  updated_at TEXT NOT NULL
);
CREATE INDEX activity_current_repo ON activity_current(repo_id, status);
CREATE INDEX activity_current_team ON activity_current(team_id);
CREATE INDEX activity_current_author ON activity_current(author_user_id);
