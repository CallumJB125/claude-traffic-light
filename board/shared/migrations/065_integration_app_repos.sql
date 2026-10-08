-- App installations (GitHub App, step 4): the repositories a team admin
-- linked from an installation connection. A delivery about any other
-- repository of that installation is ignored, and card actions (open a PR,
-- comment status) reach only these. A row names an active connection and a
-- member of that connection's team, and goes when the connection is revoked.
-- Additive: one table and its triggers, no rebuild.

CREATE TABLE integration_app_repos (
  connection_id TEXT NOT NULL REFERENCES connections(id),
  external_repo_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  linked_by TEXT NOT NULL REFERENCES members(id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, external_repo_id)
);
CREATE INDEX integration_app_repos_name ON integration_app_repos (lower(full_name));

CREATE TRIGGER integration_app_repos_ins BEFORE INSERT ON integration_app_repos
  WHEN NOT EXISTS (
    SELECT 1 FROM connections c JOIN members m ON m.id = NEW.linked_by
    WHERE c.id = NEW.connection_id AND c.status = 'active' AND m.org_id = c.org_id AND m.removed_at IS NULL)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER integration_app_repos_no_update BEFORE UPDATE ON integration_app_repos
  BEGIN SELECT RAISE(ABORT, 'a linked repository is never changed: unlink and link again'); END;
CREATE TRIGGER connections_revoked_app_repos AFTER UPDATE OF status ON connections
  WHEN NEW.status = 'revoked'
  BEGIN DELETE FROM integration_app_repos WHERE connection_id = NEW.id; END;
