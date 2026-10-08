# Plexiform release operator packet — 3 October 2026

Current committed and published review-branch candidate is `53729c85fb3b2a977ffe912c6fa399bfe646bb79` (package version 1.0.2), fast-forwarded after independent review into integration-2. Callum authorized publication if ready and selected macOS/Linux first; Windows remains unavailable. Review-branch pushes and artifact-only CI dispatches have occurred; no main push, tag, app promotion, website deployment or installation has occurred. New requested board UX, verified process stopping and strict managed handover work is uncommitted; the first two have independent approval, and the last also has final independent approval. This SHA does not identify those new bytes. Keep the existing pin until the combined changes are independently reviewed and committed.

Latest exact-SHA CI is run `37120152384` on `53729c85`: Linux root **3,518 total / 3,508 pass / 10 platform skips / 0 fail**, remote **199/199**, recursive board **2,652 total / 2,650 pass / 1 skip / 1 fail**. The failure is the relay proof's steer-completion ordering; its test-only repair passes pinned Node22 relay **18/18** and delayed real-hub scratch **1/1**, with **1/1 mutation killed**. Independent review APPROVE is recorded in `reviews/relay-turn-ordering-independent-review.md`; a new exact-SHA CI run after the combined handover/UX changes is required. Local root **3518/3518** is earlier macOS evidence, not proof that Linux's platform-specific assertions ran. Prior run `37118800270` failed; all evidence remains preserved.

The newly requested board UX has independent approval: 39/39 focused checks and 12 assertion mutations. Verified managed process stopping has independent approval: 16/16 focused checks, eight author mutations and two independent mutations. Strict managed handover has final independent approval: 106/106 focused checks and 22/22 assertion mutation kills. The intended strict flow holds the card for the selected next AI, confirms the prior managed run stopped, writes the handover document and pushes its snapshot before offering the next AI. Unconfirmed stop or handover failure must leave the card blocked and must not autoqueue another AI. The API must pin the exact prior run/fence and retain writer/repository/current-team authority. The complete combined source commit, updated cutover pin and deployed acceptance remain pending.

The Mac job succeeded but its root report omitted exactly 23 session-machine verdicts. A focused Node22 reproduction completed all 852 assertion bodies while forced exit reported only 826 and exited successfully. The unchanged session-machine file separately passes 213/213. The new source removes all three CI `--test-force-exit` flags, retaining per-test120s and job20min deadlines; a complete final CI report is still required. The old Mac root3495/3494pass/1skip is incomplete evidence. See `reviews/ci-session-machine-completeness-audit.md`.

A full unsigned macOS arm64 app directory and its native helpers have built successfully with `--publish never`, isolated build HOME and output. This is packaging evidence, not runtime or installer acceptance. The dependency-resolution warning from the shared local node_modules closure must be checked in the final package before claiming packaged runtime acceptance. Final reviewed-source repackaging and disposable smoke remain pending. No installed app was changed.

## Confirmed policy and current capability

Callum has chosen **automatic sharing and interaction for sessions related to the team's board/workspace**. Acting members can send instructions using the owner's provider account, permissions and quota; viewers retain watch-only access. Personal/unassociated sessions stay separate. An explicitly narrowed manual watch share is preserved. Removing membership/device authority, stopping a share, ending its session or disabling automatic sharing must stop the applicable authority and prevent silent grant recreation. The default is no background AI-to-AI automation unless the destination owner separately opts in.

The rollout allowlist **includes `callum@pistorventures.org`**. Use the cutover's explicit `--pistorventures include`; do not ask for this resolved choice again. The full-app goal includes a Windows decision: Callum selected macOS/Linux first, with Windows unavailable. Windows native runner/channel publication and actual Windows acceptance remain future engineering/release gates, not completed work.

