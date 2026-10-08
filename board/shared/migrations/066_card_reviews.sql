-- AI review before Review (board/shared/review.js, board/hub/reviews.js): one
-- row per second-AI review of a finished run. Tenancy follows the card: the
-- row names its card and that card's board, and every route reaches it only
-- through the card. Findings are the parsed, bounded reply (never the raw
-- model output or the diff). Additive: no table rebuild. Version 066.

CREATE TABLE card_reviews (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  board_id TEXT NOT NULL REFERENCES boards(id),
  run_id TEXT REFERENCES runs(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'unavailable')),
  provider TEXT,
  model TEXT,
  author_ai TEXT,
  independence TEXT CHECK (independence IN ('other_provider', 'same_provider')),
  device_id TEXT REFERENCES devices(id),
  verdict TEXT CHECK (verdict IN ('approve', 'changes_requested', 'needs_human')),
  summary TEXT CHECK (length(summary) <= 1000),
  findings TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(findings) AND length(findings) <= 65536),
  flags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags) AND length(flags) <= 2048),
  cap_cents INTEGER CHECK (cap_cents IS NULL OR cap_cents >= 0),
  cost_cents INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0),
  error TEXT CHECK (length(error) <= 300),
  human_action TEXT CHECK (human_action IN ('fix_requested', 'approved')),
  human_action_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX card_reviews_card ON card_reviews(card_id, created_at);
CREATE INDEX card_reviews_board ON card_reviews(board_id, created_at);
CREATE INDEX card_reviews_pending ON card_reviews(status) WHERE status = 'pending';
