CREATE TABLE workflow_recipes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  latest_version INTEGER NOT NULL DEFAULT 1 CHECK (latest_version > 0),
  archived_at TEXT,
  created_by TEXT NOT NULL REFERENCES members,
  created_at TEXT NOT NULL
);
CREATE INDEX workflow_recipes_team ON workflow_recipes(org_id, archived_at);
CREATE TABLE workflow_versions (
  recipe_id TEXT NOT NULL REFERENCES workflow_recipes,
  version INTEGER NOT NULL CHECK (version > 0),
  definition TEXT NOT NULL CHECK (json_valid(definition) AND json_type(definition) = 'object'),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  created_by TEXT NOT NULL REFERENCES members,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, version),
  UNIQUE (created_by, request_id)
);
CREATE TRIGGER workflow_version_immutable BEFORE UPDATE ON workflow_versions
  BEGIN SELECT RAISE(ABORT, 'workflow version is immutable'); END;
CREATE TRIGGER workflow_version_staff BEFORE INSERT ON workflow_versions
  WHEN NOT EXISTS (SELECT 1 FROM workflow_recipes r JOIN members m ON m.org_id = r.org_id WHERE r.id = NEW.recipe_id AND m.id = NEW.created_by)
  BEGIN SELECT RAISE(ABORT, 'workflow author belongs to another team'); END;
CREATE TABLE workflow_instances (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  board_id TEXT NOT NULL REFERENCES boards,
  created_by TEXT NOT NULL REFERENCES members,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_at TEXT NOT NULL,
  FOREIGN KEY (recipe_id, recipe_version) REFERENCES workflow_versions(recipe_id, version),
  UNIQUE (created_by, request_id)
);
CREATE TRIGGER workflow_instance_staff BEFORE INSERT ON workflow_instances
  WHEN NOT EXISTS (SELECT 1 FROM workflow_recipes r JOIN boards b ON b.org_id = r.org_id JOIN members m ON m.org_id = r.org_id WHERE r.id = NEW.recipe_id AND b.id = NEW.board_id AND m.id = NEW.created_by)
  BEGIN SELECT RAISE(ABORT, 'workflow destination belongs to another team'); END;
CREATE TRIGGER workflow_instance_immutable BEFORE UPDATE ON workflow_instances
  BEGIN SELECT RAISE(ABORT, 'workflow instance is immutable'); END;
CREATE TABLE workflow_step_cards (
  instance_id TEXT NOT NULL REFERENCES workflow_instances,
  position INTEGER NOT NULL CHECK (position >= 0 AND position < 8),
  card_id TEXT NOT NULL UNIQUE REFERENCES cards,
  PRIMARY KEY (instance_id, position)
);
CREATE TRIGGER workflow_step_destination BEFORE INSERT ON workflow_step_cards
  WHEN NOT EXISTS (SELECT 1 FROM workflow_instances i JOIN cards c ON c.board_id = i.board_id WHERE i.id = NEW.instance_id AND c.id = NEW.card_id)
  BEGIN SELECT RAISE(ABORT, 'workflow task belongs to another board'); END;
CREATE TRIGGER workflow_step_immutable BEFORE UPDATE ON workflow_step_cards
  BEGIN SELECT RAISE(ABORT, 'workflow task provenance is immutable'); END;
