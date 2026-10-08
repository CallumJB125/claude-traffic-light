-- Phase2A: private inert snapshots and future owned lineage. No execution
-- handler or dispatch grant is installed.037/039 remain immutable.
CREATE TABLE workflow_control_previews (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs,
 instance_id TEXT NOT NULL REFERENCES workflow_instances,
 board_id TEXT NOT NULL REFERENCES boards, repo_id TEXT NOT NULL REFERENCES repos,
 source_plan_id TEXT NOT NULL REFERENCES workflow_execution_plans ON DELETE CASCADE,
 execution_id TEXT REFERENCES workflow_executions ON DELETE CASCADE, purpose TEXT NOT NULL CHECK(purpose IN ('start','resume','retry')),
 expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision>=0),
 issuer_member_id TEXT NOT NULL REFERENCES members, issuer_user_id TEXT NOT NULL REFERENCES users,
 credential_kind TEXT NOT NULL CHECK(credential_kind IN ('device','session')), credential_id TEXT NOT NULL,
 request_id TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 preview_hash TEXT NOT NULL CHECK(length(preview_hash)=64 AND preview_hash NOT GLOB '*[^0-9a-f]*'),
 path_hash TEXT NOT NULL CHECK(length(path_hash)=64 AND path_hash NOT GLOB '*[^0-9a-f]*'),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND length(CAST(snapshot AS BLOB))<=32768 AND json_type(snapshot,'$.grants_execution') IS 'false'),
 created_ms INTEGER NOT NULL CHECK(typeof(created_ms)='integer'),
 expires_ms INTEGER NOT NULL CHECK(typeof(expires_ms)='integer' AND expires_ms>created_ms AND expires_ms-created_ms<=86400000),
 created_epoch TEXT NOT NULL, session_epoch INTEGER NOT NULL CHECK(session_epoch>0),
 UNIQUE(issuer_member_id,request_id)
);
CREATE TABLE workflow_control_preview_steps (
 preview_id TEXT NOT NULL REFERENCES workflow_control_previews ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 0 AND 7),card_id TEXT NOT NULL REFERENCES cards,
 target_member_id TEXT NOT NULL REFERENCES members,target_user_id TEXT NOT NULL REFERENCES users,
 PRIMARY KEY(preview_id,position),UNIQUE(preview_id,card_id)
);
CREATE TABLE workflow_executions (
 id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES orgs,instance_id TEXT NOT NULL REFERENCES workflow_instances,
 board_id TEXT NOT NULL REFERENCES boards,repo_id TEXT NOT NULL REFERENCES repos,
 source_plan_id TEXT NOT NULL REFERENCES workflow_execution_plans,
 source_hash TEXT NOT NULL CHECK(length(source_hash)=64 AND source_hash NOT GLOB '*[^0-9a-f]*'),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),
 state TEXT NOT NULL CHECK(state IN ('planned','authorized','paused_boot','paused_authority','paused','blocked','cancelled','completed')),
 created_epoch TEXT NOT NULL,created_ms INTEGER NOT NULL,
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND length(CAST(snapshot AS BLOB))<=32768)
);
CREATE UNIQUE INDEX workflow_execution_current ON workflow_executions(instance_id) WHERE state NOT IN ('cancelled','completed');
CREATE TABLE workflow_execution_steps (
 execution_id TEXT NOT NULL REFERENCES workflow_executions ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 0 AND 7),card_id TEXT NOT NULL REFERENCES cards,
 source_hash TEXT NOT NULL CHECK(length(source_hash)=64 AND source_hash NOT GLOB '*[^0-9a-f]*'),version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>=0),fence INTEGER NOT NULL CHECK(typeof(fence)='integer' AND fence>=0),
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempt_count)='integer' AND attempt_count BETWEEN 0 AND 8),
 state TEXT NOT NULL CHECK(state IN ('pending','queued','running','awaiting_review','completed','blocked','failed')),
 PRIMARY KEY(execution_id,position),UNIQUE(execution_id,card_id)
);
CREATE TABLE workflow_execution_authorizations (
 execution_id TEXT NOT NULL REFERENCES workflow_executions ON DELETE CASCADE,revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),
 preview_id TEXT NOT NULL REFERENCES workflow_control_previews ON DELETE CASCADE,
 issuer_member_id TEXT NOT NULL REFERENCES members,issuer_user_id TEXT NOT NULL REFERENCES users,
 credential_kind TEXT NOT NULL CHECK(credential_kind IN ('device','session')),credential_id TEXT NOT NULL,
 created_epoch TEXT NOT NULL,created_ms INTEGER NOT NULL,expires_ms INTEGER NOT NULL CHECK(expires_ms>created_ms AND expires_ms-created_ms<=86400000),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND length(CAST(snapshot AS BLOB))<=32768),snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
 PRIMARY KEY(execution_id,revision)
);
CREATE TABLE workflow_execution_attempts (
 id TEXT PRIMARY KEY,execution_id TEXT NOT NULL,position INTEGER NOT NULL,attempt INTEGER NOT NULL CHECK(typeof(attempt)='integer' AND attempt BETWEEN 1 AND 8),
 authorization_revision INTEGER NOT NULL,dispatch_id TEXT NOT NULL UNIQUE REFERENCES dispatches(request_id),
 provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),target_member_id TEXT NOT NULL REFERENCES members,target_user_id TEXT NOT NULL REFERENCES users,
 budget_cents INTEGER CHECK(budget_cents IS NULL OR budget_cents BETWEEN 50 AND 100000),
 run_id TEXT UNIQUE REFERENCES runs,fence INTEGER CHECK((run_id IS NULL AND fence IS NULL) OR (run_id IS NOT NULL AND typeof(fence)='integer' AND fence>=0)),state TEXT NOT NULL CHECK(state IN ('pending','claimed','completed','failed','uncertain')),
 FOREIGN KEY(execution_id,position) REFERENCES workflow_execution_steps ON DELETE CASCADE,
 FOREIGN KEY(execution_id,authorization_revision) REFERENCES workflow_execution_authorizations ON DELETE CASCADE,
 UNIQUE(execution_id,position,attempt)
);
-- Independent of private parents: a missing execution can NEVER make these
-- UUIDs ordinary. Erasure disables them before private history disappears.
CREATE TABLE workflow_owned_intents (
 request_id TEXT PRIMARY KEY REFERENCES dispatches(request_id),execution_id TEXT NOT NULL,
 card_id TEXT NOT NULL REFERENCES cards,run_id TEXT REFERENCES runs,fence INTEGER CHECK((run_id IS NULL AND fence IS NULL) OR (run_id IS NOT NULL AND typeof(fence)='integer' AND fence>=0)),
 disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1))
);
CREATE TABLE workflow_execution_receipts (
 execution_id TEXT NOT NULL REFERENCES workflow_executions ON DELETE CASCADE,request_id TEXT NOT NULL,
 issuer_user_id TEXT NOT NULL REFERENCES users,kind TEXT NOT NULL CHECK(kind IN ('start','resume','retry','pause','cancel')),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),
 result_ref TEXT NOT NULL,PRIMARY KEY(execution_id,request_id)
);
CREATE TABLE workflow_execution_proofs (
 id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL REFERENCES workflow_execution_attempts ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('complete','human_review','verified_merge','plan_review')),
 run_id TEXT NOT NULL REFERENCES runs,fence INTEGER NOT NULL CHECK(typeof(fence)='integer' AND fence>=0),card_version INTEGER NOT NULL CHECK(typeof(card_version)='integer' AND card_version>=0),
 source_epoch TEXT NOT NULL,snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND length(CAST(snapshot AS BLOB))<=32768),
 snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*')
);
CREATE TRIGGER workflow_control_preview_immutable BEFORE UPDATE ON workflow_control_previews BEGIN SELECT RAISE(ABORT,'execution preview is immutable'); END;
CREATE TRIGGER workflow_control_step_immutable BEFORE UPDATE ON workflow_control_preview_steps BEGIN SELECT RAISE(ABORT,'execution preview selection is immutable'); END;
CREATE TRIGGER workflow_authorization_immutable BEFORE UPDATE ON workflow_execution_authorizations BEGIN SELECT RAISE(ABORT,'execution authorization is immutable'); END;
CREATE TRIGGER workflow_receipt_immutable BEFORE UPDATE ON workflow_execution_receipts BEGIN SELECT RAISE(ABORT,'execution receipt is immutable'); END;
CREATE TRIGGER workflow_proof_immutable BEFORE UPDATE ON workflow_execution_proofs BEGIN SELECT RAISE(ABORT,'execution proof is immutable'); END;
CREATE TRIGGER workflow_execution_identity BEFORE UPDATE OF id,org_id,instance_id,board_id,repo_id,source_plan_id,source_hash,created_epoch,created_ms,snapshot ON workflow_executions BEGIN SELECT RAISE(ABORT,'execution source is immutable'); END;
CREATE TRIGGER workflow_step_identity BEFORE UPDATE OF execution_id,position,card_id,source_hash ON workflow_execution_steps BEGIN SELECT RAISE(ABORT,'execution selection is immutable'); END;
CREATE TRIGGER workflow_progress_monotonic BEFORE UPDATE ON workflow_execution_steps WHEN NEW.version<OLD.version OR NEW.fence<OLD.fence OR NEW.attempt_count<OLD.attempt_count BEGIN SELECT RAISE(ABORT,'execution progress cannot rewind'); END;
CREATE TRIGGER workflow_revision_monotonic BEFORE UPDATE ON workflow_executions WHEN NEW.revision<OLD.revision BEGIN SELECT RAISE(ABORT,'execution revision cannot rewind'); END;
CREATE TRIGGER workflow_attempt_identity BEFORE UPDATE OF id,execution_id,position,attempt,authorization_revision,dispatch_id,provider,target_member_id,target_user_id,budget_cents ON workflow_execution_attempts BEGIN SELECT RAISE(ABORT,'execution attempt is immutable'); END;
CREATE TRIGGER workflow_attempt_run_identity BEFORE UPDATE OF run_id,fence ON workflow_execution_attempts WHEN OLD.run_id IS NOT NULL AND (NEW.run_id IS NOT OLD.run_id OR NEW.fence IS NOT OLD.fence) BEGIN SELECT RAISE(ABORT,'execution run is immutable'); END;
CREATE TRIGGER workflow_attempt_initial_run BEFORE INSERT ON workflow_execution_attempts WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM runs r JOIN workflow_execution_steps s ON s.execution_id=NEW.execution_id AND s.position=NEW.position JOIN workflow_executions e ON e.id=s.execution_id
 WHERE r.id=NEW.run_id AND r.card_id=s.card_id AND r.dispatch_request_id=NEW.dispatch_id AND r.fence=NEW.fence AND r.repo_id=e.repo_id AND r.on_behalf_of=NEW.target_member_id)
 BEGIN SELECT RAISE(ABORT,'execution run source changed'); END;
