# Messages and handoffs (contract v1, frozen)

Owner: lane M1. Code: `board/hub/messaging.js` (hub), migration `050_session_messaging.sql`,
`src/session-messaging.js` (Mac receiver glue + client API). UI is lane V1's.
Accounts mode only. Status: implemented and proven LOCALLY (in-process hub, fake
Codex app-server). No deployed hub or real provider acceptance yet.

## 1. What this is, and is not

One provider-neutral way for a person, or a permitted AI session, to send an explicit,
task-linked message (or a handoff) to a person or to one selected session, and see real
receipts: queued → delivered → replied, or rejected / expired / outcome_unknown.

- A message is **untrusted task data**. It is never human approval, never authorization,
  never a permission answer. `grants_execution` and `approval` are always `false`.
- A message is **not** start-work, steer, interrupt, permission or ownership change. The
  receiver only delivers into an **idle** current turn as a new turn. It never steers a busy
  turn and never interrupts; a busy session leaves the message queued until it expires.
- **Routing never invokes a model.** People-to-people messages never reach a model.
- Never exactly-once. Delivery is at-least-once to the receiver, which dedupes by message id
  and by `(source user, request_id)`. A side effect whose outcome is not known is reported
  as `outcome_unknown` and is **never retried**.

## 2. Participants and authority

| Participant | Proven by | Notes |
|---|---|---|
| Signed-in human | hub credential (desktop device token or web cookie+CSRF) | `source.user_id` is derived from the credential, never from the body |
| Enrolled device | `user_devices` row, not revoked | a host device must have opted in (`interaction_role = 'host'`, migration 048) |
| Provider session | a **target** registered by its own host device | target id is opaque; bound to `(host device, session, generation)` |
| Child agent | not addressable in v1 | reported by the parent's provider adapter later (lane P3) |

Display names, session labels and provider labels are **self-declared display only**; they
never grant access and never route. Ownership (`user_id`, `host_device_id`) and scope come
from hub rows.

**Targets.** A host device declares, by full sync, which of *its own* Plexiform-owned
sessions are messageable (`PUT /host/targets`). Each gets an opaque `target` id bound to
`(host_device_id, session, generation, scope, org_id)`. A new generation, a scope change,
an un-share or the session disappearing **retires** the target; queued messages for it are
`rejected` (`target_replaced` / `unshared`) and are **never** moved to a replacement, even one
with the same label or folder.

**Scope.**
- `personal`: only the owning user (any of their devices) may message it. Team membership
  does not expose it.
- `team` (`org_id` set by the owner, explicitly per session): any **active member** of that
  team may message it, while the owner is also still an active member. Team creation never
  shares a session. (Lane *team-sharing* owns the share UX/records; when its share table
  lands, the host derives `scope/org_id` from it. This contract does not change.)

**Person destinations** require a team (`org_id`) in which both sender and recipient are
active members, at send and again at every read/receipt.

## 3. Message DTO (hub → clients)

```
{ id, request_id, kind: 'message'|'handoff', conversation_id, reply_to, caused_by,
  card_id, org_id,
  source: { kind: 'person'|'session', user_id, name, target?, provider?,
            identity_source: 'hub_credential'|'hub_host_device' },
  to:     { kind: 'person'|'session', user_id, name, target?, provider? },
  body,                     // sender and recipient only
  state: 'queued'|'delivered'|'replied'|'rejected'|'expired'|'outcome_unknown',
  reason,                   // machine reason for rejected/expired/outcome_unknown/turn end
  response, response_source: 'provider_reported'|null,   // never a success claim
  handoff: { brief, card_refs, artifacts, state: 'offered'|'accepted'|'declined'|'expired', report } | null,
  hop, authority_version, created_at, expires_at, delivered_at, replied_at,
  grants_execution: false, approval: false }
```

`authority_version` = the target generation the message was accepted against (0 for people).

`reason` values (stable): `expired`, `sender_revoked`, `sender_removed`, `recipient_removed`,
`account_gone`, `card_gone`, `not_permitted`, `automation_off`, `target_replaced`, `target_gone`,
`unshared`, `device_revoked`, `hosting_off`, `owner_removed`, `owner_gone`, `source_<any of these>`,
`receiver_<reason>` (reported by the receiver, e.g. `receiver_duplicate`), `receiver_lost` (lease
lapsed after `accepted` ⇒ `outcome_unknown`), `busy` (still queued), `turn_<interrupted|failed>`.
A viewer who lost access reads `response: null` (or 404 for a person recipient who left the team).

Bounds: body ≤ 4000 chars / 8 KiB, no control chars except `\n\t`; response ≤ 16000 chars;
handoff brief ≤ 4000, ≤ 8 card refs, ≤ 16 artifacts (`{kind:'path', path}` relative, private
segments refused); `ttl_s` 10…86400 (default 3600) for sessions, ≤ 7 days for people.
Queues: ≤ 32 queued per target, ≤ 64 queued per sender, ≤ 200 unread per person; ≤ 16 live
targets per host device.

## 4. Endpoints (`/api/messaging/v1`, accounts mode, JSON)

People (any signed-in credential):

| Method + path | Body | Result |
|---|---|---|
| `GET /targets` | – | `{targets:[{target, scope, org_id, card_id, provider, label, label_source:'self_declared', owner:{user_id,name}, mine, online, accepts_sessions}]}` – own personal + team-shared in my teams only |
| `POST /messages` | `{request_id(uuid), to:{target}|{user_id, org_id}, body, kind?, card_id?, conversation_id?, reply_to?, ttl_s?, handoff?:{card_refs?, artifacts?}}` | `{message}` – persisted (state `queued`) before this returns. Same `request_id` + same content → the same message (dedupe); different content → 409 |
| `GET /messages?box=sent|inbox&limit=` | – | `{messages}` (newest first, ≤ 50) |
| `GET /messages/:id` | – | `{message}`; sender or recipient only, re-validated (else 404) |
| `POST /messages/:id/receipt` | `{state:'delivered'}` | person recipient marks delivered |
| `POST /messages/:id/handoff` | `{decision:'accept'|'decline', report?}` | person recipient decides a handoff |

