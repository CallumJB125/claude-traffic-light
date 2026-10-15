# Plexiform owner work — 2026-10-14

Implementation branch: `codex/owner-decisions-2026-10-14`, based on `08f46dd8`.
Beta.65 tested app/runtime revision: `1adca098cf451fc6bcab6cffcd237591b4fc6c4b`.
The subsequent session-interaction implementation and its separate evidence are
recorded in [SESSION-INTERACTION-2026-10-15.md](SESSION-INTERACTION-2026-10-15.md).
The original `claude/release` checkout and handover are preserved. Implementation
PR #7 remains unmerged. The owner subsequently authorized public beta publication;
the release-note-only PR #8 was merged into `main` for the signing workflow.

## Public beta.74 and routing follow-up — 15 October 2026

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
A focused beta.77 follow-up is in progress; published beta.74 bytes are immutable.
Public team-board, Quit and unchanged-restart acceptance remain open. UI automation
is paused after concurrent app interaction and an owned Claude conversation appeared.

The new private backup `work/app-backups/20261015T171216Z-session-interaction` has
25 checked SQLite snapshots and retains accepted local beta.73. Legacy MCP
5445/6076, caffeinate 41145, old failed evidence and protected checkouts remain.
Safe visual failures reproduced against beta.72; eight acceptance exclusions remain.
Full current evidence is in the adjacent task's `outputs/session-interaction-validation.txt`
and `outputs/beta74-visual-assessment.txt`. No external teammate/device acceptance
or universal shared-checkout overwrite prevention is claimed.

## Earlier local startup candidate — 15 October 2026

Public downloads remain beta.72. The installed app is a local beta.73 candidate
at `9120098147959b01e249eeb437e4a59dd3c55220`, not a public release. Responsive
pending-Keychain navigation and Quit passed. Owner-approved saved-account
restoration into Callum's team, Live board, Home/Overview/Team sessions and Quit
also passed. After direct owner Always Allow, the next unchanged fresh restart
restored automatically; navigation and clean Quit passed. No new release was staged or
promoted. Full evidence, retained failures and scope limits are recorded in
[SESSION-INTERACTION-2026-10-15.md](SESSION-INTERACTION-2026-10-15.md).

## Public beta.72 release evidence

The following beta.72 installation observations predate the local candidate.

