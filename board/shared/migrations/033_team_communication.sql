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

CREATE TABLE task_message_threads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  repo_id TEXT NOT NULL REFERENCES repos,
  seed_card_id TEXT NOT NULL REFERENCES cards,
  seed_member_id TEXT NOT NULL REFERENCES members,
  seed_run_id TEXT UNIQUE REFERENCES runs,
  created_at TEXT NOT NULL
);
CREATE TRIGGER task_message_thread_immutable BEFORE UPDATE ON task_message_threads
  BEGIN SELECT RAISE(ABORT, 'message thread is immutable'); END;
CREATE TABLE task_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES task_message_threads,
  card_id TEXT NOT NULL REFERENCES cards,
  repo_id TEXT NOT NULL REFERENCES repos,
  fence INTEGER NOT NULL,
  author_member_id TEXT NOT NULL REFERENCES members,
  author_user_id TEXT REFERENCES users,
  author_run_id TEXT REFERENCES runs,
  author_device_id TEXT REFERENCES devices,
  provider TEXT CHECK (provider IN ('claude', 'codex')),
  actor_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('status', 'question', 'handoff', 'coordination')),
  body TEXT NOT NULL CHECK (length(body) <= 4000),
  reply_to TEXT REFERENCES task_messages,
  depth INTEGER NOT NULL CHECK (depth >= 0 AND depth <= 3),
  comment_id TEXT NOT NULL UNIQUE REFERENCES comments,
  created_at TEXT NOT NULL,
  UNIQUE(actor_key, request_id),
  CHECK ((author_run_id IS NULL AND author_device_id IS NULL AND provider IS NULL) OR
    (author_run_id IS NOT NULL AND author_device_id IS NOT NULL AND provider IS NOT NULL))
);
CREATE INDEX task_messages_card ON task_messages(card_id, created_at);
CREATE TRIGGER task_message_immutable BEFORE UPDATE ON task_messages
  BEGIN SELECT RAISE(ABORT, 'task message is immutable'); END;
CREATE TRIGGER task_message_author_scope BEFORE INSERT ON task_messages
  WHEN NOT EXISTS (SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id JOIN members m ON m.org_id = b.org_id
    JOIN task_message_threads t ON t.org_id = b.org_id AND t.repo_id = c.repo_id
    WHERE c.id = NEW.card_id AND t.id = NEW.thread_id AND m.id = NEW.author_member_id AND m.user_id IS NEW.author_user_id
      AND c.repo_id = NEW.repo_id AND c.fence = NEW.fence AND (NEW.author_run_id IS NULL OR EXISTS (SELECT 1 FROM runs r
        WHERE r.id = NEW.author_run_id AND r.card_id = c.id AND r.repo_id = NEW.repo_id AND r.fence = NEW.fence
          AND r.device_id = NEW.author_device_id AND r.on_behalf_of = m.id)))
  BEGIN SELECT RAISE(ABORT, 'task message author or scope does not match'); END;
CREATE TABLE task_message_recipients (
  message_id TEXT NOT NULL REFERENCES task_messages,
  run_id TEXT NOT NULL REFERENCES runs,
  fence INTEGER NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices,
  PRIMARY KEY(message_id, run_id, fence)
);
CREATE INDEX task_message_inbox ON task_message_recipients(run_id, fence);
CREATE TRIGGER task_message_recipient_immutable BEFORE UPDATE ON task_message_recipients
  BEGIN SELECT RAISE(ABORT, 'task message recipient is immutable'); END;
CREATE TRIGGER task_message_recipient_scope BEFORE INSERT ON task_message_recipients
  WHEN NOT EXISTS (SELECT 1 FROM task_messages m JOIN cards source ON source.id = m.card_id JOIN boards b ON b.id = source.board_id
    JOIN runs r ON r.repo_id = m.repo_id JOIN cards c ON c.id = r.card_id JOIN boards target ON target.id = c.board_id AND target.org_id = b.org_id
    WHERE m.id = NEW.message_id AND r.id = NEW.run_id AND r.fence = NEW.fence AND r.device_id = NEW.device_id
      AND r.ended_at IS NULL AND c.active_run_id = r.id AND c.fence = NEW.fence AND c.repo_id = m.repo_id)
  BEGIN SELECT RAISE(ABORT, 'task message recipient leaves the task scope'); END;
CREATE TABLE task_message_receipts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  recipient_run_id TEXT NOT NULL,
  recipient_fence INTEGER NOT NULL,
  connection_generation TEXT NOT NULL,
  received_at TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(message_id, recipient_run_id, recipient_fence) REFERENCES task_message_recipients(message_id, run_id, fence),
  UNIQUE(message_id, recipient_run_id, recipient_fence, connection_generation),
  CHECK (acknowledged_at IS NULL OR received_at IS NOT NULL)
);
CREATE TRIGGER task_message_receipt_binding BEFORE UPDATE ON task_message_receipts
  WHEN NEW.id != OLD.id OR NEW.message_id != OLD.message_id OR NEW.recipient_run_id != OLD.recipient_run_id
    OR NEW.recipient_fence != OLD.recipient_fence OR NEW.connection_generation != OLD.connection_generation OR NEW.created_at != OLD.created_at
    OR (OLD.received_at IS NOT NULL AND NEW.received_at IS NOT OLD.received_at)
    OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS NOT OLD.acknowledged_at)
  BEGIN SELECT RAISE(ABORT, 'task message receipt binding is immutable'); END;
