# Slack connector runbook (team hub)

Status: **built and tested, not offered.** Slack is in no hub's
`connectorsFor()` (`board/hub/integrations/index.js`) and the signed-out pages
show it as *Coming soon* (`LAUNCH_CONNECTORS` in `board/web/js/connectors.js`
and `buddy-window/connectors.js`). Turning it on is **owner-gated**: only the
hub owner does the steps below, on a hub they choose, after the acceptance
checks pass. Nothing here has been done on any real hub or Slack workspace.

Code: `board/hub/integrations/slack/` (`webhook.js` verify and parsing,
`spec.js` connect, identity and handlers, `README.md` the security notes and
the Slack docs it was checked against). Channel control on the Integrations
page: `board/web/js/render-slack.js`. Privacy: PRIVACY.md, *Slack (source
preparation…)*.

## What it does

- **Per team, its own Slack app.** An admin opens Integrations → Slack →
  *Connect*. Either they paste a one-time Slack **app configuration token**
  (the hub calls `apps.manifest.create` once and forgets the token), or they
  open the prefilled `api.slack.com/apps?new_app=1&manifest_json=…` link,
  create the app themselves and paste its App ID, Client ID, Client secret and
  Signing secret. The admin then approves the install on Slack; the hub
  promotes the connection only if Slack's `oauth.v2.access` answer names the
  same app and client and exactly the bot scopes asked for.
- **Scopes.** Bot: `commands`, `chat:write`. User: `openid` (Sign in with
  Slack, for linking only). No Events API, no channel history, no files.
- **Intake.** `/plex todo <text>` and the *Create Plexiform card* message
  shortcut (modal, then a card with the message permalink) in **one selected
  channel** on **one selected board**. `/plex help` and `/plex link` answer
  ephemerally.
- **Who can act.** Only a team member who linked their Slack account (Sign in
  with Slack, Integrations → Slack → *Link my account*) and can write.
- **Limits.** 30 commands per Slack user per minute; replies only through
  Slack's `response_url` (`hooks.slack.com`); outbound hosts `slack.com`,
  `hooks.slack.com`, `api.slack.com` only.

## Hub configuration (environment)

Slack adds **no** environment variables of its own: each team's app
credentials are pasted by its admin and sealed in the hub's vault. The hub
needs what every connector needs:

| Variable | Value |
|---|---|
| `BOARD_PUBLIC_URL` | the hub's public **https** origin (e.g. `https://app.plexiform.dev`). Slash command, interactivity and OAuth redirect URLs are built from it; without https, card links are left out of replies |
| `BOARD_ENC_KEY` or `BOARD_ENC_KEY_FILE` | the integrations vault key (D41). Without it integrations refuse to connect. `BOARD_ENC_KEY_PREVIOUS` only during a key rotation |

**Cloudflare.** These must reach the hub without a Cloudflare Access login
(Slack can't sign in; the signature and the signed state are their auth):

- `POST /integrations/<connection id>/webhook` (slash command and
  interactivity Request URL)
- `GET /integrations/slack/callback` (install)
- `GET /integrations/slack/identity/callback` (Sign in with Slack)

## Owner steps to go live (in order)

1. **Pick a test workspace** you administer (a free Slack workspace is enough;
   not Enterprise Grid, which the connector refuses).
2. **Enable on a non-production hub first.** In a reviewed commit, add Slack
   to `connectorsFor()` in `board/hub/integrations/index.js`:

   ```js
   import slack from './slack/index.js';
   // …
   return config.auth === 'dev' ? [fake, gh, slack] : [gh, slack];
   ```

   and run the board suite (`cd board && node --test "*/test/**/*.test.js"`;
   `hub/test/integrations-conformance.test.js` then also checks Slack as
   registered). Deploy that build to a staging hub with the variables above.
3. **Connect** (as a team admin on staging): Integrations → Slack → paste an
   app configuration token from `https://api.slack.com/apps` (*Your App
   Configuration Tokens* → *Generate Token*), or use the prefilled create link
   and paste the four values. Approve the install in Slack. The connection
   should say the workspace name.
4. **Choose the board and channel.** On the connection: *New cards go to* a
   team board, and *Slack channel* = the channel ID (channel details, bottom
   of the About tab; starts with `C`, or `G` for an older private channel).
   For a private channel, `/invite @<app name>` first. Until both are set,
   intake is paused.
5. **Link your account**: Integrations → Slack → *Link my account* (Sign in
   with Slack, `openid` only).
6. **Acceptance checks** (each is a README "not confirmed by the docs" item or
   a held-boundary item):
   - `/plex help` in the channel answers ephemerally within 3 s.
   - `/plex todo Check the deploy` makes a card on the chosen board; the
     reply names its key and links it.
   - The message shortcut on a message opens the modal; submit makes one card
     with `From Slack: <permalink>`; running it again on the same message makes
     no second card.
   - `/plex todo` in another channel is refused; an unlinked user gets the
     *link your account* message; a viewer gets the *ask an admin* message.
   - Record whether the real `message_action` payload carries `api_app_id`
     (README, *Not confirmed*), and note the result in the slack README.
   - Disconnect: the app's credentials are gone from the vault and `/plex`
     stops answering with cards.
7. **Production.** Only after 6 passes: deploy the same `connectorsFor()`
   change to the prod hub, then flip `LAUNCH_CONNECTORS` to include `'slack'`
   in **both** `board/web/js/connectors.js` and `buddy-window/connectors.js`
   in one commit (a root test fails if they drift), and release.

## Rotate

- **Signing secret / client secret**: regenerate on the app's *Basic
  Information* page, then disconnect and connect again with the new values
  (the hub never edits a connection's sealed secrets in place).
- **Vault key**: set the new key as `BOARD_ENC_KEY` and the old as
  `BOARD_ENC_KEY_PREVIOUS`, restart.

## Remove

A team admin disconnecting Slack deletes the bot token and secrets and every
member's Slack link; they then delete the app at `https://api.slack.com/apps`.
To withdraw Slack from a hub, revert the `connectorsFor()` line and
`LAUNCH_CONNECTORS`.

## Troubleshooting

| Symptom | Look at |
|---|---|
| `/plex` says `dispatch_failed` / times out | Request URL not reachable (Cloudflare Access bypass), or the hub is down |
| Every request 401 | Signing secret differs from the app's, or the hub clock is over 5 minutes off |
| Connect refused: *other scopes than requested* / *Grid* | The app was edited on Slack after creation, or the workspace is Enterprise Grid |
| Health `reconnect_required` | The connection predates migration 026 or lost its provider facts: disconnect and connect again |
| Health `wrong_workspace` | A payload named another workspace or app than the connection's |
| Commands answered but no card | Board or channel not chosen, archived or changed; or the user is not linked / can only view |
