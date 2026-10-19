# Slack connector (slice 1)

This held source slice covers connecting, verified slash commands and
interactions, `/plex help | link | todo <text>`, and the "Create Plexiform card" message shortcut, which
opens a modal and makes a card with a permalink. There's no AI and no Events API subscription.

| File | What |
|---|---|
| `webhook.js` | The pure half: v0 verify, the dedupe key, `parseBody`, `ackEarly`, workspace binding, the `response_url` allowlist, the mrkdwn escape, title cleaning, and HMAC-sealed modal metadata |
| `spec.js` | The connector spec: `ackBody`, the handlers, `connect` (prepareInputs, prepare, authorizeUrl, exchange, handshake), `identity` |
| `index.js` | `defineConnector(spec)`. slack is not in `connectorsFor()` yet |

## Framework shapes it uses (slices A, B and C, on main)

| Shape | Used as |
|---|---|
| F1 `parseBody({rawBody, headers})` | Returns `{kind, body}`, where kind is `command \| interaction \| event \| url_verification \| ssl_check`. Commands and interactivity are form-encoded (`payload=` JSON); events and url_verification are JSON. It throws on anything else, including prototype keys and Enterprise Grid |
| F2 `ackBody({payload, rateLimited})` | help and link get an ephemeral `{response_type, text}`. todo, the shortcut and block_actions get an empty ack. A modal with a missing title or board gets `{response_action: 'errors', errors}`. url_verification gets the challenge as plain text (the only answer a pending id may give). With `rateLimited` (C3) a command gets the fixed `SLOW` text, a modal submit `SLOW` as its title error, anything else an empty ack |
| F2b `ackEarly({payload})` | `true` for commands and interactions (they have a 3 s deadline and no retry), and for url_verification and ssl_check, because ackBody runs only on an early ack; `false` for events, which Slack retries |
| D97 `connect.prepareInputs`, `connect.prepare({input, fetch, webhookUrl, redirectUri, identityRedirectUri})` | Inputs `config_token, app_id, client_id, client_secret, signing_secret`. Nothing pasted → `{needs: {fields: [the four], create_url: 'https://api.slack.com/apps?new_app=1&manifest_json=…'}}`. A config token (spent on `apps.manifest.create`) or the four values → `{secrets: {client_secret, signing_secret}, settings: {app_id, client_id}, match: {app_id, client_id}}`. The manifest's `redirect_urls` are `[redirectUri, identityRedirectUri]` and its user scopes `['openid']` |
| D97 `connect.authorizeUrl({state, redirectUri, provider})`, `connect.exchange({query, redirectUri, provider, secrets, fetch})` | `provider` holds the pending `client_id` (prepare's settings; C1), `secrets` the pending `client_secret`; the admin's `config` is never read. Returns `{external_id: team.id, display_name, scopes, secrets: {bot_token}, settings: {bot_user_id}, match: {app_id: <Slack's app_id>, client_id}}`; the registry promotes only on an equal match and stores `settings.pinned` and `settings.provider` (prepare's settings, exchange's, every match key and the registry's `hub_url`) |
| D97 `connect.handshake({payload})` | `payload.kind === 'url_verification'` (our parseBody's shape) |
| D98 `identity` | `issuer: 'https://slack.com'`, `jwksUrl: 'https://slack.com/openid/connect/keys'`, `workspaceClaim: 'https://slack.com/team_id'`, `subjectRe: /^[UW][A-Z0-9]{2,20}$/`. `authorizeUrl({state, nonce, redirectUri, connection})` and `exchange({query, redirectUri, connection, secrets, fetch}) → {id_token}`; the registry verifies the id_token |
| D98 `ctx.memberFor(user)` | `member_id \| null`: linked on this connection, active and able to write. `act(…, {subject})` may act only as that member (T10) |
| C2 `ctx.linkState(user)` | `'none'` → `UNLINKED`, `'unavailable'` (linked, can't write) → `VIEWER`; after `act()` throws `ACTOR_UNAVAILABLE` or `FORBIDDEN`, `VIEWER` while still linked, else `INACTIVE` |
| C2 `onAckedFailure({payload, error_code, fetch})` | One fixed `FAILED` text to the payload's allowlisted `response_url` (none on a modal submit); nothing for `actor_unavailable`, which the handler already answered |
| C1 `ctx.hubUrl`, `configKeys` | The only link base (https only); `configKeys: ['channel_id']`; `connection.target_board_id` must explicitly name an available team board |
| C3 `rateSubject({payload})` | The Slack user id of a command or interaction, else null: the registry's `integration_user_cmd` bucket (30/min) |
| F5 `ctx.boards()`, `ctx.card(id)` | The single selected board and current card face; card key and title for replies |
| F6 `s.actAs(m).createCard(boardId, {title, body, request_id})` | Card creation |
| F8 `act('slack.create_card', {subject: <slack user>, …})` | Per-subject card limit |
| F10 `workspaceUnique: true` | One Slack workspace per hub team |

Test helpers: `hub/test/slack-shim.js`. `slack-e2e.test.js` connects through prepare → callback and links through the real identity flow.

## Security notes

- **Verify:** HMAC-SHA256 over the raw bytes of `v0:<ts>:<body>`. The timestamp must be within ±300 s in both
  directions and the signature must match `^v0=[0-9a-f]{64}$`. The compare is constant-time after a length check,
  and reasons are fixed codes. The dedupe key is `ia:<ts>:<sha256[:32]>` for form bodies, `ev:<event_id>` for
  events and `uv:` for url_verification.
- **Binding:** the workspace is the connection's `external_id` (written once, at connect), never a settings value.
  The app and client id are `settings.provider`'s, written with the row and never changed (026's trigger), which
  must agree with `settings.pinned` where it has a key and, if it names a team, name `external_id`. `config` is
  never read for any of them. `installOf()` fails closed, before anything runs: `reconnect_required` when
  `provider` is missing (a connection made before 026) or has no usable app or client id, `wrong_workspace` when
  the fixed facts contradict each other. The handler throws, so the registry audits it, records the health code,
  and `onAckedFailure` sends the one fixed `FAILED` text. Every team id in a payload (`team_id`, `team.id`,
  `view.team_id`) must equal the workspace, and every app id must equal the app id. Message shortcuts carry no
  `api_app_id` in Slack's documented shape, so there the app is bound by the signing secret alone. A mismatch throws
  `wrong_workspace`, which the registry audits and records as health (except a Slack Connect command, below).
- **Slack Connect users:** when only `user.team_id` is foreign (the workspace and app are ours), or a command's
  `team_id` is foreign but its `api_app_id` is our pinned app and there is no `enterprise_id` (commands carry no
  `user.team_id`, so a partner's names their home team), the person gets a fixed ephemeral "only members of this
  workspace can use Plexiform" through `response_url`, and the handler returns without a health failure or audit row.
- **Who is told what (C2):** unlinked (a removed member's link is deleted with them, 023) → `UNLINKED`; a linked
  member who can't write → `VIEWER`; access lost while the request ran → `INACTIVE` (or `VIEWER` if still linked).
  None names the member. The connecting member's own `ACTOR_UNAVAILABLE` (`scope: 'connection'`) is answered,
  then rethrown so the registry records `actor_unavailable` health; a member's is answered and the delivery ends
  as a success.
- **Failures after the ack (C2):** the registry marks the delivery done (a replay is a duplicate) and calls
  `onAckedFailure`, which posts the fixed `FAILED` text to the allowlisted `response_url`, never the error or input.
- **Per-user limit (C3):** `rateSubject` names the Slack user; over `integration_user_cmd` nothing runs and the
  ack says `SLOW` (a shortcut's ack can't carry text, so it is empty). The user id is only a keyed hash in memory.
- **Expired forms:** a modal submitted over an hour after it opened is answered "This form expired" in the ack
  (from the metadata's age alone) and dropped quietly by the handler. Only an HMAC mismatch, a malformed value or
  another person's metadata throws `bad_metadata`.
- **Card links:** built only from `ctx.hubUrl` (the hub's `BOARD_PUBLIC_URL` origin, read at boot), and only an
  https origin. Never from `settings.provider.hub_url` (diagnostic: the origin at connect time), `config` or a
  payload. Without one (a dev hub), replies name the card key without a link.
- **Who can act:** only `ctx.memberFor(slack user)`. A link started from Slack is never accepted (link CSRF).
- **Identity:** `identity.authorizeUrl` and `identity.exchange` take the registry's frozen `connection`
  (`{external_id, settings: {pinned, provider}}`) and use the same `installOf()`; the client id must be `settings.pinned.client_id`, the
  audience the registry checks. The authorize URL carries the registry's nonce. `exchange` returns only the
  `id_token`; the registry verifies RS256 against Slack's JWKS, `iss`, `aud`, `exp`, the nonce, the team claim equal
  to `external_id` and the subject pattern. The access token Slack also returns is dropped unused.
- **Pending handshake:** before promotion, the pending id answers only a url_verification signed with the pending
  signing secret, with the challenge (`^[A-Za-z0-9_-]{1,200}$`) as plain text; everything else is the registry's 404.
- **Credentials:** pasted or created client and signing secrets must be 32 lowercase hex characters, the client id
  `digits.digits` and the app id `A` plus 6 to 20 capitals or digits. `exchange` refuses Grid
  (`is_enterprise_install` true, 1, `'true'` or `'1'`, or an `enterprise`), a user token or any user scopes, and an
  incoming webhook.
- **Long-lived bot token:** the manifest sets `token_rotation_enabled: false`, so the bot token doesn't expire and
  there's no refresh token. It is sealed in the vault and deleted on disconnect.
- **Titles:** control, format, bidi and default-ignorable characters, Hangul fillers (U+115F, U+1160, U+3164,
  U+FFA0), U+034F and the braille blank (U+2800) are stripped; a title empty after that is refused.
- **Modal metadata:** `base64url(JSON{t, c, m, u, i, b, a}).HMAC`. The key is HMAC(signing_secret, label). The submitter
  and team must match, and metadata expires after 1 h. The selected board/channel, opaque connection/settings/member digest and current linked member must still match on submit and after permalink retrieval. The registry rechecks current principal and connection authority inside the board queue.
- **Request ids:** `cmd:<team>:<trigger_id>` for `/plex todo`, and `msg:<channel>:<ts>` for a message, so the same
  message is never carded twice.
- **Stored:** the confirmed title, plus `From Slack: <permalink>` as the card body, plus a `thread` link. Nothing
  else from the message is kept, including its author.
- **Outbound:** text is escaped (`& < >`) with unfurls off. `response_url` must match
  `^https://hooks\.slack\.com/(commands|actions|app-actions)/…$` and is used only inside the handler, never with the
  bot token. Every call goes through the registry's checked fetch (`hosts: slack.com, hooks.slack.com`).

## Checked against Slack's docs (2026-10-02)

| | What we rely on | Source |
|---|---|---|
| Signature | `v0:` + timestamp + `:` + raw body, HMAC-SHA256 with the signing secret, `v0=` hex in `X-Slack-Signature`; reject timestamps more than 5 min from local time; use an HMAC compare | https://docs.slack.dev/authentication/verifying-requests-from-slack |
| Commands | Ack within 3000 ms or the user sees `operation_timeout`; an empty 200 is allowed; `response_type: ephemeral` is the default; fields include `team_id`, `api_app_id`, `enterprise_id`, `trigger_id`, `response_url` | https://docs.slack.dev/interactivity/implementing-slash-commands |
| Interactions | Form-encoded with a `payload` JSON field; ack within 3 s; `response_url` works up to 5 times within 30 min; `trigger_id` expires in 3 s and is single use | https://docs.slack.dev/interactivity/handling-user-interaction |
| Message shortcut shape | `type: message_action`, `callback_id`, `trigger_id`, `response_url` under **`/app-actions/`**, `team`, `channel`, `user`, and `message{user, ts, text}`, with **no `api_app_id`** | https://docs.slack.dev/reference/interaction-payloads/shortcuts-interaction-payload |
| Modals | `view_submission` has `view.team_id`, `view.app_id`, `private_metadata` (≤ 3000 chars), a 3 s response, and `response_action: errors` keyed by block_id; the title is ≤ 24 chars; static_select allows ≤ 100 options with text ≤ 75 and value ≤ 150 | https://docs.slack.dev/surfaces/modals, https://docs.slack.dev/reference/interaction-payloads/view-interactions-payload |
| V-apps.manifest.create | POST `token` (an app configuration token) and `manifest` (a JSON string), form or JSON; returns `app_id`, `credentials{client_id, client_secret, verification_token, signing_secret}` and `oauth_authorize_url`; Tier 1. **V1:** the docs don't say it verifies Request URLs synchronously. Slice 1 subscribes to no events, so it doesn't matter yet | https://docs.slack.dev/reference/methods/apps.manifest.create |
| Manifest schema | `display_information.name` ≤ 35; `features.slash_commands[]{command ≤ 32, url, description, usage_hint, should_escape}`; `features.shortcuts[]{name, type message, callback_id ≤ 255, description ≤ 150}`; `oauth_config.{redirect_urls, scopes.bot}`; `settings.{interactivity, org_deploy_enabled, socket_mode_enabled, token_rotation_enabled}` | https://docs.slack.dev/reference/app-manifest |
| oauth.v2.access | HTTP Basic is recommended for the client credentials; returns `access_token` (the bot token), `token_type: bot`, `scope` (comma-separated), `bot_user_id`, `app_id`, `team{id, name}`, `enterprise`, `is_enterprise_install`, and `authed_user` | https://docs.slack.dev/reference/methods/oauth.v2.access |
| V2 Sign in with Slack | Authorize at `https://slack.com/openid/connect/authorize` with `response_type=code`, `scope=openid` and `nonce` (email and profile are optional); exchange with `openid.connect.token` (`access_token`, `id_token`); the `id_token` carries `iss` `https://slack.com`, `sub`, `https://slack.com/team_id` and the nonce, signed with the keys at `https://slack.com/openid/connect/keys`. SIWS scopes can't share an OAuth flow with other scopes, which is why it's a separate identity flow | https://docs.slack.dev/authentication/sign-in-with-slack/, https://docs.slack.dev/reference/methods/openid.connect.token, https://docs.slack.dev/reference/methods/openid.connect.userInfo |

**Not confirmed by the docs fetched:**
- PKCE for Sign in with Slack: the SIWS page documents `nonce` (returned in the `id_token`) but not
  `code_challenge`. The code exchange uses the client secret over HTTP Basic, and the registry verifies the
  `id_token`.
- Whether interactions are ever retried. There is no automatic retry claim. Delivery dedupe and the durable request id
  make a retry harmless either way.
- Whether `api_app_id` appears on real `message_action` payloads.
- Whether the internal-app restriction applies to Sign in with Slack.
- V3 (canvases), V4 (rate tiers) and V5 (`chat.postEphemeral` with `thread_ts`) belong to later slices.

## Held completion boundary

The catalog remains unchanged; these modules are registered explicitly only by synthetic tests. An admin must set the framework selected `target_board_id` and the sole Slack config key `channel_id`. Missing, archived, foreign, or changed targets refuse intake without choosing another board; modal options contain only the selected board. Linking starts on the team's Integrations page. No automatic channel/history read or AI capture runs.

Actual human app creation, OAuth approval, browser-bound Slack identity and command/shortcut acceptance remain pending. Thread synchronization, notifications, reaction routing, digests, confirmed AI capture/huddle/canvas, Home/unfurls and provider lifecycle handling remain unimplemented and disabled.

The existing Integrations page has the board selector and identity controls. A dedicated Slack channel selection control remains a UI prerequisite for offering this connector; this source packet accepts the selected channel only through the existing admin settings API. Card creation and durable receipt are atomic in the shared API; a thread link is appended by the guarded act scope afterwards. A failure between card commit and link creation retains the card receipt, and a fresh confirmed delivery can repair the same link without a second card. No exactly-once provider reply or automatic retry is promised.
