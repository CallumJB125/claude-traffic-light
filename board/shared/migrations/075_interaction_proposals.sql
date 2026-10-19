-- Exact, owner-reviewed requests within an existing interact share. These
-- grants never widen share scope. Text is retained for at most seven days.
CREATE TABLE interaction_proposals (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES interaction_shares,
  requester_user_id TEXT NOT NULL REFERENCES users,
  decision_id TEXT NOT NULL,
  decision_version INTEGER NOT NULL CHECK(decision_version > 0),
  generation INTEGER NOT NULL CHECK(generation > 0),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  digest TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action = 'send'),
  action_budget INTEGER NOT NULL CHECK(action_budget = 1),
  status TEXT NOT NULL CHECK(status IN ('pending','approved','dispatching','sent','unconfirmed','refused','revoked','superseded')),
  created_at TEXT NOT NULL,
  retain_until TEXT NOT NULL,
  acknowledged_at TEXT,
  grant_expires_at TEXT,
  used_at TEXT,
  receipt_id TEXT,
  receipt_state TEXT,
  UNIQUE(share_id, requester_user_id, decision_id, decision_version)
);
CREATE INDEX interaction_proposals_by_share ON interaction_proposals(share_id, created_at);
CREATE INDEX interaction_proposals_by_requester ON interaction_proposals(requester_user_id, created_at);
