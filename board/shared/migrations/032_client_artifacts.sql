-- Stored bytes and approvals are bound to immutable server-created versions.
CREATE TABLE client_artifact_versions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES client_items,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  name TEXT NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp','application/pdf','text/plain')),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 8388608),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  created_by TEXT NOT NULL REFERENCES members,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  UNIQUE (item_id, version_number),
  UNIQUE (created_by, request_id)
);
CREATE TRIGGER client_artifact_immutable BEFORE UPDATE ON client_artifact_versions
  BEGIN SELECT RAISE(ABORT, 'client artifact version is immutable'); END;
CREATE TRIGGER client_artifact_staff BEFORE INSERT ON client_artifact_versions
  WHEN NOT EXISTS (SELECT 1 FROM client_items i JOIN client_projects p ON p.id = i.project_id JOIN members m ON m.org_id = p.workspace_id WHERE i.id = NEW.item_id AND m.id = NEW.created_by)
  BEGIN SELECT RAISE(ABORT, 'client artifact staff belongs to another workspace'); END;
CREATE TABLE client_approval_requests (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES client_items,
  artifact_version_id TEXT NOT NULL REFERENCES client_artifact_versions,
  content_hash TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES members,
  requested_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  superseded_at TEXT,
  withdrawn_at TEXT,
  UNIQUE (requested_by, request_id)
);
CREATE TRIGGER client_approval_binding_insert BEFORE INSERT ON client_approval_requests
  WHEN NOT EXISTS (SELECT 1 FROM client_artifact_versions v WHERE v.id = NEW.artifact_version_id AND v.item_id = NEW.item_id AND v.sha256 = NEW.content_hash AND v.created_by IN (SELECT id FROM members WHERE org_id = (SELECT org_id FROM members WHERE id = NEW.requested_by)))
  BEGIN SELECT RAISE(ABORT, 'approval version or staff belongs to another item'); END;
CREATE TRIGGER client_approval_immutable BEFORE UPDATE OF id, item_id, artifact_version_id, content_hash, requested_by, requested_at, request_id ON client_approval_requests
  BEGIN SELECT RAISE(ABORT, 'client approval binding is immutable'); END;
CREATE TABLE client_approval_recipients (
  approval_id TEXT NOT NULL REFERENCES client_approval_requests,
  guest_id TEXT NOT NULL REFERENCES client_guests,
  PRIMARY KEY (approval_id, guest_id)
);
CREATE TRIGGER client_approval_recipient_insert BEFORE INSERT ON client_approval_recipients
  WHEN NOT EXISTS (SELECT 1 FROM client_approval_requests a JOIN client_items i ON i.id = a.item_id JOIN client_projects p ON p.id = i.project_id JOIN client_guests g ON g.workspace_id = p.workspace_id WHERE a.id = NEW.approval_id AND g.id = NEW.guest_id)
  BEGIN SELECT RAISE(ABORT, 'approval recipient belongs to another workspace'); END;
CREATE TRIGGER client_approval_recipient_immutable BEFORE UPDATE ON client_approval_recipients
  BEGIN SELECT RAISE(ABORT, 'client approval recipient is immutable'); END;
CREATE TABLE client_approval_decisions (
  approval_id TEXT NOT NULL,
  guest_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  comment TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL,
  PRIMARY KEY (approval_id, guest_id),
  FOREIGN KEY (approval_id, guest_id) REFERENCES client_approval_recipients(approval_id, guest_id)
);
CREATE TRIGGER client_approval_decision_immutable BEFORE UPDATE ON client_approval_decisions
  BEGIN SELECT RAISE(ABORT, 'client approval decision is immutable'); END;
