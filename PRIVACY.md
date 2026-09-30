> **DRAFT — not legal advice; pending legal review before public launch.**

# Plexiform privacy notice

Plexiform is a desktop app that watches your AI coding sessions and shows their state as a small light. This page says what it reads, what it keeps, and what (very little) ever leaves your computer. Things that are planned but not built yet are labelled **Not yet shipped**.

## In short

- **On by default:** checking GitHub for pull requests and builds through your own GitHub login (only if you have the `gh` tool signed in), and reading your Focus / Do Not Disturb status on this computer.
- **Off by default:** calendar, calendar subscription link, voice questions to Claude, answering permission prompts from Plexiform, and remote devices.
- **Never:** telemetry or analytics. Nothing is sent to us.
- **Only if you join a team board:** the team board sends your cards, handovers and run progress to the team hub your team uses (see below).
- **Not built yet:** crash reports (they will be off until you opt in) and update checks.

## What stays on your machine

Plexiform reads these on your computer and never uploads them:

- Your Claude Code conversation logs (the files in `~/.claude/projects`), read to work out tokens and spend. Only counts and costs are kept, not the text.
- Your prompts and Claude's replies. Plexiform never stores your prompts. Claude Code (and Cursor, Codex or Gemini if you connected them) tells Plexiform through small add-ons called hooks that a prompt was sent or a tool ran, and that feeds the session state below.
- Session state: for each session, the folder it runs in, its state, the current tool name, the model name, task counts, and the labels of agents it started (up to 40 characters of the agent's type or of the description the model wrote). When a turn fails, it also keeps up to 120 characters of the error or of Claude's last reply, which can therefore contain a snippet of Claude's own words.
- Waiting inputs you answer from the widget, only if you turned on "Answer permission prompts from the widget" (off by default). While Claude Code waits for you, Plexiform briefly holds what it is waiting on, in a request file with the request id, session id, folder, tool name, and a fingerprint (SHA-256) that binds your answer to exactly what was shown. What else the file holds depends on the kind:
  - **Permission:** the full tool input (the whole command, file path, web address or agent instructions) and any "allow for this session" suggestions. A command can contain secrets you typed into it.
  - **Plan:** the plan text Claude wants approved.
  - **Question:** the questions and their options.
  - **Elicitation:** the request an MCP server is making of you, including the form it asks you to fill.
  - **Notification and blocked:** not request files. The notification's title and message, or the reason Claude's classifier denied something, is recorded in the session file and only shown.
  - **Dialog:** a startup or permission dialog read from a terminal pane (see below), shown but never answered by Plexiform.
  The request files are readable only by you (mode 0600, in a folder set to 0700) and are deleted when you answer. If you don't answer, the hook removes the file itself when it gives up (about 55 seconds, or 20 for questions), and any left behind is swept after about 75 seconds while Plexiform is running. The key that proves an answer came from Plexiform is held in memory and never written to disk.
- Your settings, rules, and any face photos you add as cameos.
- Git and CI results fetched with your own `gh` login (see the next section).
- Spend: worked out from your Claude Code conversation logs, in a background thread, on your computer. Nothing is sent anywhere.
- Calendar and focus status (see below), and terminal details: to jump to a session's terminal, Plexiform records in the session file the terminal's identifiers (seven environment values, the terminal device, and the folder at session start).
- Voice: your speech is turned into text on your device. Audio is never written to disk and the spoken words are never logged.

Everything below lives in `~/.claude-traffic-light` on your computer:

- `sessions/`: one small file per live session.
- `owned/`: launch records and claims for sessions Plexiform launched (see below).
- `requests/`: pending permission requests and your answers.
- `config.json`: your settings and rules.
- `stats.json`: per-day and per-project counts, times and costs, keyed by folder name.
- `cameos/`, including `cameos/index.json`: photos you add and their names.
- `git-signals.json`: recent pull request and build events with their titles and links, the ids of events already shown, your GitHub login, branch names, local folder paths and the logins of reviewers. It holds no passwords or tokens.
- `busy-ics-cache.json` (only with a calendar subscription link): event times and the repeat rules, status and free/busy flags of those events, plus a fingerprint (SHA-256) of the link, never the link itself. Meeting titles are kept only if you turned on "show meeting name".
- `away.json`: a recap written after any busy spell, including a Focus one (Focus reading is on by default). It lists session ids, folder paths, tool names, the names of rules that held a notification, and why you were busy: the Focus mode's name, or the meeting's title only if you turned on "show meeting name" (up to 60 characters). It is deleted when you dismiss it or it expires.
- `app.log` and `app.log.old`: diagnostic log. It can contain project folder names, repo names and pull request numbers, file paths (which include your OS username) and notification titles. It never contains prompt text.
- `token` and `port`: the details of the connection on this computer (see below).
- `bin/buddy-hook` (`bin\buddy-hook.cmd` on Windows): a small launcher that Claude Code's hooks call.
- `window-bounds.json`, `manual-override.json`, and first-run marker files.

Electron (the framework Plexiform is built on) also keeps its own app data in `~/Library/Application Support/Claude Buddy` on macOS and `%APPDATA%\Claude Buddy` on Windows. That is browser-style housekeeping (cache, window state), not session data.

## What changes on your computer

Plexiform changes a few things outside its own folder, and removes them when you uninstall:

- **Hooks.** It adds its hooks to Claude Code's settings file (`~/.claude/settings.json`), and to Cursor's, Codex's or Gemini's own config if you connect them. They call `bin/buddy-hook` in `~/.claude-traffic-light`.
- **One permission rule in Claude Code's settings.** The installer adds a single rule under `permissions.deny` in `~/.claude/settings.json`: `Edit(~/.claude-traffic-light/**)`. It stops Claude sessions from editing Plexiform's own data folder, so an agent can't tamper with Plexiform's files. Before the first change, Plexiform keeps a one-time backup of your settings file at `~/.claude/settings.json.buddy-backup`; it is never overwritten. The rule is removed when you uninstall or disconnect Claude Code.
- **Claude integration (if you turn it on).** One `claude-buddy` entry in `~/.claude.json`.
- **Open at login** (macOS), if you enable it.

## What leaves the machine and when

Today, nothing is sent to us. There is no account, no telemetry, no analytics, no crash reporting and no update check in the app. The complete list of outbound flows:

- **GitHub, through your own `gh` login (ON by default).** <!-- flow:gh-poll files=src/github-signals.js --> This does nothing unless the GitHub command-line tool `gh` is installed and signed in. If it is, about every 90 seconds while a session is open (every 10 minutes when idle), Plexiform asks GitHub (read-only requests) for your user, your workflow runs, reviews on your open pull requests and review requests addressed to you, for the repos your session folders belong to. Repos you list under "Also watch" in Preferences are checked even when no session is open. GitHub can see which repos you are working in and when, as it would for any use of `gh`. Nothing is sent anywhere else. Plexiform has no GitHub token of its own and we receive nothing. Plexiform also asks `git` locally which repo and branch a folder is on. A developer setting (`CLAUDE_BUDDY_GH`) can point Plexiform at a different `gh` program. To turn it off: Preferences → Git and CI → untick "Light up for pull requests and CI", then Save.
- **Automatic updates.** <!-- flow:auto-update files=src/updater/index.js,src/updater/service.js,src/updater/download.js,src/updater/electron-updater.js,src/updater/mac-swap.js,src/updater/deb.js --> Plexiform checks Plexiform's download server for a new version when it starts and every 4 hours after, and when you choose "Check now". On every platform it downloads the update itself (you can turn automatic downloading off in Preferences, or pick the beta channel). Every update is checked against Plexiform's release signature before it is used: Plexiform refuses a file whose signature or checksum doesn't match, one meant for another channel, and an older version unless Plexiform signed it as a rollback or you asked to go back to it. A check sends nothing beyond what any download sends (your IP address, and Plexiform's version in the user agent). An update installs only when you choose to restart for it, or when you choose "when idle" (after 30 seconds with no session working or waiting on you), never in the middle of your work. On macOS Plexiform swaps its own app for the new one and keeps the previous version so you can go back; on Linux (.deb) it saves the verified file to your Downloads folder and opens it in your software installer. Technical details: the update server is `https://download.plexiform.dev` (`/beta` for the beta channel); Windows and Linux AppImage install through electron-updater; on macOS the app is unpacked with `ditto`, its version read with `plutil`, and swapped by a small script Plexiform writes to its own data folder; on Linux (.deb) the file is opened with `xdg-open`.
- **Open in browser.** The tray menu's "Open Claude" opens claude.ai in your browser. <!-- flow:rule-url files=main.js --> A rule action of type "open URL" opens whatever address you set. <!-- flow:os-settings files=src/terminal.js --> Plexiform can also open your operating system's privacy settings page to help you grant a permission. These are ordinary visits that you trigger.
- **Your own rule actions.** <!-- flow:rule-command files=main.js --> A rule can run a shell command or a Shortcut you wrote. Whatever those do is up to you.
- **Your AI tools themselves.** Claude Code, and Cursor, Codex or Gemini if connected, send your prompts to their providers under those providers' own terms. Plexiform is separate and does not change or see that traffic.
- **Connections on this computer only.** Plexiform listens only for programs on this computer, never on the network. <!-- flow:local-server files=main.js,src/signal-server.js --> Sending it signals requires a secret token saved in `~/.claude-traffic-light/token`, and requests from web pages are refused. One exception: the status page needs no token, so any program running as you on your computer can ask for your live sessions' folders, their states and update times, and a spend level with a count of runaway sessions. Web pages and other computers cannot. We plan to require the token there too. <!-- flow:local-mcp files=mcp-server.js --> The optional Claude integration talks to that same local connection.
- **Sound and speech.** <!-- flow:local-sound files=src/sound.js --> Plexiform plays sounds and speaks using your operating system. Nothing is sent anywhere. <!-- flow:windows-powershell files=src/powershell.js --> On Windows, sounds, speech and bringing a terminal to the front run through PowerShell on your computer; the values they use are passed as data, never as part of a command. Nothing is sent anywhere.
- **Plexiform's own programs (local).** <!-- flow:own-code files=hooks/uninstall-hooks.js,src/buddy-hook-runner.js,src/hook-paths.js --> Plexiform's hooks run its own bundled scripts, and on Linux AppImage it keeps a copy of them in `~/.claude-traffic-light/hooks-<version>/` so they keep working after the app quits. Uninstalling runs the same code to remove Plexiform's entries from your Claude Code settings. Nothing is sent anywhere.
- **Spell checking stays off (Windows and Linux).** <!-- flow:spellcheck-off files=src/spellcheck.js --> The built-in spell checker would download dictionaries from Google the first time you type. Plexiform turns it off and points the dictionary address at an unreachable address on your own computer, so nothing is downloaded.
- **Release test mode (never in normal use).** <!-- flow:release-smoke files=src/smoke.js --> Plexiform's release checks start it with a special switch that installs its hooks into a throwaway folder, runs one, and quits. It refuses to run unless its home folder is a temporary folder, and nothing is sent anywhere.
- **Usage costs.** <!-- flow:local-worker files=main.js --> Spend is worked out on your computer. If there are no conversation logs, Plexiform may run `ccusage` in offline mode, which also reads locally.
- **Calendar (OFF by default).** <!-- flow:calendar-helper files=main.js --> One click in Preferences turns it on and macOS then asks for permission. A small helper bundled with Plexiform reads only event start and end times and whether you are shown as busy, plus titles only if you turned on "show meeting name". Nothing leaves your computer.
- **Focus status (ON by default, local only).** Plexiform reads your Focus / Do Not Disturb status from `~/Library/DoNotDisturb` when it is readable, or from a Shortcut you name, run on your computer. Nothing leaves your computer. To turn it off, untick "A Focus or Do Not Disturb is on" in Preferences.
- **Calendar subscription link (OFF until you enter one).** <!-- flow:ics-feed files=main.js,src/busy-watch.js --> If you paste a calendar subscription link (an ICS feed), Plexiform fetches it over HTTPS about every 10 minutes and works out repeating events about once an hour. It contacts only that address (http and file addresses are rejected). Redirects are followed only to HTTPS addresses (at most 3); a redirect to anything else is refused. The provider sees your requests, as with any calendar app.
- **Jumping to a terminal.** <!-- flow:terminal-jump files=hooks/set-status.js,src/focus/index.js,src/terminal.js,src/linux-activate.js --> Plexiform runs local programs (`osascript`, `kitten`, `wezterm`, `tmux`, `open`, `ps`, and `wmctrl` on Linux) to find and focus the terminal of a session. Nothing leaves your computer.
- **Team board (ONLY if you join a team).** <!-- flow:team-hub files=board/runner/supervisor.js --> The team board connects Plexiform to the team hub your team uses. Today that is a self-hosted server that is reachable over the internet through Cloudflare, and it is moving to Plexiform accounts. You sign in with an email code and can only join teams you are invited to. What is sent to the hub:
  - Card text: titles, bodies, acceptance criteria and your comments.
  - Handovers: a short narrative, recent actions, and the files and branch involved.
  - Run progress: status, cost and token counts, and summaries of tool calls.
  - Member ids and display names.
  - The identity of repos you link to a board (their remote address, the branch and file paths relative to the repo, never absolute paths). Nothing is shared for repos you have not linked.
  - Only if you opt in, team presence: agent type, the repo's short name, branch, state, since when, and an optional summary (a separate opt-in, at most 120 characters, filtered, with no folder path). Presence is held in memory only, expires after 90 seconds, is never written to the journal, and is shown only on boards that link that repo.
  Text passes a redaction filter (credential-like strings and home-folder paths) before it leaves. Work snapshots are pushed with git to your repo's own remote (`refs/board/<KEY>/r<n>`), not to the hub. The connection to the hub is a secure websocket (wss) authenticated with a device token. Up to the hub go: a hello (device id, protocol version, linked repos), heartbeats, run events and opted-in presence. Down from it come card offers and start/stop/park commands, answers to approval questions, the linked-repo list, and context for a card (other active cards and their owners). The team hub's operators can read what you send it. Nothing is sent unless you join a board.
