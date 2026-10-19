-- The open pull request on an observed local session's branch (JSON: number, url,
-- state, checks, review), from the desktop's own GitHub poll. Written only by the
-- embedded local hub.
ALTER TABLE work_capture_cards ADD COLUMN pr TEXT CHECK (pr IS NULL OR (json_valid(pr) AND length(pr) <= 600));