Host device (desktop token, host role, only for its own targets):

| Method + path | Body | Result |
|---|---|---|
| `PUT /host/targets` | `{targets:[{session, generation, provider, label?, scope, org_id?, card_id?, automation?}]}` | `{targets:[{session, generation, target}]}`; full sync, absent ⇒ retired |
| `POST /host/pull` | `{wait_ms?: 0…20000}` | `{messages:[{…DTO, lease, session, generation}]}` (≤ 8), long-poll when empty |
| `POST /host/messages/:id/report` | `{lease, phase, reason?, response?, turn?, decision?, report?}` | `{state, proceed?}` |
| `POST /host/send` | `{request_id, from:{session, generation}, to, body, kind?, card_id?, caused_by?, handoff?}` | `{message}` from that session |

Report phases (the receiver's receipts):
`accepted` (passed host checks, about to inject; hub re-validates and answers `proceed`)
→ `delivered` (provider acknowledged a turn for that exact session/generation; also accepted
late, replacing `outcome_unknown`, since it is the real acknowledgement)
→ `replied` (`response`, provider-reported) or `turn_ended` (`turn`: interrupted/failed).
`not_sent` (host certifies no side effect, e.g. busy) → back to `queued`.
`rejected` (refused before any side effect). `unknown` (side effect may have happened).
`handoff` (`decision` accept/decline + `report`) after delivery.

## 5. Delivery semantics

- **Persist before ack.** `POST /messages` commits the row and a `msg.state` journal row in
  one transaction before answering.
- **Per-destination durable queue.** `msg_messages` is the per-destination queue (ordered by
  `seq`, scoped by target / person). The bus' consumer cursors start at the journal head and
  cannot replay earlier messages, so the bus is not the delivery path; it carries the
  content-free `msg.state` / `msg.target` journal rows for projections (Board, Overview).
- **Revalidation** of sender credential (revoked device ⇒ refused), membership, team, target
  liveness (host device not revoked, still host role, same generation, owner still member),
  card visibility and expiry happens: at send; at `pull` immediately before a lease; at the
  `accepted` report (after the awaited pull); and on every read of a queued message. Failure ⇒
  `rejected` with a reason, or `expired`. The receiver re-checks its session/generation/idle
  state before `accepted` and again after it, immediately before the provider call.
- **Leases.** A pulled message is leased for 60 s. `leased` with no `accepted` ⇒ back to
  `queued` (no side effect yet; receiver dedupes). `accepted` with no outcome ⇒
  `outcome_unknown` (retained, visible, never retried).
- **Offline queue / reconnect.** Messages wait (bounded, see §3) until expiry. A reconnecting
  host re-syncs its targets (retiring anything replaced) and pulls; every queued message is
  re-validated before it is leased again.
- **Expiry.** Expired messages are never delivered; an offered handoff becomes `expired`.
- **Retention.** Message rows (with body/response) are deleted 30 days after creation, and
  at once when sender or recipient account is deleted.

## 6. Handoffs and automation

A handoff is a message with `kind:'handoff'`: `body` is the explicit public brief, plus
`card_refs` and permitted artifacts (relative paths). Never transcripts. `handoff.state`:
`offered` → `accepted` | `declined` (by the receiving person, or by the receiving session via
its host's `handoff` report) | `expired`.

Session-sourced messages (`/host/send`) are **opt-in automation** on the destination target:
`automation: {sessions:true, max_hops:1…3, turns_per_hour:1…30, parallel:1…4}` (else refused).
Hub-wide caps: 120 session-sourced messages per team per hour, 60 per card per hour. Spend is
bounded through turns (no provider cost signal exists yet). Loop suppression: `hop` counts
session-sourced forwards (a person's message is 0, a session's first message 1, then parent
`caused_by` hop + 1); `visited` = parent's visited + source target; a destination already in
`visited`, a self-send, or `hop > max_hops` is refused. The receiver defaults `caused_by` to the
message delivered into the session's current turn, so a session cannot restart the count by
omitting it there; per-target turns/hour and parallel caps bound anything else.
A session speaks only inside its own scope: a personal session only to its owner's personal
sessions; a team session only to that team's shared sessions and members.

## 7. Revocation

Member removal, team deletion, device revoke, sign-out, account deletion, hosting turned off,
session replaced (new generation), and un-share all retire pending effects: queued messages
are rejected at the next read, pull or report, and an `accepted` message whose authority
lapsed before `delivered` reports `proceed:false`. A recipient that is revoked is never
handed a response.

## 8. What other lanes use

- **V1 (Overview UI):** `createMessagingClient` from `src/session-messaging.js`
  (`targets/send/get/list/receipt/handoff/waitFor`) or the HTTP table above; show
  `label_source`, `identity_source`, `response_source`, and every state including
  `outcome_unknown`. Render body/response with textContent only.
- **P3 (providers):** implement the session-interaction adapter contract; the receiver glue
  (`createSessionMessagingHost`) is provider-neutral and only needs `hub.state/send` and
  `generation`. Expose `sendFromSession` / `decideHandoff` to a session through a scoped tool.
- **team-sharing:** feed `shares(sessionId) → {scope:'team', org_id, card_id?, automation?}`.
