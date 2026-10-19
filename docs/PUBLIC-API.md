# Public API and outbound webhooks (v1)

Other tools can read a team's boards and cards with an **API token**, and the team hub can tell them when something changes with **webhooks**. Both need an accounts-mode hub (`BOARD_AUTH=accounts`). Only a team **owner or admin** can manage them, from **Integrations → API and webhooks** in the web app or through the management routes below.

Code: `board/hub/public-api/` (`index.js` routes, `tokens.js`, `webhooks.js`, `ssrf.js`). Tables: migration `070_public_api.sql`. Web panel: `board/web/js/render-api.js` and `api-panel.js`.

## Contents

1. Authentication and scopes
2. Read and comment endpoints
3. Errors and rate limits
4. Webhooks: registering, delivery, retries
5. Event schemas
6. Verifying a signature (Node, Python)
7. Management routes
8. What is logged and audited

## 1. Authentication and scopes

An API token looks like `plx_pat_` followed by 43 URL-safe characters. Send it as a bearer token:

```
Authorization: Bearer plx_pat_…
```

The public API ignores cookies, sessions and desktop device tokens. Only an API token works there.

- **Shown once.** The hub stores only the token's SHA-256 and its last four characters (the "hint"). If a token is lost, revoke it and create a new one.
- **Team-bound.** A token sees only the boards of the team it was made in. Ids from any other team answer `404`.
- **Acts as its maker.** A token acts as the owner or admin who created it. It stops working (`401`) when that member leaves the team or their account is deleted. A comment posted with it is authored by that member.
- **Expiry.** Each token expires 1 to 365 days after creation (default 90). There is no refresh, so create a new token before the old one expires.
- **Revocation.** A revoked token is refused immediately.
- **Limit.** A team can have at most 25 live tokens (not revoked and not expired).

| Scope | Allows |
|---|---|
| `read:boards` | `GET /boards` |
| `read:cards` | `GET /boards/:id/cards`, `GET /cards/:id`, `GET /cards/:id/events` |
| `write:cards-comment` | `POST /cards/:id/comments`. The token's maker must still be able to edit the board, so a maker who became a viewer gets `403`. |

A request that needs a scope the token does not have answers `403` with `"reason": "SCOPE"`.

## 2. Read and comment endpoints

All paths are under `/api/public/v1`. Every response carries `Plexiform-Api-Version: 1` and `Cache-Control: no-store`. Version 1 changes only by adding fields; anything incompatible becomes `/v2`.

### `GET /boards`

```json
{ "boards": [{ "id": "…", "name": "Product", "key_prefix": "PRD", "archived_at": null }] }
```

Archived boards are left out unless you add `?include_archived=1`.

### `GET /boards/:board_id/cards?limit=&cursor=&include_archived=1`

Cards are returned oldest first. `limit` can be 1 to 200 (default 100). To get the next page, pass the previous answer's `next_cursor`. `next_cursor` is `null` on the last page. Card descriptions are not included in this list.

```json
{ "cards": [{ "id": "…", "board_id": "…", "key": "PRD-12", "title": "…", "column": "in_progress",
              "run_state": "running", "labels": ["bug"], "created_at": "…", "updated_at": "…", "archived_at": null }],
  "next_cursor": "WyIyMDI2LTEwLTAx…" }
```

`column` is one of `todo`, `in_progress`, `in_review` or `done`. `run_state` is `null` when the card has no run, and otherwise a hub run state (`queued`, `running`, `blocked`, `failed`, `in_review`, `done`, …).

### `GET /cards/:card_id`

