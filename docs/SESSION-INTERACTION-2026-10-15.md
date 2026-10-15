# Session interaction implementation — 15 October 2026

## Public beta.82 and preserved installed beta.74 — 15 October 2026

Public desktop preview `1.0.2-beta.82` is frozen at `c9ec7ef241b9160eaa0c1b1960434caf0c5200ae`.
Build/stage `38793491891` and signed promotion `38796721608` passed.
Notes-only PR #14 merged to main `777ceb9cc006f92fe46279dd41c24446b34b81a2` after staged-package
acceptance; implementation PR #7 remains draft and unmerged.

Mac passed native 50/50, root 4,951 with 12 skipped, remote 220/220 and board
3,107/3,107. Linux passed root 4,942 with 21 skipped, remote 220/220 and board
3,106 with one skipped. Both packaged smokes and Windows native 69+166+71
checks passed with no failures or cancellations. Windows installers remain
unpublished; Mac x64 runtime acceptance and notarization remain open.

The public signed manifest, both feed sizes/SHA512, six installers, GitHub
tag/source/notes/asset sizes and downloaded arm64 ZIP match staging. The isolated
arm64 package matches all 31 checked runtime/privacy files; strict signatures,
universal guard with empty entitlements in both slices, four unauthorized-launch
refusals and isolated smoke passed. Initial empty-plist checker diagnostics are
retained separately from the corrected passing parser. This is isolated package
evidence, not installed beta.82 account or restart acceptance.

The matching website is deployed at `https://9b007918.plexiform-site.pages.dev`.
Thirty site tests, 152 frozen inputs/notes and 118 staged hashes passed. A provider
receipt binds that successful production deployment to the exact frozen source.
The deployment URL's download and changelog HTML match the payload byte for byte;
the public domain returns HTTP 200 and adds Cloudflare email protection and
analytics. The strict raw canonical-byte mismatch is retained.
A separate saved-response proof (`work/beta82-canonical-rewrite-proof-zSqYlc/receipt.json`)
reverses only the exact protected support href, pinned email decoder and pinned
HTTPS/SRI beacon, restoring every remaining byte to the staged payload. Both
pages have the same bounded beacon configuration. Independent adversarial
review passed 21 invalid variants. Raw canonical hashes remain different; no
analytics runtime, cookie or privacy/legal acceptance is inferred.
Waitlist GET remains HTTP 405. Gallery stays on; phone, public signup and Windows
download flags stay off. A real browser shows beta.82 and all six installer links.

Fresh Google browser sign-in reached Callum's team, and a final browser reload
still shows Live. Curl confirms both web OAuth methods enabled, email disabled
and push enabled. GitHub's separate identity reaches Create or join a team;
access to the existing Google team through GitHub remains unaccepted. No team
or invitation was created.

Installed beta.74 at `4a7f050c568df47083927ec74797104620accf6f` remains open.
It had restored the saved account after direct owner Keychain approval, then
exposed the stale cached local Board binding. The fix retires that binding while
preserving Home/Overview or an explicit local-board choice. Related tests 261/261,
independent routing/startup 27/27 and synthetic actual-Electron scenarios 3/3
passed; exact beta.74 controls reproduce the defect. The desktop runtime is
byte-identical across the synthetic-tested frozen beta.75 and public beta.82;
subsequent changes harden test fixtures and update notes/site metadata.

An owned temporary Claude continuation was observed in installed beta.74. It uses
no session persistence; an empty or evicted Sessions view does not establish that
its backend ended. No authoritative end receipt is available, and a disk backup
cannot restore that in-memory context or an unsent reply. During this publication
pass, no End, Send, Quit or replacement installation was performed. Native beta.82 account/Board/Quit/fresh-
restart acceptance is deferred. The 25 checked SQLite snapshots and retained
local beta.73 backup, original checkouts/private .omc, failed evidence, legacy
MCP 5445/6076 and caffeinate 41145 remain preserved.

Earlier beta.75–81 failures, including the cancelled beta.79 typo, remain
recorded below and in the task workspace. The final beta.82 result is independent
of those failures; no production guard or deadline was relaxed. Original
Cloudflare installation 170293601 remains per the owner's explicit skip; the
gallery key backup/restore is verified in local login Keychain only, with
off-device/offline backup still open.

External teammate/device/provider acceptance, executable next-turn queues,
proposals/granular delegation and universal shared-checkout overwrite prevention
remain incomplete. The full current report and browser screenshot are in the
adjacent task's `outputs/session-interaction-validation.txt` and
`outputs/public-beta82-download.png`. No whole-vision completion is claimed.

## Historical beta.74 checkpoint — 15 October 2026