CREATE TRIGGER workflow_attempt_run_binding BEFORE UPDATE OF run_id,fence ON workflow_execution_attempts WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM runs r JOIN workflow_execution_steps s ON s.execution_id=NEW.execution_id AND s.position=NEW.position JOIN workflow_executions e ON e.id=s.execution_id
 WHERE r.id=NEW.run_id AND r.card_id=s.card_id AND r.dispatch_request_id=NEW.dispatch_id AND r.fence=NEW.fence AND r.repo_id=e.repo_id AND r.on_behalf_of=NEW.target_member_id)
 BEGIN SELECT RAISE(ABORT,'execution run source changed'); END;
CREATE TRIGGER workflow_marker_identity BEFORE UPDATE ON workflow_owned_intents WHEN NEW.request_id IS NOT OLD.request_id OR NEW.execution_id IS NOT OLD.execution_id OR NEW.card_id IS NOT OLD.card_id OR (OLD.run_id IS NOT NULL AND (NEW.run_id IS NOT OLD.run_id OR NEW.fence IS NOT OLD.fence)) OR (OLD.disabled=1 AND NEW.disabled<>1) BEGIN SELECT RAISE(ABORT,'owned intent cannot be replaced or revived'); END;
CREATE TRIGGER workflow_marker_no_delete BEFORE DELETE ON workflow_owned_intents WHEN OLD.disabled=0
 OR EXISTS(SELECT 1 FROM dispatches WHERE request_id=OLD.request_id AND state='pending')
 OR EXISTS(SELECT 1 FROM runs WHERE id=OLD.run_id AND ended_at IS NULL)
 BEGIN SELECT RAISE(ABORT,'owned intent fence must be retained'); END;
