# Plexiform release operator packet — 3 October 2026

Prepared from local candidate `45359559`, with an independently approved local repair patch for the real-hub Overview contract, proven locally between two simultaneously hosting devices in both directions. Independent report: `overview-real-hub-contract-review.md`; 65 focused tests and 40 hub/relay/direct-guard tests pass, and 10/10 targeted mutants fail. The repair commit must be recorded when committed. This is an operator plan, not production acceptance. Nothing in this packet authorizes deployment, CI dispatch, signing, tagging, uploads, installation, account changes or live-data changes. Callum must authorize each outward action when ready. Rebind every gate below to the final independently reviewed 40-character commit SHA after any fixes; never use `main` or a moving branch as the built-source input.

## Overview: what must work for the team

The release gate is a real two-account demonstration that Callum and a teammate can find their own sessions, share selected sessions with the team, watch their activity and send into interact shares. Joining a team must not expose unshared sessions. “All sessions” cannot currently mean every conversation in every provider application: existing sessions without a supported interaction channel remain observed only; Codex desktop conversations are unsupported; Codex shared-daemon CLI sessions require opt-in and exclude child/exec/app-server threads (`board/CODEX-DAEMON.md`, `src/codex-daemon.js:27`, `main.js:1432`). Child agents are displayed from reports and are not independently addressable messaging targets (`board/MESSAGING.md:31`).

Source inspection at the initial candidate found real-contract gaps that fake-hub evidence did not catch:

| Candidate evidence | Practical consequence | Required disposition |
| --- | --- | --- |
| `board/hub/interaction-shares.js:174` returns `owner.name`; `src/team-hub-client.js:44` requires `owner.id` | Every genuine shared row is rejected by the directory client | Fixed in reviewed local patch: server-derived owner identity; genuine bidirectional-host endpoint proof and failing mutation |
| `src/session-interaction.js:87` DTO has no `observed_at`/`updated_at`; `src/remote-interaction.js:176` preserves that shape; client `:166` expects a timestamp | Shared state has unknown freshness and the Message action is unavailable (`src/session-directory.js:193`, `overview-directory.js:88`) | Fixed in reviewed local patch: authorized owner-host receipt time; real-chain proof and failing mutation; child time untouched |
| `src/team-hub-client.js:151` defaults task/card/children/input to empty; `:154` never maps them | The real path cannot demonstrate team child tasks or input-needed reporting | Implement reviewed bounded reporting or explicitly record the product requirement as unmet; no fake-only acceptance |
| `src/overview-service.js:154` uses an origin-based team key, while `:159` uses an adapter key | A host can get duplicate logical team choices; the own-only choice cannot include incoming teammate shares | Fixed in reviewed local patch: immutable client origin and matching team hashing/lookup; genuine bidirectional-host endpoint proof and failing mutations |
| `board/hub/interaction-relay.js:157` requires device role client; the directory endpoint invokes it (`board/hub/interaction-shares.js:164`) | A device hosting its own sessions cannot simultaneously read/message a teammate's shared sessions | Fixed in reviewed local patch: valid host callers may use explicit teammate shares; own-device client guard unchanged; cookie/revoked/watch/replay checks pass and guards have failing mutations |
| `src/session-interaction.js:83` reports recorded/responding/completed/interrupted/failed; `src/team-hub-client.js:13` and directory accept different enums | Genuine provider completion can display unknown even with reply text | Fixed in reviewed local patch: actual native states retained in both whitelists; genuine correlated completed-reply test; reverting either layer fails |
| `src/team-hub-client.js:221` fingerprints share metadata only | State/delivery changes do not trigger share-list push | The visible renderer does re-read every 5 seconds (`overview.js:659`); prove this fallback with a real provider, and record its latency |

This table records the initial audit and reviewed local dispositions. Owner identity, timestamp, team identity, host-as-shared-caller and delivery state are repaired locally; the full team task/child/input contract remains unmet. None of these loopback fake-provider checks replaces production two-account/provider acceptance.

## Two real accounts: acceptance record

Prerequisites: final reviewed SHA deployed to an accounts-mode HTTPS hub; email/OAuth configured for the selected accounts; two distinct authorized accounts A and B in one team; enrolled desktop devices; a harmless disposable project; an owner-enabled session host with a real supported provider. The reviewed patch allows a hosting device to call another owner's explicitly shared sessions while preserving the own-account remote-client guard. Prove bidirectional sharing from both hosting desktops on the final deployed candidate. Turn on hosting deliberately. Use synthetic task text and no credentials in messages, screenshots or logs. Run every row in both directions. Use real accounts without exposing sign-in codes in evidence.

