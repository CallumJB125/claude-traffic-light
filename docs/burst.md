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

## What Plexiform shows from Burst

From Burst's local admin address, and only while Burst is trusted. Read-only, except the compaction switch below.

- **Usage, "Through Burst".** Secondary-provider spend (Burst's API-equivalent prices, source named on the page). It is never added to Plexiform's own Claude figures, which come from the Claude transcripts. Claude-plan traffic through Burst is shown as a request count only.
- **Board budgets.** While a runner is running cards, Plexiform gives it each session's secondary spend from the last 24 hours. A run's cost then includes overflow, so `run.budget_reached` covers it. Facts older than three minutes are ignored.
- **Compaction.** Sessions shows Burst's per-session compaction savings. While Burst compaction is on, Plexiform's own Claude compactor is forced off and Preferences says why.
- **Pauseless compaction (the one setting Plexiform can change).** Settings (Claude Burst card and Compactor), and This Mac, show whether Burst's own compaction is on, a Static or Smart choice, and Burst's savings ("9 compactions, saved about $X, 3.7M tokens not resent"). It appears only when your Burst reports the setting. Turning it on asks inline first, because Burst then uses your Claude subscription tokens to write summaries; Turn off is always shown. Plexiform reads Burst's current compaction settings, changes only `enabled` (and `mode`), and writes the whole object back to `POST /api/compaction` on the local admin address with Burst's admin header, so every other setting, including ones Plexiform does not know, is kept. If Burst rejects it, its message is shown and nothing changes. While Burst compaction is on, Plexiform's own Claude compactor is off. The chip's tooltip adds "Compaction on".
- **Handover for observed sessions.** For a Claude session Plexiform watches but does not own, the newest dated section of Burst's `HANDOFF.md` for that repository is shown on Sessions. It reaches the team hub only after you tick "Share Burst handover with team" for that repository (default off). It is scrubbed first and sent as a system-written note in the salvage section; the human and agent layers of a handover are never overwritten. The hub send is a no-op until the team hub client provides an append endpoint for it.
- **Limits.** A run that ends on a plan limit while Burst has no ready secondary shows **Paused: limit** with **Continue with another AI** (a retry on another AI, chosen with the session router, seeded from the handover). When Burst fails over successfully the card keeps running with a **via secondary** badge. No new board state.
