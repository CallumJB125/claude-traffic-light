-- migrate: rebuilds
-- "Ask an admin" (organised views PR 7, CONTRACT "Board link requests"): a team member asks the team's owners and
-- admins to put a repository on a team board, as one inbox row each. A CHECK change, so inbox is rebuilt as 076
-- made it, with 'board_link_request' added to the kinds; its index and its cross-team trigger are re-created.
-- Nothing references inbox, so foreign keys can stay on.
CREATE TABLE inbox_080 (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  member_id TEXT NOT NULL REFERENCES members,
  kind TEXT NOT NULL CHECK (kind IN ('mention','reply','moment','handoff_request','handoff_answer','input_answered','board_link_request')),
  ref_json TEXT NOT NULL CHECK (json_valid(ref_json) AND json_type(ref_json) = 'object' AND length(ref_json) <= 2048),
  created_at TEXT NOT NULL,
  read_at TEXT
);
INSERT INTO inbox_080 (id, org_id, member_id, kind, ref_json, created_at, read_at)
  SELECT id, org_id, member_id, kind, ref_json, created_at, read_at FROM inbox ORDER BY rowid;
DROP TABLE inbox;
ALTER TABLE inbox_080 RENAME TO inbox;
CREATE INDEX inbox_by_member_read ON inbox(member_id, read_at, created_at);
CREATE TRIGGER xteam_inbox_ins BEFORE INSERT ON inbox
  WHEN (SELECT org_id FROM members WHERE id = NEW.member_id) IS NOT NEW.org_id
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
