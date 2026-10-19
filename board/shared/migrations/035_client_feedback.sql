-- Guest feedback never creates regular memberships or dispatch authority.
CREATE TABLE client_feedback_intake (
  project_id TEXT PRIMARY KEY REFERENCES client_projects,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  delegate_member_id TEXT NOT NULL REFERENCES members,
  configured_at TEXT NOT NULL
);
CREATE TRIGGER client_feedback_delegate_insert BEFORE INSERT ON client_feedback_intake
  WHEN NOT EXISTS (SELECT 1 FROM client_projects p JOIN members m ON m.org_id = p.workspace_id WHERE p.id = NEW.project_id AND m.id = NEW.delegate_member_id)
  BEGIN SELECT RAISE(ABORT, 'feedback delegate belongs to another workspace'); END;
CREATE TRIGGER client_feedback_delegate_update BEFORE UPDATE OF project_id, delegate_member_id ON client_feedback_intake
  WHEN NOT EXISTS (SELECT 1 FROM client_projects p JOIN members m ON m.org_id = p.workspace_id WHERE p.id = NEW.project_id AND m.id = NEW.delegate_member_id)
  BEGIN SELECT RAISE(ABORT, 'feedback delegate belongs to another workspace'); END;
CREATE TABLE client_feedback (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES client_items,
  guest_id TEXT NOT NULL REFERENCES client_guests,
  delegate_member_id TEXT NOT NULL REFERENCES members,
  card_id TEXT NOT NULL UNIQUE REFERENCES cards,
  request_id TEXT NOT NULL,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL,
  UNIQUE (guest_id, request_id)
);
CREATE TRIGGER client_feedback_scope_insert BEFORE INSERT ON client_feedback
  WHEN NOT EXISTS (SELECT 1 FROM client_items i JOIN client_projects p ON p.id = i.project_id JOIN client_guests g ON g.workspace_id = p.workspace_id JOIN members m ON m.org_id = p.workspace_id JOIN cards c ON c.board_id = p.board_id WHERE i.id = NEW.item_id AND g.id = NEW.guest_id AND m.id = NEW.delegate_member_id AND c.id = NEW.card_id AND c.created_by = m.id)
  BEGIN SELECT RAISE(ABORT, 'feedback provenance belongs to another workspace or project'); END;
CREATE TRIGGER client_feedback_immutable BEFORE UPDATE ON client_feedback
  BEGIN SELECT RAISE(ABORT, 'client feedback provenance is immutable'); END;
CREATE TABLE client_delivery_updates (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES client_items,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('todo','in_progress','review','done')),
  created_at TEXT NOT NULL
);
CREATE INDEX client_delivery_updates_item ON client_delivery_updates(item_id, created_at);
CREATE TRIGGER client_delivery_update_immutable BEFORE UPDATE ON client_delivery_updates
  BEGIN SELECT RAISE(ABORT, 'client delivery update is immutable'); END;
