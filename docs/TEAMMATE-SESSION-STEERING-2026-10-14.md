# Teammate AI-session steering — design and acceptance plan
14 October 2026

## Recommendation
Build on the existing exact-session relay and durable task inbox. Give teammates
three clearly different abilities: watch, propose a change, and act under an
explicit delegation. True steering means changing the selected current turn; a
message for the next turn must have a separate name and delivery state. Provider
support determines what Plexiform can offer. Kafka is not needed to close this
product gap.

## Evidence boundary
This is a source-backed design, not an implemented new control feature or a real
teammate/provider acceptance result. Source was reviewed in owner-decisions at
9b89c6a4060933285e8a44e5d6eb2d69887b3ad6; the runtime remains 1adca098.
The recorded installed Mac checks establish working tabs, saved task context,
exact-session navigation and native handover export. They did not send a real
team message, dispatch provider work or establish two-account steering. Existing
relay regressions use synthetic identities and fake providers. No teammate was
messaged and no session or setting was changed during this design task.

## What exists today
1. The hub stores watch/interact session shares. Viewers can watch; owner, admin
   and member roles can act on an interact share. The hub and owner host check
   their own copy of session/team/scope, and the hub checks current membership,
   credentials, host state and expiry before forwarding and before returning an
   answer. Teammates cannot list other private sessions, launch or close one.
   Shared messages/responses exclude history before the share began.
2. Supported sessions started in a signed-in team workspace can be automatically
   shared to that team under the existing preference. Manual watch shares take
   precedence; an explicit revocation is not silently recreated. Personal and
   unrelated observed sessions do not become controllable merely by discovery.
   Team-board runs have their existing participation/role boundary separately.
3. Owned interaction sends are bound to a session generation and, for steering,
   an expected turn. Provider acknowledgement, exact input echo, response and
   completion are separate observations. A foreign turn cannot masquerade as a
   message receipt. Codex-daemon refuses steering or interrupting turns started
   outside Plexiform. Provider approvals are not automatically answered here.
4. The shared relay supports send with expectedTurn and interrupt. However, the
   Team sessions UI/client currently sends only ordinary messages: it does not
   pass expectedTurn or expose a complete teammate steering/interrupt action
   path. A capability badge or share disclosure is not acceptance of that path.
5. Managed team-board messages are a durable, current-run/fence task inbox. The
   live supervisor reports receipt; the agent separately reports acknowledgement
   and can send a correlated reply. Sending does not resume a paused run. The
   Overview currently requires the board runner online before accepting a send.
6. A separate durable account-messaging service already has bounded offline
   queues, TTL, leases, idempotent request IDs, busy retry only when nothing was
   sent, and an outcome_unknown state after uncertain provider dispatch. Its
   receiver sends a new turn only when idle. It is not a busy-turn steering queue
   and must not be described as wired into every Team sessions composer.

## Provider-specific behavior
- Codex app-server: new turn, expected-current-turn steering and interrupt.
- Attached Codex-daemon: sending is supported when idle; steer/interrupt only
  turns Plexiform started. Existing unmanaged threads are not generally shared.
- Plexiform-owned Claude Code: new turn and interrupt. No expected-turn steering;
  use an explicitly queued next-turn message instead of calling it a steer.
- Explicit Claude terminal channel: accepted message and reply, with channel
  setup/confirmation; no steer or interrupt capability in the current adapter.
- Gemini ACP and local-model sessions: new turn and interrupt, no steer.
- Other observed sessions: watch/report/handover only until a documented inbound
  channel is implemented and accepted. Do not type into arbitrary terminals.

## Three steering tiers
WATCH
Keep current visibility boundaries and freshness labels. Show who owns the
session, current task, provider, whether it is managed/shared/observed, and which
actions are actually supported. Viewers remain read-only. Watching or appearing
in a team workspace grants no additional ability to execute work.

PROPOSE
Let a teammate draft a task-scoped correction, question or suggested next action
with the packet/decision version they reviewed. The owner reviews the exact
proposal and chooses Apply, Edit or Decline. This is a proposed new suggestion
workflow, not the current direct-send behavior. AI-authored proposals remain
held until the sender's person presses Send; existing Agent Mail confirmation
and off-by-default inbox polling remain. Acceptance must name the target and
content version; accepting one suggestion grants no ongoing session control.

