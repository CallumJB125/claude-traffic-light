# Claude Burst in Plexiform

Claude Burst is a separate, open-source local gateway for Claude Code on a Mac. It keeps you working through usage limits: when your plan's limit is reached it tries other Claude models on your plan, then makes a separate, paid request through a provider you chose and pay for. Plexiform does not bundle or modify Burst. Settings has a Claude Burst card that shows whether Burst is on and lets you turn it on or off, and the **Usage optimiser** page (Activity, after Stats) shows Burst's own dashboard inside Plexiform.

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

## Usage optimiser (Burst's dashboard inside Plexiform)

Burst's dashboard is a web page on its local admin address. It refuses to be framed (`X-Frame-Options: DENY`), so Plexiform loads it as its own page in a separate view, in its own storage (`persist:burst-dashboard`), sandboxed, with no preload and no access to Plexiform's data or APIs.

- **When it loads.** Only after Plexiform has confirmed that the program answering is your Burst install (the same version and process check as the card), and again on every reload. If Burst is absent, untrusted, too old (before 0.19) or not answering, the page shows a native Plexiform message instead, with the same consent-gated actions as Settings (Turn on, Repair, Update, Turn Burst off), and a link to these docs. It is never blank.
- **What it may do.** The view can only go to Burst's exact address. Links to Anthropic's documentation sites and GitHub open in your browser (https only); every other link, pop-up, permission request and download is refused, and the page cannot make network requests anywhere but Burst's own address.
- **How it looks.** Plexiform overrides Burst's colour variables and typography with its own, in light and dark. Burst's own header and menu are hidden. Its sections (Overview, Spend, Context & compaction, Routing, Sessions & handover, This Mac and so on) appear as sub-items under Usage optimiser in the sidebar, read from the page when it loads (at most ten); clicking one activates that section. If Burst renames things, the page still works, just less styled.
- **Top bar.** The page has Plexiform's own bar: the Burst status chip, **Open in browser** (the same dashboard at `127.0.0.1` in your browser, for power users) and **Refresh**.
- **Resources.** Like any page it is closed when you have been away from it for a minute, and rebuilt when you come back.
- **Hidden controls.** Burst's own header (for example its Reinstall and revert buttons) is hidden here. Turn Burst off and Repair stay available from Plexiform (Settings, the menu bar menu and this page's messages), and **Open in browser** shows the untouched dashboard.

The card's **Open dashboard** opens this page; **Open in browser** is the secondary way in.

## What Plexiform shows from Burst

From Burst's local admin address, and only while Burst is trusted. Read-only, except the compaction switch below.

- **Usage, "Through Burst".** Secondary-provider spend (Burst's API-equivalent prices, source named on the page). It is never added to Plexiform's own Claude figures, which come from the Claude transcripts. Claude-plan traffic through Burst is shown as a request count only.
- **Board budgets.** While a runner is running cards, Plexiform gives it each session's secondary spend from the last 24 hours. A run's cost then includes overflow, so `run.budget_reached` covers it. Facts older than three minutes are ignored.
- **Compaction.** Sessions shows Burst's per-session compaction savings. While Burst compaction is on, Plexiform's own Claude compactor is forced off and Preferences says why.
- **Pauseless compaction (the one setting Plexiform can change).** Settings (Claude Burst card and Compactor), and This Mac, show whether Burst's own compaction is on, a Static or Smart choice, and Burst's savings ("9 compactions, saved about $X, 3.7M tokens not resent"). It appears only when your Burst reports the setting. Turning it on asks inline first, because Burst then uses your Claude subscription tokens to write summaries; Turn off is always shown. Plexiform reads Burst's current compaction settings, changes only `enabled` (and `mode`), and writes the whole object back to `POST /api/compaction` on the local admin address with Burst's admin header, so every other setting, including ones Plexiform does not know, is kept. If Burst rejects it, its message is shown and nothing changes. While Burst compaction is on, Plexiform's own Claude compactor is off. The chip's tooltip adds "Compaction on".
- **Handover for observed sessions.** For a Claude session Plexiform watches but does not own, the newest dated section of Burst's `HANDOFF.md` for that repository is shown on Sessions. It reaches the team hub only after you tick "Share Burst handover with team" for that repository (default off). It is scrubbed first and sent as a system-written note in the salvage section; the human and agent layers of a handover are never overwritten. The hub send is a no-op until the team hub client provides an append endpoint for it.
- **Limits.** A run that ends on a plan limit while Burst has no ready secondary shows **Paused: limit** with **Continue with another AI** (a retry on another AI, chosen with the session router, seeded from the handover). When Burst fails over successfully the card keeps running with a **via secondary** badge. No new board state.
