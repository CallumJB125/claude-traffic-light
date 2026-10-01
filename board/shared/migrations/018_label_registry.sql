-- Board slice S2a (CONTRACT D91, D93): a per-board label registry that colours
-- label NAMES (cards.labels stays the source of truth: a label with no entry
-- renders neutral), and a colour-strip cover per card. Additive only: no
-- rebuild, so later versions' triggers on `cards` survive.

CREATE TABLE board_labels (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 50),
  color TEXT NOT NULL CHECK (color IN ('grey','red','orange','yellow','green','teal','blue','purple','pink','brown')),
  description TEXT CHECK (description IS NULL OR length(description) <= 200),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Card labels match an entry case-insensitively, so the names are unique that way.
CREATE UNIQUE INDEX board_labels_name ON board_labels (board_id, name COLLATE NOCASE);

-- §7.2 backstop (010 style): the creator is a member of the board's team.
CREATE TRIGGER xteam_board_labels_ins BEFORE INSERT ON board_labels
  WHEN (SELECT org_id FROM members WHERE id = NEW.created_by) IS NOT (SELECT org_id FROM boards WHERE id = NEW.board_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_board_labels_upd BEFORE UPDATE OF board_id, created_by ON board_labels
  WHEN (SELECT org_id FROM members WHERE id = NEW.created_by) IS NOT (SELECT org_id FROM boards WHERE id = NEW.board_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

ALTER TABLE cards ADD COLUMN cover TEXT CHECK (cover IS NULL OR cover IN ('grey','red','orange','yellow','green','teal','blue','purple','pink','brown'));
