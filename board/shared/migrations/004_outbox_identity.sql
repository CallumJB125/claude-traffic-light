-- Runner outbox identity (review fix): the runner names its outbox with a UUID
-- (hello.outbox_id). A new id means the outbox was wiped and its seq restarted
-- at 1, so the hub resets last_seq_acked instead of dropping the new entries as
-- "already acked". events.seq keeps UNIQUE(device_id, seq) across resets by
-- storing seq_base + the runner's seq.
ALTER TABLE devices ADD COLUMN outbox_id TEXT;
ALTER TABLE devices ADD COLUMN seq_base INTEGER NOT NULL DEFAULT 0;
