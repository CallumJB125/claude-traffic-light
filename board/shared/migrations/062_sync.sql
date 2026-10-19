-- Encrypted sync across one person's own devices (board/hub/sync.js, W3-C).
-- The hub holds ciphertext and the metadata needed to route and bill it:
-- opaque key wraps (the content key sealed to each device's public key or to
-- the recovery key), sizes, hashes and times. Never a key, a recovery code or
-- plaintext. Object bodies live in the object store (R2), not here.
-- Additive: no table rebuild. Version 062 (056, 060 and 061 are taken).

-- One row per user who has used sync. epoch = the content key generation
-- (bumped when a device is revoked); keyring_rev = the keyring's revision
-- (bumped whenever its wraps change). Lapse: when the plan ends, lapsed_at is
-- set and sync is read-only until lapsed_at + 30 days, then purge_at is due and
-- every object and row is deleted (purge also runs on account deletion).
CREATE TABLE sync_accounts (
  user_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  keyring_rev INTEGER NOT NULL DEFAULT 0 CHECK (keyring_rev >= 0),
  recovery_wrap TEXT CHECK (recovery_wrap IS NULL OR length(recovery_wrap) <= 8192),
  bytes_used INTEGER NOT NULL DEFAULT 0 CHECK (bytes_used >= 0),
  lapsed_at TEXT,
  lapse_notice_at TEXT,
  purge_at TEXT,
  purge_notice INTEGER NOT NULL DEFAULT 1 CHECK (purge_notice IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sync_accounts_lapsed ON sync_accounts(lapsed_at) WHERE lapsed_at IS NOT NULL;

-- A device in a user's sync set: the hub sign-in device (user_devices.id), its
-- public key-agreement key, and its wrap of the current keyring (NULL until
-- another device approves it or it restores with the recovery code).
CREATE TABLE sync_devices (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 80),
  agree_pub TEXT NOT NULL CHECK (length(agree_pub) BETWEEN 40 AND 200),
  wrap TEXT CHECK (wrap IS NULL OR length(wrap) <= 8192),
  wrap_rev INTEGER,
  cursor INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id)
);

-- The append-only encrypted op log: one row per uploaded blob, in upload
-- order (id is every device's cursor). object_key names the ciphertext in the
-- object store; size and sha256 are of the ciphertext.
CREATE TABLE sync_blobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  size INTEGER NOT NULL CHECK (size >= 1),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  object_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, device_id, seq)
);
CREATE INDEX sync_blobs_user ON sync_blobs(user_id, id);
