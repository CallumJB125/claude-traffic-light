-- migrate: foreign_keys=off rebuilds
-- Gemini provider (board runner): 'gemini' with backend 'gemini_cli'. Same
-- rebuild as 052 (see its header for the 12-step procedure and why every index
-- and trigger ON a rebuilt table is re-created verbatim), widening the same
-- provider/backend CHECKs and the two COALESCE fallbacks by one value. A later
-- migration that rebuilds any of these tables must re-create these triggers.
PRAGMA legacy_alter_table = ON;

CREATE TABLE dispatches__new (
  request_id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards,
  dispatched_by TEXT NOT NULL REFERENCES members,
  target_member_id TEXT REFERENCES members,   -- NULL = the dispatcher's own runner
  backend TEXT NOT NULL DEFAULT 'claude_cli' CHECK (backend IN ('claude_cli','codex_cli','hermes_cli','gemini_cli')),
  needs_confirm INTEGER NOT NULL DEFAULT 0,
  seed TEXT NOT NULL DEFAULT '{}',            -- JSON {from:['handover','answer','review'], answer?, review?}
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','cancelled','declined','superseded')),
  run_id TEXT,
  created_at TEXT NOT NULL
, ai TEXT CHECK (ai IN ('claude', 'codex', 'hermes', 'hermes-dgx', 'gemini')), budget_mode TEXT CHECK (budget_mode IN ('none', 'cap')), budget_cents INTEGER CHECK (budget_cents IS NULL OR budget_cents >= 0));
INSERT INTO dispatches__new SELECT * FROM dispatches;
DROP TABLE dispatches;
ALTER TABLE dispatches__new RENAME TO dispatches;

CREATE TABLE runs__new (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards,
  fence INTEGER NOT NULL,
  device_id TEXT REFERENCES devices,
  on_behalf_of TEXT NOT NULL REFERENCES members,   -- whose machine + account
  dispatched_by TEXT NOT NULL REFERENCES members,
  dispatch_request_id TEXT NOT NULL UNIQUE REFERENCES dispatches(request_id),
  backend TEXT NOT NULL CHECK (backend IN ('claude_cli','codex_cli','hermes_cli','gemini_cli','interactive','cloud_ma','cloud_gha')),
  -- no auth_mode: the member's CLI decides (subscription or own key); the hub never knows or stores it
  repo_id TEXT NOT NULL REFERENCES repos,
  base_ref TEXT NOT NULL,
  base_sha TEXT,
  branch TEXT,                                     -- board/<KEY>-r<fence>
  planned_paths TEXT NOT NULL DEFAULT '[]',        -- overlap inputs, repo-relative (globs ok)
  touched_paths TEXT NOT NULL DEFAULT '[]',
  snapshot_ref TEXT,                               -- refs/board/<KEY>/r<fence>
  last_snapshot_sha TEXT,
  snapshot_status TEXT CHECK (snapshot_status IN ('pushed','push_failed','held')),
  snapshot_reason TEXT,
  snapshot_at TEXT,
  facts TEXT NOT NULL DEFAULT '{}',                -- JSON facts layer (handover.js mergeHandover input)
  facts_at TEXT,
  status_summary TEXT,                             -- board_update_status (≤140)
  session_ids TEXT NOT NULL DEFAULT '[]',
  resume_session_id TEXT,
  seeded_from_handover INTEGER,                    -- handovers.version used as the seed
  cost_cents INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT, ai TEXT CHECK (ai IN ('claude', 'codex', 'hermes', 'hermes-dgx', 'gemini')), budget_cents INTEGER CHECK (budget_cents IS NULL OR budget_cents >= 0), terminal_reason TEXT CHECK (terminal_reason IN ('budget', 'budget_device')),
  UNIQUE (card_id, fence)
);
INSERT INTO runs__new SELECT * FROM runs;
DROP TABLE runs;
ALTER TABLE runs__new RENAME TO runs;