Retain SHA/build/platform, account pseudonyms A/B, team pseudonym, timestamp, screenshot or receipt reference, expected/actual result and PASS/FAIL for each row. A queue response alone is not provider acceptance.

| Step | Action | Required result |
| --- | --- | --- |
| 1 | A and B each open Overview My sessions with owned sessions, a supported tracked board run, an observed unmanaged session and, where supported, a child agent | Own work is present once with correct provider, board, task, state and origin; unmanaged capabilities accurately explain limits; child has its own task/time/input state |
| 2 | Both users enable hosting and retain an unshared session | Team choice is unique and includes the correct team; the other user sees no unshared session, private project path, provider thread identifier or earlier transcript |
| 3 | A shares one session watch-only; B opens Team sessions and stays there without manual refresh | B sees owner/provider/activity within the normal 5-second refresh cycle plus bounded network time; no Message action; watching creates no provider turn or charge |
| 4 | A changes the share to interact, then changes B's team role to viewer and back to member | Interact enables Message only for an active acting role and fresh online state; viewer remains watch-only; old open composers and cached handles cannot bypass the downgrade |
| 5 | A reports a parent task, starts a child, causes a harmless question/input-needed state, then finishes the child while parent remains busy | B sees the task and child state automatically; child completion does not finish the parent; stale child telemetry stays stale when parent activity changes. If unsupported in the real path, record FAIL, not “not applicable” |
| 6 | B sends one unique harmless instruction into A's idle interact session, e.g. “Plexiform acceptance: reply only CHECK-042” | One exact provider turn, caller attribution, native provider acknowledgement, recorded echo when offered, correlated reply and correct final state; A and B see receipt/reply without refresh; owner provider quota supplies the turn |
| 7 | A has a busy turn while B attempts another send | Overview/shared relay does not accidentally steer without a current explicit turn reference; fixed refusal or documented outcome. The separate stored-messaging service queues until idle; verify the selected route rather than assuming both behave alike |
| 8 | Disconnect owner host/network after submission, restore it, double-click Send or repeat an identical request id in a controlled authorized fixture | No automatic resend of an uncertain provider effect; an unknown outcome is visibly different from delivered/completed; dedupe/replay behavior does not cause duplicate turns |
| 9 | Revoke share while B has its composer open and while a read is outstanding; repeat with expiry, B removal, owner removal and team deletion in a disposable team | Immediate authority refusal; withheld response and scrubbed stale row details; no delivery from an old handle; a fresh share never exposes pre-share history |
| 10 | A disables hosting, signs out and revokes its host device; B signs out and switches to an unrelated account | Old host/clients stop; no new account token is borrowed by an old client; no retained old-team text/handles on the new account; reconnect cannot resurrect revoked authority |
| 11 | B watches A's provider move working → completed and sees a reply without any share-list change; hide/show Overview and wait over 90 seconds with reporting stopped | Automatic refresh actually updates delivery/state, hidden view resumes correctly and stopped reporting becomes stale rather than pretending current |
| 12 | B switches between own/team tabs and teams, while both A and B share sessions with each other | Each logical team includes applicable own and incoming shared sessions once; cross-team isolation survives cached responses; counts agree with visible parent/child records |
| 13 | Send a harmless instruction requiring a provider approval | Plexiform does not treat a teammate message as approval or authorize the tool; human approves in the supported provider surface; declined/expired approval is reported honestly |

Quota and privacy acceptance must name the route used. Overview currently calls `/api/interaction/v1/shared/:id/call` through the direct relay (`src/team-hub-client.js:119`, `:214`), which stores share records but does not persist message text in the hub (`board/hub/interaction-shares.js:32`). Shared-call rate budgets are 240/user/minute and 1200/team/minute; pending budgets are 32/host, 16 shared/host and 4/teammate (`board/hub/ratelimit.js:71`, `board/hub/interaction-relay.js:42`). These are concurrency/request controls, not a provider spend cap.

The distinct `/api/messaging/v1` service persists message/reply text for 30 days, delivers only to idle sessions and uses its own queue/hourly/automation budgets (`board/MESSAGING.md:89`, `:169`; `src/session-messaging.js:114`). Its current host target sync enumerates remote-host-owned sessions; a locally shared Overview session is not automatically in that enumeration (`main.js:1481`, `src/session-messaging.js:111`). Verify and document both services separately before promising queued team messaging for every shared session.

## Real provider, daemon and relay proof

After Callum authorizes provider use, prove a real Plexiform-owned Codex session with one harmless turn, acknowledgement, echo and reply; then prove the same session via another signed-in device and via B's share. Record provider/library versions and show an actual correlated receipt, not merely a success label from the hub.

