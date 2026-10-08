-- Multi-board lifecycle and integration defaults. Existing card keys and
-- links must never be silently rewritten to fix a legacy prefix collision.
-- This guard runs before persistent schema changes, in the migration txn.
CREATE TEMP TABLE _m029_prefix_guard (n INTEGER NOT NULL);
CREATE TEMP TRIGGER _m029_prefix_guard_check BEFORE INSERT ON _m029_prefix_guard WHEN NEW.n > 0 BEGIN
  SELECT RAISE(ABORT, 'duplicate board key prefixes: run node hub/board-prefix-audit.js <hub.sqlite> for a read-only repair preview; review affected keys before migration 029');
END;
INSERT INTO _m029_prefix_guard SELECT COUNT(*) FROM (
  SELECT org_id, key_prefix FROM boards GROUP BY org_id, key_prefix HAVING COUNT(*) > 1
);
DROP TABLE _m029_prefix_guard;

ALTER TABLE boards ADD COLUMN archived_at TEXT;
CREATE UNIQUE INDEX boards_team_prefix ON boards (org_id, key_prefix);
ALTER TABLE connections ADD COLUMN target_board_id TEXT REFERENCES boards;
UPDATE connections SET target_board_id = (SELECT id FROM boards WHERE org_id = connections.org_id ORDER BY rowid LIMIT 1);
CREATE TRIGGER connections_target_board_team_ins BEFORE INSERT ON connections
  WHEN NEW.target_board_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM boards WHERE id = NEW.target_board_id AND org_id = NEW.org_id)
  BEGIN SELECT RAISE(ABORT, 'target board belongs to another team'); END;
CREATE TRIGGER connections_target_board_team_upd BEFORE UPDATE OF target_board_id ON connections
  WHEN NEW.target_board_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM boards WHERE id = NEW.target_board_id AND org_id = NEW.org_id)
  BEGIN SELECT RAISE(ABORT, 'target board belongs to another team'); END;
