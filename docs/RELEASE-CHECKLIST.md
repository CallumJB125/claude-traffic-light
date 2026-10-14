# Release checklist

One page to run a release from start to finish: build, signing and notarisation, the R2 update host, and the auto-update test plan. The detail lives in `docs/RELEASING.md`; this page is the order of work and the tick boxes.

**[OWNER]** marks a step only Callum can do: it needs an Apple or Windows account, a payment, a Cloudflare or GitHub setting, a secret, or a decision. Everything else can be done by anyone with write access to the repo, which is also release power (the `release` environment has no required reviewer; see "Who can release" in `RELEASING.md`).

Nothing on this page has been run as part of writing it. Current state, read from the repo:

| Item | State in the repo |
|---|---|
| App version | `package.json` is `1.0.2` |
| macOS signing | Not signed. `release.yml` builds with `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`, and `electron-builder.config.js` uses ad-hoc identity `-` when no `CSC_LINK`/`CSC_NAME` is set. No `notarize` setting. |
| Windows signing | None configured (`WIN_CSC_*` unused). Windows publication is off unless the repo variable `WINDOWS_RELEASE=true`. |
| Update signing | Ed25519 keys in the `release` environment (`PLEXIFORM_UPDATE_SIGNING_KEY`, `PLEXIFORM_UPDATE_SIGNING_KEY_BETA`); public halves ship as `build/update-key.pub.pem` and `build/update-key-beta.pub.pem`. |
| Update host | `https://download.plexiform.dev` (stable) and `/beta` under it, backed by R2 bucket `plexiform-releases`. |

## A. Before tagging

- [ ] Working tree clean on main; CI green on the SHA you will tag.
- [ ] Unit suites pass under **Node 22** (CI uses 22; a newer local Node can hide failures):
  ```sh
  npx -y node@22 --test --test-force-exit test/*.test.js test/adapters/*.test.js
  npx -y node@22 --test --test-force-exit remote/test/*.test.js
  ```
- [ ] Playwright visual specs on the release SHA, one at a time on a quiet machine (neither `npm test` nor CI runs them):
  ```sh
  for s in test-visual/*.spec.js; do timeout 600 npx playwright test "$s" || echo "FAILED: $s"; done
  ```
- [ ] If workflows changed: `actionlint .github/workflows/*.yml`.
- [ ] `docs/release-notes.md` and `site/src/changelog.html` match what is in the build (see `docs/claims-audit-2026-10-09.md`). Uncomment a draft line only if it is on main and in the tagged build.
- [ ] `PRIVACY.md` and `site/src/privacy.html` match the build. Anything new that leaves the machine needs a privacy-flow entry first.
- [ ] Decide the release version and bump `version` in `package.json`; merge to main. **[OWNER]** decides the number and whether this is a stable or a beta release.
- [ ] Windows: leave `WINDOWS_RELEASE` unset unless the exact candidate has passed the Windows acceptance checks (`windows-acceptance.yml`). Setting it never bypasses tests. **[OWNER]**

## B. Signing and notarisation (macOS and Windows) **[OWNER]**

Until this section is done, every Mac build is unsigned. Users see "Plexiform can't be opened because Apple cannot check it for malicious software" and use right-click, Open (or Open Anyway). The curl installer (`plexiform.dev/install.sh`) avoids that because `curl` does not set the quarantine attribute. Update signing (Ed25519) is **separate** from this section and works regardless.

### B1. Accounts and secrets **[OWNER]**

- [ ] Apple Developer Program membership (paid, yearly) and a **Developer ID Application** certificate exported as a `.p12`.
- [ ] An App Store Connect API key (`.p8`) for `notarytool`: key id and issuer id.
- [ ] Add these as GitHub Actions secrets:

  | Secret | What |
  |---|---|
  | `CSC_LINK` | the `.p12`, base64 |
  | `CSC_KEY_PASSWORD` | the `.p12` password |
  | `APPLE_API_KEY` | the `.p8`, base64 |
  | `APPLE_API_KEY_ID` | its key id |
  | `APPLE_API_ISSUER` | issuer id |
  | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | optional Windows certificate. An OV certificate still shows SmartScreen until it builds reputation; EV does not. |

