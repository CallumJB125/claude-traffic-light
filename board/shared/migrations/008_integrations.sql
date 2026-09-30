-- Integrations framework (D41): connections per org, sealed secrets, identity
-- links for acting from another tool, card links, routing, inbound replay
-- protection.

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,          -- Slack team_id, GitHub installation_id, …
  display_name TEXT,
  scopes TEXT NOT NULL DEFAULT '[]',  -- JSON: what the provider actually granted
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked', 'error')),
  health TEXT,                        -- JSON {ok, last_ok_at, last_error, last_error_at, backlog}
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (provider, external_id)
);

-- Never selected by any route. AES-256-GCM under a key that is NOT in this DB
-- (BOARD_ENC_KEY / keyfile / the desktop app's safeStorage); key_id allows rotation.
CREATE TABLE connection_secrets (
  connection_id TEXT NOT NULL REFERENCES connections(id),
  kind TEXT NOT NULL,
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, kind)
);

-- An outside user acts as a member only after an explicit, verified link
-- (never an email match). Shaped like the accounts design's identities().
CREATE TABLE external_identities (
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  verified_via TEXT NOT NULL CHECK (verified_via IN ('oauth_link')),
  linked_at TEXT NOT NULL,
  UNIQUE (provider, workspace_id, subject),
  UNIQUE (provider, workspace_id, member_id)
);

CREATE TABLE external_links (
  card_id TEXT NOT NULL REFERENCES cards(id),
  connection_id TEXT NOT NULL REFERENCES connections(id),
  kind TEXT NOT NULL,                 -- thread | issue | pr | alert
  external_id TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, kind, external_id)
);
CREATE INDEX external_links_card ON external_links (card_id);

CREATE TABLE routes (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  board_id TEXT NOT NULL REFERENCES boards(id),
  filter TEXT NOT NULL DEFAULT '{}',  -- JSON {rules?, labels?, min_severity?, digest?}
  target TEXT NOT NULL,               -- JSON {channel_id}
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL
);

CREATE TABLE inbound_dedupe (
  provider TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (provider, dedupe_key)
);
