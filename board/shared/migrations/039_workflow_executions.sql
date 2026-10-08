-- Checkpoint1: bounded immutable PREVIEW records only, no execution grant.
-- Future launch/attempt state needs its own independently reviewed migration.
CREATE TABLE workflow_execution_plans (
 id TEXT PRIMARY KEY,
 org_id TEXT NOT NULL REFERENCES orgs,
 instance_id TEXT NOT NULL REFERENCES workflow_instances,
 board_id TEXT NOT NULL REFERENCES boards,
 repo_id TEXT NOT NULL REFERENCES repos,
 issuer_member_id TEXT NOT NULL REFERENCES members,
 issuer_user_id TEXT NOT NULL REFERENCES users,
 credential_kind TEXT NOT NULL CHECK(credential_kind IN ('device','session')),
 credential_id TEXT NOT NULL,
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64 AND plan_hash NOT GLOB '*[^0-9a-f]*'),
 snapshot TEXT NOT NULL CHECK(length(CAST(snapshot AS BLOB))<=32768 AND json_valid(snapshot)
   AND json_type(snapshot,'$.grants_execution') IS 'false'),
 created_ms INTEGER NOT NULL CHECK(typeof(created_ms)='integer'),
 expires_ms INTEGER NOT NULL CHECK(typeof(expires_ms)='integer' AND expires_ms>created_ms AND expires_ms-created_ms<=86400000),
 created_epoch TEXT NOT NULL,
 session_epoch INTEGER NOT NULL CHECK(typeof(session_epoch)='integer' AND session_epoch>0),
 UNIQUE(issuer_member_id,request_id)
);
CREATE INDEX workflow_plans_team ON workflow_execution_plans(org_id);
CREATE INDEX workflow_plans_instance ON workflow_execution_plans(instance_id,created_ms);
CREATE TRIGGER workflow_plan_immutable BEFORE UPDATE ON workflow_execution_plans
 BEGIN SELECT RAISE(ABORT,'workflow preview is immutable'); END;
CREATE TRIGGER workflow_plan_provenance BEFORE INSERT ON workflow_execution_plans WHEN NOT EXISTS (
 SELECT 1 FROM workflow_instances i JOIN workflow_recipes w ON w.id=i.recipe_id
 JOIN boards b ON b.id=i.board_id JOIN repos r ON r.org_id=b.org_id
 JOIN board_repos br ON br.board_id=b.id AND br.repo_id=r.id
 JOIN members m ON m.org_id=b.org_id JOIN users u ON u.id=m.user_id
 JOIN orgs o ON o.id=b.org_id
 WHERE i.id=NEW.instance_id AND i.board_id=NEW.board_id AND r.id=NEW.repo_id AND o.id=NEW.org_id
 AND w.org_id=o.id AND m.id=NEW.issuer_member_id AND u.id=NEW.issuer_user_id
 AND o.deleted_at IS NULL AND u.deleted_at IS NULL AND m.removed_at IS NULL AND m.role IN ('owner','admin','member')
 AND b.archived_at IS NULL AND w.archived_at IS NULL
 AND ((NEW.credential_kind='device' AND EXISTS(SELECT 1 FROM user_devices d WHERE d.id=NEW.credential_id AND d.user_id=u.id AND d.revoked_at IS NULL))
 OR (NEW.credential_kind='session' AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=NEW.credential_id AND s.user_id=u.id))))
 BEGIN SELECT RAISE(ABORT,'workflow preview source or issuer changed'); END;
CREATE TABLE workflow_execution_plan_steps (
 plan_id TEXT NOT NULL REFERENCES workflow_execution_plans ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(position>=0 AND position<8),
 card_id TEXT NOT NULL REFERENCES cards,
 target_member_id TEXT NOT NULL REFERENCES members,
 target_user_id TEXT NOT NULL REFERENCES users,
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>=0),
 fence INTEGER NOT NULL CHECK(typeof(fence)='integer' AND fence>=0),
 PRIMARY KEY(plan_id,position),
 UNIQUE(plan_id,card_id)
);
CREATE TRIGGER workflow_plan_step_immutable BEFORE UPDATE ON workflow_execution_plan_steps
 BEGIN SELECT RAISE(ABORT,'workflow preview step is immutable'); END;
CREATE TRIGGER workflow_plan_step_provenance BEFORE INSERT ON workflow_execution_plan_steps WHEN NOT EXISTS (
 SELECT 1 FROM workflow_execution_plans p JOIN workflow_step_cards s ON s.instance_id=p.instance_id
 JOIN cards c ON c.id=s.card_id JOIN members m ON m.org_id=p.org_id JOIN users u ON u.id=m.user_id
 WHERE p.id=NEW.plan_id AND s.position=NEW.position AND c.id=NEW.card_id AND c.board_id=p.board_id AND c.repo_id=p.repo_id
 AND c.archived_at IS NULL AND c.version=NEW.version AND c.fence=NEW.fence
 AND m.id=NEW.target_member_id AND u.id=NEW.target_user_id AND m.removed_at IS NULL AND u.deleted_at IS NULL
 AND m.role IN ('owner','admin','member'))
 BEGIN SELECT RAISE(ABORT,'workflow preview step or target changed'); END;
-- Erasure removes private issuer/choice snapshots, not cards or their history.
CREATE TRIGGER workflow_plans_account_erasure AFTER UPDATE OF deleted_at ON users WHEN NEW.deleted_at IS NOT NULL BEGIN
 DELETE FROM workflow_execution_plans WHERE issuer_user_id=NEW.id OR id IN
  (SELECT plan_id FROM workflow_execution_plan_steps WHERE target_user_id=NEW.id);
END;
CREATE TRIGGER workflow_plans_team_erasure AFTER UPDATE OF deleted_at ON orgs WHEN NEW.deleted_at IS NOT NULL BEGIN
 DELETE FROM workflow_execution_plans WHERE org_id=NEW.id;
END;