### B2. Repo changes (can be made by anyone once B1 is done; review them as a release change)

- [ ] Remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` from the "Build installers" step in `.github/workflows/release.yml`.
- [ ] Add `notarize: true` under `mac` in `electron-builder.config.js`.
- [ ] Give `build/sign.js` the Developer ID identity. It already keeps the calendar helper's narrow entitlements.
- [ ] Check the hardened runtime keeps working with the entitlements in `build/entitlements.mac.plist`; if terminal-jump must keep working, `com.apple.security.automation.apple-events` and `NSAppleEventsUsageDescription` must be present.
- [ ] Switch macOS auto-update from the self-swap (`src/updater/mac-swap.js`) to electron-updater's `MacUpdater` (Squirrel), keeping the manifest check in front of it as on Windows. Until then, a signed Developer ID app is still replaced by the self-swap, which checks bundle id and version, so test it (Section E).
- [ ] Update the unsigned-build wording on the download page and in `docs/release-notes.md` ("This release is not signed by Apple") only once a signed, notarised build has been verified.

### B3. Verify a notarised build **[OWNER or anyone with a Mac]**

On a Mac that has never run Plexiform, download the DMG in a browser (so it is quarantined):

- [ ] Opens with no "cannot be opened" warning; first launch shows only the standard "downloaded from the internet" prompt, if any.
- [ ] `spctl --assess --type execute -vv /Applications/Plexiform.app` reports `accepted` and `source=Notarized Developer ID`.
- [ ] `codesign --verify --deep --strict --verbose=2 /Applications/Plexiform.app` passes.
- [ ] `xcrun stapler validate /Applications/Plexiform.app` passes (the ticket is stapled).
- [ ] The calendar helper, voice helper and setups helper still run (calendar and microphone prompts appear and work).
- [ ] The Keychain no longer asks again after an update (it did while unsigned).

## C. R2 update host **[OWNER]**

The app looks for updates at `Brand.urls.updates` (`brand.js`): `https://download.plexiform.dev`, beta under `/beta`. R2 holds the installers and the signed `release.json` / `release.json.sig` feed.

### C1. One-time setup **[OWNER]**

- [ ] Cloudflare R2 bucket `plexiform-releases` exists.
- [ ] `download.plexiform.dev` is attached to the bucket as a custom domain (public read), with TLS working. The bucket must serve `release.json`, `release.json.sig`, the feed files and the installers.
- [ ] An R2 API token with write access to that bucket only. Add these as GitHub Actions secrets (the release environment): `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_RELEASES_BUCKET`. Without them, staging skips R2 (and says so); promote fails.
- [ ] The two Ed25519 private keys are in the `release` environment as `PLEXIFORM_UPDATE_SIGNING_KEY` and `PLEXIFORM_UPDATE_SIGNING_KEY_BETA` (base64 of a PKCS8 PEM). The matching public keys are the committed `build/update-key.pub.pem` and `build/update-key-beta.pub.pem`; `release-sign.js` refuses a secret that does not match.
- [ ] Optional hardening **[OWNER]**: add a required reviewer to the `release` environment (Settings, Environments, release) so promote needs a second pair of eyes.
- [ ] Back up the private keys somewhere offline. Losing a key means every install of that channel needs a manual download to take a new public key.

### C2. Check the host before the first promote

- [ ] `curl -sI https://download.plexiform.dev/release.json` and `.../beta/release.json`: returns `200` once a release has been promoted (before that, `404` is expected). Stable and beta feeds are independent.
- [ ] Nothing else is stored at the bucket root that should not be public.

