-- Board slice S2a (CONTRACT D94): archive is an orthogonal flag, not a column
-- value (cards.column_name has a CHECK; a new value would force a rebuild of
-- `cards` with all its triggers). NULL = live.

ALTER TABLE cards ADD COLUMN archived_at TEXT;
ALTER TABLE cards ADD COLUMN archived_by TEXT REFERENCES members(id);
CREATE INDEX cards_archived ON cards (board_id, archived_at) WHERE archived_at IS NOT NULL;

-- 010's xteam_cards_upd fires only on board_id, repo_id, created_by and
-- stopped_by, so archived_by gets triggers of its own instead of a rebuild.
CREATE TRIGGER xteam_cards_archived_by_ins BEFORE INSERT ON cards
  WHEN NEW.archived_by IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.archived_by) IS NOT (SELECT org_id FROM boards WHERE id = NEW.board_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_cards_archived_by_upd BEFORE UPDATE OF board_id, archived_by ON cards
  WHEN NEW.archived_by IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.archived_by) IS NOT (SELECT org_id FROM boards WHERE id = NEW.board_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
