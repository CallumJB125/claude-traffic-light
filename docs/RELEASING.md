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
   - writes `release.json` (every installer's name, size, sha512, platform,
     arch) and signs it into `release.json.sig` with
     `PLEXIFORM_UPDATE_SIGNING_KEY` (`scripts/release-sign.js`). **A tag
     release fails here if the secret is missing**: apps would refuse it.
   - creates a **draft** GitHub Release with every file and `SHA256SUMS.txt`
   - uploads the same files to R2 under `1.2.0/`, leaving the live feed alone

To try the build without staging anything: Actions → Release → Run workflow
(builds a branch, keeps the artifacts for 14 days).

## 2. Promote (make it live)

Actions → **Promote release** → version `1.2.0`. This:
- publishes the draft GitHub Release and marks it latest
- copies `1.2.0/*` to the root of the R2 bucket: installers first, then the
  `latest*.yml` feed files, then `release.json` and `release.json.sig` last.
  A version with no signed `release.json` staged is refused.

Installed apps check on launch, every 4 hours, and on "Check now". Each
update is verified against the signed release before anything is installed,
and none restarts on its own: "Restart to update" installs now, unless a
session is working or waiting on the person (then the UI asks: restart
anyway, or when idle = after 30 s with nothing busy).

| platform | what happens |
|---|---|
| Windows (NSIS) | electron-updater downloads (only after its feed matches the signed release); restart installs; also installs on the next quit |
| Linux AppImage | same as Windows |
| macOS | the app downloads the zip, verifies it, unpacks it (`ditto`), checks bundle id and version, and on restart a helper swaps the bundle and relaunches; if the new app hasn't reported in within 90 s the helper puts the old one back. The old bundle is kept for Revert |
| Linux .deb | the verified .deb goes to ~/Downloads and opens in the software installer (xdg-open) |

Beta builds (`workflow_dispatch` with beta, or a push to the installers
branch) are signed when the secret is set and stage under `beta/<version>/`.
Promote with **beta** ticked makes one the beta feed (`beta/`). Apps on the
beta channel (Preferences, or any `-beta` build) read `beta/release.json`.

## Signing

- **Key:** Ed25519. The private key is only the GitHub Actions secret
  `PLEXIFORM_UPDATE_SIGNING_KEY` (base64 of a PKCS8 PEM); the tag stage and
  a rollback promote need it. The public key ships in the app as
  `build/update-key.pub.pem`.
- **Rotating:** add the new public key as `build/update-key-2.pub.pem` (the
  app accepts any `build/update-key*.pub.pem`), release that, and only then
  switch the secret to the new private key. Drop the old public key a few
  releases later.
- **Format:** `release.json` = `{ product: 'plexiform', channel, version,
  issuedAt, rollback, notes, files: [{ name, sha512, size, platform, arch,
  kind }] }`; `release.json.sig` = base64 Ed25519 signature over its exact
  bytes. `src/updater/verify.js` is the checker.

## What the app refuses

An update is refused, and the UI shows why, when:
- `release.json.sig` does not verify with a shipped key (`signature`)
- the product isn't `plexiform`, or the channel isn't the one the app is on (`verify`)
- the version is older than the running one and the manifest isn't a
  signed rollback, and the person didn't ask to revert to it (`downgrade`)
- its `issuedAt` is older than the last manifest that channel accepted: an
  old signed release replayed (`verify`)
- a downloaded file's size or sha512 differs from the signed entry, or (on
  Windows/AppImage) electron-updater's `update-available` files differ from
  it; the latter is checked before anything is downloaded (`verify`)
- macOS: the unpacked app has another bundle id or version (`verify`), the
  app runs translocated (`translocated`), or its folder isn't writable
  (`not-writable`); both of those point the person at the .dmg

## Rolling back

Run **Promote release** with the previous version and tick **rollback**.
The workflow fetches that version's staged `release.json`, re-signs it with
`rollback: true` and a fresh `issuedAt`, and promotes it with that manifest.
Apps on the newer version then accept the downgrade (they refuse an unsigned
one, and the fresh `issuedAt` gets past their replay check). Installer file
names carry their version, so nothing is overwritten.

After a rollback, a later promote must also carry a fresh signature: stage a
new version (the normal case), or promote with rollback ticked.

People can also revert one install themselves (Revert, in the app's update settings):
macOS puts back the bundle it kept; Windows and AppImage fetch
`<version>/release.json(.sig)` for the previous version and install it
through the same verified path. That explicit revert is the only unsigned
downgrade the app allows.

## Where the apps look

`Brand.urls.updates` in brand.js: `https://download.plexiform.dev` (stable)
and `/beta` under it (beta). The updater reads `release.json` there and, on
Windows and AppImage, points electron-updater at the same folder.

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
- switch macOS from the self-swap (src/updater/mac-swap.js) to
  electron-updater's MacUpdater (Squirrel), keeping the manifest check in
  front of it as on Windows
- if the terminal-jump feature must keep working under the hardened runtime,
  check that `com.apple.security.automation.apple-events` and
  `NSAppleEventsUsageDescription` are present