CREATE TRIGGER workflow_marker_initial_run BEFORE INSERT ON workflow_owned_intents WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.card_id=NEW.card_id AND r.dispatch_request_id=NEW.request_id AND r.fence=NEW.fence)
 BEGIN SELECT RAISE(ABORT,'owned intent run source changed'); END;
CREATE TRIGGER workflow_marker_run_binding BEFORE UPDATE OF run_id,fence ON workflow_owned_intents WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.card_id=NEW.card_id AND r.dispatch_request_id=NEW.request_id AND r.fence=NEW.fence)
 BEGIN SELECT RAISE(ABORT,'owned intent run source changed'); END;
CREATE TRIGGER workflow_preview_provenance BEFORE INSERT ON workflow_control_previews WHEN NOT EXISTS (
 SELECT 1 FROM workflow_execution_plans p JOIN members m ON m.org_id=p.org_id JOIN users u ON u.id=m.user_id JOIN orgs o ON o.id=p.org_id
 WHERE p.id=NEW.source_plan_id AND p.org_id=NEW.org_id AND p.instance_id=NEW.instance_id AND p.board_id=NEW.board_id AND p.repo_id=NEW.repo_id
 AND m.id=NEW.issuer_member_id AND u.id=NEW.issuer_user_id AND m.removed_at IS NULL AND m.role IN ('owner','admin','member') AND u.deleted_at IS NULL AND o.deleted_at IS NULL
 AND ((NEW.credential_kind='device' AND EXISTS(SELECT 1 FROM user_devices d WHERE d.id=NEW.credential_id AND d.user_id=u.id AND d.revoked_at IS NULL AND d.token_hash IS NOT NULL))
 OR (NEW.credential_kind='session' AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=NEW.credential_id AND s.user_id=u.id AND s.revoked_at IS NULL))))
 BEGIN SELECT RAISE(ABORT,'execution preview issuer or source changed'); END;
