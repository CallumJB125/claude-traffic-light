-- Identity links (CONTRACT D98). A member links their own provider account
-- (Sign in with Slack) to their membership; the link names the connection it
-- was made through, so it can only ever point at an active connection of the
-- member's own team, for that connection's provider and workspace, and goes
-- when the member or the connection does. Additive: one nullable column, no
-- table rebuild. A later migration that rebuilds connections, members or
-- external_identities must re-create these triggers (and 022's).

ALTER TABLE external_identities ADD COLUMN connection_id TEXT REFERENCES connections(id);

-- No route wrote this table before D98. A row is attributed to the one active
-- connection of its live member's team with that provider and workspace; a
-- row that can't be is never deleted here: the migration aborts instead.
UPDATE external_identities SET connection_id = (
  SELECT c.id FROM connections c JOIN members m ON m.org_id = c.org_id
  WHERE m.id = external_identities.member_id AND m.removed_at IS NULL AND c.status = 'active'
    AND c.provider = external_identities.provider AND c.external_id = external_identities.workspace_id)
WHERE (SELECT COUNT(*) FROM connections c JOIN members m ON m.org_id = c.org_id
  WHERE m.id = external_identities.member_id AND m.removed_at IS NULL AND c.status = 'active'
    AND c.provider = external_identities.provider AND c.external_id = external_identities.workspace_id) = 1;
CREATE TEMP TABLE _m023_guard (n INTEGER NOT NULL);
CREATE TEMP TRIGGER _m023_guard_check BEFORE INSERT ON _m023_guard WHEN NEW.n > 0 BEGIN
  SELECT RAISE(ABORT, 'an external_identities row cannot be attributed to exactly one active connection of its member''s team: fix or remove it by hand, then start again');
END;
INSERT INTO _m023_guard SELECT COUNT(*) FROM external_identities WHERE connection_id IS NULL;
DROP TABLE _m023_guard;

CREATE TRIGGER external_identities_ins BEFORE INSERT ON external_identities
  WHEN NEW.connection_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM connections c JOIN members m ON m.id = NEW.member_id
    WHERE c.id = NEW.connection_id AND c.status = 'active' AND c.provider = NEW.provider AND c.external_id = NEW.workspace_id
      AND m.org_id = c.org_id AND m.removed_at IS NULL)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
-- A relink is a delete and a fresh, re-checked insert.
CREATE TRIGGER external_identities_no_update BEFORE UPDATE ON external_identities
  BEGIN SELECT RAISE(ABORT, 'an identity link is never changed: unlink and link again'); END;
CREATE TRIGGER members_removed_unlink AFTER UPDATE OF removed_at, org_id ON members
  WHEN NEW.removed_at IS NOT NULL OR NEW.org_id IS NOT OLD.org_id
  BEGIN DELETE FROM external_identities WHERE member_id = NEW.id; END;
-- Disconnect and team deletion (revokeDeletedTeamConnections) both revoke.
CREATE TRIGGER connections_revoked_unlink AFTER UPDATE OF status ON connections
  WHEN NEW.status = 'revoked'
  BEGIN DELETE FROM external_identities WHERE connection_id = NEW.id; END;
