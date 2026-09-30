-- Accounts P1 (ACCOUNTS-DESIGN.md §2, §14; ACCOUNTS-API.md; CONTRACT D50–D58).
-- 007/008 are reserved by another branch (D50). People become `users`; a
-- `members` row stays "user U in team T" and gains user_id, so every existing
-- foreign key keeps working. The members/devices rebuild (NOT NULL github
-- columns, viewer → guest, device enrolments) is P2/P4 work, not here.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  primary_email TEXT,                          -- lower-cased; NULL after deletion
  primary_email_verified_at TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT                              -- tombstone; the row stays so members.user_id stays valid
);
CREATE UNIQUE INDEX users_email ON users(primary_email) WHERE primary_email IS NOT NULL AND deleted_at IS NULL;

-- Sign-in methods, keyed by provider subject (never by email). Only 'email'
-- is issued today; GitHub/Google slot in later with the same shape.
CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users,
  provider TEXT NOT NULL CHECK (provider IN ('github','google','email','cf_access','dev')),
  subject TEXT NOT NULL,                       -- lower(email) | github numeric id | google sub | …
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  login TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE (provider, subject)
);
CREATE INDEX identities_by_user ON identities(user_id);

-- One install of the desktop app (or, later, a CLI runner): its bearer token
-- `bdt_…` is shown once and stored only as sha256 hex (design §6, D52).
CREATE TABLE user_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users,
  name TEXT NOT NULL,
  client TEXT NOT NULL CHECK (client IN ('buddy_desktop','board_runner_cli','legacy')),
  platform TEXT,
  form_factor TEXT CHECK (form_factor IN ('laptop','desktop')),
  token_hash TEXT UNIQUE,                      -- NULL once revoked
  prev_token_hash TEXT UNIQUE,                 -- P4 rotation
  token_rotated_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_ip_prefix TEXT,
  revoked_at TEXT,
  revoke_reason TEXT
);
CREATE INDEX user_devices_by_user ON user_devices(user_id);

-- Cookie sessions for a plain browser (client 'web'). `id` is stable across
-- rotations (sockets and revocation key on it); the cookie value is only ever
-- stored as sha256 hex.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  id_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('email','github','google')),
  created_at TEXT NOT NULL,
  auth_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  rotated_at TEXT NOT NULL,
  prev_id_hash TEXT UNIQUE,                    -- the previous value, accepted until prev_valid_until
  prev_valid_until TEXT,
  idle_expires_at TEXT NOT NULL,
  abs_expires_at TEXT NOT NULL,
  session_epoch INTEGER NOT NULL,              -- must equal hub_meta.session_epoch (bumped on restore)
  user_agent TEXT,
  ip_prefix TEXT,
  revoked_at TEXT,
  revoke_reason TEXT
);
CREATE INDEX sessions_by_user ON sessions(user_id) WHERE revoked_at IS NULL;

-- Email one-time-code flows: sign-in (sign-up = sign-in) and step-up for
-- account deletion. flow_id is public; the 6-digit code is stored as an HMAC.
CREATE TABLE login_flows (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('signin','delete')),
  client TEXT NOT NULL CHECK (client IN ('buddy_desktop','web')),
  user_id TEXT REFERENCES users,               -- purpose 'delete': who asked
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
CREATE INDEX login_flows_by_email ON login_flows(email, created_at);

ALTER TABLE members ADD COLUMN user_id TEXT REFERENCES users;
CREATE INDEX members_by_user ON members(user_id) WHERE removed_at IS NULL;

ALTER TABLE orgs ADD COLUMN slug TEXT;
ALTER TABLE audit ADD COLUMN org_id TEXT;
ALTER TABLE audit ADD COLUMN actor_user_id TEXT;
ALTER TABLE audit ADD COLUMN ip_prefix TEXT;
CREATE INDEX audit_by_user ON audit(actor_user_id, id);

INSERT INTO hub_meta (k, v) VALUES ('session_epoch', '1') ON CONFLICT(k) DO NOTHING;

-- §14 data migration. One user per distinct lower(email) among members (Access
-- verified those addresses), named after the newest member row, with a
-- verified email identity; every member row with that email links to it.
-- Members without an email stay unlinked: they cannot sign in by email.
INSERT INTO users (id, display_name, primary_email, primary_email_verified_at, created_at)
SELECT lower(hex(randomblob(16))),
       (SELECT m2.display_name FROM members m2 WHERE lower(trim(m2.email)) = p.email ORDER BY m2.created_at DESC LIMIT 1),
       p.email, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), p.first
FROM (SELECT lower(trim(email)) AS email, MIN(created_at) AS first FROM members
      WHERE email IS NOT NULL AND trim(email) != '' GROUP BY lower(trim(email))) p;

INSERT INTO identities (id, user_id, provider, subject, email, email_verified, created_at)
SELECT lower(hex(randomblob(16))), id, 'email', primary_email, primary_email, 1, created_at FROM users;

UPDATE members SET user_id = (SELECT u.id FROM users u WHERE u.primary_email = lower(trim(members.email)))
WHERE email IS NOT NULL AND trim(email) != '';

-- Their GitHub ids too, for when GitHub sign-in lands (subject = numeric id;
-- negative ids are dev/email placeholders, not GitHub accounts).
INSERT OR IGNORE INTO identities (id, user_id, provider, subject, login, email_verified, created_at)
SELECT lower(hex(randomblob(16))), m.user_id, 'github', CAST(m.github_id AS TEXT), m.github_login, 0, MIN(m.created_at)
FROM members m WHERE m.user_id IS NOT NULL AND m.github_id > 0 GROUP BY m.github_id;

-- Team slugs (§14 step 5): the name, lower-cased with spaces → '-'; a name
-- that doesn't fit ^[a-z0-9-]{1,40}$ gets team-<id>; duplicates get an id suffix.
UPDATE orgs SET slug = trim(replace(lower(trim(name)), ' ', '-'), '-');
UPDATE orgs SET slug = 'team-' || substr(replace(id, '-', ''), 1, 8)
WHERE slug = '' OR slug GLOB '*[^a-z0-9-]*' OR length(slug) > 40;
UPDATE orgs SET slug = slug || '-' || substr(replace(id, '-', ''), 1, 6)
WHERE EXISTS (SELECT 1 FROM orgs o2 WHERE o2.slug = orgs.slug AND o2.rowid < orgs.rowid);
CREATE UNIQUE INDEX orgs_slug ON orgs(slug) WHERE slug IS NOT NULL;