CREATE TABLE task_packets__new (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards,
  version INTEGER NOT NULL CHECK (version > 0 AND version <= 100),
  repo_id TEXT REFERENCES repos,
  fence INTEGER NOT NULL,
  author_member_id TEXT NOT NULL REFERENCES members,
  author_user_id TEXT REFERENCES users,
  author_run_id TEXT REFERENCES runs,
  author_device_id TEXT REFERENCES devices,
  provider TEXT CHECK (provider IN ('claude', 'codex', 'hermes', 'hermes-dgx', 'gemini')),
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
INSERT INTO task_packets__new SELECT * FROM task_packets;
DROP TABLE task_packets;
ALTER TABLE task_packets__new RENAME TO task_packets;

CREATE TABLE task_messages__new (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES task_message_threads,
  card_id TEXT NOT NULL REFERENCES cards,
  repo_id TEXT NOT NULL REFERENCES repos,
  fence INTEGER NOT NULL,
  author_member_id TEXT NOT NULL REFERENCES members,
  author_user_id TEXT REFERENCES users,
  author_run_id TEXT REFERENCES runs,
  author_device_id TEXT REFERENCES devices,
  provider TEXT CHECK (provider IN ('claude', 'codex', 'hermes', 'hermes-dgx', 'gemini')),
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
INSERT INTO task_messages__new SELECT * FROM task_messages;
DROP TABLE task_messages;
ALTER TABLE task_messages__new RENAME TO task_messages;

CREATE TABLE task_ownership__new (
  run_id TEXT PRIMARY KEY REFERENCES runs,
  org_id TEXT NOT NULL REFERENCES orgs,
  board_id TEXT NOT NULL REFERENCES boards,
  card_id TEXT NOT NULL REFERENCES cards,
  repo_id TEXT NOT NULL REFERENCES repos,
  member_id TEXT NOT NULL REFERENCES members,
  device_id TEXT NOT NULL REFERENCES devices,
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude','hermes','hermes-dgx','gemini')),
  fence INTEGER NOT NULL,
  plan_required INTEGER NOT NULL CHECK(plan_required IN (0,1)),
  generation TEXT NOT NULL,
  intent_version INTEGER NOT NULL DEFAULT 0 CHECK(intent_version >= 0),
  paths TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(paths) AND json_array_length(paths) <= 200),
  hub_epoch TEXT,
  connection_generation TEXT,
  last_hb_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO task_ownership__new SELECT * FROM task_ownership;
DROP TABLE task_ownership;
ALTER TABLE task_ownership__new RENAME TO task_ownership;

CREATE TABLE workflow_execution_attempts__new (
 id TEXT PRIMARY KEY,execution_id TEXT NOT NULL,position INTEGER NOT NULL,attempt INTEGER NOT NULL CHECK(typeof(attempt)='integer' AND attempt BETWEEN 1 AND 8),
 authorization_revision INTEGER NOT NULL,dispatch_id TEXT NOT NULL UNIQUE REFERENCES dispatches(request_id),
 provider TEXT NOT NULL CHECK(provider IN ('codex','claude','hermes','hermes-dgx','gemini')),target_member_id TEXT NOT NULL REFERENCES members,target_user_id TEXT NOT NULL REFERENCES users,
 budget_cents INTEGER CHECK(budget_cents IS NULL OR budget_cents BETWEEN 50 AND 100000),
 run_id TEXT UNIQUE REFERENCES runs,fence INTEGER CHECK((run_id IS NULL AND fence IS NULL) OR (run_id IS NOT NULL AND typeof(fence)='integer' AND fence>=0)),state TEXT NOT NULL CHECK(state IN ('pending','claimed','completed','failed','uncertain')),
 FOREIGN KEY(execution_id,position) REFERENCES workflow_execution_steps ON DELETE CASCADE,
 FOREIGN KEY(execution_id,authorization_revision) REFERENCES workflow_execution_authorizations ON DELETE CASCADE,
 UNIQUE(execution_id,position,attempt)
);
INSERT INTO workflow_execution_attempts__new SELECT * FROM workflow_execution_attempts;
DROP TABLE workflow_execution_attempts;
ALTER TABLE workflow_execution_attempts__new RENAME TO workflow_execution_attempts;

CREATE UNIQUE INDEX one_pending_dispatch_per_card ON dispatches(card_id) WHERE state = 'pending';
CREATE TRIGGER xteam_dispatches_ins BEFORE INSERT ON dispatches
  WHEN (SELECT org_id FROM members WHERE id = NEW.dispatched_by)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (NEW.target_member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.target_member_id)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id))
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_dispatches_upd BEFORE UPDATE OF card_id, dispatched_by, target_member_id ON dispatches
  WHEN (SELECT org_id FROM members WHERE id = NEW.dispatched_by)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (NEW.target_member_id IS NOT NULL AND (SELECT org_id FROM members WHERE id = NEW.target_member_id)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id))
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE UNIQUE INDEX one_active_run_per_card ON runs(card_id) WHERE ended_at IS NULL;
CREATE TRIGGER xteam_runs_ins BEFORE INSERT ON runs
  WHEN (SELECT org_id FROM members WHERE id = NEW.on_behalf_of)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (SELECT org_id FROM members WHERE id = NEW.dispatched_by)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (SELECT org_id FROM repos WHERE id = NEW.repo_id)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (NEW.device_id IS NOT NULL AND (SELECT m.org_id FROM devices d JOIN members m ON m.id = d.member_id WHERE d.id = NEW.device_id)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id))
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_runs_upd BEFORE UPDATE OF card_id, on_behalf_of, dispatched_by, repo_id, device_id ON runs
  WHEN (SELECT org_id FROM members WHERE id = NEW.on_behalf_of)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (SELECT org_id FROM members WHERE id = NEW.dispatched_by)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (SELECT org_id FROM repos WHERE id = NEW.repo_id)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id)
    OR (NEW.device_id IS NOT NULL AND (SELECT m.org_id FROM devices d JOIN members m ON m.id = d.member_id WHERE d.id = NEW.device_id)
      IS NOT (SELECT b.org_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = NEW.card_id))
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER task_packet_author_scope BEFORE INSERT ON task_packets
  WHEN NOT EXISTS (SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id JOIN members m ON m.org_id = b.org_id
    WHERE c.id = NEW.card_id AND m.id = NEW.author_member_id AND m.user_id IS NEW.author_user_id AND c.repo_id IS NEW.repo_id
      AND c.fence = NEW.fence AND (NEW.author_run_id IS NULL OR EXISTS (SELECT 1 FROM runs r
        WHERE r.id = NEW.author_run_id AND r.card_id = c.id AND r.repo_id = NEW.repo_id AND r.fence = NEW.fence
          AND r.device_id = NEW.author_device_id AND r.on_behalf_of = m.id)))
  BEGIN SELECT RAISE(ABORT, 'task packet author or scope does not match'); END;