DELEGATED ACTION
An owner deliberately grants named participants or a selected acting role a
bounded set of actions for this exact session: send-next-turn, steer-current-turn
where supported, and interrupt-current-turn where supported. Give grants an
expiry and visible revoke control. Existing broad interact shares need explicit
migration/disclosure rather than silently acquiring new powers. Automatic team
sharing must not silently grant stronger new control. The operator's Send or
Steer button confirms their action within that delegation; routine messages need
not ask the owner to approve each time. Close, fresh-session launch, paid retry,
resume after pause, plan approval, provider permission decisions, merge and
deployment retain their own existing authorization and confirmation paths.

## Proposed user flow
Select a teammate's session -> read fresh task/decision context -> choose the
action -> preview exact text, owner, provider, task, mode and delegated scope ->
Send -> observe a receipt and correlated response in that same session card.
Show that execution uses the owner's provider account, permissions and quota.
Free Agent Mail is a feature entitlement, not free provider inference. A send
does not widen the sandbox or consume another person's approval automatically.

For a busy session, offer only supported choices: Steer current turn for an
eligible Codex turn, Queue for next turn, or Propose to owner. Show an interrupt
as requested until the provider confirms that exact turn stopped. Never combine
interrupt and resend into one hidden action. An unsupported provider receives a
plain explanation and the next-turn/handover alternative.

## Command and delivery design
- Bind a command to origin hub, account/member, team, owner/host, share/grant
  version, session generation, operation, expected turn or next-turn policy,
  task/run fence when applicable, context/decision version, exact content hash,
  stable request ID and expiry. Use opaque app handles; provider IDs stay in main.
- Preserve the reviewed generation/turn through preview and confirmation. If
  either changes, refuse and refresh. Do not automatically select a replacement
  session or a later turn under the same button click.
- Make ordinary next-turn delivery durably queued with a visible TTL and Cancel
  while pending. On reconnect or wake, revalidate every binding and current
  membership/sharing/delegation before leasing and again at dispatch. A changed
  decision packet requires re-review or an explicitly reviewed follow-up policy.
- Keep current-turn steering short-lived. Never deliver an old steer into a
  later turn or convert it into a fresh turn automatically. Queue-next-turn is
  a different operation. Queueing does not resume blocked or paused work.
- Retry only after proof no provider side effect occurred. After a timeout/lost
  connection following dispatch, mark Outcome unknown, retain the same request
  identity and reconcile receipts; do not resend automatically. Persist command
  deduplication and delivery receipts across host restarts.
- Distinguish Draft, Awaiting owner, Queued, Host received, Provider accepted,
  Input recorded, Agent acknowledged requested change, Responding, Completed,
  Declined, Expired, Cancelled and Outcome unknown. Expose only states supported
  by that adapter's evidence. An agent acknowledgement is participant-reported,
  not proof of comprehension or successful work. Completion needs task evidence.
- A Cancel while pending prevents dispatch. Once dispatched, Cancel cannot undo
  side effects: explain the state and offer an independently authorized interrupt
  where supported. Revocation blocks future actions and unauthorized output; it
  does not claim that already accepted work or previously viewed text is erased.
- Server-stamp sender attribution. Render participant/provider content as text
  and frame it as task data. Keep messages separate from authorization; content
  saying "approved" cannot grant permissions. Keep private pre-share history out.

## How this connects to preventing teammates undoing work
Before a requested correction affects relevant files, refresh team context and
require the current decision/ownership/content versions at a supported write or
integration boundary. Keep managed work in isolated worktrees. Record a handoff
of editing responsibility explicitly. Messaging and streaming alone do not stop
an independent local writer; unsupported sessions must stay visibly advisory.

## Implementation sequence after the current release
A. Close the selected-session UI/client gap first. Add a closed teamAction
   contract and main-owned preview binding; preserve exact receipt details
   instead of reducing every successful send to "queued". Expose provider-
   appropriate next-turn/steer/interrupt actions and honest unsupported reasons.
B. Add proposal and granular delegation records, followed by durable scoped
   next-turn command queueing. Reuse proven inbox/lease/deduplication semantics,
   but make the Team sessions integration explicit; do not conflate the two
   existing messaging services or silently copy their plaintext retention.
