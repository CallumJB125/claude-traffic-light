Plexiform for Mac, Windows and Linux. This is the first beta build.

**What's new**
- **A new name.** The app is now called Plexiform. The first time it starts it copies your settings and data from the old app (copied, not moved; the old app's data is left in place) and points Claude Code's hooks at the new one. It keeps `.pre-plexiform` backups of what it changes. It offers to move the old app to the Bin; the default is to keep it.
- **Team and Integrations are visible before you sign in**, so you can see what they do first.
- **Sign in with Google or GitHub, or with an email code**, then create or join a team. Teams have roles and invites by link or code. <!-- email code: keep this line only once the mail service is deployed; until then say "Email code sign-in is coming" -->
- **GitHub can be connected** from Integrations once you've joined a team, including as an organisation-owned app. (GitHub's own rules decide where a private app can be installed; if it won't install on your organisation, tell us.)
- **Backups and restore** of your local settings, in Settings → Backups.
- **Updates in the app.** The app can check for a newer version and install it.
- **Jumping to a session running in a detached tmux session** no longer switches the terminal tab you are on. If the session's terminal can't be found, Plexiform tells you and shows the command to attach.

<!-- DRAFT additions. Uncomment a line only when it is on main AND in the build being tagged; they are all on main now except where noted.
- **Characters.** New characters to pick as your Body in Lights: a rubber duck, octopus, CRT monitor, blob, capybara and cactus, then an owl, penguin, fox, bee, axolotl and mushroom. [wave 3, on its own branch (egg, toaster, cloud, astronaut, sloth, T-rex, cyclops): add the line "…and an egg, toaster, cloud, astronaut, sloth, T-rex and cyclops" only once it is merged]
- **Hatch a character.** In Lights, under Body, "+ Hatch" opens a small window: choose a shape, size, arms, accessory and colour (or "Surprise me"), watch it on the real character as you go, and save it. It is made on your computer from templates and kept in `~/.claude-traffic-light/characters`. Describing a character to an AI is not in this release.
- **Right-click the widget** to open the Plexiform window. Shift- or Option-right-click still opens the full menu.
- **A Usage pop-out** from the tray or widget menu: today's spend, this week's, and the busiest model.
- **Send feedback.** A "Something's off / Idea" form in the app. It saves your note on your computer; you can attach diagnostics and a screenshot, and nothing is sent until you choose to send it. [70: please confirm the exact senders offered before this ships]
-->

**Known limits**
- This beta is not signed. Opening it the first time takes a few extra steps (see Install).
- macOS may ask to use the keychain. Enter your Mac password and choose **Always Allow**. It may ask again after an update while the beta is unsigned.
- Slack and Sentry are not in this release.
- Signing in by email needs your address verified until we move out of the email sandbox.
- Windows and Linux builds have not been tried on real machines yet.

**Install**
- Mac: open the .dmg (Apple Silicon: `mac-arm64`; Intel: `mac-x64`) and drag Plexiform to Applications. Open it and choose Done, then go to System Settings → Privacy & Security and choose Open Anyway. On macOS 14 and earlier, right-click → Open instead.
- Windows: run the .exe. If SmartScreen appears: More info → Run anyway.
- Linux: the .AppImage (`chmod +x`, then run it) or the .deb (`sudo apt install ./Plexiform-*.deb`).

Checksums are in SHA256SUMS.txt.