CREATE TRIGGER task_packet_immutable BEFORE UPDATE ON task_packets
  BEGIN SELECT RAISE(ABORT, 'task packet is immutable'); END;
CREATE INDEX task_messages_card ON task_messages(card_id, created_at);
CREATE TRIGGER task_message_author_scope BEFORE INSERT ON task_messages
  WHEN NOT EXISTS (SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id JOIN members m ON m.org_id = b.org_id
    JOIN task_message_threads t ON t.org_id = b.org_id AND t.repo_id = c.repo_id
    WHERE c.id = NEW.card_id AND t.id = NEW.thread_id AND m.id = NEW.author_member_id AND m.user_id IS NEW.author_user_id
      AND c.repo_id = NEW.repo_id AND c.fence = NEW.fence AND (NEW.author_run_id IS NULL OR EXISTS (SELECT 1 FROM runs r
        WHERE r.id = NEW.author_run_id AND r.card_id = c.id AND r.repo_id = NEW.repo_id AND r.fence = NEW.fence
          AND r.device_id = NEW.author_device_id AND r.on_behalf_of = m.id)))
  BEGIN SELECT RAISE(ABORT, 'task message author or scope does not match'); END;
CREATE TRIGGER task_message_immutable BEFORE UPDATE ON task_messages
  BEGIN SELECT RAISE(ABORT, 'task message is immutable'); END;
CREATE INDEX task_ownership_scope ON task_ownership(org_id,repo_id,board_id);
CREATE TRIGGER task_ownership_identity_immutable BEFORE UPDATE ON task_ownership
WHEN NEW.run_id!=OLD.run_id OR NEW.org_id!=OLD.org_id OR NEW.board_id!=OLD.board_id OR NEW.card_id!=OLD.card_id
  OR NEW.repo_id!=OLD.repo_id OR NEW.member_id!=OLD.member_id OR NEW.device_id!=OLD.device_id OR NEW.provider!=OLD.provider
  OR NEW.fence!=OLD.fence OR NEW.plan_required!=OLD.plan_required OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'ownership identity is immutable'); END;
