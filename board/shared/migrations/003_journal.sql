-- Append-only journal (CONTRACT §15, P-1): one row per mutation, written in the
-- same transaction as the change. The record of truth for replay, time travel
-- and (later) the event bus; `events` stays the UI feed. Never updated, never
-- deleted: the triggers make that an error.
CREATE TABLE journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT,                                   -- NULL only for hub-wide rows (restore bump)
  card_id TEXT,
  run_id TEXT,
  at_hub TEXT NOT NULL,                            -- hub wall time (ISO UTC)
  hub_epoch TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('member','runner','system')),
  actor_id TEXT,                                   -- member id | device id | NULL
  kind TEXT NOT NULL,                              -- shared/journal.js JOURNAL_KINDS
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX journal_board_seq ON journal (board_id, seq);
CREATE INDEX journal_card_seq ON journal (card_id, seq);
CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
