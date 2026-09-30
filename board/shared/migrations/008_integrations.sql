-- migrate: rebuilds
-- Integrations framework (D41): connections per org, sealed secrets, identity
-- links for acting from another tool, card links, routing, inbound replay
-- protection, and the journal actor kind 'integration' (§15).
--
-- This migration REBUILDS `journal` and `comments` (DROP + RENAME), and DROP
-- TABLE silently drops every trigger and index on the table. It recreates
-- only the ones it knows (journal_board_seq, journal_card_seq,
-- journal_no_update, journal_no_delete). A migration is plain SQL here (no
-- dynamic SQL to re-run saved definitions), so any OTHER trigger or index on
-- either table (e.g. the accounts branch's xteam_comments_ins/upd, if its
-- 009-011 were ever applied before this) makes 008 abort, rolled back, rather
-- than lose it. A trigger or view elsewhere that names either table aborts at
-- the RENAME for the same reason. The first line tells a gap-filling runner
-- not to apply this after later migrations.
CREATE TEMP TABLE _m008_guard (n INTEGER NOT NULL);
CREATE TEMP TRIGGER _m008_guard_check BEFORE INSERT ON _m008_guard WHEN NEW.n > 0 BEGIN
  SELECT RAISE(ABORT, '008 rebuilds journal and comments and would drop triggers or indexes it does not recreate: apply 008 before any migration that adds them');
END;
INSERT INTO _m008_guard SELECT COUNT(*) FROM sqlite_master
  WHERE tbl_name IN ('journal', 'comments') AND type IN ('trigger', 'index') AND sql IS NOT NULL
    AND name NOT IN ('journal_board_seq', 'journal_card_seq', 'journal_no_update', 'journal_no_delete');
DROP TABLE _m008_guard;

-- An integration's own actions are journaled as actor_kind 'integration',
-- actor_id = the connection id. SQLite can't widen a CHECK in place, so the
-- journal is rebuilt (same columns, seqs, indexes and append-only triggers;
-- DROP TABLE fires no triggers). DROP also deletes the journal's
-- sqlite_sequence row, which can be above MAX(seq): it is kept and restored
-- so a seq is never handed out twice (bus cursors point at seqs).
CREATE TEMP TABLE _s AS SELECT seq FROM sqlite_sequence WHERE name = 'journal';
CREATE TABLE journal_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT,
  card_id TEXT,
  run_id TEXT,
  at_hub TEXT NOT NULL,
  hub_epoch TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('member','runner','system','integration')),
  actor_id TEXT,                                   -- member id | device id | connection id | NULL
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO journal_new (seq, board_id, card_id, run_id, at_hub, hub_epoch, actor_kind, actor_id, kind, payload)
  SELECT seq, board_id, card_id, run_id, at_hub, hub_epoch, actor_kind, actor_id, kind, payload FROM journal ORDER BY seq;
DROP TABLE journal;
ALTER TABLE journal_new RENAME TO journal;
INSERT INTO sqlite_sequence (name, seq) SELECT 'journal', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'journal') AND EXISTS (SELECT 1 FROM _s);
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM _s), 0)) WHERE name = 'journal';
DROP TABLE _s;
CREATE INDEX journal_board_seq ON journal (board_id, seq);
CREATE INDEX journal_card_seq ON journal (card_id, seq);
CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;

