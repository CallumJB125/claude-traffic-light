-- Client collaboration is separate from ordinary team memberships.
CREATE TABLE client_workspaces (
  org_id TEXT PRIMARY KEY REFERENCES orgs,
  agency_org_id TEXT REFERENCES orgs,
  created_by_user TEXT NOT NULL REFERENCES users,
  created_at TEXT NOT NULL
);
CREATE TABLE client_workspace_requests (
  user_id TEXT NOT NULL REFERENCES users,
  request_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES client_workspaces(org_id),
  PRIMARY KEY (user_id, request_id)
);
CREATE TABLE client_projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES client_workspaces(org_id),
  board_id TEXT NOT NULL UNIQUE REFERENCES boards,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER client_project_team_insert BEFORE INSERT ON client_projects
  WHEN NOT EXISTS (SELECT 1 FROM boards WHERE id = NEW.board_id AND org_id = NEW.workspace_id)
  BEGIN SELECT RAISE(ABORT, 'client project board belongs to another workspace'); END;
CREATE TRIGGER client_project_team_update BEFORE UPDATE OF board_id, workspace_id ON client_projects
  WHEN NOT EXISTS (SELECT 1 FROM boards WHERE id = NEW.board_id AND org_id = NEW.workspace_id)
  BEGIN SELECT RAISE(ABORT, 'client project board belongs to another workspace'); END;
CREATE TABLE client_guests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES client_workspaces(org_id),
  user_id TEXT NOT NULL REFERENCES users,
  invited_by TEXT NOT NULL REFERENCES members,
  joined_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (workspace_id, user_id)
);
CREATE TABLE client_grants (
  guest_id TEXT NOT NULL REFERENCES client_guests,
  project_id TEXT NOT NULL REFERENCES client_projects,
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  PRIMARY KEY (guest_id, project_id)
);
CREATE TRIGGER client_guest_staff_insert BEFORE INSERT ON client_guests
  WHEN NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.invited_by AND org_id = NEW.workspace_id)
  BEGIN SELECT RAISE(ABORT, 'client inviter belongs to another workspace'); END;
CREATE TRIGGER client_guest_staff_update BEFORE UPDATE OF invited_by, workspace_id ON client_guests
  WHEN NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.invited_by AND org_id = NEW.workspace_id)
  BEGIN SELECT RAISE(ABORT, 'client inviter belongs to another workspace'); END;
CREATE TRIGGER client_grant_team_insert BEFORE INSERT ON client_grants
  WHEN NOT EXISTS (SELECT 1 FROM client_guests g JOIN client_projects p ON p.workspace_id = g.workspace_id WHERE g.id = NEW.guest_id AND p.id = NEW.project_id)
  BEGIN SELECT RAISE(ABORT, 'client grant project belongs to another workspace'); END;
CREATE TRIGGER client_grant_team_update BEFORE UPDATE OF guest_id, project_id ON client_grants
  WHEN NOT EXISTS (SELECT 1 FROM client_guests g JOIN client_projects p ON p.workspace_id = g.workspace_id WHERE g.id = NEW.guest_id AND p.id = NEW.project_id)
  BEGIN SELECT RAISE(ABORT, 'client grant project belongs to another workspace'); END;
CREATE TABLE client_invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES client_workspaces(org_id),
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  grants TEXT NOT NULL CHECK (json_valid(grants) AND json_type(grants) = 'array'),
  created_by TEXT NOT NULL REFERENCES members,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by_user TEXT REFERENCES users,
  guest_id TEXT REFERENCES client_guests,
  revoked_at TEXT,
  revoke_reason TEXT
);
CREATE INDEX client_invites_email ON client_invites(email, expires_at) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE TRIGGER client_invite_staff_insert BEFORE INSERT ON client_invites
  WHEN NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.created_by AND org_id = NEW.workspace_id)
  BEGIN SELECT RAISE(ABORT, 'client inviter belongs to another workspace'); END;
CREATE TRIGGER client_invite_staff_update BEFORE UPDATE OF created_by, workspace_id ON client_invites
  WHEN NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.created_by AND org_id = NEW.workspace_id)
  BEGIN SELECT RAISE(ABORT, 'client inviter belongs to another workspace'); END;
CREATE TABLE client_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES client_projects,
  card_id TEXT NOT NULL UNIQUE REFERENCES cards,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('todo','in_progress','review','done')),
  published_by TEXT NOT NULL REFERENCES members,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  unpublished_at TEXT
);
CREATE TRIGGER client_item_project_insert BEFORE INSERT ON client_items
  WHEN NOT EXISTS (SELECT 1 FROM client_projects p JOIN cards c ON c.board_id = p.board_id WHERE p.id = NEW.project_id AND c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'client item card belongs to another project'); END;
CREATE TRIGGER client_item_project_update BEFORE UPDATE OF project_id, card_id ON client_items
  WHEN NOT EXISTS (SELECT 1 FROM client_projects p JOIN cards c ON c.board_id = p.board_id WHERE p.id = NEW.project_id AND c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'client item card belongs to another project'); END;