CREATE TRIGGER xteam_task_ownership_ins BEFORE INSERT ON task_ownership
WHEN NOT EXISTS(SELECT 1 FROM runs r JOIN cards c ON c.id=r.card_id JOIN boards b ON b.id=c.board_id
  JOIN members m ON m.id=r.on_behalf_of JOIN devices d ON d.id=r.device_id JOIN repos p ON p.id=r.repo_id
  WHERE r.id=NEW.run_id AND c.id=NEW.card_id AND b.id=NEW.board_id AND b.org_id=NEW.org_id AND m.org_id=b.org_id AND p.org_id=b.org_id
  AND m.id=NEW.member_id AND d.id=NEW.device_id AND d.member_id=m.id AND r.repo_id=NEW.repo_id AND r.fence=NEW.fence
  AND COALESCE(r.ai,CASE r.backend WHEN 'codex_cli' THEN 'codex' WHEN 'hermes_cli' THEN 'hermes' WHEN 'gemini_cli' THEN 'gemini' ELSE 'claude' END)=NEW.provider)
BEGIN SELECT RAISE(ABORT,'ownership scope mismatch'); END;
CREATE TRIGGER workflow_attempt_identity BEFORE UPDATE OF id,execution_id,position,attempt,authorization_revision,dispatch_id,provider,target_member_id,target_user_id,budget_cents ON workflow_execution_attempts BEGIN SELECT RAISE(ABORT,'execution attempt is immutable'); END;
CREATE TRIGGER workflow_attempt_initial_run BEFORE INSERT ON workflow_execution_attempts WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM runs r JOIN workflow_execution_steps s ON s.execution_id=NEW.execution_id AND s.position=NEW.position JOIN workflow_executions e ON e.id=s.execution_id
 WHERE r.id=NEW.run_id AND r.card_id=s.card_id AND r.dispatch_request_id=NEW.dispatch_id AND r.fence=NEW.fence AND r.repo_id=e.repo_id AND r.on_behalf_of=NEW.target_member_id)
 BEGIN SELECT RAISE(ABORT,'execution run source changed'); END;
CREATE TRIGGER workflow_attempt_provenance BEFORE INSERT ON workflow_execution_attempts WHEN NOT EXISTS (
 SELECT 1 FROM workflow_execution_steps s JOIN workflow_executions e ON e.id=s.execution_id JOIN dispatches d ON d.card_id=s.card_id
 JOIN members m ON m.org_id=e.org_id JOIN users u ON u.id=m.user_id
 WHERE s.execution_id=NEW.execution_id AND s.position=NEW.position AND d.request_id=NEW.dispatch_id
 AND COALESCE(d.target_member_id,d.dispatched_by)=NEW.target_member_id AND m.id=NEW.target_member_id AND u.id=NEW.target_user_id
 AND m.removed_at IS NULL AND u.deleted_at IS NULL AND m.role IN ('owner','admin','member')
 AND COALESCE(d.ai,CASE d.backend WHEN 'codex_cli' THEN 'codex' WHEN 'hermes_cli' THEN 'hermes' WHEN 'gemini_cli' THEN 'gemini' ELSE 'claude' END)=NEW.provider
 AND (CASE WHEN d.budget_mode='cap' THEN d.budget_cents ELSE NULL END) IS NEW.budget_cents)
 BEGIN SELECT RAISE(ABORT,'execution attempt source changed'); END;
CREATE TRIGGER workflow_attempt_run_binding BEFORE UPDATE OF run_id,fence ON workflow_execution_attempts WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM runs r JOIN workflow_execution_steps s ON s.execution_id=NEW.execution_id AND s.position=NEW.position JOIN workflow_executions e ON e.id=s.execution_id
 WHERE r.id=NEW.run_id AND r.card_id=s.card_id AND r.dispatch_request_id=NEW.dispatch_id AND r.fence=NEW.fence AND r.repo_id=e.repo_id AND r.on_behalf_of=NEW.target_member_id)
 BEGIN SELECT RAISE(ABORT,'execution run source changed'); END;
CREATE TRIGGER workflow_attempt_run_identity BEFORE UPDATE OF run_id,fence ON workflow_execution_attempts WHEN OLD.run_id IS NOT NULL AND (NEW.run_id IS NOT OLD.run_id OR NEW.fence IS NOT OLD.fence) BEGIN SELECT RAISE(ABORT,'execution run is immutable'); END;

PRAGMA legacy_alter_table = OFF;
