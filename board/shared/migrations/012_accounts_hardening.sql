-- migrate: foreign_keys=off
-- Accounts security review fixes (CONTRACT D69, D70).
-- 1. invites.revoke_reason gains 'account_deleted' (M3: deleting an account
--    withdraws the pending invites addressed to it). A CHECK can't be altered
--    in place, so the table is rebuilt (SQLite's 12-step procedure).
-- 2. user_devices.session_epoch (L3): a desktop device token carries the
--    restore epoch like a cookie session does, so a restore
--    (BOARD_RESTORE=1, which bumps hub_meta.session_epoch) kills tokens that
--    may have been revoked after the backup was taken.

CREATE TABLE invites_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  token_hash TEXT NOT NULL UNIQUE,             -- sha256 hex of the token; the token itself is shown once
  code_hash TEXT NOT NULL,                     -- HMAC of email + short code (typed in the app instead of the link)
  email TEXT NOT NULL,                         -- lower-cased; 'deleted:<id>' once the invitee's account is deleted
  role TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
  created_by TEXT NOT NULL REFERENCES members,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by_user TEXT REFERENCES users,
  member_id TEXT REFERENCES members,
  revoked_at TEXT,
  revoke_reason TEXT CHECK (revoke_reason IN ('revoked','resent','team_deleted','inviter_removed','inviter_deleted','account_deleted')),
  replaces TEXT REFERENCES invites,
  ip_prefix TEXT,
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
INSERT INTO invites_new (id, org_id, token_hash, code_hash, email, role, created_by, created_at, expires_at, accepted_at, accepted_by_user, member_id, revoked_at, revoke_reason, replaces, ip_prefix)
  SELECT id, org_id, token_hash, code_hash, email, role, created_by, created_at, expires_at, accepted_at, accepted_by_user, member_id, revoked_at, revoke_reason, replaces, ip_prefix FROM invites;
DROP TABLE invites;
ALTER TABLE invites_new RENAME TO invites;

CREATE INDEX invites_by_org ON invites(org_id, created_at);
CREATE INDEX invites_pending_by_email ON invites(email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TRIGGER invites_single_use BEFORE UPDATE OF accepted_at, accepted_by_user, member_id, revoked_at ON invites
  WHEN OLD.accepted_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'invite already used'); END;

CREATE TRIGGER xteam_invites_ins BEFORE INSERT ON invites
  WHEN (SELECT org_id FROM members WHERE id = NEW.created_by) IS NOT NEW.org_id
    OR (NEW.member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.member_id) IS NOT NEW.org_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_invites_upd BEFORE UPDATE OF org_id, created_by, member_id ON invites
  WHEN (SELECT org_id FROM members WHERE id = NEW.created_by) IS NOT NEW.org_id
    OR (NEW.member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.member_id) IS NOT NEW.org_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

ALTER TABLE user_devices ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 1;
UPDATE user_devices SET session_epoch = COALESCE((SELECT CAST(v AS INTEGER) FROM hub_meta WHERE k = 'session_epoch'), 1);
