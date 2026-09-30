# Releasing Plexiform

Installers for Mac, Windows and Linux are built by GitHub Actions from a
version tag. A release goes out in two deliberate steps: **stage**, then
**promote**. Nothing reaches anyone's machine until it is promoted.

## 1. Stage

1. Bump `version` in package.json (e.g. `1.2.0`) and merge it to main.
2. Tag and push: `git tag v1.2.0 && git push origin v1.2.0`.
3. `.github/workflows/release.yml` then, on macOS, Windows and Ubuntu:
   - runs the unit tests
   - builds the installers:
     - Mac: DMG + zip, arm64 and x64
     - Windows: NSIS .exe, x64
     - Linux: AppImage + .deb, x64
   - smoke-tests each packaged app (`scripts/smoke-installed.js`): launch
     against a throwaway HOME → install the Claude Code hooks → run one →
     window loads → quit
   - creates a **draft** GitHub Release with every file and `SHA256SUMS.txt`
   - uploads the same files to R2 under `1.2.0/`, leaving the live feed alone

To try the build without staging anything: Actions → Release → Run workflow
(builds a branch, keeps the artifacts for 14 days).

## 2. Promote (make it live)

Actions → **Promote release** → version `1.2.0`. This:
- publishes the draft GitHub Release and marks it latest
- copies `1.2.0/*` to the root of the R2 bucket, installers first and the
  `latest*.yml` feed files last

Installed apps pick it up within a day (on launch, then daily):

| platform | what happens |
|---|---|
| Windows (NSIS) | downloads in the background; tray: "Restart to update to 1.2.0"; installs on the next quit if not restarted |
| Linux AppImage | same as Windows |
| macOS | tray and Settings: "Plexiform 1.2.0 is available — Download" (unsigned apps cannot replace themselves) |
| Linux .deb | notify + download link |

## Rolling back

Run **Promote release** with the previous version. The feed files point back
at it, and apps accept the downgrade (`allowDowngrade`). Installer file names
carry their version, so nothing is overwritten.

## Where the apps look

`Brand.urls.updates` in brand.js, baked into each build's `app-update.yml`
by electron-builder.config.js:
- now: `https://github.com/CallumJB125/claude-traffic-light/releases/latest/download`
- once download.plexiform.dev serves the R2 bucket: change that one line.
  The next release, and every one after it, reads from R2.

## R2 (Cloudflare)

Bucket `plexiform-releases`. GitHub Actions secrets: `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_RELEASES_BUCKET`. If they are
missing, the R2 step says so and skips; the GitHub Release still stages.

## Unsigned builds: what people will see

Signing is off until there is a Developer ID. The download page should say:
- **macOS:** "Plexiform can't be opened because Apple cannot check it for
  malicious software." The fix is right-click → Open, then Open (once).
- **Windows:** SmartScreen shows "Windows protected your PC". The fix is
  More info → Run anyway.
- **Linux AppImage:** `chmod +x Plexiform-*.AppImage`. Ubuntu 22.04+ needs
  `libfuse2` to run AppImages.

## Linux: what the AppImage needs

- **FUSE 2.** AppImages mount themselves through libfuse2, which Ubuntu
  22.04+ and Fedora no longer install by default. Without it the AppImage
  exits with "dlopen(): error loading libfuse.so.2". Fix:
  `sudo apt install libfuse2` (Ubuntu 24.04+: `libfuse2t64`), or run it
  unmounted with `./Plexiform-*.AppImage --appimage-extract-and-run`.
- **AppArmor on Ubuntu 23.10+.** Unprivileged user namespaces are restricted
  by AppArmor, so Chromium's sandbox can't start and the app exits at once
  ("The SUID sandbox helper binary was found, but is not configured
  correctly"). The .deb is not affected: its after-install sets the
  chrome-sandbox helper up. For the AppImage, either add an AppArmor profile
  that allows `userns` for it (the Ubuntu 24.04 release notes show the
  profile), or launch it with `--no-sandbox`. Recommend the .deb on Ubuntu.
- **Where it keeps its hooks.** An AppImage mounts somewhere new every launch,
  so the agents' hook commands run the .AppImage file itself against a copy
  of hooks/ in `~/.claude-traffic-light/hooks-<version>/`. Moving or renaming
  the .AppImage breaks them until the app is next opened, when it rewrites
  them.
- **Uninstall.** An AppImage has no uninstaller: before deleting it, run
  `./Plexiform-*.AppImage --uninstall-hooks` to take its hooks out of the
  agents' configs. The .deb and the Windows uninstaller do this themselves.
- **Icons.** `linux.icon` points at `build/icons/` (16–1024 px PNGs made from
  assets/icon.icns; `npm run icons` rebuilds them with the rest).

## Turning signing on (Callum)

What is needed, all as GitHub Actions secrets:

| secret | what | from |
|---|---|---|
| `CSC_LINK` | Developer ID Application certificate, .p12, base64 | Apple Developer account ($99/yr) → Certificates |
| `CSC_KEY_PASSWORD` | the .p12's password | set when exporting |
| `APPLE_API_KEY` | App Store Connect API key (.p8), base64, for notarytool | App Store Connect → Users and Access → Keys |
| `APPLE_API_KEY_ID` | its key id | same page |
| `APPLE_API_ISSUER` | issuer id | same page |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows code-signing certificate (optional; an OV cert still shows SmartScreen until it has reputation, EV does not) | a CA such as SSL.com or DigiCert, or Azure Trusted Signing |

Then:
- drop `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` in release.yml
- add `notarize: true` under `mac` in electron-builder.config.js
- give `build/sign.js` the identity; it already keeps the calendar helper's
  narrow entitlements
- turn on macOS auto-update in src/auto-update.js `supported()`, since signed
  apps can replace themselves
- if the terminal-jump feature must keep working under the hardened runtime,
  check that `com.apple.security.automation.apple-events` and
  `NSAppleEventsUsageDescription` are present