Returns the same fields as the list, plus `body` (the card's goal) and `acceptance`:

```json
{ "card": { "id": "…", "key": "PRD-12", "title": "…", "body": "…", "acceptance": null, "column": "todo", "…": "…" } }
```

### `GET /cards/:card_id/events?after_seq=&limit=`

The card's history, oldest first. Payloads are never included.

```json
{ "events": [{ "seq": 412, "at": "2026-10-01T09:00:00.000Z", "kind": "card.create", "actor_kind": "member", "types": ["card.created"] }],
  "next_after_seq": 412 }
```

- `kind` is the hub's internal journal kind. New kinds may appear at any time.
- `types` lists the public event types (section 5) that this row corresponds to. It can be empty.
- To page through the history, pass `next_after_seq` as `after_seq`.

### `POST /cards/:card_id/comments` (needs `write:cards-comment`)

```
Content-Type: application/json

{ "body": "Build 42 passed", "request_id": "optional, ≤ 100 chars" }
```

→ `{ "comment": { "id": "…", "card_id": "…", "author_member_id": "…", "created_at": "…" } }`

- The body can be at most 10,000 characters. The whole request can be at most 16 KiB.
- Retrying with the same `request_id` within a few minutes returns the first answer and does not create a second comment.
- Comments made through the API are never addressed to a running AI agent.
- Archived cards and archived boards are refused with `409`.

## 3. Errors and rate limits

Errors use the hub's normal error shape: `{ "error": { "code": "…", "message": "…", … } }`.

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION` | Bad query, cursor or body |
| 401 | `UNAUTHENTICATED` | The token is missing, malformed, unknown, expired or revoked, or its maker left the team. The response includes `WWW-Authenticate: Bearer`. |
| 403 | `FORBIDDEN` | The token lacks a scope (`reason: SCOPE`), or its maker can no longer write |
| 404 | `NOT_FOUND` | Unknown route or id, or an id from another team |
| 429 | `RATE_LIMITED` | See below. Includes `Retry-After` and `retry_after_s`. |

Rate limits:

- **Per token:** 120 requests per minute, refilled continuously.
- **Per client network:** 30 failed authentications per minute (per /64 for IPv6). Once that is exceeded, even a good token from that network gets `429` until the limit refills.
- **Comments** also count against the maker's normal write limit.

## 4. Webhooks

### Registering an endpoint

An admin registers an endpoint with:

- an endpoint URL,
- the event types to send (`card.created`, `card.moved`, `card.commented`, `run.finished`, `review.requested`),
- whether to **include card text**. This is off by default.

The hub then shows a signing secret (`whsec_…`) **once**. The hub stores it sealed with its encryption key, so a hub without `BOARD_ENC_KEY` refuses to register webhooks. A team can have at most 10 endpoints.

### Which URLs are accepted

The URL must use `https`. It must not contain a user name, password or fragment. It must name a public host, so `localhost`, `*.localhost`, `*.local` and `*.internal` are refused.

The hub resolves the host when the endpoint is registered and again before **every** attempt. Every address the host resolves to must be public. The hub refuses:

- loopback (`127.0.0.0/8`, `::1`)
- private ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`)
- link-local, including cloud metadata (`169.254/16`, `fe80::/10`, `fd00:ec2::254`)
- carrier-grade NAT (`100.64/10`)
- unspecified, multicast, documentation, benchmarking and reserved ranges
- IPv4-mapped and NAT64 forms of any of these

The hub then connects to the address it checked, sending the original host for SNI and in the `Host` header. A second DNS answer cannot redirect the request to an internal address.

### Delivery

Each delivery is an HTTP `POST` with a JSON body and these headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Plexiform-Webhooks/1` |
| `Plexiform-Event` | the event type |
| `Plexiform-Delivery` | the event id. It is the same on every retry, so use it to ignore duplicates. |
| `Plexiform-Timestamp` | unix seconds when this attempt was signed |
| `Plexiform-Signature` | `v1=` + hex HMAC-SHA256 of `"<timestamp>.<raw body>"`, keyed with the whole secret string |

- **Success:** any `2xx` answer within **5 seconds**. The response body is never read.
- **Redirects are not followed.** A `3xx` answer counts as a failure (`redirect_refused`).
- **Retries:** a failed delivery is tried up to **6 times** in total. The waits between attempts are 10 s, 1 min, 5 min, 30 min and 2 h.
- **Disabling:** after the 6th failure, the hub turns the endpoint off (`disabled_reason: "failing"`), marks its other pending deliveries as failed and writes a `webhook.disabled` audit row. An admin turns it back on with `PATCH … {"enabled": true}` or the **Turn on** button.
- **Ordering:** delivery is at least once and is not strictly ordered. Use the event `id` to drop duplicates and `created_at` to put events in order.
- **Test event:** **Send test event** sends one `webhook.test` event straight away. It is logged, but it is never retried and never turns the endpoint off.

### Delivery log

The hub keeps the last 50 finished deliveries per endpoint. Each entry has the event type, state, attempt count, HTTP status, an error code (`timeout`, `connect_failed`, `address_refused`, `redirect_refused`, `bad_status`, `no_key`, `endpoint_disabled`) and latency. A payload is deleted once its delivery has finished.

## 5. Event schemas

Every event has this envelope:

```json
{
  "id": "6f1c…",                     // idempotency key, same as Plexiform-Delivery
  "type": "card.moved",
  "created_at": "2026-10-01T09:00:00.000Z",
  "team_id": "…",
  "data": {
    "board": { "id": "…", "name": "Product" },
    "card":  { "id": "…", "key": "PRD-12", "title": "…", "column": "in_review", "run_state": "in_review" }
  }
}
```

By default, an event contains only ids, the board name, the card key and title, the column and the run state. When the endpoint has **include card text** on, `data.card.body` is added, and for `card.commented`, `data.comment.body` too.

| Type | Sent when | Extra `data` |
|---|---|---|
| `card.created` | a card is created (by a person, a run, a workflow or an integration) | none |
| `card.moved` | a card's column changes, either by an edit or because of its run | `from_column`, `to_column` |
| `card.commented` | a comment is added | `comment: { id }` |
| `run.finished` | an agent run ends | `run: { id, outcome, end_reason }`. `outcome` is the card's state after the run, for example `in_review`, `failed` or `parked`. |
| `review.requested` | an AI review of a finished run is queued | `review: { id }` |
| `webhook.test` | **Send test event** | `{ endpoint_id }` only (no board or card) |

## 6. Verifying a signature

Before you parse the body, check:

- the signature, computed over the **raw** body bytes,
- that the timestamp is recent (for example within 5 minutes),
- that you have not already processed this `Plexiform-Delivery` id.

**Node.js**

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret, headers, rawBody, toleranceS = 300) {
  const ts = headers['plexiform-timestamp'];
  const got = String(headers['plexiform-signature'] ?? '');
  if (!/^\d+$/.test(ts ?? '') || Math.abs(Date.now() / 1000 - Number(ts)) > toleranceS) return false;
  const want = 'v1=' + createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex');
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
```

