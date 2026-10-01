Plexiform for Mac, Windows and Linux. This is the first beta build.

**What's new**
- **A new name.** The app is now called Plexiform. The first time it starts it copies your settings and data from the old app and points Claude Code's hooks at the new one. It keeps `.pre-plexiform` backups of what it changes, and it leaves the old app installed unless you remove it.
- **Team and Integrations are visible before you sign in**, so you can see what they do first.
- **Sign in with Google or GitHub, or with an email code**, then create or join a team. Teams have roles and invites by link or code. <!-- email code: keep this line only once the mail service is deployed; until then say "Email code sign-in is coming" -->
- **GitHub connects end to end.** There's an option to use an organisation-owned GitHub app.
- **Backups and restore** of your local settings, in Settings → Backups.
- **Updates in the app.** The app can check for a newer version and install it.
- **A fix for detached sessions swapping terminal tabs** when you jump to them.
- **A strict content-security policy** on the widget, Lights and Settings pages.

<!-- Include below ONLY if merged and verified before the tag, otherwise delete:
- The full-app right-click menu and the matching tray entries.
- The Usage pop-out window.
- A Send feedback button.
-->

**Known limits**
- This beta is not signed. Opening it the first time takes a few extra steps (see Install).
- macOS may ask to use the keychain. Enter your Mac password and choose **Always Allow**. It may ask again after an update while the beta is unsigned.
- Slack and Sentry are not in this release.
- Email codes work only for verified addresses until our email service has production access.
- Windows and Linux builds have not been tried on real machines yet.

**Install**
- Mac: open the .dmg (Apple Silicon: `mac-arm64`; Intel: `mac-x64`) and drag Plexiform to Applications. Open it and choose Done, then go to System Settings → Privacy & Security and choose Open Anyway. On macOS 14 and earlier, right-click → Open instead.
- Windows: run the .exe. If SmartScreen appears: More info → Run anyway.
- Linux: the .AppImage (`chmod +x`, then run it) or the .deb (`sudo apt install ./Plexiform-*.deb`).

Checksums are in SHA256SUMS.txt.