C. Integrate versioned decisions and edit/integration checks. Measure rejected
   stale actions and preserve drafts/work. Add actor-visible audit entries with
   bounded retention; document which command text/replies are stored on the hub
   versus relayed live, and obtain the relevant sharing choice before retention.
D. Complete the external acceptance below before calling cross-platform teammate
   steering or coordinated conflict prevention a shipped, proven capability.

## Actual two-account/two-provider acceptance
Use two real people on separate signed-in desktop accounts/devices in one invited
team. Use a real Codex session and a real Claude session, with recorded provider
versions. A can operate B's explicitly shared session and then reverse roles.
Run in a disposable repository and record exact target, receipt and result.
1. Private session absent; watch-only/viewer cannot send, steer or interrupt.
2. B reviews A's proposal. Decline sends no provider work; Apply sends exactly
   the reviewed text to exactly the named current session, with attribution.
3. Delegated idle send -> host/provider receipt -> correlated reply in the app.
4. Codex busy-turn steer names its existing turn; a deliberately stale turn is
   refused. Confirm output/state changes attributable to the accepted steer.
5. Claude busy-turn UI offers next-turn queue, not steering. It waits; the next
   idle turn receives the message once. Interrupt confirmation is separate.
6. Host offline/restart and lost replies preserve queued intent and receipts.
   Confirm stable retries cannot produce duplicate provider work. Force one
   post-dispatch timeout and verify Outcome unknown prevents automatic resend.
7. Revoke share/grant, demote/remove member, sign out/switch accounts, replace
   host/session/generation and expire a command while preview, queue or watch is
   pending. Undispatched work is refused; no stale response fills the later view.
8. Revoke after dispatch: further actions and output delivery are withheld as
   authorized, without pretending the provider side effect was undone.
9. Keep pre-share text/turn output/private sessions out of the remote view. Use
   hostile message text to confirm it cannot forge attribution or approve tools.
10. Verify owner provider approvals/quota and paused task gates remain in force.
    A shared message cannot approve a tool, relaunch a paused run or merge work.
11. A publishes a newer decision while B works. B must review/acknowledge the
    correct version before a relevant managed mutation; a stale overwrite is
    refused or isolated, and both participants' contributions are preserved.
12. Publish the observed provider/action matrix, failures and limits. A synthetic
    test, API 200, green status or acknowledgement alone does not pass this case.

## Source pointers (relative to the reviewed owner-decisions checkout)
board/hub/interaction-shares.js:9-25,40-46,185-221 — share scopes/roles,
  exact target, before/after authority checks and private-history projection.
src/remote-interaction.js:215-268 — host copy of share, sender attribution,
  projection and forwarding of expected-turn send/interrupt.
src/team-session-sharing.js:15-39 — team association, automatic sharing,
  precedence for manual watch shares and explicit revocation preservation.
src/session-interaction.js:315-371 — generation/turn binding, busy checks,
  provider acknowledgements, uncertain outcomes and interrupt request.
src/team-hub-client.js:231-253,345-367,418 — current board/live send paths;
  no exported teammate steer/interrupt method, no expectedTurn in team send.
src/overview-service.js:177-193; overview-directory.js:115-132 — present
  Team sessions composer/action seam and reduction of success to queued.
src/session-directory.js:205-243 — sharing/freshness/capability separation;
  managed inbox does not imply automatic resume or owner control.
board/hub/communication.js:303-334,375-383 — current inbox, host receipt,
  agent acknowledgement and packet/run-fence authority.
src/session-messaging.js:120-180; board/hub/messaging.js:24-38,615-662 —
  separate idle-only queued service, limits/TTL/leases/unknown/reply semantics.
src/codex-app-server.js:151-181; src/codex-daemon.js:209-240 — supported
  Codex steering and refusal of foreign-turn control.
src/claude-code-session.js:176-211; src/claude-channel-session.js:135;
src/gemini-acp.js:147-192; src/local-models.js:189,278 — provider limits.
board/hub/permissions.js:18-32 — current viewer/writer/admin role boundaries.
board/hub/test/interaction-relay.test.js:1-6 — explicit synthetic/fake-provider
  evidence boundary; this test is not real external acceptance.