-- Comments an integration writes are source 'integration', trusted 0 (never
-- delivered to an agent). Same rebuild for the widened CHECK; rowids are kept
-- (delivery orders by created_at, rowid). reply_to names comments_new so the
-- DROP below never sees a child row pointing at the old table; RENAME
-- rewrites it to comments. A reply_to naming no comment (possible in a DB
-- written with foreign keys off) becomes NULL: it would abort the copy, and
-- with it the boot.
CREATE TABLE comments_new (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards,
  author_member_id TEXT REFERENCES members,
  author_run_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('web','widget','agent','linear','github','integration')),
  trusted INTEGER NOT NULL,
  body TEXT NOT NULL,
  for_agent INTEGER NOT NULL DEFAULT 0,
  reply_to TEXT REFERENCES comments_new,
  delivered_at TEXT,
  delivered_run_id TEXT,
  created_at TEXT NOT NULL,
  anchor_kind TEXT NOT NULL DEFAULT 'card' CHECK (anchor_kind IN ('card','event','file_range','diff_hunk')),
  anchor TEXT,
  plan_step_id TEXT,
  CHECK (author_member_id IS NOT NULL OR author_run_id IS NOT NULL)
);
INSERT INTO comments_new (rowid, id, card_id, author_member_id, author_run_id, source, trusted, body, for_agent, reply_to, delivered_at, delivered_run_id, created_at, anchor_kind, anchor, plan_step_id)
  SELECT rowid, id, card_id, author_member_id, author_run_id, source, trusted, body, for_agent,
    CASE WHEN reply_to IN (SELECT id FROM comments) THEN reply_to END,
    delivered_at, delivered_run_id, created_at, anchor_kind, anchor, plan_step_id FROM comments;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,          -- Slack team_id, GitHub installation_id, …
  display_name TEXT,
  scopes TEXT NOT NULL DEFAULT '[]',  -- JSON: what the provider actually granted
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked', 'error')),
  health TEXT,                        -- JSON {ok, last_ok_at, last_error, last_error_at, backlog}
  settings TEXT NOT NULL DEFAULT '{}', -- JSON {autonomy:{<action>:'auto'|'ask'|'off'}, …connector config}
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
-- Revoked rows stay (their audit, links and routes point at them); only a live
-- connection is unique, and only within its org: two teams may each connect
-- the same external workspace, each with its own secrets and webhook URL.
CREATE UNIQUE INDEX connections_live ON connections (org_id, provider, external_id) WHERE status != 'revoked';

-- Never selected by any route. AES-256-GCM under a key that is NOT in this DB
-- (BOARD_ENC_KEY / keyfile / the desktop app's safeStorage); key_id allows rotation.
CREATE TABLE connection_secrets (
  connection_id TEXT NOT NULL REFERENCES connections(id),
  kind TEXT NOT NULL,
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, kind)
);

-- An outside user acts as a member only after an explicit, verified link
-- (never an email match). Shaped like the accounts design's identities().
CREATE TABLE external_identities (
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  verified_via TEXT NOT NULL CHECK (verified_via IN ('oauth_link')),
  linked_at TEXT NOT NULL,
  UNIQUE (provider, workspace_id, subject),
  UNIQUE (provider, workspace_id, member_id)
);

CREATE TABLE external_links (
  card_id TEXT NOT NULL REFERENCES cards(id),
  connection_id TEXT NOT NULL REFERENCES connections(id),
  kind TEXT NOT NULL,                 -- thread | issue | pr | alert
  external_id TEXT NOT NULL,
  url TEXT,
  -- JSON ≤ 512 bytes, allowlisted keys and values only (registry linkStatus):
  -- {state?, checks?, review?} for a 'pr' link, shown on the card face.
  status TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, kind, external_id)
);
CREATE INDEX external_links_card ON external_links (card_id);

CREATE TABLE routes (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  board_id TEXT NOT NULL REFERENCES boards(id),
  filter TEXT NOT NULL DEFAULT '{}',  -- JSON {rules?, labels?, min_severity?, digest?}
  target TEXT NOT NULL,               -- JSON {channel_id}
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL
);

-- A delivery is leased while its handler runs ('processing' until
-- lease_until), then 'done'; a failed handler deletes its row so the
-- provider's retry runs. Rows older than 30 days are swept.
CREATE TABLE inbound_dedupe (
  provider TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  received_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'done' CHECK (state IN ('processing', 'done')),
  lease_until TEXT,
  PRIMARY KEY (provider, dedupe_key)
);
CREATE INDEX inbound_dedupe_age ON inbound_dedupe (received_at);

-- Every automatic action an integration takes (Callum: automate the obvious,
-- audit all of it, reversible from the card).
CREATE TABLE integration_audit (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  action TEXT NOT NULL,               -- e.g. card.move, card.link, card.create, notify.post
  -- 'attempted' is written before an automatic action runs, then becomes
  -- 'auto' or 'failed' (with a short error code).
  decision TEXT NOT NULL CHECK (decision IN ('attempted', 'auto', 'failed', 'asked', 'approved', 'denied', 'skipped')),
  card_id TEXT REFERENCES cards(id),
  external_ref TEXT,                  -- provider id (PR number, Sentry issue id) — never message text
  detail TEXT NOT NULL DEFAULT '{}',  -- JSON ≤ 2 KB, scalars and ids only: no secrets, no external message bodies
  undo TEXT,                          -- JSON describing how to reverse it, when reversible
  error TEXT,                         -- short code when decision = 'failed'
  at TEXT NOT NULL
);
CREATE INDEX integration_audit_by_conn ON integration_audit (connection_id, at);
CREATE INDEX integration_audit_by_card ON integration_audit (card_id) WHERE card_id IS NOT NULL;