The public desktop release is `1.0.2-beta.72`, frozen source
`09b4495146dd27d1cd8f7e0275344103f8777035`. Its
[build/stage run](https://github.com/CallumJB125/claude-traffic-light/actions/runs/38717768703)
and [signed promotion](https://github.com/CallumJB125/claude-traffic-light/actions/runs/38761070371)
passed. Final Mac root: 4,843 passed, 12 skipped; remote 220/220; board 3,107/3,107;
native Darwin 48/48. Final Linux root: 4,834 passed, 21 skipped; remote 220/220;
board 3,106 passed, one skipped. The first Linux failure and unchanged-source
retry remain recorded below. Final checks have zero failures/cancellations. Mac arm64 and Linux
x64 packaged smokes passed; Mac x64 installers built without a runtime smoke.
The Windows native filesystem gate passed 69+166+71 checks, but Windows installer
publication and broader runtime/privacy acceptance remain gated. Mac remains
ad-hoc signed and not notarized.

Team sessions now opens the selected live activity/conversation and supports
reviewed Send, Steer and Interrupt where the explicit share and provider permit.
Generation/turn binding, watch-only access, revocation clearing and uncertain
delivery handling are covered. Real Codex/Claude checks used two local test
identities, not external people/devices. Durable executable next-turn queues,
owner-reviewed proposals, new granular delegation records and universal conflict
prevention remain unimplemented. The historical design below retains that scope.

Normal installed beta.67 Home exposed synchronous project scanning. The first
worker fix made Home responsive but hung Quit; it was not published. The final
killable child-process fix passed local normal launch/navigation/clean Quit and
66 focused privacy/Home/starter/quit checks, followed by complete beta.71 CI.
Historical beta.71 verification: public manifest signature/product/channel/version/expiry, six-entry
Mac/Linux matrix and both feed size/SHA-512 checks passed. The downloaded arm64
ZIP matches staged SHA-256
`68978afa3b9aa56af00cb7b0d61f90297fd18925915e8c43b1a99792bed131f1`.
The site at `https://1fadf9e4.plexiform-site.pages.dev` is deployed, the live
changelog shows beta.71, all six browser download links resolve to beta.71, and
the waitlist GET retains its expected HTTP 405. The public arm64 app is installed;
19 runtime files plus `PRIVACY.md`, ad-hoc signature and isolated smoke match.

The owner completed Google desktop sign-in into existing Callum's team with Live
board state. A localhost browser error did not prevent completion; the transient
34-second app pause is retained as unresolved evidence. No external session was
shared or messaged. The post-sign-in private backup is
`work/app-backups/20261015T094804Z-session-interaction` in the adjacent task
workspace. Normal launch of public beta.71 initially showed "Work with a team"
rather than the earlier team connection. After the owner cleared macOS Keychain
authorization, the public app reconnected to Callum's team with Live state and
passed normal Home, Overview, Team sessions and clean Quit. Team sessions had
zero shared sessions and "Some activity is unavailable"; no real teammate was
shared or messaged. The app was closed and a new private backup with 25 checked
SQLite snapshots was saved at `work/app-backups/20261015T151256Z-session-interaction`.
Sign-in persistence through the beta.72 update remains open.

The beta.72 startup fix is frozen at
`09b4495146dd27d1cd8f7e0275344103f8777035`. Live-team identity subscription now
waits for Electron readiness, temporarily unavailable/decryption-failed credential
reads remain retryable, and transient sign-out no longer replaces the remembered
team workspace with local. Focused auth/lifecycle checks passed 226/226. Its local
package matches all 22 changed runtime/privacy files and passes ad-hoc signature
verification plus isolated smoke. Attempt 1 of CI `38717768703` passed Mac root
4,843, 12 skipped /4,855; remote 220/220; board 3,107/3,107; native Darwin 48/48
and arm64 packaged smoke. Its native Windows gate passed 69+166+71 checks.
Linux root passed 4,834, 21 skipped /4,855 and remote 220/220. Linux board had
3,105 passed, one skipped and one failure in `no card data is ever stored: only
provider ids, plan, seats and period`; staging was skipped. The synthetic assertion
reported `stored:4242`. Failed logs remain in `work/beta72-linux-job.log`.
The unchanged focused billing test passed 1/1, but a fixture collision is unproven.
Only the failed Linux job was rerun as attempt 2 at the same frozen source,
without source edits or weakening the privacy assertion. That retry passed:
Linux root 4,834, 21 skipped /4,855; remote 220/220; board 3,106 passed, one
skipped /3,107 and packaged smoke. The earlier Mac/native successes were retained;
both package smokes and six-installer/feed staging passed, with no Windows
installers. Twelve checksum entries and 13 R2 objects verified; staged arm64 ZIP
SHA-256 is `06fbf631cce3f1d9d5c004b53344621cf71a17ae1c4c00e428378fc535a18b59`.
The first failure remains unexplained and preserved. Release-notes-only PR #12
was merged; signed promotion `38761070371` passed. GitHub prerelease/source/final
notes and independent public manifest signature/channel/expiry/six-entry matrix,
both feed sizes/SHA-512 and downloaded arm64 ZIP verification passed. The public
ZIP matches the staged SHA-256 above. All six public installer HEAD requests
returned HTTP 200 with exact expected
sizes (`work/beta72-public-download-heads.json`). The site at commit
`aadd9afb0ace9c9ff2f535f06f0d0de35c239971` builds and passes 30/30 tests. Its
118-file output is deployed to `https://be3c1e09.plexiform-site.pages.dev`;
live changelog/download HTML curl checks pass and waitlist GET remains HTTP 405.
A sample of the earlier public beta.71 reconnection wait shows
`SecItemCopyMatching`; the owner cleared that OS prompt directly and beta.71 normal
team connection/navigation/clean Quit then passed.

The public beta.72 arm64 package and atomically installed copy match all 22
runtime/privacy files at the frozen source, pass ad-hoc signature verification
and pass isolated smoke. The previous public beta.71 app is preserved with the
25 checked SQLite snapshots in the latest `151256Z-session-interaction` backup.
Normal beta.72 launch waits inside macOS Keychain `SecItemCopyMatching` for the
owner to authorize the new app signature; no new pre-readiness unreadable-account
log appeared. This fix does not bypass OS authorization. Retained sign-in,
Home/Overview/Team sessions navigation and clean Quit remain pending. Browser
automation failed its internal policy service twice before site access, so the
beta.72 real-browser refresh is unchecked; no bypass was used.

Staging and production hub are at
`88c9817d162e173bfed75324c895398b7aeafd0a`; later Home changes are app-only.
Health/auth and the authenticated browser board are live. Google/GitHub web and
push are configured; production email is OFF. Current rollback backups:

- `/opt/buddy-hub-staging/owner-backup-20261015T083517241743Z`
- `/opt/buddy-hub/owner-backup-20261015T083627048062Z`

Implementation PR #7 remains draft/unmerged. Release-note-only PRs #8–#12 were
merged for publication. No original checkout, private data or failed evidence was
discarded. The sections below preserve the earlier beta.65 evidence and design;
they are historical snapshots rather than the current release state.

## Historical beta.65 publication

`1.0.2-beta.65` is published for Mac (arm64/x64) and Linux (x64), from frozen
source `6375c805bb07b43c5cdb329f07aaaeeee302d1be`. Runtime code is unchanged from
the installed, verified `1adca098`; subsequent changes prepare notes/site copy
and deterministic release tests. The site's live browser download page resolves
all six installer links to beta.65. Windows remains unavailable.

[Build/stage run](https://github.com/CallumJB125/claude-traffic-light/actions/runs/38632768053)
and [signed promotion](https://github.com/CallumJB125/claude-traffic-light/actions/runs/38634807144)
passed. Mac: root 4,752 passed, 12 skipped; remote 220 passed; board 3,106 passed;
native Darwin 48 passed. Linux: root 4,743 passed, 21 skipped; remote 220 passed;
board 3,105 passed, one skipped. No failures/cancellations. Both packaged smokes
passed. The native-directory job passed, without enabling Windows publication.

The public beta manifest's Ed25519 signature, version, channel, expiry, current
notes and six Mac/Linux entries were independently verified. Both feed files'
versions, sizes and SHA-512 values match the signed manifest. The public installer
dry run downloaded the arm64 ZIP and verified SHA-256 without replacing the app.
These checks do not establish a real signed version-to-version device update.
Mac remains ad-hoc signed and not notarized.

The static site changelog is deployed at
`https://1034b27a.plexiform-site.pages.dev` and verified on
`https://plexiform.dev/changelog`: the beta.65 entry is present, and the old blanket
keychain approval advice is removed. Site tests passed 30/30. The waitlist function
is preserved and returns the expected HTTP 405 to a read-only GET. Two Wrangler
attempts stalled during function compilation; byte-identical dist/functions files
staged outside Documents compiled and deployed successfully. Failed logs remain
in the adjacent task workspace. The exact protected file-open cause is unproven.

Failed runs 38630241589 (abbreviated-ref checkout) and 38630478009 (two Mac root
test failures) are preserved in the adjacent task workspace. Receipt fixtures now
observe rejection immediately and wait for exact events; real timeout/security
assertions remain. Root test files run serially so the unchanged 200 ms memory
benchmark is measured without unrelated fixture contention. No test was removed.

## Captured-session tabs

Cards created from local AI reports used controls designed for managed board runs.
They now show recorded activity and context, exact-session navigation, reported
files, and scoped handover refresh/copy/native export/continue/timeline actions.
Reported context imports into an explicit draft, retains edits across refreshes,
and saves through existing version/fence checks. Reported paths remain separate
from ownership declarations. Comments offers agent delivery only for a managed run;
historical handoff bodies render as text.

Main rechecks originating window, main frame, document epoch, URL, board/team,
workspace and sign-in marker after awaits. Identical-URL reloads retire document
identity. Session resolution rechecks sharing and exact card bindings. Native
export is parented to the originating window and rechecks sharing after the sheet.

## Team coordination acceptance gap

Plexiform does not yet universally prevent independent agents from undoing each
other's work. Captured sessions sharing a checkout remain observational. Collision
alerts occur after activity, declarations are advisory, and message receipts do
not require acknowledgement of the current decisions version before editing.
Managed Tasks normally use separate worktrees, but their in-place exclusion covers
only the engine's registry. General attributed undo detection is absent.

The product acceptance case is two people and two supported tools: shared current
context and ownership; conflict isolation/refusal before writes; rejection of
stale content and stale decisions; explicit acknowledged handoff; revocation and
disconnect safety; preserved rejected work; and successful integration of both
contributions. Tools that can only be observed must be labelled accordingly.
This is a source audit, not a replay of a real team incident or provider acceptance.

The next teammate-session steering design is recorded in
[TEAMMATE-SESSION-STEERING-2026-10-14.md](TEAMMATE-SESSION-STEERING-2026-10-14.md).
Start with the selected-session UI/client gap, then add owner-reviewed proposals,
granular delegation and durable next-turn queues. Watch, propose and delegated
action have separate boundaries. Codex expected-current-turn steering and other
providers' next-turn messages have distinct controls and receipts. Bind every
command to the reviewed session generation/turn and never automatically resend an
uncertain provider dispatch. Reuse the current durable stream before considering
Kafka. This is a design and acceptance plan, not shipped teammate steering.

## Owner-authorized capabilities

- Agent Mail is free, including Ask my AI. Inbox polling stays OFF; Send/Confirm
  remains required.
- Claude Tasks is enabled on macOS/Linux with Codex default. Windows is Codex-only.
- Entitlement public key is pinned; beta remains explicitly enabled. Private keys
  stay outside Git.
- Crash reporting requires renewed consent and sends structural fields only.
  Bounded private hub intake, schema validation, rate limits and retention exist.
- Separate phone Pages site, PKCE, narrow CORS and VAPID are deployed. Public phone
  remains OFF pending independent security and physical device acceptance.
- Linear/Jira delivery tooling and runbooks are ready; actual signed deliveries
  remain required before enabling/advertising.
- Signing/updater infrastructure is ready without Apple/Windows package-signing
  credentials, notarization or real signed updater/device acceptance. Privacy notice is live;
  qualified legal review remains open.

## Validation and installed Mac

- Local runtime root: **4,753 passed, 11 skipped /4,764**, zero failures/cancellations.
- Remote: 220 passed; site: 30 passed in the preceding sequential check; their
  production source is unchanged by the final app-only fix. Web: 441 passed.
- Final isolated captured-session integration passed with zero dispatches/runs;
  background native export refusal, import/edit/save/reload and tabs are covered.
- Scope/revocation/selection regressions passed. Portable scanner, transport and
  cleanup group: 130 passed, one Windows-only skip /131 locally.
- Bounded asynchronous Burst configuration reads: 47 focused checks passed.
  A timeout revokes cached authority, sends no new requests, and retains one
  underlying read across retries. Terminal memory-worker disposal is awaitable
  and cannot reopen after explicit stop.
- Arm64/x64 packaging, packaged smoke and installed smoke passed. Arm64 is installed
  in `/Applications/Plexiform.app`; installed doctor reports All checks passed.
  Its existing local board is Live. Actual saved task context persists (version2),
  native Markdown export succeeded for the expected session, and session/tab
  controls were inspected. No paid task or real agent message was launched.
- Installed ASAR SHA-256:
  `7b0bc2c08030e6e1a414f78b3f09f0c1fca7d70b4600dea712b2936b81eb550f`.
  Packages are ad-hoc signed, not notarized.
- Earlier full visual run was468/472; all four focused reruns passed without
  baseline changes. Current Mac/Linux release CI passed at `6375c805`; runtime
  code is unchanged from `1adca098`.

Earlier desktop starts/quit attempts stalled in a synchronous file open. A temporary
trace identified an optional Burst read on main and was removed before packaging.
After the bounded async fix, a later privileged filesystem trace/restart reached a
responsive installed board and passed doctor. The owner enabled macOS Full Disk
Access during diagnosis (observed OFF, then ON); the agent did not change OS
permissions. Normal launch and native export succeeded afterward. The trace did
not reproduce a slow open, so every earlier stall's cause is not directly proven.
Preserve this startup reliability concern and its failed evidence.

## Windows

[Run38612666524](https://github.com/CallumJB125/claude-traffic-light/actions/runs/38612666524)
passed native directory/ACL and all five native Job containment checks unskipped.
Root4473 passed,149 failed,3 cancelled,115 skipped; remote217/220 passed. Hub was
incomplete with68 captured failures when the unit stage hit20 minutes. Packaging
is insufficient for acceptance. Genuine key/token ACL and storage durability gaps
must not be hidden with fixture skips or deleted privacy assertions.

The [final Windows artifact-only run](https://github.com/CallumJB125/claude-traffic-light/actions/runs/38621935528)
at `1adca098` completed **failure**. Root: **4,508 passed, 118 failed, 139 skipped
/4,765**, zero cancelled. Remote: **217 passed, 3 failed /220**. Hub remains
incomplete: 30 visible failure blocks through emitted test 1122 before the Unit
tests step hit its 20-minute deadline. All five native Job containment checks and
306 native-directory checks passed unskipped. Installer build/lifecycle passed;
release staging was skipped. Windows publication remains gated.

Remaining failures include hub artifact durability (`EPERM` on directory `fsync`
and resulting HTTP 500s), backup/restore integrity, four hub file timeouts,
startup/auth and private-storage assertions. Setups/scanning, shell installers,
CLI and permission/path fixtures still need platform-specific classification.
Raw evidence: adjacent task workspace `work/owner-windows-final-current.log`.

## Deployment and recovery

Staging and production run `a705734f5f22af75ea584d47e97c78a154c91fb0` (later runtime
changes are app-only). Health and auth methods pass; Google/GitHub browser and push
are configured, production email OFF. Fresh Google OAuth after deployment reaches
Callum's team with Live board state. Staging remains behind Cloudflare Access.

Current rollback backups:

- `/opt/buddy-hub/owner-backup-20261014T182602160474Z`
- `/opt/buddy-hub-staging/owner-backup-20261014T182317482806Z`
- Local app/data backups: `work/app-backups/20261014T182559Z` in the adjacent task
  workspace, including consistent SQLite snapshots, previous/intermediate apps
  and failed-copy evidence. MCP processes5445 and6076 were preserved.

GitHub OAuth reaches separate-account/team onboarding; existing Google-team access
through GitHub remains unverified. Google secret rotation and fresh sign-in passed.
Cloudflare installation170293601 remains after the owner skipped its blocked
confirmation. Gallery key backup/restore was verified in local login Keychain,
which is not off-device/offline. Physical phone, real connector delivery,
signing/updater/device, Windows, team-conflict and legal acceptance remain open.

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
