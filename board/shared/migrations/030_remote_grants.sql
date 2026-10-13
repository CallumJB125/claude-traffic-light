-- Remote capabilities are separate from account/device/runner credentials.
-- Only opaque hashes persist. Grants survive ordinary browser logout/expiry,
-- but never revocation, account/team removal or a restored session epoch.
CREATE TABLE remote_clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  redirects TEXT NOT NULL CHECK(json_valid(redirects) AND json_type(redirects) = 'array'),
  registered_ip_hash TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE remote_grants (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users,
  member_id TEXT NOT NULL REFERENCES members, org_id TEXT NOT NULL REFERENCES orgs,
  application TEXT NOT NULL, audience TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('read','collaborate')),
  board_ids TEXT NOT NULL CHECK(json_valid(board_ids) AND json_type(board_ids) = 'array' AND json_array_length(board_ids) BETWEEN 1 AND 32),
  session_epoch INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  revoked_at TEXT, client_id TEXT REFERENCES remote_clients, family_id TEXT,
  CHECK((client_id IS NULL AND family_id IS NULL) OR (client_id IS NOT NULL AND family_id IS NOT NULL))
);
CREATE INDEX remote_grants_user ON remote_grants(user_id,created_at);
CREATE TABLE remote_tokens (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
  grant_id TEXT NOT NULL REFERENCES remote_grants,
  kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT
);
CREATE INDEX remote_tokens_grant ON remote_tokens(grant_id);
CREATE INDEX remote_tokens_expiry ON remote_tokens(expires_at);
CREATE TABLE remote_gestures (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users,
  org_id TEXT NOT NULL REFERENCES orgs, cred_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('create','revoke')),
  session_epoch INTEGER NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE remote_actions (
  grant_id TEXT NOT NULL REFERENCES remote_grants, request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, tool TEXT NOT NULL,
  response TEXT NOT NULL CHECK(json_valid(response)), created_at TEXT NOT NULL,
  PRIMARY KEY(grant_id,request_id)
);
CREATE TABLE remote_intents (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES remote_clients,
  browser_hash TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
  session_epoch INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  approving_user_id TEXT REFERENCES users, approving_session_id TEXT,
  consumed_at TEXT
);
CREATE TABLE remote_codes (
  code_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES remote_grants,
  redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
);
CREATE INDEX remote_codes_expiry ON remote_codes(expires_at);
CREATE INDEX remote_intents_expiry ON remote_intents(expires_at);
CREATE INDEX remote_gestures_expiry ON remote_gestures(expires_at);
-- A capability cannot inherit a replacement principal, client or token family.
CREATE TRIGGER remote_grants_identity_fixed BEFORE UPDATE ON remote_grants
WHEN NEW.id != OLD.id OR NEW.user_id != OLD.user_id OR NEW.member_id != OLD.member_id
  OR NEW.org_id != OLD.org_id OR NEW.audience != OLD.audience
  OR (NEW.application != OLD.application AND NOT (NEW.application = 'Deleted connection' AND NEW.revoked_at IS NOT NULL
    AND (EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id AND deleted_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id AND deleted_at IS NOT NULL))))
  OR NEW.client_id IS NOT OLD.client_id OR NEW.family_id IS NOT OLD.family_id
  OR NEW.session_epoch != OLD.session_epoch OR NEW.created_at != OLD.created_at
  OR NEW.expires_at > OLD.expires_at OR (OLD.mode = 'read' AND NEW.mode != 'read')
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
  OR EXISTS (SELECT 1 FROM json_each(NEW.board_ids) n WHERE n.type != 'text'
    OR NOT EXISTS (SELECT 1 FROM json_each(OLD.board_ids) o WHERE o.value = n.value))
BEGIN SELECT RAISE(ABORT, 'remote grant authority cannot widen or change identity'); END;
CREATE TRIGGER remote_tokens_identity_fixed BEFORE UPDATE ON remote_tokens
WHEN NEW.token_hash != OLD.token_hash OR NEW.grant_id != OLD.grant_id OR NEW.kind != OLD.kind
  OR NEW.created_at != OLD.created_at OR NEW.expires_at != OLD.expires_at
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT, 'remote token authority cannot change'); END;
CREATE TRIGGER remote_clients_identity_fixed BEFORE UPDATE ON remote_clients
WHEN NEW.id != OLD.id OR NEW.name != OLD.name OR NEW.redirects != OLD.redirects
  OR NEW.registered_ip_hash != OLD.registered_ip_hash OR NEW.created_at != OLD.created_at
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT, 'remote client identity cannot change'); END;
CREATE TRIGGER remote_actions_immutable BEFORE UPDATE ON remote_actions
BEGIN SELECT RAISE(ABORT, 'remote action receipts are immutable'); END;
CREATE TRIGGER remote_intents_identity_fixed BEFORE UPDATE ON remote_intents
WHEN NEW.id != OLD.id OR NEW.client_id != OLD.client_id OR NEW.browser_hash != OLD.browser_hash
  OR NEW.data != OLD.data OR NEW.session_epoch != OLD.session_epoch
  OR NEW.created_at != OLD.created_at OR NEW.expires_at != OLD.expires_at
  OR (OLD.approving_user_id IS NOT NULL AND (NEW.approving_user_id IS NOT OLD.approving_user_id
    OR NEW.approving_session_id IS NOT OLD.approving_session_id))
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
BEGIN SELECT RAISE(ABORT, 'remote consent intent identity cannot change'); END;
CREATE TRIGGER remote_codes_identity_fixed BEFORE UPDATE ON remote_codes
WHEN NEW.code_hash != OLD.code_hash OR NEW.grant_id != OLD.grant_id
  OR NEW.redirect_uri != OLD.redirect_uri OR NEW.challenge != OLD.challenge
  OR NEW.created_at != OLD.created_at OR NEW.expires_at != OLD.expires_at
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
BEGIN SELECT RAISE(ABORT, 'remote code identity cannot change'); END;
CREATE TRIGGER remote_gestures_identity_fixed BEFORE UPDATE ON remote_gestures
WHEN NEW.id != OLD.id OR NEW.user_id != OLD.user_id OR NEW.org_id != OLD.org_id OR NEW.cred_id != OLD.cred_id
  OR NEW.purpose != OLD.purpose OR NEW.session_epoch != OLD.session_epoch
  OR NEW.created_at != OLD.created_at OR NEW.expires_at != OLD.expires_at
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
BEGIN SELECT RAISE(ABORT, 'remote gesture identity cannot change'); END;