The actual shared path now carries bounded, sanitized parent task, child and input-needed reports with source labels and independent child report/receipt clocks. Child native IDs, paths and credentials stay out of metadata. Repeated parent reports/state receipts do not freshen children; metadata from before a grant is filtered, including reports in the same wall-clock millisecond. A child self declaration remains labelled self-reported. A human instruction title outranks an inferred/reported title. Correlated turn completion clears that turn's input wait. An old input report expires after 90 seconds even when the host keeps answering; its original report time remains available for a truthful last-reported label, and a closed provider cannot have a current question. These changes have a written independent reporting review and failing scratch mutations; final main policy wiring has its own independent review.

Supported sessions associated with a team workspace can be shared automatically. Plexiform-owned providers support exact selected-session receipt/reply. A Claude Code terminal can be connected only after the human explicitly starts it with Plexiform's development MCP channel; ordinary terminal/Desktop/web conversations without that supported channel remain observed only. The terminal retains its normal permissions, cannot be interrupted/steered by this channel and must supply exact accept/reply tool receipts. Codex shared-daemon CLI messaging is a separate opt-in; its unmanaged sessions are not silently granted team control. Child reports do not create independently addressable messaging targets. These limits must remain visible in the app; current source does not make every provider conversation controllable.

Ordinary team-board Claude/Codex runs use an additional directory: `/api/team-session-directory` lists eligible current runs across every board of the selected current team, including teammates whose work the viewer did not create, assign or dispatch. The bounded server/client/Overview contract passed genuine disposable accounts/runner fixtures and independent written review (78 focused checks and62 assertion mutation executions). This is local proof; deployed real-team acceptance remains required. It preserves current principal/role/team/run/card/fence/repository pins, current runner/enrollment/device authority, and independent heartbeat expiry. It exports board metadata already shared with that team, omitting private provider IDs, paths, tool inputs, transcripts and credentials. Child telemetry is not invented for these board runs.

Board messages use the existing journal and `/api/cards/:id/messages` task inbox. The agent must explicitly read its addressed inbox and acknowledge it; host receipt, agent-reported acknowledgement and a linked reply are separate stages. A successful queued board message does not imply a native provider user turn, automatic resume, execution permission or immediate reply. Own and uninvolved teammate board runs are projected under the correct owner in the reviewed integration. The detailed supported/unsupported matrix is the private `team-session-capability-audit.md` output.

The initial genuine-contract defects—missing owner identity, missing host receipt time, duplicate team keys, host callers blocked from shared routes and dropped native delivery states—were repaired in `fd1e2a0c`, with both simultaneously hosting fixture accounts sending in both directions through the real hub/relay/client/Overview code. The newer reporting proof also exercises the actual loopback hub, creation-filtered metadata, child clocks, input wait clearing and revocation. Fixture providers and disposable hub accounts are not production acceptance.

## Two real accounts: acceptance record

Prerequisites: final independently reviewed SHA deployed to an accounts-mode HTTPS hub; email/OAuth configured; two distinct authorized accounts A/B in one disposable team; enrolled desktops; harmless project; real supported provider. Record SHA/build/platform, account/team pseudonyms, time, receipt/screenshot reference and PASS/FAIL for every row. No sign-in codes or credentials belong in evidence. A queue or transport-write response alone is not provider acceptance.

