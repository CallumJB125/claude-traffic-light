-- migrate: rebuilds
-- login_flows.purpose gains 'delete_team' (CONTRACT D74): the step-up for
-- deleting a team is its own purpose, so it can't be spent on deleting the
-- account and the other way round. A CHECK can't be altered in place: the
-- table is rebuilt (nothing references login_flows).

CREATE TABLE login_flows_new (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('signin','delete','delete_team')),
  client TEXT NOT NULL CHECK (client IN ('buddy_desktop','web')),
  user_id TEXT REFERENCES users,               -- purpose 'delete' / 'delete_team': who asked
  device_name TEXT,
  platform TEXT,
  code_hash TEXT NOT NULL,
  browser_nonce_hash TEXT,                     -- client 'web': binds a magic link to the browser that asked
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  consumed_at TEXT,
  dead_at TEXT,                                -- too many attempts, or superseded
  ip_prefix TEXT
);
INSERT INTO login_flows_new (id, email, purpose, client, user_id, device_name, platform, code_hash, browser_nonce_hash, attempts, created_at, expires_at, verified_at, consumed_at, dead_at, ip_prefix)
  SELECT id, email, purpose, client, user_id, device_name, platform, code_hash, browser_nonce_hash, attempts, created_at, expires_at, verified_at, consumed_at, dead_at, ip_prefix FROM login_flows;
DROP TABLE login_flows;
ALTER TABLE login_flows_new RENAME TO login_flows;
CREATE INDEX login_flows_by_email ON login_flows(email, created_at);
