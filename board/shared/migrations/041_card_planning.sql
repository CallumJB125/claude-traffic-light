-- Calendar days are independent of device timezone. Dependencies never grant execution.
ALTER TABLE cards ADD COLUMN start_date TEXT CHECK(start_date IS NULL OR (length(start_date) = 10 AND start_date >= '0001-01-01' AND start_date <= '9999-12-31' AND date(start_date, '+0 days') IS NOT NULL AND date(start_date, '+0 days') = start_date));
ALTER TABLE cards ADD COLUMN due_date TEXT CHECK(due_date IS NULL OR (length(due_date) = 10 AND due_date >= '0001-01-01' AND due_date <= '9999-12-31' AND date(due_date, '+0 days') IS NOT NULL AND date(due_date, '+0 days') = due_date));
CREATE TRIGGER card_planning_insert BEFORE INSERT ON cards WHEN NEW.start_date IS NOT NULL AND NEW.due_date IS NOT NULL AND (NEW.start_date > NEW.due_date OR julianday(NEW.due_date) - julianday(NEW.start_date) > 3660) BEGIN SELECT RAISE(ABORT, 'invalid planning range'); END;
CREATE TRIGGER card_planning_update BEFORE UPDATE OF start_date, due_date ON cards WHEN NEW.start_date IS NOT NULL AND NEW.due_date IS NOT NULL AND (NEW.start_date > NEW.due_date OR julianday(NEW.due_date) - julianday(NEW.start_date) > 3660) BEGIN SELECT RAISE(ABORT, 'invalid planning range'); END;
CREATE TABLE card_dependencies (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  depends_on_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(card_id, depends_on_card_id), CHECK(card_id != depends_on_card_id)
);
CREATE INDEX card_dependencies_predecessor ON card_dependencies(depends_on_card_id);
CREATE TABLE planning_requests (
  member_id TEXT NOT NULL REFERENCES members(id), request_id TEXT NOT NULL,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  binding TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(member_id, request_id)
);
