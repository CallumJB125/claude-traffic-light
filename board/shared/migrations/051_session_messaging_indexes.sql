-- Messaging (board/MESSAGING.md): indexes for the timed sweep (retention,
-- expired handoffs, long-retired targets) and for the per-target hourly caps
-- and the host's registration cap, so none of them scans the whole table.
CREATE INDEX msg_messages_created ON msg_messages(created_at);
CREATE INDEX msg_messages_target_hour ON msg_messages(dest_target_id, created_at);
CREATE INDEX msg_messages_org_hour ON msg_messages(org_id, created_at) WHERE org_id IS NOT NULL;
CREATE INDEX msg_messages_card_hour ON msg_messages(card_id, created_at) WHERE card_id IS NOT NULL;
CREATE INDEX msg_messages_offered ON msg_messages(expires_at) WHERE handoff_state = 'offered';
CREATE INDEX msg_targets_retired ON msg_targets(retired_at) WHERE retired_at IS NOT NULL;
CREATE INDEX msg_targets_host_registered ON msg_targets(host_device_id, registered_at);
CREATE INDEX msg_targets_user ON msg_targets(user_id);
