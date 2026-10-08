-- Event triggers (board/shared/triggers.js, board/hub/triggers.js,
-- docs/event-triggers.md): a team admin's "when X happens, do Y" rules and
-- the log of their firings. A rule names one event and one action from closed
-- lists (no action can start an editing AI run or push code), starts off,
-- spends a week in dry run before it may act for real, and is never edited in
-- place: delete it and write another. A firing row is also the dedupe record:
-- one per (rule, event id), so a redelivered event never fires twice. Firings
-- hold ids and short codes only, never provider text. Rows are kept 30 days.
-- Deleting a team switches its rules off. Additive: no table rebuild. Version 069.

CREATE TABLE event_triggers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  event TEXT NOT NULL CHECK (event IN ('github.pr.opened', 'github.pr.review_requested', 'github.checks.failed', 'card.moved_to_review', 'sentry.issue.new')),
  filters TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(filters) AND length(filters) <= 1024),
  action TEXT NOT NULL CHECK (action IN ('create_card', 'add_comment', 'request_ai_review', 'notify_member', 'label_card')),
  params TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params) AND length(params) <= 4096),
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'dry_run', 'on')),
  max_per_hour INTEGER NOT NULL DEFAULT 10 CHECK (max_per_hour BETWEEN 1 AND 60),
  created_by TEXT NOT NULL REFERENCES members(id),
  enabled_by TEXT REFERENCES members(id),
  dry_run_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (mode = 'off' OR (enabled_by IS NOT NULL AND dry_run_since IS NOT NULL AND deleted_at IS NULL))
);
CREATE INDEX event_triggers_live ON event_triggers(org_id, event) WHERE deleted_at IS NULL;

CREATE TRIGGER event_triggers_same_team BEFORE INSERT ON event_triggers
  WHEN NOT EXISTS (SELECT 1 FROM members m WHERE m.id = NEW.created_by AND m.org_id = NEW.org_id AND m.removed_at IS NULL)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER event_triggers_rule_fixed BEFORE UPDATE OF org_id, event, filters, action, params, max_per_hour, created_by ON event_triggers
  BEGIN SELECT RAISE(ABORT, 'a trigger rule is never changed: delete it and make another'); END;
CREATE TRIGGER event_triggers_enabler_same_team BEFORE UPDATE OF enabled_by ON event_triggers
  WHEN NEW.enabled_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = NEW.enabled_by AND m.org_id = NEW.org_id)
  BEGIN SELECT RAISE(ABORT, 'cross-team reference'); END;
CREATE TRIGGER orgs_deleted_event_triggers AFTER UPDATE OF deleted_at ON orgs
  WHEN NEW.deleted_at IS NOT NULL
  BEGIN UPDATE event_triggers SET mode = 'off', updated_at = NEW.deleted_at WHERE org_id = NEW.id AND mode != 'off'; END;

CREATE TABLE event_trigger_firings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id TEXT NOT NULL REFERENCES event_triggers(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  event TEXT NOT NULL,
  action TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'on')),
  result TEXT NOT NULL CHECK (result IN ('done', 'would', 'skipped', 'failed', 'rate_limited')),
  detail TEXT CHECK (length(detail) <= 64),
  subject TEXT CHECK (length(subject) <= 160),
  card_id TEXT,
  at TEXT NOT NULL,
  UNIQUE (trigger_id, event_id)
);
CREATE INDEX event_trigger_firings_rate ON event_trigger_firings(trigger_id, at);
CREATE INDEX event_trigger_firings_org ON event_trigger_firings(org_id, id);
CREATE INDEX event_trigger_firings_at ON event_trigger_firings(at);
