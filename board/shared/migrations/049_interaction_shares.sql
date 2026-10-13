-- Team session sharing (board/hub/interaction-shares.js): the owner of a
-- Plexiform-owned session on their own host device lets the members of one
-- team watch it ('watch') or also send/steer/interrupt it ('interact').
-- Created only by the host device that holds the session; off by default
-- (no rows). A share is live while revoked_at IS NULL and expires_at (wall
-- ISO, NULL = until revoked) is in the future; the hub also re-checks on
-- every call that the caller and the owner are still active members of the
-- team and that both devices are still valid, so removing a member, leaving
-- the team, deleting the team or revoking a device cuts access without
-- touching this table. Additive: no table rebuild. (Unreleased: the expiry and
-- revocation guards below were added to this migration before it shipped.)

CREATE TABLE interaction_shares (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users,
  host_device_id TEXT NOT NULL REFERENCES user_devices,
  session_id TEXT NOT NULL,                 -- the host's Plexiform session id (never a provider thread id)
  org_id TEXT NOT NULL REFERENCES orgs,
  scope TEXT NOT NULL CHECK (scope IN ('watch','interact')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users
);
CREATE INDEX interaction_shares_by_org ON interaction_shares(org_id) WHERE revoked_at IS NULL;
CREATE INDEX interaction_shares_by_host ON interaction_shares(host_device_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX interaction_shares_one_live ON interaction_shares(host_device_id, session_id, org_id) WHERE revoked_at IS NULL;

-- Backstop: a share's host device belongs to its owner, and a share never
-- changes hands, session, team or scope (a new scope is a new share).
CREATE TRIGGER interaction_shares_owner_device BEFORE INSERT ON interaction_shares
  WHEN (SELECT user_id FROM user_devices WHERE id = NEW.host_device_id) IS NOT NEW.owner_user_id
  BEGIN SELECT RAISE(ABORT, 'share host is not the owner''s device'); END;
CREATE TRIGGER interaction_shares_fixed BEFORE UPDATE OF id, owner_user_id, host_device_id, session_id, org_id, scope, created_at ON interaction_shares
  BEGIN SELECT RAISE(ABORT, 'a share is fixed once created'); END;
-- An expiry can be brought forward, never pushed back or removed; a stop is
-- final (revoked_at/revoked_by are never cleared or rewritten once set).
CREATE TRIGGER interaction_shares_expiry BEFORE UPDATE OF expires_at ON interaction_shares
  WHEN OLD.expires_at IS NOT NULL AND (NEW.expires_at IS NULL OR NEW.expires_at > OLD.expires_at)
  BEGIN SELECT RAISE(ABORT, 'a share''s expiry cannot be extended'); END;
CREATE TRIGGER interaction_shares_revoked BEFORE UPDATE OF revoked_at, revoked_by ON interaction_shares
  WHEN (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at) OR (OLD.revoked_by IS NOT NULL AND NEW.revoked_by IS NOT OLD.revoked_by)
  BEGIN SELECT RAISE(ABORT, 'a stopped share stays stopped'); END;