## D. Stage, then promote

### D1. Stage (build and upload, nothing live yet)

- [ ] Tag the merged commit and push: `git tag v<version> && git push origin v<version>`.
- [ ] Actions, **Release**: all jobs green on macOS, Ubuntu (and Windows only when `WINDOWS_RELEASE=true`). It builds the installers, smoke-tests each packaged app, creates a **draft** GitHub Release with `SHA256SUMS.txt`, and uploads to R2 under `<version>/` without touching the live feed.
- [ ] The draft GitHub Release has: Mac DMG and zip (arm64 and x64), Linux AppImage and deb, and `SHA256SUMS.txt`.
- [ ] Re-running a tag changes nothing already out; bump the version instead.
- [ ] Beta rehearsal: Actions, Release, Run workflow with **beta** ticked builds `<version>-beta.<run>` and stages it to R2 `beta/<version>/` plus a draft prerelease. Do this first for any release that changes the updater, signing, or install flow.

### D2. Install the staged build on real machines (before it goes live)

- [ ] Download the staged installers from the draft release, not from R2, on a Mac (Apple Silicon and, if available, Intel) and on Linux. Check each against `SHA256SUMS.txt`: `shasum -a 256 -c SHA256SUMS.txt`.
- [ ] Install, launch, connect Claude Code hooks on a clean user (use a throwaway HOME for any manual run so your real `~/.claude/settings.json` is not rewritten), widget shows, quit cleanly.

### D3. Promote (this is the moment it goes live and gets signed) **[OWNER decides]**

- [ ] Actions, **Promote release**, from main, version `<version>`. It signs a fresh `release.json` (30-day expiry), checks R2 is byte for byte what it signed, moves the feed, publishes the GitHub Release as latest.
- [ ] `curl -fsS https://download.plexiform.dev/release.json | head` shows the new version and `"product":"plexiform"`, `"channel":"stable"`.
- [ ] Both `release.json` and `release.json.sig` return `200` from `download.plexiform.dev`.
- [ ] `PLEXIFORM_CHANNEL=stable` installer path still works: `curl -fsSL https://plexiform.dev/install.sh | sh` on a throwaway Mac user installs the new zip (it checks `SHA256SUMS.txt`).
- [ ] Renewal reminder: a live release expires 30 days after `issuedAt`. Put a calendar reminder to re-promote the live version every 3 weeks or so; an expired feed makes apps say they "couldn't confirm Plexiform is up to date". **[OWNER]**

## E. Auto-update test plan

Run on each platform you ship. You need an **older** installed build (N-1) and the new promoted build (N). Always test beta first, with the beta key and `beta/` feed, using two beta builds.

