# Team overview

The Team view summarizes work across the selected team's active boards and
keeps shared local sessions for the current board below it. It refreshes every
15 seconds while visible; Refresh checks immediately. An unavailable or old
snapshot is labeled rather than presented as current activity.

- Open tasks, tasks needing attention, work ready for review, and completed tasks.
- AI tasks with their account owner, provider, current runner activity, and task state.
- Blockers, questions, approval requests, disconnected runners, and overlapping paths.
- Attached change evidence distinguished from reported tests and reported costs.
- Board summaries and recently changed tasks, with fresh access checks when opening a task on another board.

An idle Codex turn leaves its task open until the agent explicitly completes or
releases it. A connected runner and a fresh lease establish current activity;
shared session text does not establish agent identity or verified completion.
Change verification checks a commit or pull request. A test result remains a
report. Providers without dollar telemetry show Cost unavailable.

`GET /api/team-overview` is a staff read in the selected credential team. Viewers
can read it; client guests cannot. Archived boards and cards are omitted.
Totals cover all active boards, while each task list contains at most 20 rows
and board summaries at most 60 rows. The endpoint exposes no credentials,
client email addresses, raw tool inputs, artifact bytes, or task narrative bodies.
It grants no task execution or approval rights.