CREATE TRIGGER workflow_control_step_provenance BEFORE INSERT ON workflow_control_preview_steps WHEN NOT EXISTS (
 SELECT 1 FROM workflow_control_previews p JOIN workflow_execution_plan_steps s ON s.plan_id=p.source_plan_id
 WHERE p.id=NEW.preview_id AND s.position=NEW.position AND s.card_id=NEW.card_id AND s.target_member_id=NEW.target_member_id AND s.target_user_id=NEW.target_user_id)
 BEGIN SELECT RAISE(ABORT,'execution preview selection changed'); END;
CREATE TRIGGER workflow_execution_provenance BEFORE INSERT ON workflow_executions WHEN NOT EXISTS (
 SELECT 1 FROM workflow_execution_plans p WHERE p.id=NEW.source_plan_id AND p.org_id=NEW.org_id AND p.instance_id=NEW.instance_id AND p.board_id=NEW.board_id AND p.repo_id=NEW.repo_id)
 BEGIN SELECT RAISE(ABORT,'execution source changed'); END;
CREATE TRIGGER workflow_progress_provenance BEFORE INSERT ON workflow_execution_steps WHEN NOT EXISTS (
 SELECT 1 FROM workflow_executions e JOIN workflow_step_cards s ON s.instance_id=e.instance_id JOIN cards c ON c.id=s.card_id
 WHERE e.id=NEW.execution_id AND s.position=NEW.position AND c.id=NEW.card_id AND c.board_id=e.board_id AND c.repo_id=e.repo_id AND c.version=NEW.version AND c.fence=NEW.fence)
 BEGIN SELECT RAISE(ABORT,'execution progress selection changed'); END;
