# Writing a connector

A connector is one ESM module under `hub/integrations/<id>/index.js` that
default-exports `defineConnector({...})` (see `connector.js` for the full
shape, and `fake/index.js` for a complete, tested example). Add it to
`connectorsFor()` in `index.js`.

The registry (`registry.js`) does everything around it. **Don't re-implement
these in a connector:**

| Concern | Where it lives |
|---|---|
| Sealing tokens/secrets | `createConnection({secrets})` → vault (AES-256-GCM, key never in the DB, D41). Read them with `ctx.secret(kind)`. Declare every kind in `secrets: [...]`. |
| Webhook ingress | `POST /integrations/<connection id>/webhook`: unknown/inactive connection → 404 before the body is read; an IP (an IPv6 client's /64) that keeps failing signatures or sending bodies over 1 MiB → 429 before the body is read; raw body ≤ 1 MiB; the per-connection rate limit is spent only by verified deliveries that are not duplicates. Your `verify()` must check the provider signature over the **raw bytes** in constant time and return `{ok, dedupe_key}`. Bad signature → 401 + a warning log (and the caller's IP spends a small failure budget); nothing runs. |
| Timestamps | If the provider signs a timestamp, `verify()` **must** enforce a window (Slack: `X-Slack-Request-Timestamp` within ±5 min of `now`) so a captured request can't be replayed after its dedupe row is swept. |
| Replay protection | Each delivery is keyed twice in `inbound_dedupe`: `<connection>:<dedupe_key>` and `<connection>:body:<sha256 of the raw body>`, so a captured signed request replayed under a new (unsigned) delivery id is still a duplicate, and identical raw bodies on one connection within 30 days count as one delivery. **Your `verify()` must return a `dedupe_key` that covers signed content** (an event id from the signed body) **or a signed timestamp** where the provider gives one, not only an unsigned delivery header. A finished duplicate spends no `webhook_conn`. The registry leases both keys while your handler runs: a concurrent duplicate gets `in_progress`, a finished one `duplicate`; a failed handler releases it so the provider's retry runs; a handler that timed out keeps it until the lease ends (it may still be running). Rows are kept 30 days. |
| Idempotency | Neither the dedupe row nor the D8 `request_id` cache (in memory, 10 minutes, lost on restart) is durable idempotency. Handlers **must** be idempotent through links: check `ctx.linked(kind, externalId)` before creating, and link what you create. |
| Board events | `consumes: [journal kinds]` + `onEvent(row, ctx)`, via the bus: one consumer per connection (a failing connection never blocks another team's), at-least-once, in order, retried with backoff, dead-lettered after 8 failures (≈ 3 min). Only rows of boards of the connection's own team reach it (never hub-wide rows). Be idempotent. |
| Timeouts | `handleWebhook` and `onEvent` fail after 60 s. `ctx.signal` aborts when the handler ends (returns, throws or times out; `ctx.fetch` uses it; check it in long work): after that `ctx.act`, `ctx.fetch` and `ctx.system.event` throw `this handler has ended`, so a `ctx` kept past its handler is dead. The bus never runs a row again while its timed-out call is still running; if that call later succeeds, the row counts as done (not run again); a call that never ends is dead-lettered (`handler_stuck`) after 30 busy retries (≈ 25 min), and the next row runs. |
| Acting on the board | Only inside `ctx.act(action, meta, async (s) => …)`: `s.actAs(memberId)` → `createCard / comment / action`, the same Api methods, rate limit and D8 `request_id` replay cache as the web (ids are namespaced per connection). Every call **requires** a stable `request_id` derived from the external id. `s.link(cardId, kind, externalId, url)` links a card of your team (there is no `ctx.link`). The scope, and every handle `actAs` returned, stops working once `run` returns; a call `run` started without awaiting is awaited before `act()` returns (if it fails, the action is `failed`), so nothing lands after the scope closed; each call re-checks the member. `actAs` takes only `ctx.connection.created_by` or a member linked from this workspace in `external_identities`, with at most `member` rights. `action` allows only `cancel`, `stop` and `approve_done` (the last only inside an act() action you declared `ask`); everything else — dispatch, retry, take over, hand over, request changes, answer — is `POLICY_DENIED`. `createCard` ignores `budget_usd` (a budget stays a person's call) and labels the card `via:<your connector id>` (any `via:` label you pass is dropped): the web shows it as a "via <id>" badge and the agent's envelope source says `via <id>`. `comment` refuses `for_agent: true`; your comments are `source: 'integration'`, untrusted, and never reach an agent. Answering a permission request is refused. |
| Autonomy + audit | Declare each action with its default in `actions` (`auto` for facts; `ask` for anything that speaks for a person, writes externally or touches production). Admins can change it per connection. `auto` is audited `attempted` → `auto` or `failed` (+ short code). `detail`/`undo` keep scalars and ids only (≤ 2 KB). |
| Who did it | Permission checks use the member you act as (usually `ctx.connection.created_by`); the journal records `actor_kind: 'integration'` with your connection id, and the feed names your connector. If that member is removed or becomes a viewer, the webhook answers 200 and health says `actor_unavailable` until an admin reconnects. |
| PR ↔ card links | Only from branches or PRs the board created (`shared/fence.js` `branchName()` → `board/<KEY>-r<fence>`), matched exactly. **Never** from free text such as "Fixes BDL-12" in a title or body: anyone who can open a PR could then move any card. |
| System facts | `systemEvents` + `ctx.system.event(type, {kind, external_id, pr, by})` for a card linked to this connection. `pr` must be an integer, `by` a GitHub login (else dropped). **Never call it from inside a `withBoard` callback on the same board** (it waits on that queue: deadlock; the hub throws instead). |
| HTTP out | Declare `hosts: ['api.example.com']` (exact hostnames, https only). `ctx.fetch(url, init)` refuses any other host, follows one same-host redirect at most, 10 s timeout, retries 5xx/429 honouring `Retry-After`, records health. `connect.exchange` / `verifyToken` get the same restricted fetch. |
| Health and errors | Health keeps a short code (members can read it). Your error messages are logged redacted and never shown to users, so don't bother making them friendly — and never put secrets in them. |

**Never** journal or audit secrets, tokens or external message text (D41): ids and short
labels only. **Never** trust identity from a payload field: map external users to
members only through a verified link (`external_identities`) or a rule approved in review.

**Connections** are per team: two teams may connect the same external workspace, each with
its own secrets and webhook URL (whether the provider allows a second install is up to
the provider). OAuth `state` is bound to the browser that consents: the callback refuses
unless the bind cookie set by `POST …/start` comes back: `__Host-board_int_<provider>` (`Path=/`,
`Secure`) on an https hub, `board_int_<provider>` (`Path=/integrations/`) on an http dev/local hub.
Inside the desktop shell only, the web passes the bind in the connect window's name and the app
sets the cookie in its connect window; a browser tab gets `_blank` and uses the cookie it has (D42).

Tests: follow `hub/test/integrations-registry.test.js` and
`hub/test/integrations-security.test.js`. Every connector needs a forged-signature test,
a stale-timestamp test where the provider signs one, and recorded-fixture tests for each
webhook it handles.
