-- Event bus cursors (D40): integrations read the append-only journal through
-- a per-consumer cursor; the journal itself is never updated (P-1).
CREATE TABLE bus_cursors (
  consumer TEXT PRIMARY KEY,
  seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
