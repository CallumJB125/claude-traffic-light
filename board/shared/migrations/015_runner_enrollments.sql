-- Accounts P4: runner enrolment (CONTRACT D79–D81). One install of the desktop
-- app (a user_devices row) enrols as a runner in one team and gets its own
-- runner token (`brt_…`, shown once, stored as sha256), separate from the
-- app's device token: revoking the runner never signs the app out. The hub's
-- runner sockets keep their `devices` row: each enrolment points at one, made
-- for the user's membership in that team (no Cloudflare fields), reused when
-- the same install enrols again (rotation keeps the outbox sequence).

CREATE TABLE runner_enrollments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  user_id TEXT NOT NULL REFERENCES users,
  user_device_id TEXT NOT NULL REFERENCES user_devices,
  member_id TEXT NOT NULL REFERENCES members,
  device_id TEXT NOT NULL REFERENCES devices,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE,                      -- sha256 hex; NULL once revoked
  session_epoch INTEGER NOT NULL,              -- a restore (epoch bump) kills it, like device tokens
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_ip_prefix TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE UNIQUE INDEX runner_enrollments_active ON runner_enrollments(user_device_id, org_id) WHERE revoked_at IS NULL;
CREATE INDEX runner_enrollments_by_org ON runner_enrollments(org_id, user_id);
CREATE INDEX runner_enrollments_by_device ON runner_enrollments(device_id);

-- §7.2 backstop: the membership and the runner device are the enrolment's team's.
CREATE TRIGGER xteam_runner_enrollments_ins BEFORE INSERT ON runner_enrollments
  WHEN (SELECT org_id FROM members WHERE id = NEW.member_id) IS NOT NEW.org_id
    OR (SELECT m.org_id FROM devices d JOIN members m ON m.id = d.member_id WHERE d.id = NEW.device_id) IS NOT NEW.org_id
    OR (SELECT user_id FROM members WHERE id = NEW.member_id) IS NOT NEW.user_id
    OR (SELECT user_id FROM user_devices WHERE id = NEW.user_device_id) IS NOT NEW.user_id
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_runner_enrollments_upd BEFORE UPDATE OF org_id, user_id, user_device_id, member_id, device_id ON runner_enrollments
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
