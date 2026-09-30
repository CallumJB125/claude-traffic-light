-- Member removal (soft): a removed member no longer authenticates (HTTP, WS,
-- runner devices), and their live browser sockets are closed. Rows stay, since
-- runs, comments and the journal refer to them.
ALTER TABLE members ADD COLUMN removed_at TEXT;