| Step | Action | Required result |
| --- | --- | --- |
| 1 | A/B open My sessions with supported owned work, a tracked board run, an observed unmanaged session and a reported child | Correct provider/board/task/source/state once; truthful unsupported capabilities; child independent report clock and task/input state |
| 2 | Start supported sessions on the team workspace and personal workspace; have B start a board run with no A assignment/dispatch involvement | Associated owned/channel sessions and ordinary uninvolved teammate board runs appear in the correct Team view once each; acting members can Message through the appropriate transport, viewers cannot; personal/unassociated work stays private |
| 3 | Narrow one share to watch, then downgrade B to viewer and back to member | Watch/viewer cannot send or interrupt, including cached composers/forged requests; no automatic upgrade of the explicit watch grant |
| 4 | Run a parent and reported child, trigger a harmless question, then finish the child while parent stays busy | Truthful task/input/child state and source; parent activity does not freshen the child; parent completion clears its own input marker |
| 5 | B sends a unique harmless instruction into A's idle owned/channel session, e.g. reply only CHECK-042; then sends a board task message to A's current board run | Direct relay: exactly one selected native turn, caller attribution, provider receipt/recorded echo/correlated reply. Board inbox: exact current run/fence/repository, one journaled message, distinct host receipt and agent acknowledgement, then a linked reply when the agent reads/responds. Owner supplies provider quota |
| 6 | A is busy; B attempts another new turn, repeats a request ID and disconnects after submission | Fixed busy/stale/replay handling; no unintended steer; uncertain delivery visibly differs from refusal/completion and is never resent automatically |
| 7 | Stop/revoke share with composer/read pending; repeat expiry and member/owner/device removal in a disposable team | Immediate authority refusal, withheld stale response, no stale-handle effects or grant recreation, no pre-share metadata on a fresh grant |
| 8 | Disable automatic sharing while retaining manual hosting; sign out/account-switch; lose and restore owner connection | Manual grants still refresh membership while auto sharing is off; old account tokens/handles/text do not carry into new identity; revoked access stays revoked |
| 9 | B stays on Team view while provider state/reply changes; hide/show view; stop reporting beyond 90 seconds | Automatic visible refresh proves state/reply without share-list change; stopped child telemetry grows stale |
| 10 | Both desktops host and share in both directions, switching teams and own/team views | Own and teammate work appear once under the correct logical team; cross-team isolation and visible counts agree |
| 11 | Cause a harmless provider approval request | A teammate message is not approval; Plexiform never authorizes the tool; supported provider surface retains human permission control |

Run both directions. Prove hosting, live role downgrade and correlated provider response on the deployed final SHA. Actual email/OAuth/invite and team-account acceptance is still outstanding.

Overview uses `/api/interaction/v1/shared/:id/call`, a direct relay. It stores share records, passes message/reply text through the hub and does not persist that direct text there; the hub operator can read it in transit. Request/concurrency budgets are not provider spend caps. Board task messages use the existing durable task-message journal/database and current run/fence/device addressing; direct shared-session state is not that inbox. The separate `/api/messaging/v1` service persists text/replies for 30 days and queues only for currently advertised idle targets; a shared Overview session is not automatically an advertised stored-messaging target. Do not promise queued messaging for every shared session until the real target registration supports it. Final PRIVACY.md must name these differences and signed-in directory polling accurately.

## Provider acceptance already completed and still required

One authorized **real Plexiform-owned Claude Code** disposable turn passed on 2026-10-03, CLI 2.1.288, through the actual adapter and interaction hub. Evidence the private `live-claude-disposable.json` acceptance record records target match, acknowledgement, exact provider-recorded input, completed state and correlated reply. Tools were disabled and session persistence was disabled. This proves that owned Claude path for one harmless turn; it does not prove terminal-channel organization policy, team-account delivery or installed packaging.

A real Claude terminal-channel opt-in remains a human/org acceptance gate: prepare its private config in Overview, run the displayed command in the selected harmless project, acknowledge Claude's research-preview confirmation yourself, then discover/attach that exact terminal. Prove exact accept/reply, busy/replay/revoke/no-auto-retry and the org-policy-denied outcome. Unconfigured terminals/Desktop/web chats remain observed only.

For real owned Codex, run one harmless selected-session turn and prove its receipt/echo/reply; then prove the same via a teammate's automatic team share. For existing Codex CLI, the human must start a supported daemon-backed interactive terminal in a disposable trusted project and enable the daemon preference. Desktop chats are unsupported. After authorization, these existing proof commands require on-request approval and a sandbox and refuse full access:

```sh
node scripts/codex-daemon-proof.js
node scripts/codex-daemon-proof.js --send 1
```

Require acknowledged/completed/recorded:true and the matching terminal reply; prove foreign turns cannot be steered/interrupted and approvals are never answered. Real provider use is already allowed for the authorized harmless disposable acceptance scope; additional production/real-data operations are not implied.

## Decisions and authorizations still required from Callum

