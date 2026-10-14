# Owner decisions implementation — 2026-10-14

The owner authorized autonomous implementation of the remaining handover items,
with Agent Mail free. Inbox polling remains opt-in. Codex remains the default
Tasks provider; Claude is available only where its provider sandbox is supported.

Implementation branch: `codex/owner-decisions-2026-10-14`, based on `08f46dd8`.

## Work ledger

- Agent Mail: free, including the text-only Ask my AI menu and launch. Inbox polling stays off by default; sending still requires Send/Confirm.
- Claude in Tasks: enabled on macOS/Linux, with Codex the default. Windows remains Codex-only because Claude's required sandbox is unsupported there.
- Entitlements: Ed25519 public key pinned; beta access is an explicit release policy and remains enabled. Private key stays outside Git; hub installation is pending.
- Crash reports: versioned renewed consent, structural-only sender, bounded hub intake, strict schema, rate limits and 30-day retention implemented. No historical uploads. Intake deployment is pending.
- Phone: standalone static Pages build, pinned hub API, CSP/SRI, narrow CORS, PKCE browser sign-in and session revocation checks implemented. VAPID generated privately; configuration/deployment pending. Public phone flag remains off.
- Linear/Jira: existing opt-in implementations retained; raw-delivery verification CLI added. Synthetic signature tests pass. Real signed provider deliveries remain required before enabling or advertising.
- Release: signing preflight and signed-Mac updater path implemented. No Developer ID/notarization or Windows signing credentials are available. Native Windows CI and local visual/install acceptance are pending.
- Privacy: technical notice updated; qualified legal review is still pending.

## Validation

Root suite: 4,722 passed, 7 skipped (4,729 total), bounded concurrency.
Remote suite: 220 passed. Site suite: 30 passed. Targeted menu/updater/phone checks passed.
The first full hub run found four sign-in tests failing because the phone return
path assumed session storage existed. Fixed with a safe fallback and strict-flow
regression coverage; the full hub rerun is in progress. All logs are retained in
the adjacent work directory. No new installer or production deploy is claimed here.

## Existing operational evidence

GitHub web OAuth is configured, but this provider account reaches team onboarding;
existing Google-team access through GitHub remains unverified. Google rotation and
fresh browser sign-in succeeded. The stray Cloudflare GitHub installation remains
installed after the owner explicitly skipped the blocked confirmation. Gallery key
backup/restoration was verified in the local login Keychain; it is not off-device.

Public phone/Windows/connector claims remain gated until their documented real
device/provider acceptance is met. Synthetic tests are labelled as such.
