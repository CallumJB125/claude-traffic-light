# Jira connector runbook (team hub)

Status: **implemented, opt-in, awaiting real provider acceptance.** The registry
already supports `BOARD_CONNECTORS=slack,sentry,linear,jira`; it defaults to
Slack/Sentry. Jira remains unadvertised until real signed deliveries and
staging card creation/update are recorded. Synthetic tests are not that evidence.

Code: `board/hub/integrations/jira/index.js` (verify, parsing, handler).
UI: `board/web/js/render-tracker.js` (intake panel), `render-integrations.js`
(action names, secret label). Tests: `board/hub/test/jira-connector.test.js`
over hand-made fixtures in `board/hub/test/fixtures/jira/`, and
`board/web/test/integrations.test.js`.

## What it does

- **Webhook only.** No OAuth (3LO) app and no API token: the connector makes
  **no** outbound request (`hosts: []`). A Jira admin creates a webhook with a
  **secret**, and pastes the same secret into the hub; it is the only
  credential and is sealed in the hub vault.
- **Signature.** `X-Hub-Signature` must be `sha256=` + the hex HMAC-SHA256 of
  the raw body under that secret (constant-time compare). The body's
  `timestamp` (signed) must be within 24 h back / 5 min ahead of the hub clock,
  else 401. Bodies with duplicate JSON keys are refused.
  `X-Atlassian-Webhook-Identifier` is unsigned and never used.
- **Cards.** `jira:issue_created` or `jira:issue_updated` for an issue that has
  no card yet, and whose status category is not *Done*, becomes one Todo card
  on the connection's target board (*New cards go to*). Deduplicated by the
  Jira issue id (durable `request_id` `jira-issue-<id>` and an `issue` link).
  The card holds a fixed template: key, scrubbed summary (links, emails,
  mentions and markup removed), project key, issue type, status, priority and
  `https://<site>.atlassian.net/browse/<KEY>` (built from the issue's own REST
  `self` URL, only on `*.atlassian.net`). Description, comments, reporter,
  assignee and the acting user are never read.
- **Status updates.** A `jira:issue_updated` whose `changelog.items` has a
  `status` item, for an issue that already has a card, adds one comment:
  "Jira status changed to <name>. This update came from Jira; it does not move
  the card or start an AI." It is untrusted, not for the agent, and keyed on
  the changelog id so retries make one comment. **It never moves the card and
  never starts an AI run** (same rule as Sentry). Other edits do nothing.
- **Limits.** 100 new cards per connection per day, plus the registry's
  hourly rules; signed duplicates are dropped.

## Hub configuration (environment)

Jira adds **no** environment variables. The hub needs what any webhook
connector needs:

| Variable | Value |
|---|---|
| `BOARD_PUBLIC_URL` | the hub's public **https** origin. The connection's Webhook URL (`<origin>/integrations/<connection id>/webhook`) is shown to admins only when it is set |
| `BOARD_ENC_KEY` or `BOARD_ENC_KEY_FILE` | the integrations vault key. `BOARD_ENC_KEY_PREVIOUS` only during a rotation |

**Cloudflare.** `POST /integrations/<connection id>/webhook` must reach the
hub without a Cloudflare Access login (Jira can't sign in; the signature is
its auth).

## Owner steps to go live (in order)

1. **Test site.** Use a Jira Cloud site (a free one is fine) with a throwaway
   project and no real customer data; the captured body becomes a committed
   test fixture.
2. **Make a secret** on your machine, e.g. `openssl rand -base64 32`
   (16–256 printable characters, no spaces). Keep it in your password
   manager only.
3. **Create the webhook** in Jira: *Settings (cog) → System → WebHooks →
   Create a WebHook* (Jira admin).
   - Name: `Plexiform test`.
   - URL: a temporary https capture endpoint you control (step 4).
   - Secret: the value from step 2.
   - Events: **Issue → created** and **Issue → updated** only. Optional JQL,
     e.g. `project = TEST`.
   - Leave *Exclude body* off.
4. **Capture one real delivery.** The capture endpoint must save the request
   body **byte for byte** and its headers. Create an issue in the test project,
   then transition it (two deliveries). Save the bodies as `created.bin` /
   `updated.bin` and the headers as JSON (must include `X-Hub-Signature`).
5. **Gate check** (offline, on your machine; the secret stays in your shell):

   ```sh
   JIRA_CHECK_SECRET='<secret>' node --input-type=module -e "
     import { readFileSync } from 'node:fs';
     import { createJiraConnector } from './board/hub/integrations/jira/index.js';
     const raw = readFileSync('created.bin');
     const headers = Object.fromEntries(Object.entries(JSON.parse(readFileSync('created-headers.json', 'utf8'))).map(([k, v]) => [k.toLowerCase(), v]));
     const ts = JSON.parse(raw).timestamp;
     const c = createJiraConnector({ now: () => ts });
     console.log(c.verify({ headers, rawBody: raw, secrets: { webhook_secret: process.env.JIRA_CHECK_SECRET } }));
   "
   ```

   `{ ok: true, … }` passes. Anything else: **stop** and investigate the
   capture or the signature header format; never adapt `verify()` to accept
   a re-serialised body. Repeat for `updated.bin`.
6. **Reviewed code change** (one PR): commit the captured bodies as fixtures
   (re-signed under a test secret in the test, never the real one), with a
   test that runs them through `verify()` and the handler; add Jira to
   `connectorsFor()`:

   ```js
   import jira from './jira/index.js';
   // …
   return config.auth === 'dev' ? [fake, gh, jira] : [gh, jira];
   ```

   and change the go-live test in `jira-connector.test.js` to expect it.
7. **Staging hub.** Deploy that build to a non-production hub. As a team
   admin: Integrations → Jira → *Connect* → paste the secret → choose *New
   cards go to* → copy the shown Webhook URL into the Jira webhook (edit its
   URL). Then check:
   - a new issue makes one Todo card; editing its summary makes none;
   - transitioning it adds one status comment; the card stays in Todo and no
     run starts;
   - a delivery signed with another secret is 401.
8. **Production.** Only after 7 passes, the owner deploys to the prod hub
   (the normal hub deploy; nothing Jira-specific), then adds `'jira'` to
   `LAUNCH_CONNECTORS` in **both** `board/web/js/connectors.js` and
   `buddy-window/connectors.js` in one commit, and releases.
9. Delete the capture endpoint and the test webhook.

## Rotate

Make a new secret, disconnect Jira in Plexiform, connect again with the new
secret, then edit the Jira webhook: new secret and the new Webhook URL (the
connection id changes on reconnect).

## Remove

A team admin disconnecting Jira deletes the secret; deliveries to the old URL
answer 404. Delete the webhook in Jira. To withdraw Jira from a hub, revert
the `connectorsFor()` line and `LAUNCH_CONNECTORS`.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Deliveries 401 | Secret differs, no secret set on the Jira webhook (no `X-Hub-Signature`), body altered in transit, or the hub clock is off by more than 5 minutes / the delivery is over 24 h old |
| Deliveries 404 | Connection disconnected, or Jira not in `connectorsFor()` |
| No cards | Target board archived or unset, the issue already in a Done category, the webhook's events or JQL exclude it, or the daily cap reached (connection Activity) |
| No status comment | The issue has no card on this connection, or the update had no status change |

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
