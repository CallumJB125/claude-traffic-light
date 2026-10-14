# Plexiform owner work — 2026-10-14

Implementation branch: `codex/owner-decisions-2026-10-14`, based on `08f46dd8`.
Final tested app/runtime revision: `1adca098cf451fc6bcab6cffcd237591b4fc6c4b`.
The original `claude/release` checkout and handover are preserved. No merge or public
release promotion has occurred.

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
- Signing/updater infrastructure is ready without signing credentials,
  notarization or real signed updater/device acceptance. Privacy notice is live;
  qualified legal review remains open.

## Validation and installed Mac

- Final root: **4,753 passed, 11 skipped /4,764**, zero failures/cancellations.
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
  baseline changes. Mac/Linux CI success is earlier-revision evidence.

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
