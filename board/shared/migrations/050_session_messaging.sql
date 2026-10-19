-- Messages and handoffs between people and permitted sessions (board/MESSAGING.md,
-- board/hub/messaging.js). Additive. 049 is reserved for team-sharing.
-- No foreign keys: account deletion and device/member removal must never be
-- blocked by a message row; the hub re-validates and sweeps instead.

-- A session a host device declared messageable. The id is the only public
-- handle; (host_device_id, session, generation, scope, org_id) never change:
-- any change retires this row and registers a new one.
CREATE TABLE msg_targets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  host_device_id TEXT NOT NULL,
  session TEXT NOT NULL,
  generation INTEGER NOT NULL,
  provider TEXT NOT NULL,
  label TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('personal','team')),
  org_id TEXT,
  card_id TEXT,
  automation TEXT,
  registered_at TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  retired_at TEXT,
  retire_reason TEXT,
  CHECK ((scope = 'team') = (org_id IS NOT NULL))
);
CREATE UNIQUE INDEX msg_targets_live ON msg_targets(host_device_id, session) WHERE retired_at IS NULL;
CREATE INDEX msg_targets_org ON msg_targets(org_id) WHERE retired_at IS NULL;

-- One message: the durable per-destination queue (ordered by seq) and its receipts.
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
  handoff_state TEXT CHECK (handoff_state IN ('offered','accepted','declined','expired')),
  handoff_report TEXT,
  hop INTEGER NOT NULL DEFAULT 0,
  visited TEXT NOT NULL DEFAULT '[]',
  authority_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','delivered','replied','rejected','expired','outcome_unknown')),
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
  UNIQUE (source_user_id, request_id)
);
CREATE INDEX msg_messages_dest_target ON msg_messages(dest_target_id, state, seq);
CREATE INDEX msg_messages_dest_user ON msg_messages(dest_user_id, seq);
CREATE INDEX msg_messages_source ON msg_messages(source_user_id, seq);
CREATE INDEX msg_messages_queued ON msg_messages(state, expires_at) WHERE state = 'queued';
