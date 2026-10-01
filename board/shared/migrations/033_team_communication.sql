-- Participant context never carries an execution/approval grant.
CREATE TABLE task_packets (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards,
  version INTEGER NOT NULL CHECK (version > 0 AND version <= 100),
  repo_id TEXT REFERENCES repos,
  fence INTEGER NOT NULL,
  author_member_id TEXT NOT NULL REFERENCES members,
  author_user_id TEXT REFERENCES users,
  author_run_id TEXT REFERENCES runs,
  author_device_id TEXT REFERENCES devices,
  provider TEXT CHECK (provider IN ('claude', 'codex')),
  actor_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE(card_id, version),
  UNIQUE(actor_key, request_id),
  CHECK ((author_run_id IS NULL AND author_device_id IS NULL AND provider IS NULL) OR
    (author_run_id IS NOT NULL AND author_device_id IS NOT NULL AND provider IS NOT NULL))
);
CREATE TRIGGER task_packet_immutable BEFORE UPDATE ON task_packets
  BEGIN SELECT RAISE(ABORT, 'task packet is immutable'); END;
CREATE TRIGGER task_packet_author_scope BEFORE INSERT ON task_packets
  WHEN NOT EXISTS (SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id JOIN members m ON m.org_id = b.org_id
    WHERE c.id = NEW.card_id AND m.id = NEW.author_member_id AND m.user_id IS NEW.author_user_id AND c.repo_id IS NEW.repo_id
      AND c.fence = NEW.fence AND (NEW.author_run_id IS NULL OR EXISTS (SELECT 1 FROM runs r
        WHERE r.id = NEW.author_run_id AND r.card_id = c.id AND r.repo_id = NEW.repo_id AND r.fence = NEW.fence
          AND r.device_id = NEW.author_device_id AND r.on_behalf_of = m.id)))
  BEGIN SELECT RAISE(ABORT, 'task packet author or scope does not match'); END;
