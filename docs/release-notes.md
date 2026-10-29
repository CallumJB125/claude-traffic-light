Plexiform app update — 30 October 2026 (1.0.2-beta.108)

For macOS (Apple silicon and Intel) and Linux (x64).

What changed

- Your AI sessions on this computer now know about each other, on by default: each Claude Code and Codex session is told which others are running here (tool, folder name, branch and whether it is working, idle or waiting on you), can leave short notes for them, and gets one line at its start about Plexiform's tools. On macOS, Plexiform does this by adding a tool server named plexiform-bus to Claude Code (one entry in ~/.claude.json) and to Codex (through Codex's own codex mcp add). The first time it adds them, Home shows a notice with Undo, which removes them and keeps them off. Preferences → Advanced → AI sessions on this computer has a switch for each: "Let my AI sessions see each other" and, on macOS, "Add Plexiform's bus tools to Claude Code and Codex".
- Answering permission prompts from the widget is now on for new installs. Existing installs keep the setting they had. Turn it off with "Answer permission prompts from the widget" in Preferences → Widget, under Permission prompts.
- In Setups, pressing Cancel on the Apply confirmation now says "Cancelled. Nothing was changed." instead of an error, and you can press Apply again without building the review again (the review still expires when it did). If another window is asking you something, Setups says so.
- Overview no longer sticks on "Plexiform session state is unavailable right now" after a Settings save: it appears only after two failed reads in a row and goes away on the first good one.
- Your teammates no longer see you as viewing a session after you minimise Plexiform, leave Team sessions or sign out.
- Clicking a session in the widget or Overview now brings its terminal forward, including when its window is minimised or the terminal app is hidden. When Plexiform can't, it says why instead of implying it did.
- A session's card on the widget has its own buttons: open its terminal, show its folder in Finder, open it in your editor, or copy the command that resumes it. The card also shows the folder and how long the session has waited on you.
- The widget remembers where you put it on each display. Overview's My sessions shows how long each session has been waiting on you.
- Find a session in Overview's My sessions by folder, task or AI tool. Show in Overview from a notification now lands on that session.
- A key to bring forward the next session waiting on you, oldest first. It is off until you set a key on the Widget page.
- Snooze one session's alerts for up to an hour, from its widget card or its notification. Clicking a Plexiform notification now always takes you somewhere useful, and notifications have buttons (Show in Overview and Snooze 1 hour; Stop session for one that is running away).
- On macOS, Preferences → Advanced now has a Terminal access section listing Terminal, iTerm2, Ghostty and Ghostty Dock and whether Plexiform may switch to their tabs. Test checks one terminal, only when you press it and only if it is already open, so macOS can ask for permission then but never by itself. Open settings takes you to the right place in System Settings.
- When a teammate stops a turn in a session you shared, Overview and the Team directory now say who (for example "Alex stopped this turn.").
- Sessions you start in a team workspace are now shared with that team to watch only. To let teammates send to one, open its Share… in Overview and choose Allow sending (it keeps the time the share had left). Teammates can't propose messages to a watch-only session. Terminal Claude channels you attach on purpose still let teammates send. Sessions already shared keep their current access until Plexiform restarts or the session ends.
- Find agents: search a catalogue of ready-made agents, read what each does, and add one to Claude Code, Codex and other AI tools with one click, with Undo. Plexiform writes a file only when you click +, never replaces one that is already there, and backs up your own agents before taking them over.
- The plexiform command line tool (Preferences → Advanced → Command line) can now hand over a task: plexiform run "‹task›" picks Claude or Codex for it and runs it in Tasks. Runs that do real work get a board card on their own.
- Runs Plexiform starts (Tasks, chat, takeover, Explain and the other helpers) now use your own Claude Code and Codex setup: your gateway or cloud provider, model and key. A key never reaches a shell the AI can use: runs with tools get it through a private file the AI can't read, deleted when the run ends.
- Usage now takes your plan from your own provider instead of guessing Pro, shows turns it can't price as activity rather than spend, and explains its numbers in one place (About these numbers).
- Sessions and This Mac show which board each project's new work goes to. When a project could go to a team board, Plexiform asks once, with Keep on My board as a choice.
- Sessions and My sessions are grouped by project, then by status, and the app uses the same words for session states everywhere.
- The widget's bubble is smaller, stays clear of the main window, and can still be answered on short displays.
- A new graphite accent colour replaces the old terracotta throughout the app.
- Linux: clicking a session raises that session's own terminal window, found by its process, never a different one. Your keyring choice is remembered, and the agent bus tools are not added (they need a Mac).
- The agent bus is now automatic, and you can opt out. AI tools on this Mac can hand work to each other (for example Claude Code to Codex) in any git repository a Claude Code or Codex session here is working in, with no need to add each project first. Your home folder, hidden folders in it (such as ~/.claude and ~/.codex) and ~/Library are never used. To opt out, untick "Automatic" or list "Only these repositories" in Preferences → Advanced → Agent bus, add repositories to "Never these repositories", or switch the bus off there. If you had set the bus up before through the Tasks policy file with an empty list in Preferences, it stays limited to those repositories. Results now say which AI did the work (for example "Codex running in Plexiform").
- Ghostty Dock, the third-party terminal by Andrew Baker, can be installed from Preferences or Health on Apple silicon Macs. Plexiform opens Terminal with Andrew's own installer command and nothing runs until you press Return there; Plexiform tells you when it is ready.
- Clicking a session that needs you goes to its exact Ghostty Dock tab even when the session was first seen as plain Ghostty or started before Ghostty Dock was installed, and a session Ghostty Dock shows as waiting is included. Sessions that are blocked on you now come before finished ones, longest-waiting first. When only the terminal app could be brought forward, the widget now says it couldn't pick the tab instead of implying it did.

