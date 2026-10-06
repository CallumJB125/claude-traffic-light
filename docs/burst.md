# Claude Burst in Plexiform

Claude Burst is a separate, open-source local gateway for Claude Code on a Mac. It keeps you working through usage limits: when your plan's limit is reached it tries other Claude models on your plan, then makes a separate, paid request through a provider you chose and pay for. Plexiform does not bundle or modify Burst. Settings has a Claude Burst card that shows whether Burst is on and lets you turn it on or off.

macOS only. On Windows and Linux the card says so and does nothing.

## What it changes on your Mac

- Entries in `~/.claude/settings.json`: hooks for the features you switch on, and `ANTHROPIC_BASE_URL` in base-url mode.
- A LaunchAgent that runs the gateway, one for Burst's support console, and the binary in `~/.local/bin`.
- Transparent mode only (you choose it): an `/etc/hosts` entry, a pf redirect, a trusted root CA in the System keychain (name-constrained to `api.anthropic.com`) and root daemons. macOS asks for your password in Terminal; Plexiform never sees it.

Plexiform shows this list, the terms note, and the exact command before every action, and nothing runs until you confirm. Each action opens a visible Terminal window. Plexiform stores no secrets, and your provider key stays in Burst's dashboard and your Keychain.

## Turning it off

- Settings, Claude Burst, **Turn Burst off**, or **Turn Burst off…** in the menu bar menu. This runs `burst-off`, which works even when the gateway is broken.
- **Uninstall…** runs `./install.sh uninstall` from the Burst checkout and checks everything is gone.
- Quitting Plexiform leaves Burst as it was.

Plexiform only reads Burst's local admin address (`127.0.0.1`), and only trusts it when it is the gateway started by Burst's own LaunchAgent. Otherwise the card says Untrusted and reads nothing.
