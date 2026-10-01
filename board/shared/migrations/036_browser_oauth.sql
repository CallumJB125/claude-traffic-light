-- Browser OAuth has distinct credentials, exact own callbacks and a browser-
-- bound encrypted cookie. Provider tokens, verifier and invitation tokens
-- never enter this table. Existing native loopback flows remain unchanged.
CREATE TABLE oauth_web_flows (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('google','github')),
  state_hash TEXT NOT NULL UNIQUE,
  browser_nonce_hash TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  nonce TEXT,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1)),
  used_at TEXT,
  outcome TEXT,
  user_id TEXT REFERENCES users,
  session_id TEXT,
  consumed_at TEXT,
  ip_prefix TEXT,
  ip_key TEXT,
  session_epoch INTEGER NOT NULL
);
CREATE INDEX oauth_web_open ON oauth_web_flows(ip_key,used,expires_at);
CREATE INDEX oauth_web_expiry ON oauth_web_flows(expires_at);
CREATE INDEX oauth_web_user ON oauth_web_flows(user_id);