Public and installed beta.74 is frozen at `4a7f050c568df47083927ec74797104620accf6f`.
Build/stage `38771091656` and signed promotion `38774498360` passed. Notes-only
PR #13 merged to main `b434ce5a`; implementation PR #7 remains draft/unmerged.
Mac native 49/49, root 4,932 passed/12 skipped, remote 220/220, board 3,107/3,107;
Linux root 4,923 passed/21 skipped, remote 220/220, board 3,106 passed/one skipped.
Both packaged smokes and Windows native 69+166+71 checks passed. No Windows
installers published; Mac x64 runtime acceptance and notarization remain open.
Public signatures/feeds/six installers, GitHub source/notes/HEAD sizes and the
downloaded arm64 ZIP/staged SHA256 match. Site `fe84befe` deployed at
`https://fb51c908.plexiform-site.pages.dev`; site tests 30/30 and 118-file staging
provenance plus live HTML/GET405 checks pass. Browser policy-service failure
continues to prevent fresh real-browser acceptance.

The installed public package matches 31 changed runtime/privacy files; its native
guard is universal with empty entitlements, four unauthorized launches were denied,
and isolated public/installed smokes pass. Pending-Keychain navigation is usable.
After direct owner approval, the saved team account restored. A real routing defect
was then observed: restoring off a hub page retains the cached local board, so Board
can show local My board under a team workspace label. Local Live is not team Live.
A focused beta.82 follow-up is in progress; published beta.74 bytes are immutable.
Public team-board, Quit and unchanged-restart acceptance remain open. UI automation
is paused after concurrent app interaction and an owned Claude conversation appeared.

The new private backup `work/app-backups/20261015T171216Z-session-interaction` has
25 checked SQLite snapshots and retains accepted local beta.73. Legacy MCP
5445/6076, caffeinate 41145, old failed evidence and protected checkouts remain.
Safe visual failures reproduced against beta.72; eight acceptance exclusions remain.
Full current evidence is in the adjacent task's `outputs/session-interaction-validation.txt`
and `outputs/beta74-visual-assessment.txt`. No external teammate/device acceptance
or universal shared-checkout overwrite prevention is claimed.

## Earlier publication checkpoint (before beta.74)

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

## Beta.75 failed build and beta.76 preparation

Release run `38777606934` at frozen source `5461acac` failed before staging;
no beta.75 installers, feed change or website deployment occurred. Mac/Linux
root suites each found one obsolete source assertion that omitted the new hub
binding guard. Mac root: 4,950 passed, one failed, 12 skipped; Linux root:
4,941 passed, one failed, 21 skipped. Remote 220/220 passed on both. Mac board:
3,106 passed, one failed; Linux board: 3,106 passed, one skipped. Mac native
49/49 and Windows native 69+166+71 passed. Failed logs are retained.

The Mac sharing fixture could request its independent held turn before the
previous steer completed, ignore a busy refusal and poll for a turn that never
started. The test now waits for that exact completion, asserts the new-turn
acknowledgement and checks the remote held turn before interrupting it. No
production rate limit or runtime code was changed by these test repairs. Focused
routing/action regressions pass 39/39 and sharing contracts pass 21/21.

Installation remains deferred: the previously observed no-persistence Sessions
conversation may survive even when its renderer no longer displays the controls.
The live backend has no read-only inventory exposed to this UI. No End, Send,
Quit or install action was issued against that conversation. A disk backup cannot
restore its in-memory provider context or an unsent reply.

## Beta.76 retained failures and beta.77 fixture correction

Release run `38780052146` at frozen `bc7ccd1e` failed before staging in both
attempts. Linux passed: root 4,942 plus 21 skips, remote 220, board 3,106 plus
one skip, and packaged smoke. Windows native 69+166+71 passed.

Mac attempt one passed native49, root4,951 plus12 skips and remote220, then
board3,105 passed/two failed. Both failures were an extra single process-table
observation after the backend had already returned a verified stop and was
not alive. The known stop fixture passed9/9 in isolation; an unchanged failed-job
retry preserved every assertion. Unknown process-table evidence and observed
live processes both fail that probe; the failed boolean cannot distinguish them.

Attempt two passed native49, remote220 and all3,107 board tests, including those
stop cases. Root passed4,950/failedone/skipped12: the task-message test selected
a speed40 demo run that could change state while openTask awaited the socket.
The stale-action guard correctly returned ILLEGAL_TRANSITION. The test now
selects a stable in_review task advertising message and still requires the real
Unix-socket round trip and exact human-message event. Its21 checks pass.

No beta.76 package, public feed or website update occurred. Both attempts and
the classification are retained in the task workspace. Beta.77 will carry the
same routing runtime; no production process-stop or task guard was relaxed.

Fresh browser checks recovered: GitHub OAuth signs in but its separate identity
reaches Create or join a team, without the existing Google-team membership.
A subsequent fresh Google sign-in as callum@pistorventures.org reached Callum's
team Board with Live status. No team was created/joined and no invite was sent.
The browser was restored to the Google team board. This supersedes earlier
browser-policy-service unavailability; native77 acceptance remains separate.

## Beta.77 stop-fixture observation and beta.78 preparation

Run `38784500243` at frozen `18aced9c` failed before staging. Mac native49,
root4,951 plus12 skips, remote220 passed; board3,106 passed/one failed. Linux
root4,942 plus21 skips, remote220, board3,106 plusone skip and packaged smoke
passed; Windows native69+166+71 passed. The task-message fixture now passes.

