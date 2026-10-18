# Collaboration in managed Tasks

A managed task can ask Claude Code or Codex for help in a separate working copy,
inspect its related tasks, exchange messages and read its own inbox. The Tasks
overview links parent and helper tasks and shows outgoing delivery receipts.
Existing personal or teammate sessions do not become controllable through this API.

`buddy_spin_off` starts a helper from the parent's committed branch, within the
same repository and at the same or narrower permission level. A family has at
most four helpers, two levels deep. The supervisor's concurrency limits still
apply. Tasks with a spend cap cannot delegate until aggregate budget allocation
exists. Stop/pause of an ancestor revokes further helper collaboration; existing
isolated work remains available for human review.

`buddy_message` needs an exact related task id and a unique request id.
Identical retries reuse the durable result. Changed requests cannot reuse an id;
uncertain outcomes after a crash remain held rather than dispatching again.
Busy sessions receive queued messages at a supported boundary. A finished turn
can resume when a new message arrives. Peer content cannot grant permissions.

`buddy_tasks` returns bounded, redacted reported results and current task states.
`check_messages` returns a bounded inbox after a sequence cursor. Dispatch through
the inbox updates transport delivery so Codex does not receive a duplicate turn.
Stored/delivered receipts are not a model acknowledgement. An acknowledgement or
answer is a separate attributed message; the UI shows this distinction.

## Verified boundary

A real local Codex task delegated a read-only review to a real Claude helper,
received acknowledgement and report, sent one follow-up and received its answer
on 18 October 2026. This used the normal auto-edits task permission mode with
no edits requested or performed. Claude's native planning mode refused the
message tools; that mode is not accepted for this complete exchange. Read-only
tool annotations are supplied, but cannot override provider permission decisions.

The initial failed attempt is retained alongside the successful receipt. These
runs used the production engine in a separate local profile. They are not
installed-app, remote-device or two-person acceptance. No arbitrary external
file writer is prevented by this feature: isolation and reviewed integration
are the enforcement boundaries, while shared context is advisory.
