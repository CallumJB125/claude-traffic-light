-- migrate: rebuilds
-- An accepted handoff is closed by its receiver with the outcome 'done' or
-- 'failed' (board/MESSAGING.md §6), which the sender and the sender's AI read.
-- A CHECK change, so msg_messages is rebuilt exactly as 072 did (same copy-out,
-- sequence carry-over and index re-creation); via_json now rides along.

CREATE TABLE msg_seq_073 AS SELECT seq FROM sqlite_sequence WHERE name = 'msg_messages';
CREATE TABLE msg_messages_073 AS SELECT * FROM msg_messages;
DROP TABLE msg_messages;
CREATE TABLE msg_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message','handoff')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('person','session')),
  source_user_id TEXT NOT NULL,
  source_cred_kind TEXT NOT NULL,
  source_cred_id TEXT NOT NULL,
  source_target_id TEXT,
  dest_kind TEXT NOT NULL CHECK (dest_kind IN ('session','person')),
  dest_target_id TEXT,
  dest_user_id TEXT NOT NULL,
  org_id TEXT,
  card_id TEXT,
  conversation_id TEXT NOT NULL,
  reply_to TEXT,
  caused_by TEXT,
  body TEXT NOT NULL,
  handoff TEXT,
  handoff_state TEXT CHECK (handoff_state IN ('offered','accepted','declined','expired','done','failed')),
  handoff_report TEXT,
  hop INTEGER NOT NULL DEFAULT 0,
  visited TEXT NOT NULL DEFAULT '[]',
  authority_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held','queued','delivered','replied','rejected','expired','outcome_unknown')),
  phase TEXT CHECK (phase IN ('leased','accepted')),
  lease TEXT,
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  response TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  replied_at TEXT,
  via_json TEXT CHECK (via_json IS NULL OR (json_valid(via_json) AND length(via_json) <= 512)),
  UNIQUE (source_user_id, request_id)
);
INSERT INTO msg_messages (seq, id, request_id, request_hash, kind, source_kind, source_user_id, source_cred_kind, source_cred_id, source_target_id,
  dest_kind, dest_target_id, dest_user_id, org_id, card_id, conversation_id, reply_to, caused_by, body, handoff, handoff_state, handoff_report,
  hop, visited, authority_version, state, phase, lease, lease_until, attempts, reason, response, created_at, expires_at, updated_at, delivered_at, replied_at, via_json)
SELECT seq, id, request_id, request_hash, kind, source_kind, source_user_id, source_cred_kind, source_cred_id, source_target_id,
  dest_kind, dest_target_id, dest_user_id, org_id, card_id, conversation_id, reply_to, caused_by, body, handoff, handoff_state, handoff_report,
  hop, visited, authority_version, state, phase, lease, lease_until, attempts, reason, response, created_at, expires_at, updated_at, delivered_at, replied_at, via_json
FROM msg_messages_073;
DROP TABLE msg_messages_073;
UPDATE sqlite_sequence SET seq = max(seq, (SELECT seq FROM msg_seq_073)) WHERE name = 'msg_messages' AND EXISTS (SELECT 1 FROM msg_seq_073);
INSERT INTO sqlite_sequence (name, seq) SELECT 'msg_messages', seq FROM msg_seq_073 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'msg_messages');
DROP TABLE msg_seq_073;

CREATE INDEX msg_messages_dest_target ON msg_messages(dest_target_id, state, seq);
CREATE INDEX msg_messages_dest_user ON msg_messages(dest_user_id, seq);
CREATE INDEX msg_messages_source ON msg_messages(source_user_id, seq);
CREATE INDEX msg_messages_queued ON msg_messages(state, expires_at) WHERE state = 'queued';
CREATE INDEX msg_messages_created ON msg_messages(created_at);
CREATE INDEX msg_messages_target_hour ON msg_messages(dest_target_id, created_at);
CREATE INDEX msg_messages_org_hour ON msg_messages(org_id, created_at) WHERE org_id IS NOT NULL;
CREATE INDEX msg_messages_card_hour ON msg_messages(card_id, created_at) WHERE card_id IS NOT NULL;
CREATE INDEX msg_messages_offered ON msg_messages(expires_at) WHERE handoff_state = 'offered';
CREATE INDEX msg_messages_source_state ON msg_messages(source_user_id, state);
