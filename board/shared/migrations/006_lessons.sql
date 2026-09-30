-- Lessons (CONTRACT D32): what an agent learned about a repo, suggested for
-- the team. Minimal and append-only: org- and repo-scoped rows, never updated
-- or deleted (triggers). Review, voting and read-back to agents come later as
-- their own append-only rows; nothing reads these into an agent's context yet.
CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  repo_id TEXT NOT NULL REFERENCES repos,
  card_id TEXT REFERENCES cards,
  author_run_id TEXT,
  author_member_id TEXT REFERENCES members,        -- the member the run was for
  text TEXT NOT NULL CHECK (length(text) BETWEEN 10 AND 500),
  evidence TEXT CHECK (evidence IS NULL OR length(evidence) <= 1000),
  created_at TEXT NOT NULL
);
CREATE INDEX lessons_by_repo ON lessons (org_id, repo_id, created_at);
CREATE TRIGGER lessons_no_update BEFORE UPDATE ON lessons BEGIN SELECT RAISE(ABORT, 'lessons are append-only'); END;
CREATE TRIGGER lessons_no_delete BEFORE DELETE ON lessons BEGIN SELECT RAISE(ABORT, 'lessons are append-only'); END;

-- D31: the run that created a card (board_create_card), so the board can mark
-- it agent-suggested. NULL for every human-created card.
ALTER TABLE cards ADD COLUMN created_by_run_id TEXT;
