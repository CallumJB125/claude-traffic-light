-- Paid plans (board/hub/billing/, W3-A). One row per paying subject: a user
-- (Plus) or a team (Team, with its paid seat count). Only the payment
-- provider's own ids, the plan and its period are kept: never a card number,
-- its last digits, an expiry, a billing address or a provider payload. The
-- provider is the source of truth; rows are written only by verified webhook
-- events (billing/webhook.js) and read to answer GET /api/entitlement.
-- Additive: no table rebuild. Version 060 leaves 054–059 for parallel work (D50).

CREATE TABLE entitlements (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user','org')),
  subject_id TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('plus','team')),
  interval TEXT CHECK (interval IS NULL OR interval IN ('month','year')),
  seats INTEGER NOT NULL DEFAULT 1 CHECK (seats >= 1 AND seats <= 10000),
  status TEXT NOT NULL CHECK (status IN ('incomplete','incomplete_expired','trialing','active','past_due','unpaid','canceled','paused')),
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
  current_period_end INTEGER,               -- unix seconds: end of the current billing period
  paid_through INTEGER,                     -- unix seconds: end of the last period an invoice was paid for
  state_at INTEGER NOT NULL DEFAULT 0,      -- provider event time of the last state applied (older events never overwrite newer)
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  provider_customer TEXT CHECK (provider_customer IS NULL OR length(provider_customer) <= 255),
  provider_subscription TEXT CHECK (provider_subscription IS NULL OR length(provider_subscription) <= 255),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX entitlements_subject ON entitlements(subject_type, subject_id);
CREATE UNIQUE INDEX entitlements_subscription ON entitlements(provider, provider_subscription) WHERE provider_subscription IS NOT NULL;
CREATE INDEX entitlements_customer ON entitlements(provider, provider_customer) WHERE provider_customer IS NOT NULL;

-- Idempotency: one row per provider event id applied (or deliberately
-- ignored). Recorded in the same transaction as its effect, so a failed apply
-- is retried by the provider and a repeated delivery changes nothing. No
-- payload is stored.
CREATE TABLE billing_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 255),
  type TEXT NOT NULL CHECK (length(type) <= 100),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied','ignored')),
  received_at TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);