CREATE TRIGGER workflow_authorization_provenance BEFORE INSERT ON workflow_execution_authorizations WHEN NOT EXISTS (
 SELECT 1 FROM workflow_executions e JOIN workflow_control_previews p ON p.instance_id=e.instance_id AND p.board_id=e.board_id AND p.repo_id=e.repo_id
 WHERE e.id=NEW.execution_id AND p.id=NEW.preview_id AND p.issuer_member_id=NEW.issuer_member_id AND p.issuer_user_id=NEW.issuer_user_id
 AND p.credential_kind=NEW.credential_kind AND p.credential_id=NEW.credential_id AND p.expected_revision=NEW.revision
 AND NEW.created_epoch=p.created_epoch AND NEW.expires_ms<=p.expires_ms AND NEW.created_ms>=p.created_ms)
 BEGIN SELECT RAISE(ABORT,'execution authorization source changed'); END;
CREATE TRIGGER workflow_attempt_provenance BEFORE INSERT ON workflow_execution_attempts WHEN NOT EXISTS (
 SELECT 1 FROM workflow_execution_steps s JOIN workflow_executions e ON e.id=s.execution_id JOIN dispatches d ON d.card_id=s.card_id
 JOIN members m ON m.org_id=e.org_id JOIN users u ON u.id=m.user_id
 WHERE s.execution_id=NEW.execution_id AND s.position=NEW.position AND d.request_id=NEW.dispatch_id
 AND COALESCE(d.target_member_id,d.dispatched_by)=NEW.target_member_id AND m.id=NEW.target_member_id AND u.id=NEW.target_user_id
 AND m.removed_at IS NULL AND u.deleted_at IS NULL AND m.role IN ('owner','admin','member')
 AND COALESCE(d.ai,CASE WHEN d.backend='codex_cli' THEN 'codex' ELSE 'claude' END)=NEW.provider
 AND (CASE WHEN d.budget_mode='cap' THEN d.budget_cents ELSE NULL END) IS NEW.budget_cents)
 BEGIN SELECT RAISE(ABORT,'execution attempt source changed'); END;
CREATE TRIGGER workflow_proof_provenance BEFORE INSERT ON workflow_execution_proofs WHEN NOT EXISTS (
 SELECT 1 FROM workflow_execution_attempts a JOIN workflow_execution_steps s ON s.execution_id=a.execution_id AND s.position=a.position
 JOIN runs r ON r.id=a.run_id JOIN cards c ON c.id=s.card_id
 WHERE a.id=NEW.attempt_id AND r.id=NEW.run_id AND r.card_id=s.card_id AND r.dispatch_request_id=a.dispatch_id
 AND r.fence=NEW.fence AND a.fence=NEW.fence AND c.version=NEW.card_version)
 BEGIN SELECT RAISE(ABORT,'execution proof source changed'); END;
CREATE TRIGGER workflow_marker_provenance BEFORE INSERT ON workflow_owned_intents WHEN NOT EXISTS (
 SELECT 1 FROM dispatches d WHERE d.request_id=NEW.request_id AND d.card_id=NEW.card_id)
 OR (NEW.disabled=0 AND NOT EXISTS(SELECT 1 FROM workflow_executions e JOIN workflow_execution_authorizations a ON a.execution_id=e.id AND a.revision=e.revision
 JOIN members m ON m.id=a.issuer_member_id JOIN users u ON u.id=a.issuer_user_id JOIN orgs o ON o.id=e.org_id
 WHERE e.id=NEW.execution_id AND e.state='authorized' AND a.created_epoch=(SELECT v FROM hub_meta WHERE k='hub_epoch')
 AND m.org_id=e.org_id AND m.user_id=u.id AND m.removed_at IS NULL AND m.role IN ('owner','admin','member') AND u.deleted_at IS NULL AND o.deleted_at IS NULL
 AND ((a.credential_kind='device' AND EXISTS(SELECT 1 FROM user_devices d WHERE d.id=a.credential_id AND d.user_id=u.id AND d.revoked_at IS NULL AND d.token_hash IS NOT NULL))
 OR (a.credential_kind='session' AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=a.credential_id AND s.user_id=u.id AND s.revoked_at IS NULL)))))
 BEGIN SELECT RAISE(ABORT,'owned intent source changed'); END;
