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
| Webhook ingress | `POST /integrations/<connection id>/webhook` (raw body ≤ 1 MiB, IP rate limit). Your `verify()` must check the provider signature over the **raw bytes** in constant time and return `{ok, dedupe_key}`. Bad signature → 401 + a warning log; nothing runs. |
| Replay protection | `inbound_dedupe` on `(connection, dedupe_key)`, recorded only after your handler succeeds (a failed handler lets the provider's retry run again). |
| Board events | `consumes: [journal kinds]` + `onEvent(row, ctx)`, via the bus (at-least-once, in order, retried with backoff, dead-lettered after 8 failures). Only rows of the connection's own team reach it. Be idempotent. |
| Acting on the board | `ctx.actAs(memberId)` → `createCard / comment / action / answerPermission`, the same Api methods, rate limit and D8 `request_id` replay cache as the web. Use a stable `request_id` derived from the external id so retries don't duplicate. |
| Autonomy + audit | Wrap every side effect in `ctx.act(action, {card_id?, external_ref?, detail?, undo?}, run)`. Declare each action with its default in `actions` (`auto` for facts; `ask` for anything that speaks for a person, writes externally or touches production). Admins can change it per connection. Everything is audited. |
| Links | `ctx.link(cardId, kind, externalId, url)` / `ctx.linked(kind, externalId)`: dedupe cards by external id. |
| HTTP out | `ctx.fetch(url, init)`: 10 s timeout, retries 5xx/429 honouring `Retry-After`, records health. |
| Health | Recorded from webhook and fetch outcomes; `health(ctx)` for an active check. |

**Never** journal or audit secrets, tokens or external message text (D41): ids and short
labels only. **Never** trust identity from a payload field: map external users to
members only through a verified link (`external_identities`) or a rule approved in review.

Tests: follow `hub/test/integrations-registry.test.js`. Every connector needs a
forged-signature test and recorded-fixture tests for each webhook it handles.