Setup: install N-1 from its release asset. Open the update settings (the **What's new** / About page) and note the channel. The app checks 30 seconds after launch and every 4 hours; use "Check for updates" to force it.

| # | Test | Steps | Expected result | Platforms |
|---|---|---|---|---|
| E1 | Happy path | With N live, N-1 clicks **Check**, then **Download**, then **Restart to update** | Offers N; downloads only when asked; after restart the app reports N; settings and hooks still work | Mac, Linux AppImage, Windows NSIS |
| E2 | Busy session | Start a Claude session that is working, then click Restart to update | The UI asks: restart anyway, or when idle (after 30 s with nothing busy). Nothing installs mid-session without a choice | all |
| E3 | Mac rollback guard | Mac only: install N, and simulate the new app failing to report in (use a build that exits at launch) | If the new app has not reported within 90 s the helper puts the old app back | Mac |
| E4 | .deb | Linux deb: Check, Download, Install | The verified .deb goes to `~/Downloads`; Install re-checks it and opens the system installer. No silent install | Linux deb |
| E5 | Portable | Windows portable, if shipped | A verified offer with instructions to download and replace; the portable never self-installs | Windows |
| E6 | Tamper: bad signature | Serve a `release.json` whose `.sig` was made with another key (local test server, or edit a copy) | Refused with `signature`; nothing downloads | any |
| E7 | Tamper: bad file | Change one byte in a downloaded installer or a file's sha512 in a test feed | Refused (`verify`) before anything installs | any |
| E8 | Downgrade | Point an N build at a feed advertising N-1 without rollback | Refused (`downgrade`) | any |
| E9 | Expired feed | Test feed past its `expiresAt` (30 days) | App reports `expired` ("couldn't confirm Plexiform is up to date"), no update installed | any |
| E10 | Replay | Test feed whose `issuedAt` is older than the last accepted manifest | Refused (`verify`) | any |
| E11 | Wrong channel | A stable install given a beta-signed manifest, and the reverse | Refused (`verify`) | any |
| E12 | Channel switch | Switch an install to beta in update settings and back | Beta reads `beta/release.json`; stable reads root; each trusts only its own key | any |
| E13 | Revert | After updating to N, use **Revert** in the update settings | Fetches `<previous>/release.json(.sig)`, verifies, installs the previous version; only that exact version is allowed | Mac, Windows NSIS, AppImage |
| E14 | Signed rollback | **[OWNER]** Promote the previous version with **rollback** ticked | Apps on the bad version accept the downgrade; others refuse. Promote the newer fixed version afterwards to go forward again | any |
| E15 | Mac translocation / read-only | Run the app from the mounted DMG, then from a read-only folder | Update refuses with `translocated` / `not-writable` and tells the user to use the .dmg | Mac |
| E16 | Offline | Disconnect the network and check for updates | A clear "could not check" state; the app keeps working | any |

Unit-level coverage of E6 to E11 already exists in the updater tests under `test/`; this plan proves them against the **live** feed and real installers, which tests cannot.

Windows: the installer lifecycle check is a same-version upgrade-mode test only. It is **not** proof of a signed version-to-version download and restart, DPAPI token persistence or tray behaviour; those checks (E1, E5) on real Windows machines remain required before `WINDOWS_RELEASE=true`. **[OWNER]**

## F. After it is live

- [ ] Update `docs/release-notes.md` (the release body is shown in the draft release) and `site/src/changelog.html` with the real date.
- [ ] Rebuild and deploy the site if the download page changed (site deploy is **[OWNER]**; flags live in `site/site.config.json`: `windowsDownloads`, `phone`, `publicSignup`).
- [ ] Review optional structural crash reports in the private hub intake (new reports after renewed consent only; no error text or stacks). Feedback and support remain the source of detailed user reports. Check GitHub issues and the feedback board daily for the first week.
- [ ] Write the release SHA, the promote time and `issuedAt` in the handover notes.

## G. Rollback quick reference

| Situation | Action |
|---|---|
| Bad build not yet promoted | Do not promote. Delete the draft release; bump the version and tag again. |
| Bad build promoted | Promote the previous version with **rollback** ticked (E14). Affected apps go back; new installs get the old one. |
| Feed expired | Re-promote the live version (fresh `issuedAt`, 30 more days). |
| Signing key lost or leaked | **[OWNER]** Ship a release replacing the public key (`build/update-key*.pub.pem`), then switch the secret. Older installs need a manual download. |

## Signing implementation update (2026-10-14)

`build/signing-policy.js` enables notarization only with a Developer ID plus
complete Apple API-key or app-password credentials. Set
`PLEXIFORM_REQUIRE_SIGNING=1` for release builds: missing signing/notarization
credentials fail before packaging. Unsigned development builds remain possible.
Signed/notarized macOS packages carry `plexiformSignedMac` metadata and use
electron-updater only after the existing signed-manifest checks; ad-hoc packages
retain the existing verified swap path. Signed Windows packaging also requires
a certificate when signing is required. This code does not constitute signed
installer, notarization, Windows device or legal/privacy acceptance.
