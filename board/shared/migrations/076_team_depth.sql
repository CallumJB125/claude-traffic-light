-- migrate: foreign_keys=off rebuilds
-- Team depth (plan .omc/plans/team-depth-2026-10-19.md, step 0): moments
-- become rows, comments can sit on a moment and carry mentions, every member
-- gets a hub inbox, and a card can be handed from one person to another.
--
-- `comments` is REBUILT (DROP + RENAME, SQLite's 12-step procedure) because
-- card_id loses NOT NULL and a CHECK is added; a CHECK cannot be altered in
-- place. Foreign keys are off for the file: 046's integration_comment_requests
-- cascades on delete from comments, and a DROP with keys on would wipe it.
-- The rebuild drops the objects 010 and 027 put on comments; they are
-- re-created below (xteam_comments_ins/upd widened to the moment path,
-- comments_by_card unchanged). rowids are kept: delivery orders by
-- created_at, rowid. reply_to names comments_new so the DROP never sees a
-- child row pointing at the old table; RENAME rewrites it to comments.
-- Tables elsewhere that REFERENCE comments (033, 046, 052, 053) keep their
-- text and resolve to the new table. 046's two triggers on
-- integration_comment_requests name comments in their body, which the RENAME
-- validates: they are dropped first and re-created verbatim after it.

-- Moments as rows. board.settings.moments stays as a mirror for one release
-- (old desktops read it); api.js setMoments writes both.
CREATE TABLE moments (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards,
  kind TEXT NOT NULL CHECK (kind IN ('moment','ship','decision','demo')),
  label TEXT NOT NULL CHECK (length(label) <= 120),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  author_member_id TEXT REFERENCES members,
  created_at TEXT NOT NULL
);
CREATE INDEX moments_by_board ON moments(board_id, created_at);
CREATE TRIGGER xteam_moments_ins BEFORE INSERT ON moments
  WHEN NEW.author_member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.author_member_id)
    IS NOT (SELECT org_id FROM boards WHERE id = NEW.board_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

CREATE TABLE comments_new (
  id TEXT PRIMARY KEY,
  card_id TEXT REFERENCES cards,
  author_member_id TEXT REFERENCES members,
  author_run_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('web','widget','agent','linear','github','integration')),
  trusted INTEGER NOT NULL,
  body TEXT NOT NULL,
  for_agent INTEGER NOT NULL DEFAULT 0,
  reply_to TEXT REFERENCES comments_new,
  delivered_at TEXT,
  delivered_run_id TEXT,
  created_at TEXT NOT NULL,
  anchor_kind TEXT NOT NULL DEFAULT 'card' CHECK (anchor_kind IN ('card','event','file_range','diff_hunk')),
  anchor TEXT,
  plan_step_id TEXT,
  moment_id TEXT REFERENCES moments,
  mentions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(mentions_json) AND json_type(mentions_json) = 'array' AND length(mentions_json) <= 1024),
  CHECK (author_member_id IS NOT NULL OR author_run_id IS NOT NULL),
  CHECK ((card_id IS NOT NULL) + (moment_id IS NOT NULL) = 1)
);
INSERT INTO comments_new (rowid, id, card_id, author_member_id, author_run_id, source, trusted, body, for_agent, reply_to, delivered_at, delivered_run_id, created_at, anchor_kind, anchor, plan_step_id)
  SELECT rowid, id, card_id, author_member_id, author_run_id, source, trusted, body, for_agent,
    CASE WHEN reply_to IN (SELECT id FROM comments) THEN reply_to END,
    delivered_at, delivered_run_id, created_at, anchor_kind, anchor, plan_step_id FROM comments;
DROP TRIGGER xteam_integration_comment_requests_ins;
DROP TRIGGER xteam_integration_comment_requests_upd;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;
CREATE TRIGGER xteam_integration_comment_requests_ins BEFORE INSERT ON integration_comment_requests
  WHEN (SELECT org_id FROM connections WHERE id=NEW.connection_id)
    IS NOT (SELECT b.org_id FROM comments m JOIN cards c ON c.id=m.card_id JOIN boards b ON b.id=c.board_id WHERE m.id=NEW.comment_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_integration_comment_requests_upd BEFORE UPDATE OF comment_id, connection_id ON integration_comment_requests
  WHEN (SELECT org_id FROM connections WHERE id=NEW.connection_id)
    IS NOT (SELECT b.org_id FROM comments m JOIN cards c ON c.id=m.card_id JOIN boards b ON b.id=c.board_id WHERE m.id=NEW.comment_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

CREATE INDEX comments_by_card ON comments(card_id);
CREATE INDEX comments_by_moment ON comments(moment_id) WHERE moment_id IS NOT NULL;
-- 010's cross-team guard, widened: a comment's org is its card's board's org
-- or its moment's board's org.
CREATE TRIGGER xteam_comments_ins BEFORE INSERT ON comments
  WHEN NEW.author_member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.author_member_id)
    IS NOT COALESCE(
      (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id),
      (SELECT b.org_id FROM moments m JOIN boards b ON b.id = m.board_id WHERE m.id = NEW.moment_id))
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_comments_upd BEFORE UPDATE OF card_id, moment_id, author_member_id ON comments
  WHEN NEW.author_member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.author_member_id)
    IS NOT COALESCE(
      (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id),
      (SELECT b.org_id FROM moments m JOIN boards b ON b.id = m.board_id WHERE m.id = NEW.moment_id))
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

-- Per-member inbox: who should look, and at what. ref_json names the thing
-- (card_id / moment_id / comment_id / handoff_id …); capped at 500 rows per
-- member by api.js notify() (oldest read rows pruned). Own rows only.
CREATE TABLE inbox (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  member_id TEXT NOT NULL REFERENCES members,
  kind TEXT NOT NULL CHECK (kind IN ('mention','reply','moment','handoff_request','handoff_answer','input_answered')),
  ref_json TEXT NOT NULL CHECK (json_valid(ref_json) AND json_type(ref_json) = 'object' AND length(ref_json) <= 2048),
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX inbox_by_member_read ON inbox(member_id, read_at, created_at);
CREATE TRIGGER xteam_inbox_ins BEFORE INSERT ON inbox
  WHEN (SELECT org_id FROM members WHERE id = NEW.member_id) IS NOT NEW.org_id
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

-- Person-to-person hand-off of a card, with the handover packet attached.
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards,
  from_member_id TEXT NOT NULL REFERENCES members,
  to_member_id TEXT NOT NULL REFERENCES members,
  state TEXT NOT NULL CHECK (state IN ('requested','accepted','declined','cancelled')),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  handover_id TEXT,                                -- handovers.version of the card at request time, as text; NULL when none
  created_at TEXT NOT NULL,
  answered_at TEXT,
  CHECK (from_member_id <> to_member_id),
  CHECK ((state = 'requested') = (answered_at IS NULL))
);
CREATE INDEX handoffs_by_card ON handoffs(card_id, created_at);
CREATE INDEX handoffs_by_to ON handoffs(to_member_id, state, created_at);
CREATE TRIGGER xteam_handoffs_ins BEFORE INSERT ON handoffs
  WHEN (SELECT org_id FROM members WHERE id = NEW.from_member_id)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (SELECT org_id FROM members WHERE id = NEW.to_member_id)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
