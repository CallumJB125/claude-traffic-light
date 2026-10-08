-- Phone push (W2-B, board/hub/push.js; docs/PHONE-RUNBOOK.md). One Web Push
-- subscription per phone sign-in (user_devices row): only the push service's
-- endpoint address. No encryption keys are kept because no push carries a
-- payload: the hub sends an empty "something needs you" ping and the phone
-- fetches what is waiting through the end-to-end relay. Removed when the
-- device is revoked or signs out, when the account is deleted, and when the
-- push service says the subscription is gone (404/410). Additive: no table
-- rebuild. 061 follows 056 (W2-A) and 060 (W3-A).

CREATE TABLE push_subscriptions (
  device_id TEXT PRIMARY KEY REFERENCES user_devices(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 12 AND 1024),
  created_at TEXT NOT NULL,
  last_ok_at TEXT
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
