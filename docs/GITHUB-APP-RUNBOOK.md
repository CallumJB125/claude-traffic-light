# GitHub App runbook (team hub)

The team hub (`app.plexiform.dev`) can own one GitHub App that every team
installs, instead of each team creating its own app from a manifest. This
page is for the operator who registers that app and runs the hub. The code
is `board/hub/integrations/github/` (`app.js` auth, `webhook.js` events,
`index.js` the connector, `cards.js` the card actions) and the registry's
"one app, many installations" section.

## What it does

- **Install.** A team owner or admin opens Integrations → GitHub → *Install
  on GitHub*. GitHub shows its install page (pick an account or organization,
  pick repositories), asks the user to authorize the app, and redirects to
  `/integrations/github/callback` with `installation_id`, `code` and the
  hub's signed `state`. The hub trades the `code` for the user's token, asks
  GitHub `GET /user/installations` whether that user can see that
  installation of this app, revokes the user token, and only then makes the
  team's connection (`external_id` `inst:<installation id>`). One
  installation belongs to one team; another team gets a generic "already
  connected".
- **Link repositories.** On the connection, *Choose repositories* lists the
  installation's repositories (from GitHub, with an installation token); *Link*
  records one in `integration_app_repos` and adds it to the open board (as a
  team repo first, if needed). Deliveries about any other repository are
  answered 200 and do nothing.
