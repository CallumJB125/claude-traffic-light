-- Advisory intent, never a filesystem lock or execution/approval grant.
CREATE TABLE task_ownership (
  run_id TEXT PRIMARY KEY REFERENCES runs,
  org_id TEXT NOT NULL REFERENCES orgs,
  board_id TEXT NOT NULL REFERENCES boards,
  card_id TEXT NOT NULL REFERENCES cards,
  repo_id TEXT NOT NULL REFERENCES repos,
  member_id TEXT NOT NULL REFERENCES members,
  device_id TEXT NOT NULL REFERENCES devices,
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
  fence INTEGER NOT NULL,
  plan_required INTEGER NOT NULL CHECK(plan_required IN (0,1)),
  generation TEXT NOT NULL,
  intent_version INTEGER NOT NULL DEFAULT 0 CHECK(intent_version >= 0),
  paths TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(paths) AND json_array_length(paths) <= 200),
  hub_epoch TEXT,
  connection_generation TEXT,
  last_hb_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX task_ownership_scope ON task_ownership(org_id,repo_id,board_id);
CREATE TRIGGER xteam_task_ownership_ins BEFORE INSERT ON task_ownership
WHEN NOT EXISTS(SELECT 1 FROM runs r JOIN cards c ON c.id=r.card_id JOIN boards b ON b.id=c.board_id
  JOIN members m ON m.id=r.on_behalf_of JOIN devices d ON d.id=r.device_id JOIN repos p ON p.id=r.repo_id
  WHERE r.id=NEW.run_id AND c.id=NEW.card_id AND b.id=NEW.board_id AND b.org_id=NEW.org_id AND m.org_id=b.org_id AND p.org_id=b.org_id
  AND m.id=NEW.member_id AND d.id=NEW.device_id AND d.member_id=m.id AND r.repo_id=NEW.repo_id AND r.fence=NEW.fence
  AND COALESCE(r.ai,CASE WHEN r.backend='codex_cli' THEN 'codex' ELSE 'claude' END)=NEW.provider)
BEGIN SELECT RAISE(ABORT,'ownership scope mismatch'); END;
CREATE TRIGGER task_ownership_identity_immutable BEFORE UPDATE ON task_ownership
WHEN NEW.run_id!=OLD.run_id OR NEW.org_id!=OLD.org_id OR NEW.board_id!=OLD.board_id OR NEW.card_id!=OLD.card_id
  OR NEW.repo_id!=OLD.repo_id OR NEW.member_id!=OLD.member_id OR NEW.device_id!=OLD.device_id OR NEW.provider!=OLD.provider
  OR NEW.fence!=OLD.fence OR NEW.plan_required!=OLD.plan_required OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'ownership identity is immutable'); END;