- **The local board hub and Plexiform window (local).** <!-- flow:local-board-hub files=board/hub/app.js,buddy-window/index.js,buddy-window/hub-process.js --> Plexiform can run the board hub inside the app for just you. It listens only on this computer (127.0.0.1, enforced), on a random port, refuses requests that come through a proxy or name another host, uses a secret cookie created for each launch, has no login in this local mode, and keeps its data in a folder inside Plexiform's app data (readable only by you). The Plexiform window talks to it on this computer, and in a development build signs in to it with a per-launch secret; that is refused in packaged builds. 
- **The Plexiform window's board view.** <!-- flow:board-view files=buddy-window/index.js,board/web/js/socket.js,board/web/js/api.js --> The Plexiform window shows the board page served by the hub you use: the one built into Plexiform (this computer only) or your team's hub (see Team board), and the page keeps a live connection to that same hub. The window may show only pages from that hub (and, for a team hub, its own sign-in page). The board can show members' profile pictures loaded directly from GitHub's image server (avatars.githubusercontent.com) for members with a GitHub account. GitHub can see your IP address from that request, like any web image.
- **What a team hub server does on its own (operator side).** <!-- flow:hub-server files=board/hub/app.js,board/hub/auth.js,board/hub/github.js --> The hub code also contains server-side features that a team hub's operator can switch on; Plexiform's built-in hub does not use them, and its local mode refuses to run behind a tunnel. These features are operator-side only and unset by default; the hub built into the app does not use them. With a GitHub token configured (unset by default) the hub makes read-only requests to api.github.com to check that the pull requests and commits named on cards exist and have been merged. With a tunnel probe address configured, it checks its own public address every 15 seconds to see that it is reachable. When signing in through Cloudflare Access, it fetches Cloudflare's public signing keys from the team's `cloudflareaccess.com` address to verify sign-ins. When accounts ship, the operator's hub will also contact Google (`accounts.google.com`, `oauth2.googleapis.com`) and GitHub (`github.com`, `api.github.com`) for sign-in, and Resend (`api.resend.com`) to send sign-in emails. Today your team's hub is at `app.plexiform.dev`, and the project site is `plexiform.dev`. These requests come from the server, not from your computer.
- **Links you click.** <!-- flow:open-link-in-browser files=buddy-window/index.js --> Web links in the Plexiform window open in your default browser, only when you click one or a page tries to navigate away. Plexiform sends nothing.
- **Board helper sockets (local).** <!-- flow:local-board-sockets files=board/hub/config.js,board/mcp/ipc.js,board/runner/cli.js,board/runner/ipc.js,board/runner/supervisor.js --> The board's runner and its Claude add-on talk to each other over local socket files on this computer (a control socket in the runner's data folder and a per-run socket), readable only by you. They never use the network.
- **Laptop or desktop check (local).** <!-- flow:form-factor files=board/runner/procs.js --> The runner asks the operating system once whether this computer has an internal battery (`pmset -g batt` on macOS), to decide how to treat sleeping. Nothing is sent.
- **Reading a terminal pane (local).** <!-- flow:tmux-capture files=src/pane-dialogs.js --> For a session that has been waiting with no hook event, Plexiform runs `tmux capture-pane -p` (read-only) on the pane recorded for that session, on your own tmux server, at most about once every 15 seconds per pane. It reads the visible text of that pane only to recognise a stuck startup dialog (trust this folder, new MCP servers, a plan or permission prompt) and show it in the bubble. Only a recognised dialog's title, text (at most 2,000 characters) and options are kept, in memory, and they are dropped when the dialog goes away. Nothing is written to disk or logged, and Plexiform never types into a pane.
- **Binding answers to requests (local).** <!-- flow:request-key files=hooks/set-status.js,src/signal-server.js --> When the hook registers a per-request key with the app, it makes a short challenge-and-response over the connection on this computer only. Nothing leaves your computer.
- **Launch records (local).** <!-- flow:launch-record files=hooks/owned.js --> A session Plexiform launches itself can be recorded in `~/.claude-traffic-light/owned/` (readable only by you): a launch id, the launcher's name, the folder, the tmux pane if any, and start and expiry times. When the session starts, a claim file records its session id, process id and time. Unclaimed records expire after about an hour and claimed ones are deleted after 30 days. The part that writes launch records is not in the app yet; the part that reads them is.
- **Voice questions to Claude (OFF by default).** Turning your speech into text happens on your device using Apple's on-device recognition, and it fails rather than use Apple's servers. Asking free-form questions is a separate switch. If you turn it on, <!-- flow:voice-ask files=src/voice-helper.js --> Plexiform runs your own `claude` program under your own login, with a cleaned environment (only your home folder, path, user name, language and temp folder), and sends to Anthropic through your account: your spoken question as text (up to 500 characters), the name of each session's folder, what each session is doing (which can include a tool name, for example "wants permission to use Bash"), the number of live agents, today's spend, and the recent state changes. It runs with no tools, nothing saved, a spend cap of 5 US cents per question, and in a temporary folder that is deleted afterwards. It is under Anthropic's terms for your account.

