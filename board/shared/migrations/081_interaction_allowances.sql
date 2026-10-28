-- Per-teammate, time-boxed permission to send, steer and stop in ONE shared
-- session that the team has only been allowed to watch (T4d,
-- board/hub/interaction-shares.js). Created only by the host device that owns
-- the share (the owner's Mac holds the authority and checks its own copy
-- again on every call). A row is live while expires_at (wall ISO) is in the
-- future; the hub also re-checks the share, the teammate's team role and the
-- owner's membership on every call, so removing a member, a role change to
-- viewer, ending the share or revoking a device cuts it without touching this
-- table. Never stores message text. Additive: one new table, no rebuild.

CREATE TABLE interaction_allowances (
  share_id TEXT NOT NULL REFERENCES interaction_shares,
  user_id TEXT NOT NULL REFERENCES users,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  granted_by TEXT NOT NULL REFERENCES users,
  PRIMARY KEY (share_id, user_id)
);
CREATE INDEX interaction_allowances_by_expiry ON interaction_allowances(expires_at);

-- Backstop: an allowance exists only on a watch share (an interact share needs none),
-- for an active member of the share's team other than its owner, and is granted by the owner.
CREATE TRIGGER interaction_allowances_valid BEFORE INSERT ON interaction_allowances
  WHEN (SELECT scope FROM interaction_shares WHERE id = NEW.share_id) IS NOT 'watch'
    OR NEW.user_id = (SELECT owner_user_id FROM interaction_shares WHERE id = NEW.share_id)
    OR NEW.granted_by IS NOT (SELECT owner_user_id FROM interaction_shares WHERE id = NEW.share_id)
    OR NOT EXISTS (SELECT 1 FROM members m JOIN interaction_shares s ON s.org_id = m.org_id
                   WHERE s.id = NEW.share_id AND m.user_id = NEW.user_id AND m.removed_at IS NULL)
  BEGIN SELECT RAISE(ABORT, 'an allowance needs a watch share, an active teammate and the owner'); END;
-- An allowance can be shortened, never extended or reassigned (a new grant replaces the row).
CREATE TRIGGER interaction_allowances_fixed BEFORE UPDATE ON interaction_allowances
  WHEN NEW.share_id IS NOT OLD.share_id OR NEW.user_id IS NOT OLD.user_id OR NEW.expires_at > OLD.expires_at
  BEGIN SELECT RAISE(ABORT, 'an allowance cannot be extended'); END;
