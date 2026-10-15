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
  were covered by the frozen release CI.
- Final combined main/preload/controller/renderer/provider/client regressions:
  259 passed, including per-steer output isolation and busy-provider drafts.
- Remote 220/220 and site 30/30 passed. The first full board run had 3,104 passed
  and three fixture failures: old cache timing assumptions and an old collapsed
  success shape. Tests now exercise selected live read/action paths, unchanged
  passive observation times and exact task-inbox receipts. All 23 sharing/board
  contract tests passed after those updates. Frozen release CI subsequently
  passed the complete suites on both Mac and Linux.
- Frozen beta.67 build/stage run `38706691686`, source `88c9817d`: Mac root
  4,828 passed / 12 skipped, remote 220/220, board 3,107/3,107 and native Darwin
  48/48. Linux root 4,819 passed / 21 skipped, remote 220/220 and board 3,106
  passed / one skipped. Zero failures or cancellations. Mac arm64 and Linux x64
  packaged smoke checks passed; Mac x64 installers built without a runtime
  smoke on that architecture. All six Mac/Linux installers and feed checksums
  passed staging validation. Windows publication remains disabled.
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

## Publication and Home follow-up

Beta.67 build/stage `38706691686` and signed promotion `38709044983` passed.
Public manifest signature, channel, version, expiry, six installer entries and
both feed hashes/sizes verified. The downloaded arm64 ZIP also matched its staged
GitHub SHA-256. The live browser download page resolves all six links to beta.67;
the 15 October changelog is deployed. Production hub health/auth and an existing
authenticated browser board remain live.

The public arm64 app was installed after preserving the previous app and private
data, including 25 checked SQLite snapshots. Package and installed smoke checks,
ad-hoc signature verification and the 15 changed desktop files' source hashes
passed. Normal board launch worked, but Home navigation then blocked on a
synchronous directory scan. A CLI diagnostic launch reached Home, Overview and
Team sessions; that does not establish normal-launch acceptance. The optional
Home starter-pack detector scans arbitrary recent project roots synchronously,
matching the blocked native call, though the exact blocked path was not captured.

The first follow-up moved starter project-marker reads into a dedicated worker.
Normal Home, Overview and Team sessions then loaded, but quitting blocked in
Node's Worker::JoinThread while the worker remained inside a native directory
open. The local candidate and sample are retained; beta.69 was cancelled before
staging. The earlier beta.68 dispatch selected main's older workflow and was
cancelled before staging; the gated workflow remains required.

The revised follow-up isolates every starter project-marker read in a dedicated
child process with a 1.5-second deadline and explicit termination. Pending reads
remain single flight until actual exit; a 45-second cooldown follows folder
paths, unaffected by changing activity timestamps. Child output is discarded;
folder inputs and the closed metadata response use IPC only. Ineligible cards
skip usage/folder scans, and dismissal, installation, navigation and close retire
late suggestions. Native FIFO-blocked process tests, natural parent exit and
positive detection are covered; Home/starter regressions passed 38/38. Frozen
follow-up CI and normal installed Home plus shutdown acceptance remain required
before calling that issue resolved.

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