- **Webhooks.** Every installation's deliveries arrive at
  `POST /api/integrations/github/webhook`, signed with the app's webhook
  secret. A delivery is verified (HMAC-SHA256 over the raw body, constant
  time), keyed twice for replay (signed content and the body hash, 30 days),
  leased while it runs, rate limited per connection, and handled by the
  same connector code as a per-team app:

  | GitHub event | Card |
  |---|---|
  | `pull_request` opened from the card's run branch into its base | PR linked on the card |
  | `pull_request` `review_requested` | card shows *review requested*; an alert for the people on it |
  | `check_run` completed failing, `check_suite` completed | checks *failing* (alert) / *passing* on the card |
  | `push` to the card's branch | checks back to *pending* |
  | `pull_request` closed merged (the card's hub-verified PR) | card moves to **Done** |
  | `pull_request_review` by someone with write access | review state on the card |
  | `issue_comment` on the card's PR by someone with write access | a card comment naming who and linking the comment (never its text) |
  | `installation` deleted / suspend / unsuspend | connection revoked / health *suspended* / healthy |
  | `installation_repositories` removed | those repositories unlinked |

  A card's column still follows the run's state machine: a PR whose review is
  requested is shown as such; the card is in *In review* because its run
  finished, not because of GitHub.
- **Card actions.** In a card's drawer, a member (not a viewer) can *Open PR on
  GitHub* (from the card's latest run branch into its base; the description is
  the card's title, goal, done-means and the run's last status line, secrets
  redacted) and *Comment status* on the linked PR. The hub records the PR it
  opened as hub-verified evidence, so its merge moves the card to Done. Each
  is audited on the connection and can be switched off there (*On its own*).
  Limits: 10 per member per 10 minutes, 3 per card per minute.

## Register the app (once)

1. Pick the owner: the Plexiform GitHub organization. The app is **public**
   (other organizations must be able to install it).
2. Create it from `docs/github-app-manifest.json` with GitHub's
   [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
   serve this form from any local file, signed in to GitHub as an owner of
   the organization, and submit it:

   ```html
   <form method="post" action="https://github.com/organizations/<org>/settings/apps/new?state=<random>">
     <input type="hidden" name="manifest" value='<the JSON, minified>'>
     <button>Create</button>
   </form>
   ```

   If the name *Plexiform* is taken, change `name` (34 characters at most)
   before you submit. GitHub redirects to
   `https://app.plexiform.dev/?github_app_created=1&code=<code>&state=<random>`.
   Check `state`, then within an hour convert the code:

   ```sh
   curl -s -X POST https://api.github.com/app-manifests/<code>/conversions
   ```

   The answer holds `id`, `slug`, `client_id`, `client_secret`,
   `webhook_secret` and `pem`. It is shown once: put each value straight into
   the secret store (below) and do not paste the answer anywhere else.
   Or register it by hand (Settings → Developer settings → GitHub Apps → New)
   with exactly the values in the manifest.
3. Check the app's settings page matches:
   - Webhook URL `https://app.plexiform.dev/api/integrations/github/webhook`, active, a secret set.
   - Callback URL `https://app.plexiform.dev/integrations/github/callback`;
     *Request user authorization (OAuth) during installation* on; *Redirect
     on update* on. No Setup URL (GitHub ignores it with OAuth during install).
   - Repository permissions: **Metadata** read, **Pull requests** read and
     write, **Checks** read, **Contents** read, **Issues** read. Nothing else,
     no organization or account permissions.
   - Events: Pull request, Pull request review, Check suite, Check run, Push,
     Issue comment. (Installation events are always sent to an app.)
   - Where can it be installed: *Any account*.

## Configure the hub

Secrets come from the host's secret store into the hub's environment (the
same place as `BOARD_SECRET`), never from the repository:

| Variable | Value |
|---|---|
| `GITHUB_APP_ID` | the app's numeric id |
| `GITHUB_APP_PRIVATE_KEY_FILE` | path to the `.pem` (e.g. `/etc/plexiform/github-app.pem`, owner the hub's user, mode `0600`, outside the repo and `BOARD_DATA_DIR`) |
| `GITHUB_APP_WEBHOOK_SECRET` | the webhook secret |
| `GITHUB_APP_CLIENT_ID` | the app's client id (`Iv1.…` or `Iv23…`) |
| `GITHUB_APP_CLIENT_SECRET` | the app's client secret |

All five or none: a partial set stops start-up with a message naming the
variable. The hub also needs `BOARD_PUBLIC_URL=https://app.plexiform.dev`
and its encryption key (integrations refuse to connect without it, D41).
Webhook and client secrets are removed from the environment once read; the
key is read once into memory. Installation tokens are minted with an app
JWT (RS256, 10 minutes at most), kept in the hub process's memory until 5
minutes before GitHub's expiry, and never written, logged or returned.

**Cloudflare.** `/api/integrations/github/webhook` and
`/integrations/github/callback` must reach the hub without a Cloudflare
Access login (GitHub can't sign in): add both to the Access bypass, as for
`/integrations/<id>/webhook`. The signature and the signed state are their auth.

Restart the hub, then:

1. GitHub app settings → Advanced → *Recent deliveries*: redeliver the `ping`;
   the hub answers `200 {"ok":true,"ignored":true}`.
2. Integrations → GitHub → *Install on GitHub* on a test organization; the
   callback page says *acme is connected*. *Choose repositories* lists them;
   link one.
3. Open a PR from a card's branch (or *Open PR on GitHub* in the drawer); the
   card shows it. Merge it; the card moves to Done.

## Rotate

- **Private key**: generate a new key on the app's page, install the file,
  restart the hub, then delete the old key on GitHub. Cached tokens die with
  the process; a token GitHub refuses (401) is minted again once.
- **Webhook secret**: set the new secret on GitHub and in
  `GITHUB_APP_WEBHOOK_SECRET` together and restart; deliveries in between
  answer 401 and GitHub retries them from *Recent deliveries*.
- **Client secret**: add a new one on GitHub, update
  `GITHUB_APP_CLIENT_SECRET`, restart, delete the old one. Only installs in
  progress are affected.

## Remove

A team admin disconnecting the GitHub connection stops it at once (its
deliveries are ignored); uninstalling the app on GitHub revokes it too. To
retire the app, unset the five variables (teams keep the per-team manifest
flow), restart, then delete the app on GitHub.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Webhook deliveries 401 | `GITHUB_APP_WEBHOOK_SECRET` differs from the app's; log line `integration app webhook rejected` |
| Deliveries 200 `ignored` | the installation is not connected to a team, or the repository is not linked on it |
| Install callback: *did not confirm that installation* | the user who installed is not the one GitHub signed in, or OAuth during installation is off |
| Install callback: *request … sent to the account's owners* | an organization member requested the install; an owner must approve, then connect again |
| *Open PR*: *GitHub refused it* | the run branch is not pushed, or has no commits beyond the base |
| *Open PR*: *no access to this repository* | the installation no longer includes it: add it on GitHub, link it again |
| Connection health *suspended* | the installation was suspended on GitHub |
