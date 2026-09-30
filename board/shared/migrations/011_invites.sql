-- Accounts P3: email-bound team invites (ACCOUNTS-DESIGN.md §8, ACCOUNTS-API.md
-- "Invites", CONTRACT D64–D65). One row per invite; the token (`inv_` + 32
-- random bytes) and the short code are stored only as hashes. Single use,
-- 7-day expiry, never for owner. A resend revokes the row and makes a new one
-- (`replaces` points back).

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  token_hash TEXT NOT NULL UNIQUE,             -- sha256 hex of the token; the token itself is shown once
  code_hash TEXT NOT NULL,                     -- HMAC of email + short code (typed in the app instead of the link)
  email TEXT NOT NULL,                         -- lower-cased; acceptance needs a verified identity with this address
  role TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
  created_by TEXT NOT NULL REFERENCES members,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by_user TEXT REFERENCES users,
  member_id TEXT REFERENCES members,
  revoked_at TEXT,
  revoke_reason TEXT CHECK (revoke_reason IN ('revoked','resent','team_deleted','inviter_removed','inviter_deleted')),
  replaces TEXT REFERENCES invites,
  ip_prefix TEXT,
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX invites_by_org ON invites(org_id, created_at);
CREATE INDEX invites_pending_by_email ON invites(email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Single use: once accepted, an invite is never accepted again or reopened.
CREATE TRIGGER invites_single_use BEFORE UPDATE OF accepted_at, accepted_by_user, member_id, revoked_at ON invites
  WHEN OLD.accepted_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'invite already used'); END;

-- §7.2: an invite's inviter and the member it made belong to its team.
CREATE TRIGGER xteam_invites_ins BEFORE INSERT ON invites
  WHEN (SELECT org_id FROM members WHERE id = NEW.created_by) IS NOT NEW.org_id
    OR (NEW.member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.member_id) IS NOT NEW.org_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_invites_upd BEFORE UPDATE OF org_id, created_by, member_id ON invites
  WHEN (SELECT org_id FROM members WHERE id = NEW.created_by) IS NOT NEW.org_id
    OR (NEW.member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.member_id) IS NOT NEW.org_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
