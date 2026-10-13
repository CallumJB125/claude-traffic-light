-- Hosted (cloud) runners, docs/CLOUD-RUNNER-RUNBOOK.md. A hosted runner is an
-- always-on board runner on a server (the team's Pi), enrolled by an admin from
-- the desktop app like any runner, but not tied to that install's sign-in: it
-- keeps working while the laptop that created it is closed or signed out.
-- runner_enrollments.hosted marks it; the per-install uniqueness of desktop
-- enrolments no longer covers hosted rows (one install may create several).
ALTER TABLE runner_enrollments ADD COLUMN hosted INTEGER NOT NULL DEFAULT 0 CHECK (hosted IN (0, 1));
DROP INDEX runner_enrollments_active;
CREATE UNIQUE INDEX runner_enrollments_active ON runner_enrollments(user_device_id, org_id) WHERE revoked_at IS NULL AND hosted = 0;

-- 'hosted' = only a hosted runner may claim this dispatch ("Run in the cloud");
-- NULL = only the target member's own (non-hosted) runners, as before.
ALTER TABLE dispatches ADD COLUMN placement TEXT CHECK (placement IN ('hosted'));

-- Per-team provider credentials for hosted runs, sealed with the hub's
-- encryption key (vault.js, AAD = provider-config:<org_id> | provider | key id).
-- Delivered to a hosted runner per run over its authenticated socket, never
-- returned by any HTTP route, never logged.
CREATE TABLE team_provider_configs (
  org_id TEXT NOT NULL REFERENCES orgs,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'hermes-dgx')),
  base_url TEXT CHECK (base_url IS NULL OR length(base_url) <= 300),
  model TEXT CHECK (model IS NULL OR length(model) <= 100),
  key_id TEXT,
  nonce BLOB,
  ciphertext BLOB,
  updated_by TEXT NOT NULL REFERENCES members,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, provider),
  CHECK ((key_id IS NULL AND nonce IS NULL AND ciphertext IS NULL) OR (key_id IS NOT NULL AND nonce IS NOT NULL AND ciphertext IS NOT NULL))
);
CREATE TRIGGER xteam_team_provider_configs_ins BEFORE INSERT ON team_provider_configs
  WHEN (SELECT org_id FROM members WHERE id = NEW.updated_by) IS NOT NEW.org_id
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER xteam_team_provider_configs_upd BEFORE UPDATE OF org_id, updated_by ON team_provider_configs
  WHEN (SELECT org_id FROM members WHERE id = NEW.updated_by) IS NOT NEW.org_id
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
