# Owner decisions implementation — 2026-10-14

The owner authorized autonomous implementation of the remaining handover items,
with Agent Mail free. Inbox polling remains opt-in. Codex remains the default
Tasks provider; Claude is available only where its provider sandbox is supported.

Implementation branch: `codex/owner-decisions-2026-10-14`, based on `08f46dd8`.

## Work ledger

- Agent Mail: free, including the text-only Ask my AI menu and launch. Inbox polling stays off by default; sending still requires Send/Confirm.
- Claude in Tasks: enabled on macOS/Linux, with Codex the default. Windows remains Codex-only because Claude's required sandbox is unsupported there.
- Entitlements: Ed25519 public key pinned; beta access is an explicit release policy and remains enabled. Private key stays outside Git and is installed with restricted permissions on staging and production.
- Crash reports: versioned renewed consent, structural-only sender, bounded hub intake, strict schema, rate limits and 30-day retention implemented. No historical uploads. Intake is deployed on staging and production; invalid payloads are rejected.
- Phone: standalone static Pages build, pinned hub API, CSP/SRI, narrow CORS, PKCE browser sign-in and session revocation checks implemented. VAPID is installed on both hubs; Pages site is deployed and its CSP/SRI verified. Public phone flag remains off.
- Linear/Jira: existing opt-in implementations retained; raw-delivery verification CLI added. Synthetic signature tests pass. Real signed provider deliveries remain required before enabling or advertising.
- Release: signing preflight and signed-Mac updater path implemented. No Developer ID/notarization or Windows signing credentials are available. Native Windows directory/ACL CI passed. The Windows process helper now compiles under strict MSVC settings. Windows installer/portable packaging and install/upgrade/uninstall lifecycle checks passed; its unit-test stage failed and timed out, so Windows remains gated. Mac arm64/x64 packaging and packaged smoke passed. The arm64 package is installed in `/Applications/Plexiform.app`; installed smoke and all installed-doctor checks passed. These packages are ad-hoc signed, not notarized.
- Privacy: technical notice updated; qualified legal review is still pending.

## Validation

- Root suite: 4,722 passed, 7 skipped (4,729 total), bounded concurrency.
- Remote: 220 passed. Site: 30 passed. Targeted release checks: 112 passed.
- Hub rerun: 3,089 passed with one known Hermes stop timing failure; its isolated nine-test suite then passed. The earlier missing-sessionStorage sign-in failures are fixed with regression coverage.
- Visual: 468/472 in the complete run. Focused reruns passed all four failed cases: Agent Mail navigation, the newly enabled Claude choice, Settings after building native helpers, and sparkline rasterization. No screenshot baselines changed.
- Fresh Google browser OAuth against the final deployed source revision reaches Callum's team with Live board state.
- Installed Mac app opens its existing local board with Live state, and the Tasks provider menu visibly offers Claude and Codex. No paid task was launched during verification.
- Phone browser smoke caught duplicate sign-in links on repaint; fixed and covered by an actual DOM test. All 28 phone tests passed, and the live page retains one link with retry available. No phone device was enrolled by automation.
- Linux CI exposed Mac-specific fixtures without an explicit platform and an asynchronous provider-release rejection. Both are fixed; 51 focused tests passed. Installer-policy checks: 32 passed.
- Mac CI at the runtime revision passed its root suite (4,724 passed, 8 skipped), remote suite (220), hub suite (3,091), installer build and smoke.
- The next Linux run found one launch fixture exhausting a fixed immediate-turn budget before its child process started. The fixture now waits against a real 10-second deadline independently of mocked launch timers; both focused tests passed. The corrected [Linux run 38600793496](https://github.com/CallumJB125/claude-traffic-light/actions/runs/38600793496), at `35894755b0c58b89e17a2e88b7ba75486f5a3d09`, passed root (4,716 passed, 17 skipped), remote (220), hub (3,090 passed, 1 skipped), packaging and smoke. Changes after the runtime revision are test/workflow-only.
- Windows native directory/ACL acceptance, installer/portable builds and install/upgrade/uninstall lifecycle passed. Root tests reported 4,432 passed, 272 failed, 3 cancelled and 28 skipped; remote tests reported 217 passed and 3 failed. Hub tests were incomplete when the unit stage reached its 20-minute deadline. Failures include POSIX modes/paths/sockets, platform expectations, file-lock cleanup and provider fixtures. Windows acceptance remains open; full logs and lifecycle evidence are preserved.
- Artifact-only validation can now select one platform while retaining all its tests and the native acceptance gate. The selector cannot narrow a beta or tag release. All 33 installer-policy tests passed.

Both hubs deploy revision `a7baac25318a41737aa591688497acf176492601`.
Production auth methods report Google/GitHub web sign-in and push configured,
email disabled. Staging's public address remains protected by Cloudflare Access;
its health/API checks were performed through authorized SSH. Code, data and env
backups were preserved before each deployment. Phone and main privacy sites are
live. Mac and Linux CI passed. Windows packaging/lifecycle passed, while its failed unit checks remain a release blocker. Logs and failed
screenshots remain in the adjacent work directory. The previous installed app,
app data and signal data were preserved, including a consistent SQLite backup
whose integrity check passed. Installed `app.asar` matches the verified arm64
package (SHA-256 `ff179506bb34974e4e46bcc7680a47b20e27d6c432840eb78bcc52d4b6cad388`).

## Existing operational evidence

GitHub web OAuth is configured, but this provider account reaches team onboarding;
existing Google-team access through GitHub remains unverified. Google rotation and
fresh browser sign-in succeeded. The stray Cloudflare GitHub installation remains
installed after the owner explicitly skipped the blocked confirmation. Gallery key
backup/restoration was verified in the local login Keychain; it is not off-device.

Public phone/Windows/connector claims remain gated until their documented real
device/provider acceptance is met. Synthetic tests are labelled as such.