For existing Codex CLI sessions, Callum starts a supported daemon-backed interactive terminal session in a disposable trusted project using his installed CLI; no `--no-daemon`, profile, OSS or configuration overrides. Enable the explicit daemon preference. Do not run against Codex desktop conversations. The proof script requires approval policy `on-request` and a sandbox; it refuses full-access sessions. After authorization:

```sh
node scripts/codex-daemon-proof.js
node scripts/codex-daemon-proof.js --send 1
```

Require `send: acknowledged`, final `completed`, `recorded: true`, the matching “OK” in the real terminal and proper detach without terminating the CLI session (`scripts/codex-daemon-proof.js:38`, `board/CODEX-DAEMON.md`). Also prove foreign user turns are not steered/interrupted and approval requests are not answered. Each extra real-provider test is a separate deliberate paid/limited-account action.

## Decisions Callum must make

1. Approve the final privacy wording and session-sharing behavior. Decide whether active teammates may create user turns using the owner's provider quota, who may interact versus watch, and whether wider team read access to post-share outputs is intended. Joining a team alone must remain private. Direct-relay messages and stored messaging have different retention/visibility; approve wording that names both accurately.
2. Decide the unresolved allowlist entry using the cutover runbook's explicit `--pistorventures include` or `exclude`; no default. Confirm the intended rollout addresses/domains and real Google test-user membership independently.
3. Choose automation defaults explicitly: no background AI-to-AI turns unless the destination owner opts in; stored target automation accepts `sessions`, `max_hops` 1–3, `turns_per_hour` 1–30, `parallel` 1–4 (`board/MESSAGING.md:176`). Decide selected values and how spend/rate limits are disclosed. Code ranges are not approval to enable them.
4. Choose Windows full runner support (named pipes plus current-user ACLs and native acceptance) or an explicitly narrower Mac/Linux execution release. Existing Unix sockets/chmod/getuid checks are not a Windows authority boundary (`board/runner/ipc.js:15`, `board/runner/util.js:43`). A Windows installer build alone does not establish runner security or complete functionality.
5. Approve or reject platform-gating the 24 POSIX-mode assertions identified by the handover. Require the exact inventory and replacements before changing tests: gate only assertions genuinely inapplicable on Windows, retain Windows native ACL/effect tests and keep behavioral tests mandatory. This packet has not re-counted those 24 assertions. A blanket Windows skip is not acceptance.
6. Decide the disposition of the known same-URL retirement failure, migration-026 test failure, missing-dependency import failure and load-related timing/phone flakes using current rerun evidence. Installing isolated locked dependencies can resolve an environment defect; a known label alone never overrides a release job's hard gate. The same-URL approval-authority scenario deserves a deliberate security release decision.
7. Authorize source publication, exact-SHA CI dispatch, Pi rehearsal/cutover, the reviewed Keychain click, backup provisioning/drill, signing/notarization, staging and promotion separately. Select the release version, beta cohort and whether the first public artifacts are platform signed.

Suggested privacy text for Callum to review (do not insert into PRIVACY.md without sign-off):

> When signed in, Plexiform periodically asks your team hub which sessions teammates explicitly shared with you and reads their current state. Watch shares allow reading only; interact shares allow permitted teammates to send instructions that run under the owner's provider account, permissions and quota. Joining a team does not share your sessions. Overview's direct interaction relay passes message text and post-share replies through the hub without persisting that text there; the hub operator can read it in transit. The separate stored messaging service keeps messages and replies in the hub database until deletion under its retention policy, and its operator can read them. Sharing exposes permitted output from after the share, never earlier history. Signing out or losing share/member/device authority stops further access. The app refreshes visible sessions automatically.

The existing `team-hub-directory` paragraph is inaccurate about persistence and “only when open”: `main.js:1424` subscribes the live client at startup, so the directory polls while signed in even with Overview closed. Retention wording for `session-messaging` is also stale about team targets. Approve exact behavior and reconcile both paragraphs before release; run `test/privacy.test.js` after any change. This is a factual source reconciliation, not legal approval.

## CI: prepared commands for Callum; none executed

Prerequisites: independently reviewed SHA is reachable on GitHub after an explicitly approved push; reviewed workflow definitions exist on the dispatch branch; `gh` is authenticated for repo Actions rights; root, board and offsite locked dependencies are available; selected Windows gates/dispositions are committed. Dispatching a local-only SHA cannot work. The workflow selector `--ref` chooses the workflow's code; input `-f ref=...` chooses candidate source. Keep both independently reviewed because beta staging/promotion scripts come from workflow code, not merely the candidate source input.

