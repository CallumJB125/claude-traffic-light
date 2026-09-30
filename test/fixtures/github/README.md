Recorded `gh api -i` output, one file per response: the status line, headers and body
exactly as `gh api -i` prints them (status line ends in `\n`, headers in `\r\n`, as recorded
live on gh 2.93.0 on 2026-09-30). Field shapes were copied from real responses to
`repos/{owner}/{repo}/actions/runs?actor=…`, `repos/{owner}/{repo}/pulls` and `user`; names,
ids and times are replaced with the synthetic acme/widget repo so no real repo data is committed.
Reviews follow the documented `pulls/{n}/reviews` shape (no live review was available to record).
`reviews-8-page1/2` are a PR with more than 100 reviews: page 1 carries the `Link` header
(format as recorded live) whose `rel="last"` page holds the newest review.
