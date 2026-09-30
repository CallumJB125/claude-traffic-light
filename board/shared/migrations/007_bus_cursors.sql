-- Event bus cursors (D40): integrations read the append-only journal through
-- a per-consumer cursor; the journal itself is never updated (P-1).
CREATE TABLE bus_cursors (
  consumer TEXT PRIMARY KEY,
  seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- A row whose handler keeps failing is parked here after DEAD_AFTER tries on
-- the same seq, so one poison row never blocks its consumer for ever.
CREATE TABLE bus_dead_letters (
  consumer TEXT NOT NULL,
  seq INTEGER NOT NULL,
  error TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (consumer, seq)
);