1. Automatic team sharing, provider quota disclosure, factual privacy notice and `callum@pistorventures.org` inclusion are recorded in reviewed source; these choices do not need another confirmation.
2. Choose any future background AI-to-AI automation limits/opt-in defaults beyond the current off-by-default behavior. Runtime ranges are not permission to enable paid automation.
3. Approve the exact Windows assertion inventory/gates if genuinely platform-specific checks must be gated. Historical 24 is not a verified runtime count: the current source inventory lists 82 sites, including 27 ungated root sites. Retain meaningful Windows ACL/native effect tests and behavior tests; a blanket Windows skip is not acceptable.
4. Candidate stable version is1.0.2; source publication and artifact-only CI are already authorized. Complete physical Keychain, real-account and package acceptance, then authorize the private backup/drill, Pi operator work and signing/installer steps still outside that scope. The first macOS/Linux release scope is already chosen. Full Windows native functionality and acceptance must be built/proven before a future Windows release.

Recorded sharing-policy wording (the reviewed PRIVACY.md additionally distinguishes durable board inboxes and stored messaging):

> Supported sessions associated with your team board/workspace are shared automatically with that team. Acting members may send instructions using your provider account, permissions and quota; viewers may watch. Personal/unassociated sessions stay separate, and you can narrow or stop a share. Shared metadata is bounded and source-labelled; pre-share history is excluded. The direct relay passes message/reply text through the hub without persisting that text there, but the hub operator can read it in transit. Stored messaging has separate database retention and target registration. Plexiform polls the signed-in directory and refreshes visible state automatically. Signout or loss of share/member/device authority stops further access.

## CI: exact-source validation and prepared next commands

Prerequisites: independently reviewed SHA is reachable on GitHub after an explicitly approved push; reviewed workflow definitions exist on the dispatch branch; `gh` is authenticated for repo Actions rights; root, board and offsite locked dependencies are available; selected Windows gates/dispositions are committed. Dispatching a local-only SHA cannot work. The workflow selector `--ref` chooses the workflow's code; input `-f ref=...` chooses candidate source. Keep both independently reviewed because beta staging/promotion scripts come from workflow code, not merely the candidate source input.

```sh
PF_REPO=CallumJB125/claude-traffic-light
PF_RELEASE_SHA=REPLACE_WITH_REVIEWED_40_HEX_SHA
PF_WORKFLOW_REF=REPLACE_WITH_PUBLISHED_REVIEWED_WORKFLOW_REF
gh workflow run windows-native.yml --repo "$PF_REPO" --ref "$PF_WORKFLOW_REF" -f ref="$PF_RELEASE_SHA"
gh workflow run release.yml --repo "$PF_REPO" --ref "$PF_WORKFLOW_REF" -f ref="$PF_RELEASE_SHA" -f native_only=false -f beta=false -f validate_windows=false
```

`windows-native.yml` compiles actual Windows SDK ACL/namespace/private-file/publication fixtures on an official disposable Windows runner. `release.yml` runs macOS/Linux by default, root/remote/recursive-board suites, native Darwin acceptance and installer builds; it retains evidence for14days. The Windows SDK job remains mandatory. `validate_windows=true` adds the Windows installer/tests acceptance leg without enabling publication; `WINDOWS_RELEASE=true` includes Windows in publication only after its separate acceptance. The Windows leg checks NSIS install/reinstall/uninstall and portable hooks. The artifact-only dispatch still uploads CI artifacts; it is an outward action. It does not stage a release when beta is false and no version tag is used. `native_only=true` runs only the native Windows job. Site and visual suites are not included in this matrix: retain separate exact-SHA evidence (`.github/workflows/release.yml:145`, `docs/RELEASING.md`).

After a successful reviewed matrix, real acceptance and separate staging permission, beta staging is:

```sh
gh workflow run release.yml --repo "$PF_REPO" --ref "$PF_WORKFLOW_REF" -f ref="$PF_RELEASE_SHA" -f native_only=false -f beta=true
```

It creates `<package version>-beta.<GitHub run number>`; “beta8/9” are historical cohort labels, not a guarantee of generated version numbers. Record actual version from the run. Beta staging creates a draft prerelease and uploads to versioned R2 beta storage. After separate promotion permission:

