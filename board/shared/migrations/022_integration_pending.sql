-- Pending connections (CONTRACT D97). A connector that declares
-- connect.prepare makes its provider app first (Slack: from an admin's
-- configuration token); what comes back waits here, sealed, for one hour,
-- until the OAuth callback of the admin who prepared it promotes the row to
-- a connection with the same id. A table of its own rather than a
-- connections status: no query that reads connections can see a pending
-- row, connections keep their CHECK (D71), and a pending row can be purged
-- (connections are never deleted, D41). 020 and 021 are reserved for the
-- board slices S2b/S2c (D50 fills the gap when they land).

CREATE TABLE integration_pending (
  id TEXT PRIMARY KEY,                -- the id the connection will keep (webhook URL, vault AAD)
  org_id TEXT NOT NULL REFERENCES orgs(id),
  provider TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(id),
  external_id TEXT,                   -- the workspace, when prepare already knows it
  match TEXT NOT NULL DEFAULT '{}',   -- JSON: what exchange() must reproduce; '{}' = no secrets yet (needs a paste)
  settings TEXT NOT NULL DEFAULT '{}', -- JSON: non-secret scalars, overlaid on the connection's config
  authorize_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
-- Every row counts, expired or not: the registry purges expired rows of that
-- org/provider/member in the transaction that creates the next one.
CREATE UNIQUE INDEX integration_pending_org ON integration_pending (org_id, provider);
CREATE UNIQUE INDEX integration_pending_member ON integration_pending (created_by);
CREATE INDEX integration_pending_exp ON integration_pending (expires_at);

-- Never selected by any route. Sealed exactly like connection_secrets (AAD
-- `<id>|<kind>|<key_id>`), so promotion copies the rows unchanged.
CREATE TABLE integration_pending_secrets (
  pending_id TEXT NOT NULL REFERENCES integration_pending(id),
  kind TEXT NOT NULL,
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (pending_id, kind)
);

CREATE TRIGGER xteam_integration_pending_ins BEFORE INSERT ON integration_pending
  WHEN (SELECT org_id FROM members WHERE id = NEW.created_by) IS NOT NEW.org_id
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
-- Who, where, which provider and for how long are fixed at creation: a row is
-- never moved, handed to another admin or extended. Only the prepare answer
-- (external_id, match, settings) and the authorize count change.
CREATE TRIGGER integration_pending_fixed BEFORE UPDATE OF id, org_id, provider, created_by, created_at, expires_at ON integration_pending
  WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.provider IS NOT OLD.provider OR NEW.created_by IS NOT OLD.created_by
    OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  BEGIN SELECT RAISE(ABORT, 'a pending connection is fixed once created'); END;
CREATE TRIGGER integration_pending_secrets_purge BEFORE DELETE ON integration_pending
  BEGIN DELETE FROM integration_pending_secrets WHERE pending_id = OLD.id; END;

-- An id is pending or a connection, never both. Promotion deletes the pending
-- row first, in the same transaction, then inserts the connection.
CREATE TRIGGER pending_id_not_connection BEFORE INSERT ON integration_pending
  WHEN EXISTS (SELECT 1 FROM connections WHERE id = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'that id is a connection'); END;
CREATE TRIGGER connection_id_not_pending BEFORE INSERT ON connections
  WHEN EXISTS (SELECT 1 FROM integration_pending WHERE id = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'that id is still pending'); END;

-- settings.pinned (the app a promoted connection was made for) is written
-- with the row and never again, whatever the code above it does.
CREATE TRIGGER connections_pinned_fixed BEFORE UPDATE OF settings ON connections
  WHEN json_extract(NEW.settings, '$.pinned') IS NOT json_extract(OLD.settings, '$.pinned')
  BEGIN SELECT RAISE(ABORT, 'settings.pinned never changes'); END;
