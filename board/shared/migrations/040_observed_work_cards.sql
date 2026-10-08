-- Observations are neither runner authority nor completed work. Source identities
-- are keyed hashes, unique across a user's team memberships. Keep tombstones
-- even if a card is deleted so old reports cannot recreate a user's removed task.
CREATE TABLE work_capture_cards (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  user_id TEXT REFERENCES users,
  member_id TEXT NOT NULL REFERENCES members,
  board_id TEXT NOT NULL REFERENCES boards,
  repo_id TEXT REFERENCES repos,
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  provider TEXT NOT NULL CHECK (provider IN ('codex','cursor','gemini','hermes','claude')),
  card_id TEXT NOT NULL UNIQUE,
  tracking TEXT NOT NULL DEFAULT 'active' CHECK (tracking IN ('active','stopped','archived','deleted')),
  reported_status TEXT NOT NULL CHECK (reported_status IN ('working','waiting','review','idle','ended')),
  managed_title TEXT NOT NULL,
  managed_body TEXT NOT NULL,
  managed_column TEXT NOT NULL CHECK (managed_column IN ('in_progress','in_review')),
  title_managed INTEGER NOT NULL DEFAULT 1 CHECK (title_managed IN (0,1)),
  body_managed INTEGER NOT NULL DEFAULT 1 CHECK (body_managed IN (0,1)),
  column_managed INTEGER NOT NULL DEFAULT 1 CHECK (column_managed IN (0,1)),
  created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE(principal, source_hash)
);
CREATE INDEX work_capture_principal_created ON work_capture_cards(principal, created_at);
CREATE TRIGGER work_capture_destination BEFORE INSERT ON work_capture_cards
  WHEN NOT EXISTS (SELECT 1 FROM cards c JOIN boards b ON b.id=c.board_id JOIN members m ON m.org_id=b.org_id
    WHERE c.id=NEW.card_id AND c.board_id=NEW.board_id AND c.repo_id IS NEW.repo_id AND m.id=NEW.member_id
      AND m.user_id IS NEW.user_id AND NEW.principal=CASE WHEN m.user_id IS NULL THEN 'local:'||m.id ELSE 'user:'||m.user_id END)
  BEGIN SELECT RAISE(ABORT, 'capture destination or principal mismatch'); END;
CREATE TRIGGER work_capture_identity_immutable BEFORE UPDATE OF principal,user_id,member_id,board_id,repo_id,source_hash,provider,card_id ON work_capture_cards
  BEGIN SELECT RAISE(ABORT, 'capture identity and destination are immutable'); END;
CREATE TRIGGER work_capture_tombstone_monotonic BEFORE UPDATE OF tracking ON work_capture_cards
  WHEN OLD.tracking <> 'active' AND NEW.tracking <> OLD.tracking
  BEGIN SELECT RAISE(ABORT, 'capture tombstone is permanent'); END;
CREATE TRIGGER work_capture_management_monotonic BEFORE UPDATE OF title_managed,body_managed,column_managed ON work_capture_cards
  WHEN NEW.title_managed > OLD.title_managed OR NEW.body_managed > OLD.body_managed OR NEW.column_managed > OLD.column_managed
  BEGIN SELECT RAISE(ABORT, 'capture cannot reclaim a human field'); END;
-- Capture updates its managed values BEFORE writing the corresponding card
-- fields in the same transaction. Every other writer permanently takes them.
CREATE TRIGGER work_capture_human_edit AFTER UPDATE OF title,body,column_name,repo_id,run_state ON cards
  BEGIN UPDATE work_capture_cards SET
    title_managed=CASE WHEN NEW.title <> managed_title OR NEW.run_state IS NOT NULL OR NEW.repo_id IS NOT repo_id THEN 0 ELSE title_managed END,
    body_managed=CASE WHEN NEW.body <> managed_body OR NEW.run_state IS NOT NULL OR NEW.repo_id IS NOT repo_id THEN 0 ELSE body_managed END,
    column_managed=CASE WHEN NEW.column_name <> managed_column OR NEW.run_state IS NOT NULL OR NEW.repo_id IS NOT repo_id THEN 0 ELSE column_managed END
    WHERE card_id=NEW.id; END;
CREATE TRIGGER work_capture_archive AFTER UPDATE OF archived_at ON cards
  WHEN NEW.archived_at IS NOT NULL
  BEGIN UPDATE work_capture_cards SET tracking='archived' WHERE card_id=NEW.id AND tracking='active'; END;
CREATE TRIGGER work_capture_delete AFTER DELETE ON cards
  BEGIN UPDATE work_capture_cards SET tracking='deleted' WHERE card_id=OLD.id AND tracking='active'; END;
