# Linear connector runbook (team hub)

Status: **implemented, opt-in, awaiting real provider acceptance.** The registry
already supports `BOARD_CONNECTORS=slack,sentry,linear,jira`; it defaults to
Slack/Sentry. Linear remains unadvertised until real signed deliveries and
staging card creation/update are recorded. Synthetic tests are not that evidence.

Code: `board/hub/integrations/linear/index.js` (verify, parsing, handler).
UI: `board/web/js/render-tracker.js` (intake panel), `render-integrations.js`
(action names, secret label). Tests: `board/hub/test/linear-connector.test.js`
over hand-made fixtures in `board/hub/test/fixtures/linear/`, and
`board/web/test/integrations.test.js`.

## What it does

- **Webhook only.** No OAuth app and no API key: the connector makes **no**
  outbound request (`hosts: []`). An admin creates a Linear webhook and pastes
  its **signing secret** into the hub; that secret is the only credential and
  is sealed in the hub vault.
- **Signature.** `Linear-Signature` must be the hex HMAC-SHA256 of the raw
  body under that secret (constant-time compare). The body's
  `webhookTimestamp` (signed) must be within 24 h back / 5 min ahead of the hub
  clock, else 401. Bodies with duplicate JSON keys are refused.
  `Linear-Delivery` is unsigned and never used.
- **Cards.** An `Issue` `create` or `update` for an issue that has no card yet,
  and is not completed/canceled, becomes one Todo card on the connection's
  target board (*New cards go to*). Deduplicated by the Linear issue id
  (durable `request_id` `linear-issue-<uuid>` and an `issue` link), so retries,
  redeliveries and later updates never make a second card. The card holds a
  fixed template: identifier, scrubbed title (links, emails, mentions and
  markup removed), team key, status, priority and the checked
  `https://linear.app/<workspace>/issue/<ID>` link. Description, assignee,
  labels and actor are never read.
- **Status updates.** An `update` whose `updatedFrom.stateId` differs from the
  new `stateId`, for an issue that already has a card, adds one comment:
  "Linear status changed to <name>. This update came from Linear; it does not
  move the card or start an AI." It is untrusted, not for the agent, and
  idempotent across Linear's retries. **It never moves the card and never
  starts an AI run** (same rule as Sentry). Other edits do nothing.
- **Limits.** 100 new cards per connection per day, plus the registry's
  hourly rules; signed duplicates are dropped.

## Hub configuration (environment)

Linear adds **no** environment variables. The hub needs what any webhook
connector needs:

| Variable | Value |
|---|---|
| `BOARD_PUBLIC_URL` | the hub's public **https** origin. The connection's Webhook URL (`<origin>/integrations/<connection id>/webhook`) is shown to admins only when it is set |
| `BOARD_ENC_KEY` or `BOARD_ENC_KEY_FILE` | the integrations vault key. `BOARD_ENC_KEY_PREVIOUS` only during a rotation |

**Cloudflare.** `POST /integrations/<connection id>/webhook` must reach the
hub without a Cloudflare Access login (Linear can't sign in; the signature is
its auth).

## Owner steps to go live (in order)

1. **Test workspace.** Use a Linear workspace (or team) with no real customer
   data; the captured body becomes a committed test fixture.
2. **Create the webhook** in Linear: *Settings → API → Webhooks → New
   webhook* (workspace admin).
   - Label: `Plexiform test`.
   - URL: a temporary https capture endpoint you control (step 3).
   - Data change events: **Issues** only.
   - Team: the test team.
   - Save, then open the webhook and copy its **Signing secret**.
3. **Capture one real delivery.** The capture endpoint must save the request
   body **byte for byte** and its headers. Create an issue in the test team,
   then move it to another state (two deliveries: `create`, `update`). Save
   each body as `create.bin` / `update.bin` and the headers as JSON (must
   include `Linear-Signature`).
