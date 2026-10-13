-- Additive owned lifecycle bindings. Applied037/039/044 snapshots remain
-- immutable; ordinary state changes advance this separate private binding.
CREATE TABLE workflow_step_bindings (
 execution_id TEXT NOT NULL,position INTEGER NOT NULL,
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>=0),
 fence INTEGER NOT NULL CHECK(typeof(fence)='integer' AND fence>=0),
 source_hmac TEXT NOT NULL CHECK(length(source_hmac)=32 AND source_hmac NOT GLOB '*[^0-9a-f]*'),
 state_hmac TEXT NOT NULL CHECK(length(state_hmac)=32 AND state_hmac NOT GLOB '*[^0-9a-f]*'),
 PRIMARY KEY(execution_id,position),
 FOREIGN KEY(execution_id,position) REFERENCES workflow_execution_steps ON DELETE CASCADE
);
CREATE TRIGGER workflow_binding_identity BEFORE UPDATE ON workflow_step_bindings
 WHEN NEW.execution_id IS NOT OLD.execution_id OR NEW.position IS NOT OLD.position OR NEW.version<OLD.version OR NEW.fence<OLD.fence
 BEGIN SELECT RAISE(ABORT,'workflow binding cannot rewind or move'); END;
CREATE TABLE workflow_verified_pr (
 evidence_id TEXT PRIMARY KEY REFERENCES evidence ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES runs,repo_hmac TEXT NOT NULL CHECK(length(repo_hmac)=32),
 head_sha TEXT NOT NULL CHECK(length(head_sha)=40 AND head_sha NOT GLOB '*[^0-9a-f]*'),
 base_ref TEXT NOT NULL CHECK(length(base_ref) BETWEEN 1 AND 200),
 head_repo_id INTEGER NOT NULL,base_repo_id INTEGER NOT NULL CHECK(base_repo_id=head_repo_id)
);
CREATE TRIGGER workflow_pr_immutable BEFORE UPDATE ON workflow_verified_pr BEGIN SELECT RAISE(ABORT,'workflow verified PR is immutable'); END;
CREATE TRIGGER workflow_pr_source BEFORE INSERT ON workflow_verified_pr WHEN NOT EXISTS(
 SELECT 1 FROM evidence e JOIN runs r ON r.id=e.run_id JOIN workflow_owned_intents m ON m.run_id=r.id
 WHERE e.id=NEW.evidence_id AND e.run_id=NEW.run_id AND e.card_id=r.card_id AND e.kind='pr' AND e.verification='hub_verified'
 AND m.card_id=r.card_id AND m.fence=r.fence)
 BEGIN SELECT RAISE(ABORT,'workflow verified PR source changed'); END;
CREATE TABLE workflow_stop_requests (
 execution_id TEXT NOT NULL REFERENCES workflow_executions ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES runs,fence INTEGER NOT NULL,requested_ms INTEGER NOT NULL,
 PRIMARY KEY(execution_id,run_id)
);
CREATE TRIGGER workflow_stop_immutable BEFORE UPDATE ON workflow_stop_requests BEGIN SELECT RAISE(ABORT,'workflow stop request is immutable'); END;
-- Resume/Retry bind the reviewed prior revision; their new authorization is
-- a distinct revision. Start remains revision0 and its original triple hash.
DROP TRIGGER workflow_authorization_provenance;
CREATE TRIGGER workflow_authorization_provenance BEFORE INSERT ON workflow_execution_authorizations WHEN NOT EXISTS (
 SELECT 1 FROM workflow_executions e JOIN workflow_control_previews p ON p.instance_id=e.instance_id AND p.board_id=e.board_id AND p.repo_id=e.repo_id
 WHERE e.id=NEW.execution_id AND p.id=NEW.preview_id AND p.source_plan_id=e.source_plan_id
 AND p.issuer_member_id=NEW.issuer_member_id AND p.issuer_user_id=NEW.issuer_user_id
 AND p.credential_kind=NEW.credential_kind AND p.credential_id=NEW.credential_id
 AND ((p.purpose='start' AND NEW.revision=0 AND p.expected_revision=0 AND p.execution_id IS NULL)
 OR (p.purpose IN ('resume','retry') AND p.execution_id=e.id AND NEW.revision=p.expected_revision+1))
 AND NEW.created_epoch=p.created_epoch AND NEW.expires_ms<=p.expires_ms AND NEW.created_ms>=p.created_ms)
 BEGIN SELECT RAISE(ABORT,'execution authorization source changed'); END;
-- Erasure invalidates only this exact unclaimed intent, including direct SQL
-- parent deletion. Claimed runs/cards/journal never become fabricated stops.
CREATE TRIGGER workflow_disabled_pending AFTER UPDATE OF disabled ON workflow_owned_intents
 WHEN NEW.disabled=1 AND OLD.disabled=0 BEGIN
 UPDATE dispatches SET state='cancelled' WHERE request_id=NEW.request_id AND card_id=NEW.card_id AND state='pending';
END;
CREATE TRIGGER workflow_disabled_initial_pending AFTER INSERT ON workflow_owned_intents WHEN NEW.disabled=1 BEGIN
 UPDATE dispatches SET state='cancelled' WHERE request_id=NEW.request_id AND card_id=NEW.card_id AND state='pending';
END;
-- Narrative-free ownership never turns an old UUID into an ordinary request
-- even after all private parents and its unclaimed dispatch are invalidated.
CREATE TRIGGER workflow_owned_lineage_retained BEFORE DELETE ON workflow_owned_intents BEGIN
 SELECT RAISE(ABORT,'owned intent fence must be retained');
END;
CREATE TRIGGER workflow_non_authorized_pending AFTER UPDATE OF state ON workflow_executions
 WHEN NEW.state IN ('paused_boot','paused_authority','paused','blocked','cancelled') BEGIN
 UPDATE workflow_owned_intents SET disabled=1 WHERE execution_id=NEW.id AND run_id IS NULL;
 UPDATE workflow_execution_attempts SET state='failed' WHERE execution_id=NEW.id AND state='pending' AND run_id IS NULL;
 UPDATE workflow_execution_steps SET state='pending' WHERE execution_id=NEW.id AND state='queued'
 AND card_id IN (SELECT card_id FROM workflow_owned_intents WHERE execution_id=NEW.id AND disabled=1 AND run_id IS NULL);
END;
