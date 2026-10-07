# Billing runbook (paid plans: Plus and Team)

The code for paid plans is in place but switched off. Every step below is
**OWNER-GATED**: it involves a payment account, live keys, tax, legal text or
production infrastructure, so only the owner does it. No agent creates
products, keys, webhooks or deploys.

## What the code does today

- **Hub** (`board/hub/billing/`): checkout and portal links, the signed webhook
  `POST /api/billing/webhook`, the `entitlements` and `billing_events` tables
  (migration `060_entitlements.sql`), Team seats capping membership, and
  `GET /api/entitlement` (an Ed25519-signed token, `exp = paid period end + 14 days`).
  With no `BOARD_BILLING_PROVIDER` set, the billing routes answer `METHOD_DISABLED`
  and the webhook is not a route.
- **Web** (`/billing`): plan, seats used / paid, Subscribe, Manage billing.
- **Desktop** (`src/entitlement-refresh.js`, Plan & billing page): asks the
  signed-in hub once a day and on sign-in. `src/entitlement-keys.js` is
  **empty**, so every install stays free until a key is pinned.
- **Card data:** never stored. Only the provider's customer and subscription
  ids, plan, seats, status and period end are kept.

## Owner-gated steps, in order

1. **Choose Stripe or a Merchant of Record.** Plexiform sells from a South
   African entity to customers worldwide. With Stripe direct, Plexiform is the
   seller and must register for and remit VAT/GST/sales tax where thresholds
   are met (EU OSS, UK, US states, etc.) and handle SA VAT. Stripe Tax helps
   with calculation, not registration. A Merchant of Record (Paddle, Lemon
   Squeezy) becomes the seller and handles global tax, at a higher fee (about
   5% + $0.50 against about 2.9% + $0.30). The architecture plan recommends an
   MoR. If you choose an MoR, a `board/hub/billing/<provider>.js` with the same
   interface as `stripe.js` is added and registered in `entitlements.js`
   `PROVIDERS` (a code task, not an owner step).
2. **Create the products and prices** in the provider's dashboard, in test
   mode first:
   - Plus: $5 per month (`BOARD_BILLING_PRICE_PLUS_MONTH`)
   - Plus: $48 per year (`BOARD_BILLING_PRICE_PLUS_YEAR`)
   - Team: $15 per seat per month, quantity-based (`BOARD_BILLING_PRICE_TEAM_MONTH`).
     Optionally a yearly Team price (`BOARD_BILLING_PRICE_TEAM_YEAR`).
   - Turn on the customer portal: allow cancellation (at period end), card
     updates, invoice history, and seat-quantity changes for Team.
   - Configure dunning (smart retries). The desktop keeps a paid plan for 14
     days past the last paid period, so retries should finish within that window.
3. **Create the webhook endpoint** `https://app.plexiform.dev/api/billing/webhook`
   with these events: `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
   Put its signing secret in the hub env as `BOARD_BILLING_WEBHOOK_SECRET`, and
   the secret API key (a restricted key that can create Checkout and portal
   sessions is enough) as `BOARD_BILLING_API_KEY`. Set `BOARD_BILLING_PROVIDER=stripe`.
   Keep both secrets in the root-only env file, never in git.
4. **Generate and pin the entitlement signing key.** On the hub host:
   `node board/hub/scripts/gen-entitlement-key.mjs --out /etc/buddy-hub/entitlement-key.pem`
   (outside the repo; mode 0600; it refuses to overwrite). Set
   `BOARD_ENTITLEMENT_KEY_FILE` to that path. Paste the printed **public** key
   into `src/entitlement-keys.js` and ship it in a desktop release. Back up the
   private key offline: losing it means a new key and a new desktop release.
   Rotation: add the new public key next to the old one in a release first,
   then switch the hub's file.
5. **Deploy the hub migration to the Pi** (`app.plexiform.dev`): deploy the
   hub build that contains `060_entitlements.sql`. Migrations run at start.
   Check `schema_migrations` has version 60 and `GET /api/health` is OK.
6. **Check that Litestream covers the new tables.** Litestream replicates the
   whole `board.db`, so `entitlements` and `billing_events` are included. Prove
   it: restore the latest replica to a scratch path and check that both tables
   are there with the expected rows.
7. **Legal and privacy.** Fill the `[Callum to confirm …]` placeholders in
   `PRIVACY.md` (processor entity and country, transfer basis, retention), and
   publish Terms of Service and a refund policy (the plan suggests no-questions
   refunds in the first 14 days).
8. **Test mode end to end.** Use test keys and prices on a staging hub. Buy
   Plus with a test card, check that `/billing` and the desktop Plan & billing
   page show Plus, cancel in the portal and check access lasts to the period
   end, and fail a renewal with a test card to check dunning. Buy Team with N
   seats and check that inviting member N+1 is refused.
9. **Switch from test to live.** Create the live products, prices and
   webhook, swap in the live key, secret and price ids, restart the hub, and
   make one real low-value purchase and refund it.

## Not done in code yet (follow-ups)

- **Account deletion with an active subscription.** It should cancel the
  subscription at the provider first. Today it soft-deletes the user and
  leaves the entitlement row and the subscription in place.
- **Team plan changes.** These need owner role only. The design's step-up
  (fresh email code) for plan changes is not enforced on checkout or portal;
  payment on the provider's page is the confirmation.
- **The Team yearly price** is optional, and the web page offers monthly
  only.
