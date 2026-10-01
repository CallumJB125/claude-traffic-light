# Releasing Plexiform

Installers for Mac, Windows and Linux are built by GitHub Actions from a
version tag. A release goes out in two deliberate steps: **stage**, then
**promote**. Nothing reaches anyone's machine until it is promoted, and
nothing is signed until then either: the update signature is made by the
promote run, from the GitHub Release's own files.

## 1. Stage

1. Bump `version` in package.json (e.g. `1.2.0`) and merge it to main.
2. Tag and push: `git tag v1.2.0 && git push origin v1.2.0`.
3. `.github/workflows/release.yml` then, on macOS, Windows and Ubuntu:
   - writes `build/release-floor.json` (this build's time): the app refuses
     any `release.json` signed before it, even on a fresh install
   - runs the unit tests (each run capped at 20 minutes)
   - builds the installers:
     - Mac: DMG + zip, arm64 and x64
     - Windows: NSIS .exe, x64
     - Linux: AppImage + .deb, x64
   - smoke-tests each packaged app (`scripts/smoke-installed.js`): launch
     against a throwaway HOME → install the Claude Code hooks → run one →
     the widget page loads → quit
   - checks the installers against the feed files (`release-sign.js check`)
   - creates a **draft** GitHub Release with every file and `SHA256SUMS.txt`
   - uploads the same files to R2 under `1.2.0/`, leaving the live feed alone

Re-running a tag never changes a release that is out: the stage job fails
if the GitHub Release is already published or `1.2.0/release.json` exists
on R2. Bump the version instead.

To try the build without staging anything: Actions → Release → Run workflow
(builds a ref, keeps the artifacts for 14 days).

## Release checklist

- Windows does not ship yet. The first release is macOS-first: the Windows Unit tests step only reports (Mac and Linux block), and the stage and promote jobs drop every Windows file (`*-win-*`, `latest.yml`, `beta.yml`) unless the repo variable `WINDOWS_RELEASE` is `true`, so no Windows installer is staged, signed, listed in `release.json` or promoted. Installed Windows apps see such a release as "no update".
- To ship Windows, only once the Windows suite is green on a tag build, do both together: set the repo variable `WINDOWS_RELEASE=true` (Settings → Secrets and variables → Actions → Variables) AND remove `|| matrix.platform == 'win'` from the Unit tests step's `continue-on-error` in release.yml. One without the other either ships Windows untested or blocks it for nothing.
- CI runs Node 22 (`node-version: 22` in release.yml), while development machines may run a newer Node. A suite that passes locally can still fail on CI. Before tagging, run the suites under Node 22 from the checkout, without touching node_modules: `npx -y node@22 --test --test-force-exit test/*.test.js test/adapters/*.test.js` and `npx -y node@22 --test --test-force-exit remote/test/`.
- Run the Playwright visual specs on the release SHA before tagging, one spec at a time on a quiet machine (load under 16): `for s in test-visual/*.spec.js; do timeout 600 npx playwright test "$s" || echo "FAILED: $s"; done`. Neither `npm test` nor CI runs them, so a merge that changes wording without re-shooting a screenshot (as the rename once did for the Settings window and the pairing-code panel) only shows up here. A failed screenshot is either a stale baseline (re-shoot it with `--update-snapshots` for that spec, look at the new image, commit it) or a real regression (fix it); never re-shoot without looking.
- Lint the workflows after changing them: `actionlint .github/workflows/*.yml` (Homebrew: `brew install actionlint`). GitHub refuses an invalid workflow file outright, which shows as a failed run on every push and blocks every tag and dispatch. test/installers.test.js also parses each file.

## 2. Promote (make it live, and sign it)

Actions → **Promote release** → version `1.2.0`, run from main. In order:
1. downloads the GitHub Release's assets (the draft the tag staged)
2. reads the live `release.json` from R2 and verifies it with this repo's key
3. signs a fresh `release.json` from those assets with the channel's key
   (`release-sign.js build`): `issuedAt` now, `expiresAt` 30 days on. An
   older version than the live one is refused unless **rollback** is ticked
4. checks that what R2 staged under `1.2.0/` is byte for byte what it signed
5. points the R2 feed at it: installers, then the feed files, then
   `release.json(.sig)` (to `1.2.0/` for Revert, and last to the root)
6. publishes the GitHub Release and marks it latest

Any failure stops before the feed changes, or before GitHub says it's out.
Re-promoting the live version just signs it again with a fresh `issuedAt`
and expiry; that is how a release that has gone 30 days without a newer one
is renewed (the apps say they "couldn't confirm Plexiform is up to date"
once the live release has expired).

Installed apps check 30 s after launch and every 4 hours. Nothing downloads
unless the person asks (or turns automatic downloads on), and nothing
installs except through the updater's install command: "Restart to update"
installs now, unless a session is working or waiting on the person (then the
UI asks: restart anyway, or when idle = after 30 s with nothing busy). The
.deb only opens the system installer, so it never waits.

| platform | what happens |
|---|---|
| Windows (NSIS) | electron-updater downloads (only after its feed matches the signed release); install runs the installer silently and starts the new version; nothing installs on quit |
| Linux AppImage | same as Windows |
| macOS | the app downloads the zip, verifies it, unpacks it (`ditto`) and checks bundle id, version and that no link leaves the bundle; on restart it checks the zip again, unpacks it afresh, and a helper swaps the bundle and relaunches; if the new app hasn't reported in within 90 s the helper puts the old one back |
| Linux .deb | the verified .deb goes to ~/Downloads; install checks it again and opens it in the software installer (xdg-open) |

### Beta

Actions → Release → Run workflow with **beta** ticked builds `<ref>` as
`<version>-beta.<run>`, stages it to R2 `beta/<version>/` and a draft GitHub
prerelease. Promote with **beta** ticked signs it with the beta key and makes
it the beta feed (`beta/`). Apps on the beta channel (chosen in the update
settings, or any `-beta` build until the person picks a channel) read
`beta/release.json`. electron-builder names a beta's feed files `beta*.yml`
(after the version's prerelease tag); the stage, promote and signing scripts
and the app's electron-updater back end all expect that.

## Local builds (your Mac)
macOS registers every `.app` it sees with LaunchServices. Each packaged build left in a worktree, `/tmp` or the Bin therefore adds another "Plexiform" (or a copy of the app under its old name) to Open With, Spotlight and the Dock, and a stale one can even be launched by a `plexiform://` link. Clean up after every local build:
- `npm run smoke` does it for you: after a passing smoke test of the app it found in `dist/`, it unregisters that app (helpers included) and moves it to the Bin. The DMG and zip in `dist/` stay. It never touches an app you pass by path, such as `/Applications/Plexiform.app`.
- After `npm run dist` without a smoke test, run `npm run forget-build` (`scripts/forget-local-build.js`). It does the same for every `.app` under `dist/`.
- By hand, for any other copy (look at the path first; in an interactive shell `rm` and `mv` may be aliases, so use `/bin/mv`):
  ```
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "<path/to/App.app>"
  /bin/mv "<path/to/App.app>" ~/.Trash/
  ```
- Throwaway probe builds (sandboxed test apps with made-up names) must unregister themselves and every helper `.app` inside them when the probe ends.
- To check what's registered: `lsregister -dump | grep -E '^path:.*Plexiform.*\.app'` should list only `/Applications/Plexiform.app` (and its helpers).
- None of this matters on CI runners: `forget-build` does nothing there (`CI` is set).

## Who can release

The promote job runs in the GitHub environment `release`, which holds both
signing keys and only deploys from main or a `v*` tag. It has no required
reviewer, so **anyone who can run workflows on main can promote and sign a
release: repo write access is release power.** A required reviewer can be
added back to the environment in the repo's Settings → Environments →
release.

## Signing

- **Keys:** Ed25519, one per channel. The private keys exist only as the
  `release` environment's secrets `PLEXIFORM_UPDATE_SIGNING_KEY` (stable)
  and `PLEXIFORM_UPDATE_SIGNING_KEY_BETA` (beta), base64 of a PKCS8 PEM;
  only the promote job uses them. The public keys ship in the app as
  `build/update-key.pub.pem` (stable) and `build/update-key-beta.pub.pem`
  (beta). A beta install trusts only the beta key and only a manifest that
  says `channel: beta`; a stable install only the stable key and
  `channel: stable`. `release-sign.js` refuses a secret that doesn't match
  the public key in this repo.
- **Rotating:** the app trusts exactly those two files, so a rotation is a
  release that replaces the public key, followed by switching the secret.
  Installs older than that release then need a manual download.
- **Format:** `release.json` = `{ product: 'plexiform', channel, version,
  issuedAt, expiresAt, rollback, rollbackFrom?, notes, files: [{ name,
  sha512, size, platform, arch, kind }] }`; `release.json.sig` = base64
  Ed25519 signature over its exact bytes. `src/updater/verify.js` is the
  checker.

## What the app refuses

An update is refused, and the UI shows why, when:
- `release.json.sig` does not verify with the key for the app's channel (`signature`)
- the product isn't `plexiform`, or the channel isn't the one the app is on (`verify`)
- the version is older than the running one and the manifest isn't a
  signed rollback that lists the running version in `rollbackFrom`, and
  the person didn't ask to revert to it (`downgrade`)
- its `issuedAt` is older than the last manifest that channel accepted, or
  than this build's own build time: an old signed release replayed (`verify`)
- it is a rollback signed at or before the running version was built, or
  past its `expiresAt` (`verify`, `expired`)
- its `issuedAt` is more than a day in the future (`verify`)
- a downloaded file's size or sha512 differs from the signed entry, or (on
  Windows/AppImage) electron-updater's `update-available` files differ from
  it, name another server, or carry web-installer packages; that is
  checked before anything is downloaded (`verify`)
- macOS: the unpacked app has another bundle id or version, is a link, or
  links outside itself (`verify`); the app runs translocated
  (`translocated`), its folder isn't writable, or it is on another disk
  from its data folder (`not-writable`); those point the person at the .dmg

A release that is the running version but past its `expiresAt` is not
refused: the app reports `expired` ("couldn't confirm Plexiform is up to
date since …"), so a feed frozen on an old release shows.

## Rolling back

Run **Promote release** with the previous version and tick **rollback**.
It signs that version's GitHub Release assets afresh with `rollback: true`
and `rollbackFrom` = the live version (plus what the live one rolled back
from, plus anything in **rollback_from**). Apps on those versions accept the
downgrade; nobody else does. Only a version that was promoted before can
be rolled back to: every asset must have the sha512 that version's own
`<version>/release.json` on R2 lists (verified with this repo's key for the
channel), so a rollback never signs bytes that weren't signed before. Installer file names carry their version, so
nothing is overwritten. To go forward again, promote the newer version as
usual: it is signed fresh too.

People can also revert one install themselves (Revert, in the update
settings): every platform fetches `<version>/release.json(.sig)` for the
previous version, verifies it, and installs it through the same verified
path. That explicit revert is the only downgrade without a signed rollback
the app allows, and only to exactly that version.

## Where the apps look

`Brand.urls.updates` in brand.js: `https://download.plexiform.dev` (stable)
and `/beta` under it (beta). The updater reads `release.json` there and, on
Windows and AppImage, points electron-updater at the same folder.

## Identity, and builds from before the rename

Every release is `Plexiform.app` / `Plexiform.exe` / `plexiform` with bundle
id and appId `dev.plexiform.app`, and `release.json` says
`product: 'plexiform'` (test/rename-identity.test.js keeps package.json, the
builder config, brand.js, the updater and release-sign in step). A local
build from before the rename (`com.callumbaker.claude-buddy`) can't update
itself to Plexiform: the macOS swap refuses an app with another bundle id.
Install the DMG instead. On its first launch Plexiform copies the old
`claude-buddy` data folder, re-points the hooks and the MCP entry, asks a
running old copy to quit and offers to move it to the Bin
(src/rename-migration.js). Windows and Linux get the data folder, hooks, MCP
and login item; asking an old Windows copy to quit, or uninstalling it, is
not handled (no release ever shipped under the old name there).

## R2 (Cloudflare)

Bucket `plexiform-releases`. Secrets: `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_RELEASES_BUCKET`. Staging skips
R2 (and says so) without them, so the GitHub Release still stages; promote
fails without them.

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