```sh
PF_REPO=CallumJB125/claude-traffic-light
PF_RELEASE_SHA=REPLACE_WITH_REVIEWED_40_HEX_SHA
PF_WORKFLOW_REF=REPLACE_WITH_PUBLISHED_REVIEWED_WORKFLOW_REF
gh workflow run windows-native.yml --repo "$PF_REPO" --ref "$PF_WORKFLOW_REF" -f ref="$PF_RELEASE_SHA"
gh workflow run release.yml --repo "$PF_REPO" --ref "$PF_WORKFLOW_REF" -f ref="$PF_RELEASE_SHA" -f native_only=false -f beta=false
```

`windows-native.yml` compiles actual Windows SDK ACL/namespace/private-file/publication fixtures on an official disposable Windows runner. `release.yml` runs Mac/Windows/Linux root, remote and board suites, native Darwin acceptance, builds installers, checks Windows NSIS install/reinstall/uninstall plus portable hooks, and retains evidence for 14 days. The artifact-only dispatch still uploads CI artifacts; it is an outward action. It does not stage a release when beta is false and no version tag is used. `native_only=true` runs only the native Windows job. Site and visual suites are not included in this matrix: retain separate exact-SHA evidence (`.github/workflows/release.yml:145`, `docs/RELEASING.md`).

After a successful reviewed matrix, real acceptance and separate staging permission, beta staging is:

```sh
gh workflow run release.yml --repo "$PF_REPO" --ref "$PF_WORKFLOW_REF" -f ref="$PF_RELEASE_SHA" -f native_only=false -f beta=true
```

It creates `<package version>-beta.<GitHub run number>`; “beta8/9” are historical cohort labels, not a guarantee of generated version numbers. Record actual version from the run. Beta staging creates a draft prerelease and uploads to versioned R2 beta storage. After separate promotion permission:

```sh
PF_BETA_VERSION=REPLACE_WITH_ACTUAL_STAGED_BETA_VERSION
gh workflow run release-promote.yml --repo "$PF_REPO" --ref main -f version="$PF_BETA_VERSION" -f beta=true -f rollback=false
```

Run promotion from independently reviewed published `main` (or the allowed version tag), with GitHub environment `release` properly restricted. Stable tag/staging and stable promotion require another explicit permission and version choice. Never dispatch these commands merely to “see what happens.” CI failures block stage; `WINDOWS_RELEASE=true` allows Windows publication only after its exact candidate acceptance and review. It never bypasses tests. Matrix still includes Windows if publication is disabled.

## Offsite: operator setup and encrypted recovery gate

Use a dedicated private R2 backup bucket, separate from release downloads. Disable public access, r2.dev/custom domains and browser CORS. Provision bucket-scoped uploader Object Read & Write credentials and a distinct read-only recovery credential. Configure/read back a 35-day lock and 90-day lifecycle; record the actual policy and date. The uploader token alone is not deletion-proof. Retain matching code/environment/secret escrow outside the bucket; no hub.env is uploaded by the tool.

Use a separately installed Node 22 runtime and locked offsite dependency cache (`npm ci --ignore-scripts` after installation authorization), not shared app node_modules. Config/key files are regular no-symlink `0600`; outbox/recovery/work parents are private normalized `0700` absolute paths without symlink ancestors. Pin public signing keys independently on recovery host, escrow native age X25519 identity separately from uploader and keep old keys until backups expire.

Only Darwin arm64 age 1.3.2 is currently pinned: binary SHA-256 `4012dfc2725883beafb710894af4f599b7a94f8c8e0f51f02cc96ab8df33915e` (`board/deploy/offsite/age-pins.json`). A Linux/Pi drill needs correct official architecture archive and Sigsum proof verification, recorded provenance and independently reviewed Linux binary hash pin first; the Darwin pin does not validate Linux. Read `board/deploy/offsite/PROVENANCE.md` and do not infer legitimacy from `--version` alone.

After provisioning/drill authorization, with operator-owned private paths substituted and no secret in argv:

```sh
PF_NODE22=/ABSOLUTE/PATH/TO/NODE22
PF_CLI=/ABSOLUTE/REVIEWED/CHECKOUT/board/deploy/offsite/cli.mjs
PF_UPLOAD_CONFIG=/PRIVATE/PATH/uploader.json
PF_RECOVERY_CONFIG=/PRIVATE/PATH/recovery.json
PF_VERIFIED_PAIRED_BUNDLE=/PRIVATE/PATH/verified-paired-bundle
PF_DRILL_WORK=/PRIVATE/PATH/offsite-drill-work
"$PF_NODE22" "$PF_CLI" --drill "$PF_UPLOAD_CONFIG" "$PF_RECOVERY_CONFIG" "$PF_VERIFIED_PAIRED_BUNDLE" "$PF_DRILL_WORK"
```