What has been verified

- Every change in this release was reviewed before it merged, and the full unit, remote and website test suites ran on a Mac with no new failures.
- The unit tests also passed on macOS and Linux in a release dry run on GitHub Actions. The release build runs them again on both, and smoke-tests each packaged app, before anything is published.
- All 62 screenshot test files ran on a recent build of this release: 59 passed. The other three (animated character poses, a page that navigates mid-test and a timing check) failed from the tests' timing, not the app; a test-only fix in this build makes them pass, and none is a visible change.

Current limits

- Mac builds remain ad-hoc signed and are not Apple-notarized.
- On Linux, adding or adopting an agent in Find agents needs a working system keyring (libsecret, such as GNOME Keyring, or KWallet). With a weak or unknown keyring, Plexiform refuses rather than store the key unprotected.
- Builds are for macOS and Linux only; there is no Windows build.
- The limits listed for earlier betas below still apply.

<!-- Parked until the chat-first preview ships (R6a); each line below is one HTML comment, hidden on GitHub and stripped in the app. Restore by removing the comment marks. -->
<!-- A teammate's shared session now opens as a watch-only chat when you click it under Shared with you in the sidebar (chat-first preview): who shared it, what it is doing now, and the messages sent through the share with each reply. You can't send from it yet; use Team sessions for that. -->
<!-- When you open a teammate's shared session, its owner can see you're watching while it's open and on screen; the session's thread says so. As the owner, you see who is watching on the session in Overview and on its thread (chat-first preview). Nothing about who watched is kept. On a team hub that doesn't support this yet, nobody is shown as watching and the thread doesn't say it. -->
<!-- Session threads now mark which messages steered a turn already under way, and when a teammate stops a turn, the thread says who (for example "Alex stopped this turn."). Your own messages and stops look as before (chat-first preview). -->
<!-- Sending to a teammate's shared session (chat-first preview) asks you to review the first message, then sends straight away for up to 30 minutes, until you leave the thread, or until the share changes. Turn on Ask me each time under the message box to review every one; Plexiform now remembers that choice on this computer between launches. Proposals, approved sends and withdrawals always ask. -->
<!-- In your own session's thread, on a watch-only share, you can now let one teammate send, steer and stop for a set time (15 minutes, 30 minutes, 1 hour or 4 hours) with Allow ‹name› to send, and stop it any time. The rest of the team still only watches. Allowances last until the time you chose, or until Plexiform quits on your Mac. Needs the latest team hub; until it is updated the thread says so and offers nothing. -->
<!-- Queued follow-ups (chat-first preview) are now sent once, when the session is idle, while Plexiform is running and you are signed in as you, even with Overview closed. If the share ends, becomes watch-only, you sign in as someone else or you sign out, the follow-up is dropped, not sent, and its text is removed from this Mac. At most three can wait for one session. -->
<!-- In a teammate's shared session you can send to (chat-first preview), a working session now offers Queue for when idle. You review it on a card, it is sent once when the session is idle, and your queued messages are listed above the box with Cancel and Discard. A queued message always asks first, even inside the 30-minute window. -->

Plexiform app update — 20 October 2026 (1.0.2-beta.101)

For macOS (Apple silicon and Intel) and Linux (x64).

What changed

