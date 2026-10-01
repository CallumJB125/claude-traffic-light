-- PR evidence binding (CONTRACT D90): what a hub_verified PR was verified
-- against, so the merge poll can re-check it every cycle. NULL on rows from
-- before this migration and on every non-PR row.
ALTER TABLE evidence ADD COLUMN pr_head_repo_id INTEGER;
ALTER TABLE evidence ADD COLUMN pr_base_repo_id INTEGER;
ALTER TABLE evidence ADD COLUMN pr_base_ref TEXT;
