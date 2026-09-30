-- Accounts P2: teams, memberships and cross-team isolation (ACCOUNTS-DESIGN.md
-- §2.2, §3, §7.2, §9.3; CONTRACT D59–D62). Teams keep the table name `orgs`.
-- Roles stay owner/admin/member/viewer (no guest/board_guests yet).

ALTER TABLE orgs ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','self_hosted'));
ALTER TABLE orgs ADD COLUMN created_by_user TEXT REFERENCES users;
ALTER TABLE orgs ADD COLUMN deleted_at TEXT;       -- soft delete: every route 404s
ALTER TABLE orgs ADD COLUMN purge_after TEXT;      -- deleted_at + 7 d (the purge job is P5)
-- Teams that existed before accounts are Callum's own (design §14 step 5).
UPDATE orgs SET plan = 'self_hosted';

-- One membership row per (team, user); a removed member who comes back gets
-- the same row again (history keeps pointing at it).
CREATE UNIQUE INDEX members_org_user ON members(org_id, user_id) WHERE user_id IS NOT NULL;
ALTER TABLE members ADD COLUMN joined_via TEXT;    -- 'created_team' | invite id | NULL (legacy)

-- The last active owner can be neither demoted nor removed (unless the team
-- itself is being deleted).
CREATE TRIGGER members_keep_an_owner BEFORE UPDATE OF role, removed_at ON members
  WHEN OLD.role = 'owner' AND OLD.removed_at IS NULL AND (NEW.role != 'owner' OR NEW.removed_at IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM members m WHERE m.org_id = OLD.org_id AND m.id != OLD.id AND m.role = 'owner' AND m.removed_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.deleted_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'a team needs an owner'); END;

-- §7.2 backstop: a row can never point at another team's member, repo,
-- board, card or device. A missed guard in code fails loudly instead of leaking.

CREATE TRIGGER xteam_cards_ins BEFORE INSERT ON cards
  WHEN (NEW.repo_id IS NOT NULL AND (SELECT org_id FROM repos WHERE id = NEW.repo_id) IS NOT (SELECT org_id FROM boards WHERE id = NEW.board_id))
    OR (SELECT org_id FROM members WHERE id = NEW.created_by) IS NOT (SELECT org_id FROM boards WHERE id = NEW.board_id)
    OR (NEW.stopped_by IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.stopped_by) IS NOT (SELECT org_id FROM boards WHERE id = NEW.board_id))
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_cards_upd BEFORE UPDATE OF board_id, repo_id, created_by, stopped_by ON cards
  WHEN (NEW.repo_id IS NOT NULL AND (SELECT org_id FROM repos WHERE id = NEW.repo_id) IS NOT (SELECT org_id FROM boards WHERE id = NEW.board_id))
    OR (SELECT org_id FROM members WHERE id = NEW.created_by) IS NOT (SELECT org_id FROM boards WHERE id = NEW.board_id)
    OR (NEW.stopped_by IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.stopped_by) IS NOT (SELECT org_id FROM boards WHERE id = NEW.board_id))
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

CREATE TRIGGER xteam_board_repos_ins BEFORE INSERT ON board_repos
  WHEN (SELECT org_id FROM repos WHERE id = NEW.repo_id) IS NOT (SELECT org_id FROM boards WHERE id = NEW.board_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_board_repos_upd BEFORE UPDATE ON board_repos
  WHEN (SELECT org_id FROM repos WHERE id = NEW.repo_id) IS NOT (SELECT org_id FROM boards WHERE id = NEW.board_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

CREATE TRIGGER xteam_card_assignees_ins BEFORE INSERT ON card_assignees
  WHEN (SELECT org_id FROM members WHERE id = NEW.member_id)
    IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_card_assignees_upd BEFORE UPDATE ON card_assignees
  WHEN (SELECT org_id FROM members WHERE id = NEW.member_id)
    IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

CREATE TRIGGER xteam_dispatches_ins BEFORE INSERT ON dispatches
  WHEN (SELECT org_id FROM members WHERE id = NEW.dispatched_by)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (NEW.target_member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.target_member_id)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id))
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_dispatches_upd BEFORE UPDATE OF card_id, dispatched_by, target_member_id ON dispatches
  WHEN (SELECT org_id FROM members WHERE id = NEW.dispatched_by)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (NEW.target_member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.target_member_id)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id))
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

CREATE TRIGGER xteam_runs_ins BEFORE INSERT ON runs
  WHEN (SELECT org_id FROM members WHERE id = NEW.on_behalf_of)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (SELECT org_id FROM members WHERE id = NEW.dispatched_by)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (SELECT org_id FROM repos WHERE id = NEW.repo_id)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (NEW.device_id IS NOT NULL AND (SELECT m.org_id FROM devices d JOIN members m ON m.id = d.member_id WHERE d.id = NEW.device_id)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id))
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_runs_upd BEFORE UPDATE OF card_id, on_behalf_of, dispatched_by, repo_id, device_id ON runs
  WHEN (SELECT org_id FROM members WHERE id = NEW.on_behalf_of)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (SELECT org_id FROM members WHERE id = NEW.dispatched_by)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (SELECT org_id FROM repos WHERE id = NEW.repo_id)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (NEW.device_id IS NOT NULL AND (SELECT m.org_id FROM devices d JOIN members m ON m.id = d.member_id WHERE d.id = NEW.device_id)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id))
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

CREATE TRIGGER xteam_comments_ins BEFORE INSERT ON comments
  WHEN NEW.author_member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.author_member_id)
    IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_comments_upd BEFORE UPDATE OF card_id, author_member_id ON comments
  WHEN NEW.author_member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.author_member_id)
    IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

CREATE TRIGGER xteam_asks_upd BEFORE UPDATE OF answered_by ON asks
  WHEN NEW.answered_by IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.answered_by)
    IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_permission_requests_upd BEFORE UPDATE OF answered_by ON permission_requests
  WHEN NEW.answered_by IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.answered_by)
    IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

CREATE TRIGGER xteam_memories_ins BEFORE INSERT ON memories
  WHEN (SELECT org_id FROM repos WHERE id = NEW.repo_id) IS NOT NEW.org_id
    OR (NEW.card_id IS NOT NULL AND (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id) IS NOT NEW.org_id)
    OR (NEW.author_member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.author_member_id) IS NOT NEW.org_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_memories_upd BEFORE UPDATE OF org_id, repo_id, card_id, author_member_id ON memories
  WHEN (SELECT org_id FROM repos WHERE id = NEW.repo_id) IS NOT NEW.org_id
    OR (NEW.card_id IS NOT NULL AND (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id) IS NOT NEW.org_id)
    OR (NEW.author_member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.author_member_id) IS NOT NEW.org_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

CREATE TRIGGER xteam_lessons_ins BEFORE INSERT ON lessons
  WHEN (SELECT org_id FROM repos WHERE id = NEW.repo_id) IS NOT NEW.org_id
    OR (NEW.card_id IS NOT NULL AND (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id) IS NOT NEW.org_id)
    OR (NEW.author_member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.author_member_id) IS NOT NEW.org_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

CREATE TRIGGER xteam_runner_repos_ins BEFORE INSERT ON runner_repos
  WHEN (SELECT org_id FROM repos WHERE id = NEW.repo_id)
    IS NOT (SELECT m.org_id FROM devices d JOIN members m ON m.id = d.member_id WHERE d.id = NEW.device_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