### Technical details

For readers who want the exact terms:

- "Fingerprint" is a SHA-256 hash.
- "Readable only by you" is file mode 0600, in a folder with mode 0700.
- "Hooks" are the commands Claude Code runs on events; Plexiform's is `bin/buddy-hook`.
- "Asks GitHub" means `gh api` GET requests to api.github.com. Plexiform keeps the ETags GitHub returns in memory only, not on disk.
- "A connection on this computer only" is an HTTP server bound to 127.0.0.1. The no-token page is `GET /status`. The token is the `x-buddy-token` header, and the `port` file records the port. The optional Claude integration is an MCP server.
- "Calendar subscription link" is an ICS feed (also written webcal://). The cache stores event times plus UID, RRULE, EXDATE, STATUS and TRANSP fields.
- "Terminal device" is the tty.
- Voice questions run `claude -p --model haiku` with `--tools ''`, `--no-session-persistence` and `--max-budget-usd 0.05`.

### Not yet shipped

These are planned. None of them exists in the app today, and each would update this notice first:

- **Crash reporting.** Opt-in, off by default, with personal details scrubbed, and a "view what will be sent" screen. Lawful basis: your consent.
- **Update checks.** Asking the release host (`download.plexiform.dev`, already named in the app's settings but not contacted by any code yet) whether a new version exists. Lawful basis: legitimate interests (keeping you on a secure, working version).
- **Accounts on your team's hub.** The team board itself exists (see above); accounts, in place of today's email-code sign-in, are not built yet. When they ship you will sign in with Google (scopes `openid`, `email`, `profile`) or GitHub (scopes `read:user`, `user:email`; only your verified primary email is read). The hub will store, per user: a user id, your display name, your verified email, the sign-in provider and your id with that provider, device records (name, platform, a hash of the device token, last seen), sessions (stored hashed), and audit entries with a shortened IP address (the last part removed: /24 for IPv4, /48 for IPv6). It will not store the provider's access tokens or any password. A delete confirmed by an emailed code will anonymise your user and revoke every device and session. PROPOSED: how long audit entries are kept: `[audit-log retention period — Callum to decide]`. Lawful basis: contract, with the team's administrator. Processors: the hub host, Cloudflare (traffic passes through it), Google and GitHub (sign-in) and Resend (sign-in emails).
- **Automatic work tracking.** Off by default, with per-repo and per-board switches and a pause in the tray. It would send only a title, a summary, a status, the branch and allowed paths relative to the repo. Lawful basis: your consent.
- **Phone approvals.** A relay so you can answer permission requests from your phone. The code for it is in the repository but is not built into the app or wired in, so it makes no network connections today.
- **Slack and other connectors.**

Before any of these ships, this notice will name the processors involved and the countries your data would go to. Sending personal information abroad is regulated by POPIA section 72 and GDPR Chapter V, so each would need a lawful transfer basis. The same applies today to the team board: its hub is reached through Cloudflare, which acts as a processor passing the traffic through, and the hub host may be outside your country. With accounts, sign-in data also goes to Google or GitHub and email to Resend, each of which may process it outside your country. Presence is shared on the basis of your consent.

## How long things are kept

What the code does today:

- **Stats:** per-day counts and costs are pruned after 60 days.
- **Session files:** swept automatically once they are stale, which is the longer of your "waiting" and "working" stale settings (defaults 4 hours and 6 minutes) plus 12 hours.
- **`app.log`:** rotated at 512 KB into one `app.log.old` file, which is overwritten at the next rotation. So at most about 1 MB of log is kept.
- **Git events:** at most the last 30 events, and "seen" markers are dropped after 2 days.
- **Permission requests:** removed when answered. A leftover request is swept after about 75 seconds and a leftover answer after 10 minutes, while Plexiform is running.
- **Team hub (if you join):** its change journal is append-only (comment bodies are not copied into it). Presence is held in memory only and expires after 90 seconds. The hub host keeps nightly database snapshots, the last 14. Until accounts ship, deletion is on request; when they ship, a code-confirmed delete anonymises your user and revokes every device and session.
- **Busy cache and `away.json`:** `away.json` is deleted when dismissed or expired; the feed cache is overwritten on each fetch.
- **Everything else** (config, cameos, window position) stays until you delete it.

PROPOSED, not built: let you choose how many days of stats to keep.

## Export your data

- **Stats:** in the Lights window, Stats → Export JSON or Export CSV.
- **Rules:** in the Lights window, the share menu → Export rules.
- **Setup:** in the Lights window, Export setup, which bundles your settings, rules, presets and face photos into one file. It contains the photos you added, so be careful who you share it with.
- The Privacy section in Preferences has shortcuts for the stats and setup exports.

## Delete your data

Plexiform never deletes your data for you. To remove it yourself:

1. Quit the app from its tray (menu-bar) icon → Quit.
2. Remove the hooks it added to Claude Code (in `~/.claude/settings.json`, or `%USERPROFILE%\.claude\settings.json` on Windows), and the `claude-buddy` entry in `~/.claude.json` if you turned on the Claude integration. Hooks for Cursor, Codex and Gemini, if connected, are in those tools' own config.
3. Delete the folder `~/.claude-traffic-light` (`%USERPROFILE%\.claude-traffic-light` on Windows), which includes `bin/buddy-hook`.
4. Delete Electron's app data: `~/Library/Application Support/Claude Buddy` on macOS, `%APPDATA%\Claude Buddy` on Windows.
5. Uninstall the app the usual way for your system: on macOS drag Plexiform from Applications to the Bin, on Windows use Settings → Apps. Turn off "Open at login" first if you enabled it.

## Your rights

**South Africa (POPIA).** Plexiform keeps data on your device and we do not receive it, so today we hold no personal information about you. If that changes (the planned features above), these apply. Responsible parties must process information lawfully and in a way that does not infringe your privacy, and must follow the eight conditions in plain words:

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