- Your Claude Code sessions are back on the board. Since beta.98, sessions started in Claude Code got no card, so "In progress" stayed empty while you worked. They show up again and move between columns as they work, wait and finish.
- Less clutter from scheduled Hermes jobs. Each scheduled (cron) Hermes job now keeps one card that every run updates, instead of a new card per run. Older cards from past runs can be cleared with "Clear all" on the Idle column.

What has been verified

Desktop (5,586 tests) and privacy test suites pass on this build, with new tests for both fixes.

Current limits

- The limits listed for earlier betas below still apply.

Plexiform app update — 20 October 2026 (1.0.2-beta.100)

For macOS (Apple silicon and Intel) and Linux (x64).

What changed

- Project safety. Plexiform checks what your AI changed after every turn. It warns when a turn adds what looks like a password or API key, when a secret would end up in the browser (for example behind NEXT_PUBLIC_ or VITE_), and when a .env file is not ignored by git. You see a blanked-out preview, a link to make a new key, and a one-click undo of that turn. Secrets are never saved or shown.
- Careful with destructive commands. When an AI asks to run something like rm -rf, a force push, a database reset or a production deploy, the light turns red and Home shows an "Approve with care" card with what it would affect. With restore points on, Plexiform saves one first.
- Database rules that only look locked. Turn it on per project and Plexiform flags Supabase and Firebase rules that let anyone read or write, and tables without row-level security, with a plain-English fix.
- Spend safety. "This session burned $X in Y minutes" alerts, daily caps per project, a projected total for today, and a warning when an AI keeps retrying the same failing step. A new rule template alerts when a session crosses an amount.
- Your Claude plan, not API dollars. Pro and Max users see estimated bars for how close they are to their 5-hour and weekly Claude limits. API-price equivalents are behind "Show what this would cost on the API".
- Explain mode (off until you turn it on). "Explain this" on permission questions gives one plain sentence, a safe / be careful / risky rating and a suggested answer. Common commands are explained on this Mac; others go to your own claude login with a 2-cent cap. Home shows "What did my AI just do?" after each turn, with "Test it now" when a local dev server is running, and one-click prompts to copy when a session is stuck.
- Deploys. Plexiform finds Vercel, Netlify and Cloudflare projects and shows building, live with a link, or failed next to the session, using the command-line tools you are already signed in to or a token you paste. A failed build gets a plain-English reason and "Send this error to Claude", which copies a ready prompt. Claude celebrates when a deploy goes live.
- Easier for people new to coding. Setup asks "Just me, building an app" or "Developer / team", explains in plain words what it adds to Claude Code, and gives a test prompt to copy with help if nothing shows up. Simple mode hides team and developer settings and keeps Home to what matters. Each light colour now means one thing, with a key in Help, Preferences and the More menu. Rule templates read as wishes, such as "Chime when it's done".
- Build logs and starter kits. Turn a session into a build log, review every line before anything leaves your Mac, then save it as a file or publish a link with "Made with Plexiform — remix this". Anyone can "Start from this" to install a starter kit (repo, CLAUDE.md, skills, MCP servers) after a consent sheet that lists what it may do. Discover now has one catalogue for starters, skills and MCP servers.
- Smaller follow-ups. When a session crosses your spend line, the "Session crossed my spend line" rule now holds its other nudges until you press "Resume nudges" on its widget card. The widget card shows the latest "What did my AI just do?" recap, a help line and the deploy status. Plexiform keeps the last 50 recaps, scrubbed of secrets, so they survive a restart.
- Fixes. Light-mode text is readable again in the widget bubble, the Waiting page, Settings and Lights. A saved sign-in is restored when you enter a hub address.

What has been verified

Desktop, remote, site and board test suites pass on this build (desktop 5,585 tests, board 3,282, 0 failures), with the privacy census and the hub tenancy matrix. The team hubs already run this build's hub code.

Current limits

- Claude limit bars are estimates from this Mac's usage. Anthropic does not publish the limits, and use on other devices is not counted.
- Deploy status has been tested with simulated Vercel, Netlify and Cloudflare responses, not live accounts.
- Mac builds remain ad-hoc signed and are not Apple-notarized.
- The limits listed for earlier betas (1.0.2-beta.100 and before) still apply. They are in those betas’ release notes: https://github.com/CallumJB125/claude-traffic-light/releases

Install

Use https://plexiform.dev/download for the published beta. Release assets include SHA256SUMS.txt. A signed update manifest verifies release bytes; it does not establish platform code signing or a completed device update check.
