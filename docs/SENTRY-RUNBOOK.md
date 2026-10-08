# Sentry connector runbook (team hub)

Status: **built and tested, not offered.** Sentry is in no hub's
`connectorsFor()` (`board/hub/integrations/index.js`; a test in
`board/hub/test/sentry-connector.test.js` asserts it for every auth mode), and
the signed-out pages show it as *Coming soon* (`LAUNCH_CONNECTORS` in
`board/web/js/connectors.js` and `buddy-window/connectors.js`). CONTRACT D42
addendum "the Sentry connector" sets a **go-live gate**: a real Sentry
delivery must be checked against `verify()` over its exact bytes before Sentry
is added anywhere. That gate, and enabling on any hub, is **owner-gated**.
Nothing here has been done with a real Sentry org.

Code: `board/hub/integrations/sentry/` (`index.js` verify and handler,
`events.js` issue and metric-alert parsing, `text.js` the scrub and caps).
Routing form: `board/web/js/render-sentry.js`, `sentry-settings.js`. Gate
check: `board/hub/scripts/sentry-check-delivery.mjs`.

## What it does

- **Webhook only.** An org owner/manager creates a Sentry **Internal
  Integration** and pastes its **Client Secret** into the hub. That secret is
  the webhook signing key and the only credential; the connector makes **no**
  outbound request (`hosts: []`).
- **New issues** (`issue` resource, `created`) at or above the chosen level
  become one Todo card per Sentry issue id on the routed board (title and
  culprit scrubbed and capped; the message only with *Include a redacted issue
  message*). Status changes (resolved, ignored, regressed, unresolved) add a
  comment to that card only; they never move it or start an AI.
- **Critical metric alerts** (`metric_alert` resource) create one incident
  card per alert rule per cooldown interval (default 60 minutes); later
  warning/resolved updates comment on it.
- **Routing.** An admin must save a default board; project slugs can be routed
  to other boards (up to 32). Until a default board is saved, intake is
  paused.
- **Limits.** 100 new cards per connection per day (then one notice comment
  per day), plus the registry's hourly rule; signed duplicates are dropped.

## Hub configuration (environment)

Sentry adds **no** environment variables: each team's client secret is pasted
by its admin and sealed in the vault. The hub needs:

| Variable | Value |
|---|---|
| `BOARD_PUBLIC_URL` | the hub's public **https** origin. The connection's Webhook URL (`<origin>/integrations/<connection id>/webhook`) is shown to admins only when it is set |
| `BOARD_ENC_KEY` or `BOARD_ENC_KEY_FILE` | the integrations vault key (D41). `BOARD_ENC_KEY_PREVIOUS` only during a rotation |

**Cloudflare.** `POST /integrations/<connection id>/webhook` must reach the
hub without a Cloudflare Access login (Sentry can't sign in; the signature is
its auth).

The gate script reads one variable, on the owner's machine only:

| Variable | Value |
|---|---|
| `SENTRY_CHECK_SECRET` | the test integration's Client Secret, for `sentry-check-delivery.mjs`. Never on a hub, never committed |

## Owner steps to go live (in order)

1. **Test org.** Use a Sentry org and project with no real user data (a
   throwaway project); the captured body is committed as a test fixture.
2. **Create the Internal Integration** (Settings → Developer Settings →
   Custom Integrations → *Create New Integration* → Internal):
   - Permissions: **Issue & Event: Read**. Nothing else.
   - Webhooks: **issue** (and **metric_alert** for incidents, via an alert
     rule's action). *Alert Rule Action* on if you want incident cards.
   - Webhook URL: a temporary capture endpoint you control (step 3).
3. **Capture one real delivery.** Point the Webhook URL at an https endpoint
   you control that saves the request body **byte for byte** and its headers
   (any request-capture tool you trust; not the hub, which does not have
   Sentry yet). Trigger a new issue in the test project (e.g. throw an error
   from a test app). Save the body as `body.bin` and the headers as a JSON
   object `headers.json` (must include `Sentry-Hook-Signature`,
   `Sentry-Hook-Resource`, `Sentry-Hook-Timestamp`).
4. **Run the gate check** (offline, on your machine):

   ```sh
   SENTRY_CHECK_SECRET='<client secret>' \
     node board/hub/scripts/sentry-check-delivery.mjs \
       --body body.bin --headers headers.json \
       --fixture board/hub/test/fixtures/sentry/issue-created.recorded.json
   ```

   - `OK: signature verifies…` → the fixture is written: the same bytes,
     re-signed under a fresh test secret. The real secret and signature are
     not in it.
   - `FAIL: …` → **stop.** Per the contract the connector is never adapted to
     verify a re-serialised body; investigate the capture (a proxy that
     re-encoded the body is the usual cause) or Sentry's signing.
   Repeat for `metric_alert` if incidents are wanted.
5. **Reviewed code change** (one PR): commit the recorded fixture with a test
   that runs it through `verify()` and the issue handler; add Sentry to
   `connectorsFor()`:

   ```js
   import sentry from './sentry/index.js';
   // …
   return config.auth === 'dev' ? [fake, gh, sentry] : [gh, sentry];
   ```

   and change the go-live test in `sentry-connector.test.js` to expect it.
6. **Staging hub.** Deploy that build to a non-production hub. As a team
   admin: Integrations → Sentry → paste the Client Secret; copy the shown
   Webhook URL into the integration; save a default board (and routes). Then:
   - a new issue makes one card; a second event of the same issue makes none;
   - resolving it in Sentry adds a status comment, card not moved;
   - a critical metric alert makes one incident card per cooldown interval;
   - deliveries signed with another secret are 401.
7. **Production.** Only after 6 passes: deploy to the prod hub, then add
   `'sentry'` to `LAUNCH_CONNECTORS` in **both** `board/web/js/connectors.js`
   and `buddy-window/connectors.js` in one commit, and release.
8. Delete the capture endpoint and rotate (or delete) the test integration's
   secret.

## Rotate

Rotate the Client Secret in Sentry, then disconnect and connect again with
the new one (rotate first, so old signed requests can't be replayed to the new
connection).

## Remove

A team admin disconnecting Sentry deletes the secret; deliveries to the old
URL answer 404. Delete the Internal Integration in Sentry. To withdraw Sentry
from a hub, revert the `connectorsFor()` line and `LAUNCH_CONNECTORS`.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Deliveries 401 | Client Secret differs from the pasted one, or the body was altered in transit |
| Deliveries 404 | Connection disconnected or still pending, or Sentry not in `connectorsFor()` |
| No cards | No default board saved, the board archived, the issue below *Minimum severity*, or the daily cap reached (connection Activity) |
| Incident paused | The alert's projects route to different boards |
| Log `sentry webhook timestamp is far from the hub clock` | Informational only; the hub clock or Sentry's is off by over a day |
