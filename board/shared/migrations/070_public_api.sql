-- Public API tokens and outbound webhooks (docs/PUBLIC-API.md,
-- board/hub/public-api/). Additive: no table rebuild. Version 069.
--
-- An API token belongs to a team and is made by one of its owners or admins.
-- Only its sha256 is kept; the token itself is shown once. A token acts as
-- the member who made it, and only while that member is still in the team.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  token_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL CHECK (length(hint) <= 16),
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  created_by TEXT NOT NULL REFERENCES members,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  last_audit_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES members
);
CREATE INDEX api_tokens_org ON api_tokens(org_id, created_at);
CREATE TRIGGER xteam_api_tokens_ins BEFORE INSERT ON api_tokens
  WHEN (SELECT org_id FROM members WHERE id = NEW.created_by) IS NOT NEW.org_id
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

-- An https endpoint a team admin registered. The signing secret is sealed with
-- the hub's encryption key (vault.js, AAD = endpoint id | webhook_secret | key id).
CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  url TEXT NOT NULL CHECK (length(url) <= 500),
  events TEXT NOT NULL CHECK (json_valid(events) AND json_type(events) = 'array'),
  include_text INTEGER NOT NULL DEFAULT 0 CHECK (include_text IN (0, 1)),
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_by TEXT NOT NULL REFERENCES members,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  disabled_reason TEXT CHECK (disabled_reason IN ('admin', 'failing')),
  deleted_at TEXT
);
CREATE INDEX webhook_endpoints_org ON webhook_endpoints(org_id) WHERE deleted_at IS NULL;
CREATE TRIGGER xteam_webhook_endpoints_ins BEFORE INSERT ON webhook_endpoints
  WHEN (SELECT org_id FROM members WHERE id = NEW.created_by) IS NOT NEW.org_id
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;

-- One event for one endpoint: the id is the receiver's idempotency key and
-- stays the same across retries. The payload holds ids and titles (and card
-- text only when the endpoint asked for it). Finished rows beyond the latest
-- 50 per endpoint are deleted.
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints,
  event_type TEXT NOT NULL,
  journal_seq INTEGER,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(payload) <= 65536),
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at_ms INTEGER,
  last_status INTEGER,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 64),
  latency_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (endpoint_id, journal_seq, event_type)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_at_ms) WHERE state = 'pending';
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at);