```sh
PF_BETA_VERSION=REPLACE_WITH_ACTUAL_STAGED_BETA_VERSION
gh workflow run release-promote.yml --repo "$PF_REPO" --ref main -f version="$PF_BETA_VERSION" -f beta=true -f rollback=false
```

Run promotion from independently reviewed published `main` (or the allowed version tag), with GitHub environment `release` properly restricted. Stable tag/staging and stable promotion require another explicit permission and version choice. Never dispatch these commands merely to “see what happens.” CI failures block stage; `WINDOWS_RELEASE=true` allows Windows publication only after its exact candidate acceptance and review. It never bypasses tests. The default approved installer matrix is macOS/Linux; the separate native Windows job still runs. No test within a selected platform leg is bypassed.

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

1. Complete real two-account email/OAuth/invite/provider acceptance, physical Claude-channel/org-policy confirmation and reviewed Keychain acceptance against the final package; include uninvolved teammate runs, task-inbox versus live-turn receipts and strict handover behavior.
2. Review the combined handover/UX and relay-fix reports, commit/rebind the exact source, and pass final macOS/Linux/native artifact CI. Source push and artifact-only CI are already authorized; failed CI cannot authorize promotion. Windows remains excluded until separate native runtime/installer acceptance.
3. Provide the requested explicit Chrome file-URL permission if website upload should proceed; preview the reviewed website bundle, verify the existing WAITLIST function/binding and headers, then promote only the website after preview acceptance.
4. Authorize private paired backup, verified platform age pin, real encrypted offsite restore and independent review, then Pi rehearsal and demonstrated rollback. Agents never execute the cutover script.
5. Configure trusted signing/notarization; accept the exact installers, clean sign-in, version-to-version update and rollback on the chosen platforms. Installation in /Applications remains outside current authorization.
6. Promote/tag/upload the reviewed app version only after those acceptance gates pass; handle hosted accounts cutover and Access changes separately with the reviewed operator runbook.

## Evidence binding and historical counts

Latest exact-SHA CI is run `37120152384` on `53729c85`: Linux root **3,518 total / 3,508 pass / 10 platform skips / 0 fail**, remote **199/199**, recursive board **2,652 total / 2,650 pass / 1 skip / 1 fail**. The failure is the relay proof's steer-completion ordering; its test-only repair passes pinned Node22 relay **18/18** and delayed real-hub scratch **1/1**, with **1/1 mutation killed**. Independent review APPROVE is recorded in `reviews/relay-turn-ordering-independent-review.md`; a new exact-SHA CI run after the combined handover/UX changes is required. Local root **3518/3518** is earlier macOS evidence, not proof that Linux's platform-specific assertions ran. Prior run `37118800270` failed; all evidence remains preserved.

- The existing cutover pin identifies committed53729 only; the new uncommitted handover/UX changes require a new reviewed commit and an independently reviewed pin. Do not execute any cutover script.
- Historical app candidateaba127 passed root3506/3506 and hub glob1778/1778. Original requested remote200/200 and site16/16 passed; reviewed site8acd22/22. These are retained evidence snapshots, not substitutes for the latest recursive CI or the new source's validation.
- Independent team-board contract review:78/78 plus62 assertion mutation executions; actual persisted two-account/client/hub/Overview contract2/2 plus9 author mutations. It proves direct selected board-inbox targeting, exact text/request/sender correlation and receipt/ack/reply separation on disposable local accounts.
- Structured reporting review56/56+29mutants; terminal channel review12/12+16mutants. Owned real Claude2.1.288 exact input/correlated reply proof is recorded; terminal-channel human/org, real team accounts and installed packaging remain unaccepted.
- Corrected Keychain fake harness15/15 is reviewed; physical final-package run remains required. Linux's10 root platform skips are current CI evidence, not newly introduced gates in the relay fix. Historical24 POSIX assertions is not a verified current runtime count; consult the Windows audit and retain Windows native ACL behavior coverage.
- Review-branch source has been pushed and artifact CI dispatched with approval. No main push, app release tag/promotion, website deployment, /Applications mutation or production cutover has occurred at this checkpoint.
