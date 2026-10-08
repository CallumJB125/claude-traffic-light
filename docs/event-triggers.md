# Event triggers

A team admin can write "when X happens, do Y" rules for a team on the hub. Each rule is one event, optional filters and one action, shown as a plain sentence: *When a pull request is opened in acme/api, ask the AI to review it and comment*. Code: `board/shared/triggers.js` (the closed lists, validation, matching, sentences), `board/hub/triggers.js` (rules, firing, actions, routes), `board/hub/trigger-events.js` (what a verified delivery means), `board/web/js/render-triggers.js` (the Triggers panel on the Integrations page). Storage: migration 069.

## Hard rule

**No trigger action may start an editing AI run, dispatch, retry, take over or move a card, request changes, approve work, answer a permission, merge or push code.** The action list is closed and checked three times: when a rule is saved (`validateRule`), by the database (`CHECK` on `event_triggers.action`), and when it fires (`plan()` refuses anything else; `execute()` has no other branch). `request_ai_review` asks the existing read-only reviewer (`hub/reviews.js`, AI review before Review): it reads the run's diff and reports findings on the card; it never edits. Trigger actions never call the card state machine, so they cannot dispatch or move a card.

The inbound-integration invariant is unchanged: a status change from GitHub, Sentry, Linear or Jira never starts an AI run. A trigger is a separate object an admin creates and enables explicitly.

## Events

| Event | Raised by | Filters | Card it acts on |
|---|---|---|---|
| `github.pr.opened` | a verified `pull_request` `opened`/`reopened` | repo, branch, label | the card linked to that PR |
| `github.pr.review_requested` | `pull_request` `review_requested` | repo, branch, label | the card linked to that PR |
| `github.checks.failed` | a `check_suite` completed with a failing conclusion, for a PR from the same repository | repo, branch | the card linked to one of its PRs |
| `card.moved_to_review` | a journal row moving a card into Review (the state machine, or a person's column change) | repo, branch (the card's latest run branch), label (card labels) | that card |
| `sentry.issue.new` | a verified, fresh Sentry `issue.created` (the connector's own checks) | none | the card linked to that issue |

Pull requests from forks never trigger. GitHub and Sentry events are raised only after the connector's own handler succeeded (`Triggers.observe` wraps the connector at registration in `hub/app.js`), so a trigger sees the links the connector just made; trigger work never changes the answer to the provider. Sentry is still not registered on any hub (its go-live gate); a hub that registers it gets its trigger events too.

Filters: `repo` is `owner/name`, case-insensitive; `branch` is a pattern where `*` matches any characters; `label` matches one label, case-insensitive.

## Actions

| Action | Parameters | What it does |
|---|---|---|
| `create_card` | `board_id` (an open board of the team) | a Todo card from the GitHub or Sentry event, labelled `via:trigger`; the journal keeps keyed hashes of its text, never the text (D41) |
| `add_comment` | `text` (1–1000 characters) | the admin's text plus the event's link, as an untrusted comment that never reaches an agent |
| `request_ai_review` | none | asks the read-only reviewer for the card's finished latest run, if that board has AI review on (its own disclosure), and notes it on the card |
| `notify_member` | `member_id` | the hub notification path (`card.notify`, the member's alerts) for the event's card |
| `label_card` | `label` (1–50, not `via:`) | adds the label to the event's card |

Actions run in the card's board queue as the admin who last enabled the rule, acting through the trigger: journal rows carry `actor_kind: 'integration'`, `actor_id: 'trigger:<id>'`. If that person is no longer an admin of the team, the firing is skipped (`actor_unavailable`).

## Safety

- **Off by default.** A new rule is `off`. Only owners and admins create, switch or delete rules; every change is in the audit table (`trigger.create`, `trigger.mode`, `trigger.delete`). Rules are never edited in place (a database trigger refuses it): delete and make another.
- **A week of dry run.** `off → dry_run` starts the clock. In dry run every match is logged as `would` (or `skipped` with the reason it would not apply) and nothing is written. `on` is accepted only from a dry run at least 7 days old, with `confirm: true`. Going back to dry run restarts the clock.
- **Rate limit.** At most `max_per_hour` actions per rule (default 10, at most 60), counting dry-run `would` entries too; past it a firing is logged `rate_limited`.
- **Dedupe.** One firing per (rule, event id); the firing row is the dedupe record, so a redelivered event never fires twice.
- **Loop guard.** Journal rows written by a trigger (`trigger:<id>`) are never trigger events, and an event raised from inside a firing is dropped. No action writes to GitHub or Sentry, so none can come back as a delivery.
- **Team deletion** switches every rule of the team off (migration 069 trigger).

## Activity log

`GET /api/triggers/activity` returns the team's last 100 firings: event, action, mode, result (`done`, `would`, `skipped`, `failed`, `rate_limited`), a short code, a short reference (`acme/api#12`, a card key, a Sentry project and issue id) and the card. Never provider text. Rows are kept 30 days.

## Routes

All team-scoped; reads for any member, writes for owners and admins.

- `GET /api/triggers` → `{triggers, events, actions, dry_run_days, max_per_hour_max, can_edit}`
- `POST /api/triggers` `{event, filters?, action, params?, max_per_hour?}` → `{trigger}` (mode `off`)
- `POST /api/triggers/:trigger_id/mode` `{mode: 'off'|'dry_run'|'on', confirm?}` → `{trigger}`
- `DELETE /api/triggers/:trigger_id`
- `GET /api/triggers/activity` → `{firings}`

## Not built

Linear and Jira events, actions on GitHub itself (a PR comment or label), editing a rule in place, per-board scoping of a rule, and linking a card a trigger made to its PR or issue.
