-- Published build logs (vibe-coder loop, lane F). A team member publishes a
-- reviewed, scrubbed build log of their own sessions; it is readable by anyone
-- with its unguessable link (/b/<slug>) until its author or a team admin
-- unpublishes it. Unpublishing deletes the row and its reports. Reports from
-- the public page hide the log after three distinct reporters until an admin
-- restores or removes it.
CREATE TABLE build_logs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  author_member_id TEXT NOT NULL REFERENCES members,
  author_user_id TEXT NOT NULL REFERENCES users,
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 16 AND 64),
  title TEXT NOT NULL CHECK (length(title) <= 120),
  body TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 300000),
  remix_count INTEGER NOT NULL DEFAULT 0 CHECK (remix_count >= 0),
  report_count INTEGER NOT NULL DEFAULT 0 CHECK (report_count >= 0),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX build_logs_by_org ON build_logs(org_id, created_at);
CREATE TABLE build_log_reports (
  log_id TEXT NOT NULL REFERENCES build_logs ON DELETE CASCADE,
  reporter TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) <= 500),
  created_at TEXT NOT NULL,
  PRIMARY KEY (log_id, reporter)
);