CREATE TRIGGER workflow_receipt_quota BEFORE INSERT ON workflow_execution_receipts WHEN (SELECT count(*) FROM workflow_execution_receipts WHERE execution_id=NEW.execution_id)>=128 BEGIN SELECT RAISE(ABORT,'execution receipt quota'); END;
CREATE TRIGGER workflow_execution_quota BEFORE INSERT ON workflow_executions WHEN (SELECT count(*) FROM workflow_executions WHERE org_id=NEW.org_id)>=1000 BEGIN SELECT RAISE(ABORT,'execution quota'); END;
CREATE TRIGGER workflow_preview_quota BEFORE INSERT ON workflow_control_previews WHEN (SELECT count(*) FROM workflow_control_previews WHERE org_id=NEW.org_id)>=1000 BEGIN SELECT RAISE(ABORT,'execution preview quota'); END;
-- These hooks ONLY invalidate private workflow metadata; they do not write
-- cards, dispatches, runs, approvals, journal or provider lifecycle effects.
CREATE TRIGGER workflow_execution_erasure BEFORE DELETE ON workflow_executions BEGIN
 UPDATE workflow_owned_intents SET disabled=1 WHERE execution_id=OLD.id;
END;
CREATE TRIGGER workflow_authorization_erasure BEFORE DELETE ON workflow_execution_authorizations BEGIN
 UPDATE workflow_owned_intents SET disabled=1 WHERE execution_id=OLD.execution_id;
 UPDATE workflow_executions SET state='paused_authority' WHERE id=OLD.execution_id;
END;
CREATE TRIGGER workflow_control_erasure BEFORE DELETE ON workflow_control_previews BEGIN
 UPDATE workflow_owned_intents SET disabled=1 WHERE execution_id IN (SELECT execution_id FROM workflow_execution_authorizations WHERE preview_id=OLD.id);
 DELETE FROM workflow_executions WHERE id IN (SELECT execution_id FROM workflow_execution_authorizations WHERE preview_id=OLD.id);
END;
CREATE TRIGGER workflow_source_erasure BEFORE DELETE ON workflow_execution_plans BEGIN
 UPDATE workflow_owned_intents SET disabled=1 WHERE execution_id IN (SELECT id FROM workflow_executions WHERE source_plan_id=OLD.id);
 DELETE FROM workflow_executions WHERE source_plan_id=OLD.id;
END;
CREATE TRIGGER workflow_control_account_erasure AFTER UPDATE OF deleted_at ON users WHEN NEW.deleted_at IS NOT NULL BEGIN
 DELETE FROM workflow_executions WHERE id IN (SELECT execution_id FROM workflow_execution_authorizations WHERE issuer_user_id=NEW.id)
 OR id IN (SELECT execution_id FROM workflow_execution_attempts WHERE target_user_id=NEW.id);
 DELETE FROM workflow_control_previews WHERE issuer_user_id=NEW.id OR id IN (SELECT preview_id FROM workflow_control_preview_steps WHERE target_user_id=NEW.id);
END;
CREATE TRIGGER workflow_control_team_erasure AFTER UPDATE OF deleted_at ON orgs WHEN NEW.deleted_at IS NOT NULL BEGIN
 DELETE FROM workflow_executions WHERE org_id=NEW.id;DELETE FROM workflow_control_previews WHERE org_id=NEW.id;
END;
CREATE TRIGGER workflow_execution_boot_update AFTER UPDATE OF v ON hub_meta WHEN NEW.k='hub_epoch' AND NEW.v IS NOT OLD.v BEGIN
 UPDATE workflow_executions SET state='paused_boot',revision=revision+1 WHERE state NOT IN ('cancelled','completed');
END;
CREATE TRIGGER workflow_execution_boot_insert AFTER INSERT ON hub_meta WHEN NEW.k='hub_epoch' BEGIN
 UPDATE workflow_executions SET state='paused_boot',revision=revision+1 WHERE state NOT IN ('cancelled','completed');
END;
