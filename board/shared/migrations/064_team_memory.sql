-- Team memory (board/hub/activity/memory.js): a full-text index over what the
-- activity log already holds, so a teammate's AI can ask "has anyone already
-- done or decided X?". One row per current WorkRecord, kept in step by the
-- activity log's own writes (upsert by record_id, gone with its
-- activity_current row: same 7/30-day retention, deleted teams and accounts).
-- Indexed text is the scrubbed record (title, goal, summary, repo-relative
-- paths, branch, author display name, repo name) and the handover text its
-- author chose to share, scrubbed again here. Never transcripts.
-- Additive: no table rebuild. Version 064 (063 is the activity log).

CREATE TABLE memory_docs (
  id INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE CHECK (length(record_id) <= 300),
  team_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  rev INTEGER NOT NULL CHECK (rev >= 0),
  status TEXT NOT NULL,
  record TEXT NOT NULL CHECK (json_valid(record) AND length(record) <= 16384),
  handover TEXT CHECK (handover IS NULL OR length(handover) <= 8000),
  handover_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX memory_docs_team ON memory_docs(team_id, updated_at);
CREATE INDEX memory_docs_repo ON memory_docs(repo_id, updated_at);
CREATE INDEX memory_docs_author ON memory_docs(author_user_id);

-- rowid = memory_docs.id. Written only by memory.js, which deletes and
-- re-inserts a row's text on every change.
CREATE VIRTUAL TABLE memory_fts USING fts5(
  title, goal, summary, files, branch, author, repo, handover,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
