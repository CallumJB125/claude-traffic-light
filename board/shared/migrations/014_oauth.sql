-- OAuth sign-in (CONTRACT D76–D78): Google and GitHub through the desktop
-- app's loopback redirect with PKCE. One row per started flow; the state the
-- hub minted is stored only as sha256, the nonce (Google) to compare with the
-- id_token. Provider tokens are never stored anywhere.

CREATE TABLE oauth_flows (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google','github')),
  purpose TEXT NOT NULL CHECK (purpose IN ('signin','delete','delete_team')),
  client TEXT NOT NULL CHECK (client IN ('buddy_desktop')),
  state_hash TEXT NOT NULL,
  nonce TEXT,                                  -- Google: must come back in the id_token
  code_challenge TEXT NOT NULL,                -- base64url S256
  redirect_uri TEXT NOT NULL,                  -- http://127.0.0.1:<port>/callback, sent again at exchange
  device_name TEXT,
  platform TEXT,
  user_id TEXT REFERENCES users,               -- step-ups: who asked; sign-ins: who it signed in (so erasure finds it)
  cred_id TEXT,                                -- step-ups: the device token that asked (and alone may spend it)
  team_id TEXT,                                -- a team-deletion step-up: the one team it may delete
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,             -- burned before the provider is called; never reopened
  used_at TEXT,
  stepup_until TEXT,                           -- step-ups: set once the same provider identity signed in again
  consumed_at TEXT,                            -- step-ups: spent by a deletion
  ip_prefix TEXT,                              -- /24 or /48; the exchange must come from the same one
  ip_key TEXT                                  -- the client (IPv6 /64): the open-flow cap counts per this
);
CREATE INDEX oauth_flows_open ON oauth_flows(ip_key, used, expires_at);
CREATE INDEX oauth_flows_expiry ON oauth_flows(expires_at);
CREATE INDEX oauth_flows_stepup ON oauth_flows(user_id, stepup_until) WHERE stepup_until IS NOT NULL;

-- An identity a provider sign-in proved (NULL: written by migration 009 from
-- an admin-typed GitHub id, which never counts as proof of anything).
ALTER TABLE identities ADD COLUMN verified_at TEXT;
UPDATE identities SET verified_at = created_at WHERE provider = 'email' AND email_verified = 1;

-- Who proved users.primary_email (D83): NULL (before OAuth: an email code,
-- migration 009 / Access), 'email', 'google' (a Google account authoritative
-- for the address: hd = its domain, or gmail.com) are authoritative and may
-- be linked to by address; 'github' and 'google_weak' never are.
ALTER TABLE users ADD COLUMN primary_email_via TEXT CHECK (primary_email_via IN ('email','google','github','google_weak'));