The remaining Codex stop case again failed only the extra timeout0 process-table
observation, after b.stop returnedtrue and the backend was not alive. Across76/77
the extra observation affected allthree adapters; no retained rows identify
whether those failures were unknown metadata or a live owned process. No actual
receipt violation or a specific kernel cause is asserted from that boolean.

The disposable fixture now waits for the tool's ready handshake after both
SIGTERM handlers exist, verifies both detached groups and the root's discovery
of its tool, and preserves its recorded identity through failed later reads.
After the unchanged production stop and not-alive assertions, one bounded real
ps snapshot includes the observer, each exact owned PID (even if its group
changes), and every member of each owned group. Exact owned identities must
be absent or zombies; the existing timeout0 helper also verifies all owned
groups against that same frozen snapshot. Unknown owned metadata and unreadable
observations fail, with bounded PID/PGID/STAT diagnostics. Unrelated process
status churn is outside this independent owned-scope assertion. No post-stop
wait or retry was added and no production guard/deadline changed.

All9 stop checks pass, including a further run under two controlled disposable
process-churn workers. Independent review retained PID, group, observer and
cleanup coverage. Real provider sessions and installed74 were untouched. Beta.78
will use unchanged routing runtime; public74 and all failed evidence remain.

## Beta.78 billing sentinel and beta.79 preparation

Run `38787326030` at frozen `882c4b88` passed Mac's native/root/remote/board
unit acceptance, including all revised stop cases. Linux root4,942 plus21 skips
and remote220 passed, but board3,105 passed/one failed/one skipped. The failure
was the billing privacy test's raw search for four digits4242 in every database
value, including random UUIDs and token hashes. The exact colliding row was not
logged, so that cause is plausible rather than proven from the old CI output.
No staged package or publication is accepted from this run.

The test now deliberately persists a valid provider customer ID containing4242,
while all three accepted webhook fixtures retain their original card canaries.
It rejects exact string/numeric last4 values throughout all rows, including
nested and JSON-encoded values, and retains the raw long fingerprint/address/
brand/email canary checks plus entitlements/billing-events schema assertions.
This distinguishes legitimate identifier substrings from card values. All7
billing checks pass; independent review found no remaining concrete issues.
No billing runtime, payment setting, production privacy guard or card data
handling changed. Beta.79 retains the same desktop routing runtime.

## Beta.79 cancelled dispatch

Run `38789254653` used the correct workflow-branch head `b9d1784a`, but its
checkout input contained a mistyped full source hash. The release operator
requested cancellation immediately, before staging/publication. No beta.79
package or feed change is accepted. The next dispatch reads the exact ref from
Git rather than manually transcribing it. Beta.80 retains the same reviewed
fixtures and desktop runtime.

## Beta.80 ticket tampering fixture and beta.81 preparation

Run `38789411498` at frozen `dcaa5d1c` failed Linux board tests before
staging. Linux root passed 4,942 with 21 skipped, remote passed 220, and board
passed 3,105 with one failure and one skip. The sync ticket-tampering test
replaced a random UUID's final character with `0`; when already `0`, the request
was unchanged and correctly accepted. The fixture now guarantees a different
path and asserts inequality before checking the existing HTTP 403 refusal.
Size, hash, device and expiry checks and production sync code are unchanged.
Focused sync tests pass 8/8. Mac passed native 49/49, root 4,951 with
12 skipped, remote 220/220, board 3,107/3,107 and packaged smoke. Staging was
skipped because Linux failed. No beta.80 publication or website deployment occurred.

An analogous audit found three Slack test cases replacing a random HMAC suffix
with fixed `AA`, which could also be unchanged. Those test mutations now guarantee
a different canonical suffix and explicitly verify inequality while retaining
the original rejection assertions. Focused Slack tests pass 85/85; all 16 valid
SHA256 base64url final characters were checked to remain canonical and change
the decoded signature bytes. No production authentication code changed.
Beta.81 retains the same desktop runtime as the frozen synthetic-tested beta.75
source; installation over the owner's live beta.74 continuation remains deferred.

## Beta.81 native supervisor observation and beta.82 preparation

Run `38791472396` at frozen `208f6efa` failed Mac's native bootstrap-cutoff
test: 48 passed and one failed. Its immediate assertion required the child's
exitCode/signalCode to be set when open rejected. Production intentionally
returns after its absolute deadline with renewal blocked if reaping is still
pending, and keeps that block until the captured child's close event. A slow
synchronous launch can consume the fixture's 200 ms budget before timers are
installed; the deadline then leaves only a minimal close-event wait. The failed
assertion alone does not establish that the child escaped SIGKILL.

The fixture correction checks the kill request, the separate close receipt, and
a deterministic held-close case that refuses replacement launches until cleanup
is observed. Production deadlines, SIGKILL behavior and fail-closed renewal
remain unchanged. Focused native supervisor checks pass 5/5, including both
changed cases independently (2/2); the complete local native suite passes 50/50.
Linux's full unit step passed and continued to packaging; exact final receipts
are retained separately. Windows native checks passed 69+166+71. No beta.81
staging or publication is claimed.
