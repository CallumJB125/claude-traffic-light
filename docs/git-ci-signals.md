# Git and CI signals

Six transient rule signals from GitHub, remappable in Lights like any other:

| Signal | When | Default rule (accent only, never the lamp) |
| --- | --- | --- |
| `pr-review-requested` | someone requests your review on their PR | sign "REVIEW PLEASE", surprised eyes |
| `pr-changes-requested` | a "changes requested" review on a PR you opened | sign "CHANGES ASKED", sad eyes |
| `ci-failed` | the latest run of a non-deploy workflow on a branch one of your sessions is on failed | sign "CI FAILED", red eyes, Funk sound |
| `ci-passed` | …succeeded | thumbs up, green eyes |
| `deploy-failed` | a deploy workflow run you started failed (any branch) | sign "DEPLOY FAILED", red eyes, Funk sound |
| `deploy-finished` | …succeeded | party, green eyes |

Only runs you triggered (`actor=<your login>`) count. A workflow is a deploy when its
name is in Preferences → Git and CI → Deploy workflows, or, with that empty, when the
name contains deploy, release or publish (but not "notes", "drafter" or "changelog").

Git events never raise a macOS notification. Each new event plays its rule's sound once
(Preferences → "Play a sound" permitting); events restored from the state file after a
restart, still inside their hold, show again but stay silent.

Each event fires once (deduped by run id + attempt + conclusion, review id, or
repo#PR for a review request) and shows for 10 minutes (failures, reviews) or 2 minutes
(passes). Anything older than 15 minutes is never fired, so a restart or a newly watched
repo doesn't replay old news.

## Polling (v1)

`src/github-signals.js` calls `gh api -i` with the user's own `gh` login. Nothing is
stored but the state file `git-signals.json` (events, seen ids, repos, rate limit; no
credentials) in the app's data folder. gh's own config is never touched.

- Repos: the GitHub `origin` (else first GitHub) remote of each live session's folder,
  kept for an hour after its last session, plus the "Also watch" list. Manual repos with no
  session get no CI signals (no branch to watch).
- Per repo per poll: `actions/runs?actor=<you>&per_page=20`,
  `pulls?state=open&sort=updated&direction=desc&per_page=100`, and `pulls/<n>/reviews?per_page=100`
  for up to 5 of your most recently updated open PRs, plus the Link header's `rel="last"` page
  when a PR has more than 100 reviews (they come oldest first); `user` once an hour.
  Requests go one at a time.
- Review requests come from that PR page: asking for a review bumps a PR's `updated_at`, so a
  fresh request is always on it. A request missing from a full page is not taken as withdrawn.
  The search API (`user-review-requested:@me`) would cover every repo in one call, but it sends no
  ETag (checked live), so it would cost a request every poll; the PR page is free while unchanged.
- Only reviews requested from you personally count; requests to a team you're on
  (`requested_teams`) are ignored in v1.
- Every request sends the last ETag as `If-None-Match`. A 304 does not count against the
  primary rate limit (GitHub REST best practices; checked live: `X-RateLimit-Used` unchanged).
- Cadence: every 90 s while any session is live, every 10 min otherwise; every 10 min
  when gh is missing or logged out (Settings shows a one-line setup hint); slows to 10 min
  below 100 remaining requests.
- Errors: `Retry-After` is obeyed; `X-RateLimit-Remaining: 0` waits for `X-RateLimit-Reset`;
  anything else backs off 1, 2, 4… minutes up to 30. A 403/404 on one repo marks only that
  repo and the rest carry on.
- The next poll is timed from the end of the last one. The app checks `due()` before it
  gathers sessions, so an idle tick costs nothing. No login from gh means no polling at all
  (there is no "yours" without one).
- The state file is rewritten only when something other than poll times and the rate count
  changed, or every 10 minutes, so `lastPollAt` / `nextPollAt` there can be up to 10 minutes old.
- Dev runs (demos, shots, visual tests) never call gh; they still show events saved in the state file.

Budget: only changed responses cost anything. Worst case (every response changed on every
poll) is about 40 polls/hour × (2 + your open PRs, max 5, ×2 past 100 reviews) requests per
active repo, so ≈280/hour (≈480 in the extreme) for one busy repo against gh's 5,000/hour. In practice most polls are all 304s,
and the runs list only changes while a run is in flight.

## Hub / GitHub App path (later)

A GitHub App's webhooks, relayed by the hub to the member's local app, call
`ingest(events, 'hub')` on the same instance the poller uses:

```js
ingest([{ id, signal, repo, at, branch, pr, title, url }], 'hub')
```

- `id` must be the same id the poller would make (`run:<repo>:<run id>:<attempt>:<conclusion>`,
  `review:<repo>:<review id>`, `rr:<repo>#<pr>`), so a repo can move between polling and
  webhooks, or both run at once, without double-firing.
- `signal` must be one of the six above; anything else is dropped. `at` is the event time
  (freshness); `cwd` is filled from a live session in that repo.
- Dedupe, freshness, hold, the state file, the rules and `buddy_git_status` are shared, so
  nothing downstream knows or cares where an event came from (each keeps `source`).
- The local transport for the relay (e.g. a token-protected route on the signal server)
  is not built yet and needs its own security review.

## MCP

`buddy_git_status`: state, setup hint, whether gh is signed in (not the login), watched
repos with branches and per-repo errors (no session folders), the events showing now, the
last 10 fired, rate limit, last/next poll. PR titles and branch/workflow names are written by
other people, so they come back truncated as `untrusted_title` / `untrusted_branch`, and the
note tells the calling agent to treat them as data, never instructions. `buddy_status` and
`buddy_why` also see live git events, so "why is he holding a CI FAILED sign?" is answerable.