The real drill removes its disposable local copy/outbox before downloading with recovery credentials; confirms genuine encryption, bounded hash-checked restore, paired artifacts and SQLite integrity; probes denied unconditional overwrite/delete and read-only write/delete with exact 403 results. Receipt must say `REAL_R2_DRILL_PASSED_PENDING_INDEPENDENT_REVIEW`, then obtain an independent report. Receipt alone does not establish lock/lifecycle configuration. Loopback passes or `NOT_PROVEN` do not count.

For an operational completed backup, use `--prepare UPLOADER_CONFIG VERIFIED_BUNDLE`, `--upload UPLOADER_CONFIG TRANSPORT_UUID`, then on the isolated recovery host `--retrieve RECOVERY_CONFIG TRANSPORT_UUID NEW_DIRECTORY`. A drill-marked transport is deliberately refused by operational retrieve. Validate the new paired bundle; compare exact approved artifact hashes and database approval/version records; stageRestore into new disposable data, never live data. No destination overwrite. A future authorized live restore must stop both hub and Litestream, preserve failed data, restore code/environment/secrets/ownership, swap database and artifacts together, use BOARD_RESTORE once and prove epochs/fences/sign-in/exact approved downloads. The offsite CLI performs none of that live cutover.

## Signing, installers and update acceptance

Code signatures/notarization and Ed25519 feed signatures are separate. Candidate release builds currently disable automatic code signing; Mac falls back to ad-hoc and Windows has no configured certificate (`.github/workflows/release.yml:177`, `electron-builder.config.js:39`, `build/sign.js:27`). Do not call these signed/trusted installers because the update manifest was signed. Review/update the signing workflow first if signed artifacts are required: Apple Developer ID certificate/passphrase plus notary API credentials, appropriate helper entitlements and hardened-runtime behavior; separately configure the selected Windows Authenticode service/certificate. `docs/RELEASING.md` describes a proposed Mac updater/signing transition that is additional implementation/review work, not an existing switch.

Before tagging: exact-SHA Node 22 suite evidence, native Darwin tests, site tests, visual screenshots reviewed on a quiet machine and valid workflows. No network dependency provisioning is authorized by this packet. Fix root security failures rather than treating local newer-Node green as CI proof.

After staging/promotion authorization and completed gates: verify platform installer bytes, SHA256SUMS, feed manifests/signatures, version/channel, signing identity/notarization and artifact provenance. Install only with Callum's authorization. In the chosen beta cohort, verify clean sign-in, Keychain behavior (reviewed harness first), own/team Overview above, relaunch, macOS arm64/x64, and selected Windows NSIS/portable on disposable runners. Then prove actual beta-version-to-next-beta download/restart from the promoted beta feed, busy/input-needed restart deferral, preserved synthetic data, hooks/MCP paths, installed version and rollback/revert. NSIS is Windows auto-update target; portable requires manual replacement and must never silently install NSIS. Same-version reinstall is not version-to-version updater proof.

Stable promotion signs a fresh 30-day manifest, checks staged bytes, publishes feed last and GitHub Release afterward (`release-promote.yml`). A rollback can only re-sign previously promoted identical assets, with current version(s) listed. Keep last-good artifact/feed and demonstrated rollback evidence. Releases need renewal before manifest expiry if no newer version ships.

## What Callum must do to ship

1. Resolve/approve the privacy, shared-session quota/turns, allowlist, automation, Windows and test-gating choices above; bind the reviewed Overview repairs to the shipped SHA and resolve the remaining team task/child/input requirement or explicitly decline that scope.
2. Approve the independently reviewed cutover SHA/hash; rehearse on the Pi with verified paired backup and dropped-SSH rollback evidence; run the Keychain harness only after its third written APPROVE.
3. Authorize published exact-SHA CI and require actual passing required jobs plus site/visual/native evidence; resolve every unexplained failure.
4. Authorize real two-account/provider/daemon/relay acceptance and capture correlated turn/reply, revocation and automatic Overview updates.
5. Provision/read back private R2 policy and verified platform age pin; authorize the encrypted recovery drill and obtain its independent report.
6. Authorize required signing/notarization and reviewed beta staging/promotion; install the beta and prove version-to-version updates/rollback with the team.
7. Choose the final version and authorize stable tag/staging, then promotion only when all evidence is bound to the shipped SHA and installer bytes.