**Python**

```python
import hashlib, hmac, time

def verify(secret: str, headers: dict, raw_body: bytes, tolerance_s: int = 300) -> bool:
    ts = headers.get("plexiform-timestamp", "")
    got = headers.get("plexiform-signature", "")
    if not ts.isdigit() or abs(time.time() - int(ts)) > tolerance_s:
        return False
    want = "v1=" + hmac.new(secret.encode(), ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(got, want)
```

## 7. Management routes

These routes are for a signed-in **owner or admin** of the team in the URL. They use a cookie session (with `X-CSRF-Token`) or a desktop device token. Everyone else gets `403`. A team the caller is not in, or ids from another team, give `404`.

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/teams/:team_id/api-tokens` | | `{ tokens, scopes }` |
| `POST /api/teams/:team_id/api-tokens` | `{ name, scopes, expires_days? }` | `{ token, secret }`. The secret is shown once. |
| `DELETE /api/teams/:team_id/api-tokens/:token_id` | | `{ token }` (revoked) |
| `GET /api/teams/:team_id/webhooks` | | `{ endpoints, event_types }` |
| `POST /api/teams/:team_id/webhooks` | `{ url, events, include_text? }` | `{ endpoint, secret }`. The secret is shown once. |
| `PATCH /api/teams/:team_id/webhooks/:endpoint_id` | `{ events?, include_text?, enabled? }` | `{ endpoint }` |
| `DELETE /api/teams/:team_id/webhooks/:endpoint_id` | | `{ ok }`. The secret and delivery log are erased. |
| `GET /api/teams/:team_id/webhooks/:endpoint_id/deliveries` | | `{ deliveries }` (latest 50) |
| `POST /api/teams/:team_id/webhooks/:endpoint_id/test` | | `{ delivery }`. Limited to 10 per minute per admin. |

A token has the fields `id`, `name`, `hint`, `scopes`, `created_at`, `expires_at`, `last_used_at` and `revoked_at`. An endpoint has `id`, `url`, `events`, `include_text`, `enabled`, `disabled_at`, `disabled_reason`, `created_at` and `updated_at`.

## 8. What is logged and audited

Audit rows go in the hub's `audit` table, with the team's `org_id`:

- `api_token.create` (name, scopes, expiry) and `api_token.revoke`
- `api_token.use`: written at most once an hour per token, with the route name. Every request also updates `last_used_at`.
- `webhook.create` (host, events, include_text), `webhook.update`, `webhook.delete` and `webhook.test`
- `webhook.disabled`, written with actor `system` when an endpoint is turned off after repeated failures

Tokens, secrets and payloads are never logged. For the privacy side, see the "Outbound webhooks and the public API" entry in `PRIVACY.md`.
