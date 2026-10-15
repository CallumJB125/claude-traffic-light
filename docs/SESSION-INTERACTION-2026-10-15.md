# Session interaction implementation — 15 October 2026

The Team sessions page now opens a selected live session's activity and
conversation, including actual provider receipt, exact input echo, streamed
output, completion and interruption states. Send, current-turn steer and
interrupt are separate actions, limited by the existing explicit share and
provider capability. Watch shares remain read-only. The final reviewed text and
action use a one-use main-owned token bound to account, hub, team, share,
session generation and current turn. A changed binding refuses the action.

Pending actions are serialized per shared target, including across view closure
and reopening. Losing authority before dispatch refuses it; losing the reply
after a possible dispatch reports an unconfirmed outcome. No automatic retry is
performed. Drafts survive temporary failures and turn changes, and private
selected-session text is cleared on revocation, account/team change and close.
Busy providers without steering support allow a local next-turn draft; sending
remains a deliberate action after the session becomes idle.

Codex and Claude adapters emit fixed activity categories with exact target/turn
binding and independent activity timestamps. Raw commands, paths and tool
arguments are excluded. A new steering delivery shows only post-dispatch turn
output, and does not claim the agent understood or applied the correction.
The selected conversation reads live state; passive directory state is cached
for up to 45 seconds while share metadata remains freshly authorized. Cached
reads retain their actual observation times and cannot refresh child activity.

## Privacy fixes

Both host and hub conservatively exclude deliveries stamped in the same
millisecond as share creation, in addition to older history. Immediate action
receipts are derived from the already filtered state, preventing a steer into
an older turn from revealing its earlier output. The new client also derives
receipts this way when talking to older hosts/hubs. Unsupported or temporary
live-state failures cannot silently downgrade into the legacy send path.

## Evidence

- Full local root run during implementation: 4,813 passed, 11 skipped /4,824;
  zero failures/cancellations. Later changes have focused regressions below and
  will be covered by the frozen release CI.
- Final combined main/preload/controller/renderer/provider/client regressions:
  259 passed, including per-steer output isolation and busy-provider drafts.
- Remote 220/220 and site 30/30 passed. The first full board run had 3,104 passed
  and three fixture failures: old cache timing assumptions and an old collapsed
  success shape. Tests now exercise selected live read/action paths, unchanged
  passive observation times and exact task-inbox receipts. All 23 sharing/board
  contract tests passed after those updates. Frozen release CI remains required.
- Real Codex CLI `0.162.0-alpha.17.2` and Claude `2.1.300`: isolated empty
  sessions, disabled tools, exact marker accepted, literal input echo recorded,
  response completed, untouched sibling received zero deliveries.
- Actual Electron Overview UI, preload, main/service, real loopback accounts
  hub, owner host and TeamHubClient, with two clearly labelled local identities
  and real Codex: selected send returned the marker; current-turn steering
  changed the integer-list task into `PLEXIFORM_UI_STEER_OK`; independent
  interruption returned `interrupted`; the sibling received zero deliveries.
- The first desktop fixture refreshed at one-second intervals and exhausted
  its request budget. Evidence is retained. The corrected five-second fixture
  and bounded passive cache completed the send/steer/interrupt checks.

Logs, screenshots and safe fixture state are in the adjacent task workspace.
Real provider calls used disposable sessions only. Existing user sessions,
external teammates, provider permissions and installed app data were untouched
during these checks. No credentials appear in the evidence.

## Remaining acceptance and scope

This implements the selected-session interaction gap. External two-person,
two-device/provider acceptance is still required; local account identities do
not establish that acceptance. Activity category execution was covered by wire
regressions; the real disabled-tool checks observed Thinking only. Unsupported
observed sessions remain visibly advisory. Codex desktop chats cannot be reached
through the optional CLI shared daemon.

Durable executable next-turn queues, owner-reviewed proposal workflows and new
granular delegation records remain separate work. The existing interact share
already discloses send/steer/interrupt and was not silently expanded. Provider
approvals, worktree/file ownership enforcement and integration gates are not
granted by messages. Universal prevention of independent agents undoing shared
checkout work remains unimplemented; Kafka would not itself enforce it.
