# Session interaction implementation — 15 October 2026

## Current release and local candidate

Public downloads remain `1.0.2-beta.72` at frozen source
`09b4495146dd27d1cd8f7e0275344103f8777035`. Build/stage
[38717768703](https://github.com/CallumJB125/claude-traffic-light/actions/runs/38717768703)
and signed promotion
[38761070371](https://github.com/CallumJB125/claude-traffic-light/actions/runs/38761070371)
passed, and the beta.72 site remains deployed. No newer release was staged or
published. Implementation PR #7 stays draft and unmerged.

The installed app is now a **local beta.73 candidate** from
`9120098147959b01e249eeb437e4a59dd3c55220`. Its 31 changed runtime/privacy files,
deep/strict ad-hoc signature and candidate/installed isolated smoke checks pass.
Real installed Board, Home, Overview and Team sessions remain responsive while
Keychain authorization waits in the isolated crypto process. Normal Quit exits
both GUI and credential child while authorization is pending. After the owner
completed the OS prompt directly, the retained account restored into Callum's
team with Live board state; navigation and signed-in Quit passed.

After the owner completed Always Allow, the next unchanged fresh restart restored
the team and Live board without another authorization step. Home, Overview,
Team sessions and normal Quit passed. No security setting or Keychain ACL was changed by automation;
Computer Use cannot operate the system security dialog. Zero sessions are shared
with this team and some activity remains unavailable; no real teammate was
shared or messaged. Public beta.72's earlier blank/blocked-launch evidence remains
below and does not describe the candidate's responsive UI.

## Implemented behavior

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
- Final beta.71 build/stage run `38713970039`, source `af711c57`: Mac root
  4,839 passed, 12 skipped /4,851; remote 220/220; board 3,107/3,107; native
  Darwin 48/48. Linux root 4,830 passed, 21 skipped /4,851; remote 220/220;
  board 3,106 passed, one skipped /3,107. Zero failures or cancellations.
  Packaged Mac arm64 and Linux x64 smokes passed. Mac x64 installers built;
  there is no Mac x64 runtime smoke. The Windows native-filesystem gate passed
  69 directory-DACL, 166 private-file-reader and 71 owned-publication/control
  checks, without publishing Windows installers.
- Real Codex CLI `0.162.0-alpha.17.2` and Claude `2.1.300`: isolated empty
  sessions, disabled tools, exact marker accepted, literal input echo recorded,
  response completed, untouched sibling received zero deliveries.
- Actual Electron Overview UI, preload, main/service, real loopback accounts
  hub, owner host and TeamHubClient, with two clearly labelled local identities
  and real Codex/Claude: Claude send completed with its exact marker, unsupported
  steering stayed disabled and the unsent draft remained local. Codex selected
  send returned the marker; current-turn steering
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

Beta.71 signed promotion `38716434781` passed. Independent public verification
confirmed the Ed25519 manifest signature, product/channel/version, expiry, six
Mac/Linux entries and both feeds' sizes/SHA-512 values. The arm64 ZIP's SHA-256
`68978afa3b9aa56af00cb7b0d61f90297fd18925915e8c43b1a99792bed131f1`
matches the authoritative staged artifact. No Windows installers were published.
The changelog/site prepared at `53f58cb5bc4288d4c8d6c0f15f994304ad07e570`
was deployed to `https://1fadf9e4.plexiform-site.pages.dev`; live browser downloads
resolve all six links to beta.71. Live changelog reads show beta.71, and a GET to
the preserved waitlist function returns the expected HTTP 405.

After private app/data backup, the verified public arm64 package replaced the
local candidate in `/Applications/Plexiform.app`. The package and installed
copies match frozen source for all 19 changed desktop runtime files plus
`PRIVACY.md`; ad-hoc signature verification and isolated installed smoke passed.
Normal launch initially showed "Work with a team" rather than the previous team
connection. The owner later cleared macOS Keychain authorization and public
beta.71 reconnected as Callum Baker into existing Callum's team with Live state.
Normal Home, Overview, Team sessions and clean Quit passed. Team sessions showed
zero shared sessions and "Some activity is unavailable"; no real teammate was
shared or messaged. The app was closed and private data was backed up again with
25 checked SQLite snapshots at `work/app-backups/20261015T151256Z-session-interaction`.
Persistence through the beta.72 public update remains to be checked.

The following beta.67 and local-candidate observations preserve the path to the
final Home fix; they are historical evidence, not the current public version.

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
positive detection are covered. Final focused privacy/Home/starter/quit checks
passed 66/66. A local packaged candidate at `2adb08c0` passed normal Applications
launch, Home, Overview, Team sessions and clean Quit. Beta.70 CI then caught a
missing privacy-inventory annotation for the new local helper process. That test
was preserved and the actual fork plus `PRIVACY.md` were annotated; `af711c57`
changes documentation/annotations only beyond the tested process behavior.
Beta.71's complete Mac/Linux CI passed at that final source. The final public
installation/source/signature/smoke checks passed, as did normal navigation and
clean Quit after the owner's Keychain authorization and reconnection. Retaining
that desktop team connection through the beta.72 update remains a
separate acceptance check as recorded below.

The desktop Google PKCE sign-in completed after the owner entered their password
directly: Callum Baker, existing Callum's team, board Live. Chrome displayed
`ERR_BLOCKED_BY_CLIENT` on the localhost return and the app briefly paused for
about 34 seconds, then completed sign-in and responded. The exact pause cause is
unproven. Team sessions resolved the team with zero shared sessions and a
"Some activity is unavailable" notice. No real teammate was shared or messaged.
The signed-in private app data was backed up before the public update. The final
public app initially did not retain the team connection on normal launch. After
the owner cleared the Keychain prompt, public beta.71 reconnected with Live team
state and passed normal navigation/clean Quit. The newer post-reconnection backup
is recorded above; beta.72 must still establish persistence through the update.

## Published beta.72 retained-account follow-up

Source review found that the live-team subscription could construct and read the
account vault before Electron secure storage was ready, then cache the account
as absent. Workspace initialization could also replace the remembered team choice
with local while sign-in was temporarily unavailable. At frozen source
`09b4495146dd27d1cd8f7e0275344103f8777035`, the subscription starts after readiness,
unavailable/decryption-failed credential reads remain retryable, and validating
the saved workspace no longer consults transient credential availability.
Sealed account data and the remembered team choice are retained. Focused
auth/lifecycle checks passed 226/226. The local beta.72 package matches all 22
changed runtime/privacy files at the frozen source; ad-hoc signature verification
and isolated packaged smoke passed. Attempt 1 of CI `38717768703` passed Mac root
4,843, 12 skipped /4,855; remote 220/220; board 3,107/3,107; native Darwin 48/48;
and Mac arm64 packaged smoke. Its Windows native-filesystem gate passed 69+166+71
checks without installer publication. Linux root passed 4,834, 21 skipped /4,855
and remote passed 220/220. Linux board had 3,105 passed, one skipped and one failed:
`no card data is ever stored: only provider ids, plan, seats and period`, with the
synthetic assertion reporting `stored:4242`. Staging was skipped. Failed logs are
retained at `work/beta72-linux-job.log`; the unchanged isolated billing test then
passed 1/1. A fixture collision is unproven. Only the failed Linux job was rerun
as attempt 2 at the same frozen source, without source edits. The privacy
assertion was not weakened or removed.

Attempt 2 passed: Linux root 4,834, 21 skipped /4,855; remote 220/220; board
3,106 passed, one skipped /3,107, and Linux x64 packaged smoke. The successful
Mac and native Windows jobs were retained. Both package smokes and complete
staging passed: six Mac/Linux installers, feed files, 12 checksum entries and
13 R2 objects; no Windows installers. The staged arm64 ZIP's SHA-256 is
`06fbf631cce3f1d9d5c004b53344621cf71a17ae1c4c00e428378fc535a18b59`.
Full-run success does not explain the first Linux assertion failure; its raw
evidence remains retained. Release-notes-only PR #12 was merged for publication.
Signed promotion `38761070371` passed. GitHub prerelease/source/final notes and
independent public verification passed: signature, channel, expiry, six-entry
Mac/Linux matrix, both feeds' sizes/SHA-512 values and the arm64 ZIP hash. The
public ZIP matches staged SHA-256
`06fbf631cce3f1d9d5c004b53344621cf71a17ae1c4c00e428378fc535a18b59`.
All six public GitHub installer HEAD requests returned HTTP 200 with exact
expected sizes; evidence is retained in `work/beta72-public-download-heads.json`.
The beta.72 site build and 30/30 tests passed. The 118-file output from commit
`aadd9afb0ace9c9ff2f535f06f0d0de35c239971` was deployed to
`https://be3c1e09.plexiform-site.pages.dev`. Live changelog and download HTML pass
read-only curl checks; waitlist GET returns the expected HTTP 405. Hub auth methods
confirm Google/GitHub web enabled, email disabled and push enabled. The beta.72
real-browser refresh remains unchecked because browser automation fails its
internal policy service before site access; no alternate bypass was used.

Public beta.71 reconnection reached a macOS Keychain authorization prompt.
A retained sample places the read inside `SecItemCopyMatching`; the owner later
cleared the prompt directly. Public beta.71 then connected and passed normal
navigation/clean Quit. This is not normal beta.72 UI or update-persistence
acceptance.

The verified public beta.72 arm64 package passed exact 22-file/runtime/privacy
comparison, ad-hoc signature verification and isolated smoke, then replaced
`/Applications/Plexiform.app` atomically. The installed copy passed those checks
again. Public beta.71 is preserved alongside the 25 checked SQLite snapshots in
`work/app-backups/20261015T151256Z-session-interaction`. Normal beta.72 launch is
waiting inside macOS Keychain `SecItemCopyMatching`; the new signature needs the
owner's OS authorization. No new pre-readiness unreadable-account log was emitted.
The fix does not bypass that authorization. Normal retained-sign-in,
Home/Overview/Team sessions navigation and clean Quit remain pending the owner;
source/signature/isolated-smoke results do not establish those outcomes.

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

### Final native acceptance status

The owner cleared the beta.72 Keychain prompts, including reporting Always Allow.
Startup then resumed, but both widget and main windows were blank. Both processes
quit cleanly. A fresh launch still blocked in `SecItemCopyMatching`; the retained
sample is `work/beta72-final-restart-sample.txt`. No further native acceptance is
claimed: signed-in restoration, rendered navigation and a usable fresh restart
remain open. Post-launch source hashes and deep/strict signature verification
still match the public package. No Keychain ACL or OS security setting was changed
by automation. The system security dialog cannot be controlled by Computer Use.

## Async account startup candidate — local only

`db398da6` adds cache-only asynchronous account restoration, awaited encrypted
saves with generation/cancellation fences, explicit retry after a failed read,
and remembered-workspace preservation during concurrent hub hydration.
`91200981` isolates packaged Mac account crypto in a disposable process because
Electron's native worker can remain alive on Quit while Keychain waits. A fixed
native guard checks kernel ancestry, executable/code identity, GUI registration,
startup mode and stable process lifetime before any credential request. Account
text uses private in-memory pipes, never argv/environment/logs/plaintext files.
Four packaged unauthorized-launch tests passed, including Electron Node mode.
The native guard is universal and signed with empty entitlements. Linux's secure
backend guard remains synchronous, as do existing runner/native-board credential
paths; they are outside this fix's nonblocking claim. This user profile has no
saved runner or native-board connection files.

The direct-async candidate's failed native Quit and samples are preserved. The
isolated candidate passed pending-authorization navigation/Quit and post-approval
saved-account restoration/navigation/Quit. Its unchanged fresh restart again
waits for OS authorization; persistent trust is still an owner-controlled gate.
Screenshots and process evidence are in the adjacent task outputs/work folders.
Latest completed data backup contains 25 checked SQLite snapshots, with the
failed direct-async app retained; public beta.72 is retained in the prior backup.
Legacy MCP processes and caffeinate remain untouched.

Final root run: 4,932 passed, 11 skipped and one updater-helper failure /4,944;
its unchanged focused rerun passed 1/1. Earlier affected privacy/harness checks
were repaired and passed 58/58 focused checks. Native run: 42 passed, seven existing
Setups failures /49; the exact two failed files passed 25/25 unchanged separately.
All failures remain retained. Their exact causes are unproved; do not call these
clean full runs or real-device updater acceptance. Logs are
`work/account-isolation-root-final-tests.log`,
`work/account-isolation-updater-targeted-retry.log`,
`work/account-isolation-native-tests.log` and
`work/account-isolation-native-targeted-retry.log` in the adjacent task workspace.
Hub auth methods still report Google/GitHub web enabled, email disabled and push
enabled. Browser refresh remains unchecked after the earlier policy-service
failure; no bypass or provider configuration change was attempted.

## Accepted unchanged candidate restart — 15 October 2026

The owner completed Always Allow directly. The next unchanged installed launch
restored the retained Callum Baker account, Callum's team and Live board without
another authorization step. Home, Overview, Team sessions and normal Quit passed;
both GUI and credential child exited. Package executable/ASAR hashes are unchanged
from before approval. Evidence is `work/account-isolated-fresh-accepted.json` and
`outputs/async-startup-fresh-restored.png` in the adjacent task workspace. Earlier
pending restart observations remain history; this result supersedes that gate for
this exact local candidate. It is not public-package or updater-device acceptance.
Public beta.72 remains live while the next build/stage gates are prepared.