4. **Gate check** (offline, on your machine; the secret stays in your shell):

   ```sh
   LINEAR_CHECK_SECRET='<signing secret>' node --input-type=module -e "
     import { readFileSync } from 'node:fs';
     import { createLinearConnector } from './board/hub/integrations/linear/index.js';
     const raw = readFileSync('create.bin');
     const headers = Object.fromEntries(Object.entries(JSON.parse(readFileSync('create-headers.json', 'utf8'))).map(([k, v]) => [k.toLowerCase(), v]));
     const ts = JSON.parse(raw).webhookTimestamp;
     const c = createLinearConnector({ now: () => ts });
     console.log(c.verify({ headers, rawBody: raw, secrets: { webhook_secret: process.env.LINEAR_CHECK_SECRET } }));
   "
   ```

   `{ ok: true, … }` passes. Anything else: **stop** and investigate the
   capture (a proxy that re-encoded the body is the usual cause); never adapt
   `verify()` to accept a re-serialised body. Repeat for `update.bin`.
5. **Reviewed code change** (one PR): commit the captured bodies as fixtures
   (re-signed under a test secret in the test, never the real one), with a
   test that runs them through `verify()` and the handler; add Linear to
   `connectorsFor()`:

   ```js
   import linear from './linear/index.js';
   // …
   return config.auth === 'dev' ? [fake, gh, linear] : [gh, linear];
   ```

   and change the go-live test in `linear-connector.test.js` to expect it.
6. **Staging hub.** Deploy that build to a non-production hub. As a team
   admin: Integrations → Linear → *Connect* → paste the signing secret →
   choose *New cards go to* → copy the shown Webhook URL into the Linear
   webhook (edit its URL). Then check:
   - a new issue makes one Todo card; editing its title makes none;
   - moving it to *In Progress* adds one status comment; the card stays in
     Todo and no run starts;
   - a delivery signed with another secret is 401.
7. **Production.** Only after 6 passes, the owner deploys to the prod hub
   (the normal hub deploy; nothing Linear-specific), then adds `'linear'` to
   `LAUNCH_CONNECTORS` in **both** `board/web/js/connectors.js` and
   `buddy-window/connectors.js` in one commit, and releases.
8. Delete the capture endpoint and the test webhook.

## Rotate

Linear webhooks cannot rotate a secret in place: create a new webhook (new
secret), disconnect Linear in Plexiform, connect again with the new secret,
paste the new Webhook URL, then delete the old Linear webhook.

## Remove

A team admin disconnecting Linear deletes the secret; deliveries to the old
URL answer 404. Delete the webhook in Linear. To withdraw Linear from a hub,
revert the `connectorsFor()` line and `LAUNCH_CONNECTORS`.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Deliveries 401 | Signing secret differs from the pasted one, body altered in transit, or the hub clock is off by more than 5 minutes / the delivery is over 24 h old |
| Deliveries 404 | Connection disconnected, or Linear not in `connectorsFor()` |
| No cards | Target board archived or unset, the issue already completed/canceled, the webhook not subscribed to Issues, or the daily cap reached (connection Activity) |
| No status comment | The issue has no card on this connection, or the update did not change its state |

## Current capture verification tool

Store the signing secret in a private file outside the repository (0600), then run:

```sh
node board/hub/scripts/verify-connector-delivery.mjs PROVIDER create.bin headers.json /private/secret-file
```

Replace PROVIDER with the connector name in lowercase. The tool prints only a
signature verdict, byte count, body hash and times. It never prints payloads,
headers or secrets. For an archived capture, supply its independently recorded
receipt time as the final ISO argument; this is historical verification. Capture
provenance and a staging delivery with duplicate/update behavior must still be
recorded separately. Do not commit customer payloads or live signing headers.

The historical step asking for a registry code change is superseded: after
acceptance, use BOARD_CONNECTORS on staging, then production. Public advertising
is a separate launch change.
