> **DRAFT — not legal advice; pending legal review before public launch.**

# Claude Buddy privacy notice

Claude Buddy is a desktop app that watches your AI coding sessions and shows their state as a small light. This page says what it reads, what it stores, and what (very little) ever leaves your computer. Things that are planned but not built yet are labelled **Not yet shipped**.

## What stays on your machine

Buddy reads these locally and never uploads them:

- Your Claude Code transcripts in `~/.claude/projects`, read to work out tokens and spend. Only counts and costs are kept, not the text.
- Your prompts and Claude's replies. Buddy never stores your prompts. Hooks from Claude Code (and from Cursor, Codex or Gemini if you connected them) tell Buddy that a prompt was submitted or a tool ran, and that feeds the session state below.
- Session state: for each session, the folder it runs in, its state, the current tool name, the model name, task counts, and the labels of agents it started (up to 40 characters of the agent's type or of the description the model wrote). When a turn fails, it also keeps up to 120 characters of the error or of Claude's last reply, which can therefore contain a snippet of Claude's own words.
- Permission previews, only if you turned on "Answer permission prompts from the widget" (off by default). Then, when Claude asks permission, Buddy briefly holds a preview (up to 200 characters) of the command, file path or URL, or the start of an agent's instructions. A command can contain secrets you typed into it. The file is readable only by you (mode 0600), is deleted when you answer, and any left behind is swept after 24 hours.
- Your settings, rules, and any face photos you add as cameos.
- Git and CI results fetched with your own `gh` login (see the next section).

Everything below lives in `~/.claude-traffic-light` on your computer:

- `sessions/`: one small file per live session.
- `requests/`: pending permission previews and your answers.
- `config.json`: your settings and rules.
- `stats.json`: per-day and per-project counts, times and costs, keyed by folder name.
- `cameos/`, including `cameos/index.json`: photos you add and their names.
- `git-signals.json`: recent pull request and CI events (repo names, titles, links).
- `app.log` and `app.log.old`: diagnostic log. It can contain project folder names, repo names and pull request numbers, file paths (which include your OS username) and notification titles. It never contains prompt text.
- `token` and `port`: the local connection details (see below).
- `bin/buddy-hook` (`bin\buddy-hook.cmd` on Windows): a small launcher that Claude Code's hooks call.
- `window-bounds.json`, `manual-override.json`, and first-run marker files.

Electron (the framework Buddy is built on) also keeps its own app data in `~/Library/Application Support/Claude Buddy` on macOS and `%APPDATA%\Claude Buddy` on Windows. That is browser-style housekeeping (cache, window state), not session data.

## What leaves the machine and when

Today, nothing is sent to us. There is no account, no telemetry, no analytics, no crash reporting and no update check in the app. The complete list of outbound flows:

- **GitHub, through your own `gh` login (ON by default).** <!-- flow:gh-poll --> This does nothing unless the GitHub command-line tool `gh` is installed and logged in. If it is, about every 90 seconds while a session is open (every 10 minutes when idle), Buddy runs `gh api` to ask GitHub about pull requests and Actions runs for the repos your session folders belong to. The request goes from your computer to api.github.com using your existing login. Buddy has no GitHub token of its own and we receive nothing. GitHub can see which repos you are working in and when, as it would for any `gh` use. Buddy also runs `git remote` and `git branch` locally to find the repo. To turn it off: Preferences → Git and CI → untick "Light up for pull requests and CI", then Save.
- **Open in browser.** The tray menu's "Open Claude" opens claude.ai in your browser. <!-- flow:rule-url --> A rule action of type "open URL" opens whatever address you set. These are ordinary browser visits that you trigger.
- **Your own rule actions.** A rule can run a shell command or a Shortcut you wrote. Whatever those do is up to you.
- **Your AI tools themselves.** Claude Code, and Cursor, Codex or Gemini if connected, send your prompts to their providers under those providers' own terms. Buddy is separate and does not change or see that traffic.
- **Local connections only.** Buddy listens on `127.0.0.1` only (never the network). Sending it signals requires a secret token saved in `~/.claude-traffic-light/token`, and browser requests are refused. One exception: `GET /status` needs no token, so any program running as you on your computer can ask for your live sessions' folders, their states and update times, and whether a budget is exceeded. Web pages and other computers cannot. We plan to require the token there too. <!-- flow:local-server --><!-- flow:local-probe --><!-- flow:local-mcp --> The optional Claude integration (MCP) talks to that local port.
- **Sound and speech.** Buddy plays sounds and speaks using your operating system (`afplay`, `say`, Windows speech). Nothing is sent anywhere.
- **Usage costs.** Spend is worked out from your transcripts on your machine. If there are none, Buddy may run `ccusage` in offline mode, which also reads locally.

### Not yet shipped

These are planned. None of them exists in the app today, and each would update this notice first:

- **Crash reporting.** Opt-in, off by default, with personal details scrubbed, and a "view what will be sent" screen. Lawful basis: your consent.
- **Update checks.** Asking GitHub Releases whether a new version exists. Lawful basis: legitimate interests (keeping you on a secure, working version).
- **Team board.** For teams that choose to join a shared hub: cards, handovers and presence would be shared with that team. Lawful basis: contract, with the team's administrator.
- **Phone approvals.** A relay so you can answer permission requests from your phone.
- **Slack and other connectors.**

Before any of these ships, this notice will name the processors involved and the countries your data would go to. Sending personal information abroad is regulated by POPIA section 72 and GDPR Chapter V, so each would need a lawful transfer basis.

## How long things are kept

What the code does today:

- **Stats:** per-day counts and costs are pruned after 60 days.
- **Session files:** swept automatically once they are stale, which is the longer of your "waiting" and "working" stale settings (defaults 4 hours and 6 minutes) plus 12 hours.
- **`app.log`:** rotated at 512 KB into one `app.log.old` file, which is overwritten at the next rotation. So at most about 1 MB of log is kept.
- **Git events:** at most the last 30 events, and "seen" markers are dropped after 2 days.
- **Permission previews:** removed when answered. Any orphaned file is swept after 24 hours.
- **Everything else** (config, cameos, window position) stays until you delete it.

PROPOSED, not built: let you choose how many days of stats to keep.

## Export your data

- **Stats:** in the Lights window, Stats → Export JSON or Export CSV.
- **Rules:** in the Lights window, the share menu → Export rules.
- **Setup:** in the Lights window, Export setup, which bundles your settings, rules, presets and face photos into one file. It contains the photos you added, so be careful who you share it with.
- The Privacy section in Preferences has shortcuts for the stats and setup exports.

## Delete your data

Buddy never deletes your data for you. To remove it yourself:

1. Quit Claude Buddy (tray menu → Quit).
2. Remove the hooks it added to Claude Code (in `~/.claude/settings.json`, or `%USERPROFILE%\.claude\settings.json` on Windows), and the `claude-buddy` entry in `~/.claude.json` if you turned on the Claude integration. Hooks for Cursor, Codex and Gemini, if connected, are in those tools' own config.
3. Delete the folder `~/.claude-traffic-light` (`%USERPROFILE%\.claude-traffic-light` on Windows), which includes `bin/buddy-hook`.
4. Delete Electron's app data: `~/Library/Application Support/Claude Buddy` on macOS, `%APPDATA%\Claude Buddy` on Windows.
5. Uninstall the app the usual way for your system: on macOS drag Claude Buddy from Applications to the Bin, on Windows use Settings → Apps. Turn off "Open at login" first if you enabled it.

## Your rights

**South Africa (POPIA).** Buddy keeps data on your device and we do not receive it, so today we hold no personal information about you. If that changes (the planned features above), these apply. Responsible parties must process information lawfully and in a way that does not infringe your privacy, and must follow the eight conditions in plain words:

- Accountability: someone is responsible for compliance.
- Processing limitation: collect only what is needed, lawfully, with consent where needed.
- Purpose specification: collect for a stated purpose and keep it no longer than needed.
- Further processing limitation: don't reuse it for an unrelated purpose.
- Information quality: keep it accurate.
- Openness: tell you what is collected and why.
- Security safeguards: protect it.
- Data subject participation: you can ask what we hold and ask for correction or deletion.

You can also ask us to restrict processing and object to it (POPIA section 11(3)). Our Information Officer is `[Information Officer — Callum to confirm]`. You can complain to the Information Regulator (South Africa) at inforeg.org.za.

**GDPR basics (if you are in the EU or UK).** You can ask for access to your data, correction of it, erasure, restriction of processing, a portable copy, and you can object to processing or withdraw consent at any time. You can complain to your local data protection authority, for UK users the Information Commissioner's Office (ICO).

Because the data is on your machine, you can do most of this yourself with the export and delete steps above.

## Contact

`[privacy contact — Callum to fill]`

## Changes to this notice

If we add any new flow, we will update this notice before it ships. This page is a draft and will change.
