Plexiform app update — next beta (unreleased)

For macOS (Apple silicon and Intel) and Linux (x64).

What changed

- Overview no longer sticks on "Plexiform session state is unavailable right now" after a Settings save: it appears only after two failed reads in a row and goes away on the first good one.
- A teammate's shared session now opens as a watch-only chat when you click it under Shared with you in the sidebar (chat-first preview): who shared it, what it is doing now, and the messages sent through the share with each reply. You can't send from it yet; use Team sessions for that.
- Your teammates no longer see you as viewing a session after you minimise Plexiform, leave Team sessions or sign out.
- When you open a teammate's shared session, its owner can see you're watching while it's open and on screen; the session's thread says so. As the owner, you see who is watching on the session in Overview and on its thread (chat-first preview). Nothing about who watched is kept. On a team hub that doesn't support this yet, nobody is shown as watching and the thread doesn't say it.
- Session threads now mark which messages steered a turn already under way, and when a teammate stops a turn, the thread says who (for example "Alex stopped this turn."). Your own messages and stops look as before (chat-first preview).
- Sending to a teammate's shared session (chat-first preview) asks you to review the first message, then sends straight away for up to 30 minutes, until you leave the thread, or until the share changes. Turn on Ask me each time under the message box to review every one; Plexiform now remembers that choice on this computer between launches. Proposals, approved sends and withdrawals always ask.
- In your own session's thread, on a watch-only share, you can now let one teammate send, steer and stop for a set time (15 minutes, 30 minutes, 1 hour or 4 hours) with Allow ‹name› to send, and stop it any time. The rest of the team still only watches. Allowances last until the time you chose, or until Plexiform quits on your Mac. Needs the latest team hub; until it is updated the thread says so and offers nothing.
- Sessions you start in a team workspace are now shared with that team to watch only. To let teammates send to one, open its Share… in Overview and choose Allow sending (it keeps the time the share had left). Teammates can't propose messages to a watch-only session. Terminal Claude channels you attach on purpose still let teammates send. Sessions already shared keep their current access until Plexiform restarts or the session ends.
- Queued follow-ups (chat-first preview) are now sent once, when the session is idle, while Plexiform is running and you are signed in as you, even with Overview closed. If the share ends, becomes watch-only, you sign in as someone else or you sign out, the follow-up is dropped, not sent, and its text is removed from this Mac. At most three can wait for one session.
- In a teammate's shared session you can send to (chat-first preview), a working session now offers Queue for when idle. You review it on a card, it is sent once when the session is idle, and your queued messages are listed above the box with Cancel and Discard. A queued message always asks first, even inside the 30-minute window.
- The agent bus is now automatic, and you can opt out. AI tools on this Mac can hand work to each other (for example Claude Code to Codex) in any git repository a Claude Code or Codex session here is working in, with no need to add each project first. Your home folder, hidden folders in it (such as ~/.claude and ~/.codex) and ~/Library are never used. To opt out, untick "Automatic" or list "Only these repositories" in Preferences → Advanced → Agent bus, add repositories to "Never these repositories", or switch the bus off there. If you had set the bus up before through the Tasks policy file with an empty list in Preferences, it stays limited to those repositories. Results now say which AI did the work (for example "Codex running in Plexiform").
- Ghostty Dock, the third-party terminal by Andrew Baker, can be installed from Preferences or Health on Apple silicon Macs. Plexiform opens Terminal with Andrew's own installer command and nothing runs until you press Return there; Plexiform tells you when it is ready.
- Clicking a session that needs you goes to its exact Ghostty Dock tab even when the session was first seen as plain Ghostty or started before Ghostty Dock was installed, and a session Ghostty Dock shows as waiting is included. Sessions that are blocked on you now come before finished ones, longest-waiting first. When only the terminal app could be brought forward, the widget now says it couldn't pick the tab instead of implying it did.

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
- The limits listed for earlier betas below still apply.

Plexiform app update — 19 October 2026 (1.0.2-beta.97)

For macOS (Apple silicon and Intel) and Linux (x64).

What changed

- Search past sessions. Find what you asked an AI about, across your past sessions on this Mac, from the command palette or the Memory page, with project and date filters. Results open the session's timeline. The index stays on this Mac and is scrubbed of secrets.
- Where the money went. The Usage page breaks spend down by project, branch and pull request, compares it with the period before, and suggests one saving each week: the share of Opus turns that looked routine and what Sonnet would have cost. The weekly digest carries the top projects and the same suggestion.
- Rules made easy. Start a rule from a template ("Tell me when a session is stuck", "Red banner when CI fails" and more), read each rule as a plain sentence, and have a rule send a desktop notification. Notifications respect quiet hours and meetings.
- A first-run tour. Five short steps on the demo board within half a minute of setup: the widget, answering a question, rules, spend and team. Skip it any time; take it again from Help.
- Local models in two clicks. Plexiform finds Ollama and LM Studio running on this Mac, lists their models, starts a session with the one you pick, and says what to do when none is pulled. Sessions show which model they use. You can add your own OpenAI-compatible endpoint; its key is kept in secure storage.
- Phone. A waiting permission request on your phone's lock screen now has a Review button that opens it straight away; approving still needs your passkey. You can dictate a reply with the microphone and press Send yourself.
- Team. A heat map of the files your team is working in, with files two people touch flagged; an automatic standup per teammate you can copy; and handoffs that can be declined with a note, with the outcome shown to the sender.
- Create a Linear or Jira issue from a session. Plexiform drafts it from the session's handover, you edit it, and nothing is sent until you press Create.
- Ask about your screen. Turn on "Use the screen when I ask" in Voice settings, hold your talk key or long-press Claude, and ask out loud ("where is the Wi-Fi setting?"). Plexiform captures the display under your mouse, asks your own Claude through the `claude` command (no API key), speaks the answer, and Claude flies to the thing it means on screen. The screenshot is deleted as soon as the answer comes back. macOS asks for Screen Recording permission the first time.
- Say "Plexiform, do …" to offer a new Task. It starts only when you press Start.
- The widget no longer fails to appear after an update when macOS asks for permission to a folder your sessions use, such as Desktop or Documents. Plexiform keeps running while that prompt waits for your answer.
- Fewer interruptions in meetings. Nudges and rule notifications wait while Plexiform sees a meeting or screen share.

What has been verified

Desktop, remote, site and board test suites pass on this build (desktop 5,499 tests, board 3,278, 0 failures), with the privacy census and the hub tenancy matrix.

Current limits

- Setting your Slack status from Plexiform is built but not available yet: it needs a Slack user permission the team's Slack app does not ask for today. The Slack runbook has the owner step.
- Phone notification and voice changes reach phones after the team hub is updated.
- Mac builds remain ad-hoc signed and are not Apple-notarized.
- The limits listed for earlier betas below still apply.

Plexiform widget update — 19 October 2026 (1.0.2-beta.92)

For macOS (Apple silicon and Intel) and Linux (x64).

What changed

- Session cards on the widget. Hovering a session on the widget's strip opens a card with the project, what it is doing and for how long, how long it has been waiting on you, this session's spend when known, and a teammate's initials for shared sessions. The card's buttons open the session, answer its waiting input, or pin it.
- A smarter strip. A pinned session stays first, idle sessions fold into one "+N idle" chip, and teammates' sessions sit on their own row.
- What just happened, at a glance. A small lane beside Claude shows the last three events (needs you, finished, stuck, teammate collision, CI failed) and fades each one after a few seconds. Click one to jump to it.
- Two rings round Claude: how long the current turn has run against your usual turn, and today's spend against your budget. They hide when there is nothing to show and respect reduced motion and low power.
- Widget settings: snap to any screen edge, not just corners; Normal, Compact or Dot size (Dot is the lamp alone); a global shortcut to summon or hide the widget; an accent colour per project; and "Quiet for 30 minutes" from the widget menu, shown by a small moon.
- More character content: costumes witch, viking, tricorn, beret, antlers, astronaut and heartband; pets penguin, ghost, chick and owl; effects fireworks, bats, lightning, clouds, aurora and embers; poses dance, shrug and yawn. All appear in the Lights rule editor.
- Seasonal pack: around New Year, Valentine's Day, spring, Halloween and winter the character picks up a matching costume, pet and effect, but only on channels no rule sets. Turn it off with `"seasonalPack": false` in config.json (the older Seasonal looks setting still works).
- Sprite packs: put a folder with `pack.json` and PNG/SVG frames in `~/.plexiform/sprites/<pack>/` and set `"spritePack": "<pack>"` in config.json to show your own frames instead of the drawn character. Packs are checked strictly (plain file names, no links, 512 KB a frame, 64 frames a state, 8 MB a pack; SVGs with scripts or external references are refused) and never run; any problem falls back to the drawn character.
- Keep-awake on the Burst card now says "Saved, not applied yet" while Burst's machine-wide half waits for the password step in Terminal, instead of "On".

What has been verified

Desktop, remote and site test suites pass on this build (desktop 5,430 tests, 0 failures). The visual regression suite was run on this build and on beta.91's source: the only difference is the character baselines, which grew to include the new costumes and poses. The suite's other failing screenshots fail identically on beta.91's source and are tracked separately.

Current limits

- Mac builds remain ad-hoc signed and are not Apple-notarized. A changed build may require fresh authorization for Plexiform's own permissions.
- Sprite packs and project colours are set per Mac; they do not sync.
- The limits listed for beta.91 below still apply.

Plexiform Claude Burst preview — 19 October 2026

For macOS (Apple silicon and Intel) and Linux (x64). Claude Burst itself is macOS only.

What changed

- Claude Burst inside Plexiform, verified against Burst v0.20.36. Plexiform now reads Burst's newer state (primary health, Remote Control expectation, hosts entry, certificate trust) and gates every feature on a capability flag, so a 0.19 install keeps working with the newer parts hidden rather than broken.
- Usage & Burst in the sidebar. One entry opens the Usage optimiser: Burst's status, its dashboard in a locked-down view, and the tools it adds.
- Guided setup. The optimiser's empty state walks through Install, Trust, Enable and First check, says what each step changes on your Mac (from Burst's own README), and reads progress back from Burst while a step runs instead of sending you to a Terminal and asking you to come back.
- One cause, one action. Every Burst state names what is wrong and offers one next step: not installed → Install; too old → Update; gateway not answering → Repair, with the last known state shown dimmed and its age; certificate or hosts entry not trusted → Fix; console down → Start console; usage panel not installed → Install. An unknown listener on Burst's port is named and nothing is read from it. Every Burst call from a page answers {ok, reason} and never throws.
- Home tells you when to look. A single Burst row appears in Home's attention list only when something needs you: broken, too old, not trusted, not responding after several checks, an update available, a limit near, or loose ends. A healthy Burst, an intentionally off Burst or no Burst at all adds nothing.
- Loose ends on Overview. Each repository row carries Burst's counts of uncommitted files, unpushed commits and stashes for repositories your sessions use; file names only, never contents, diffs or stash names.
- Keep-awake, Remote Control and mods on the Burst card and the Tools tab. The card shows whether this Mac is being kept awake and whether Remote Control is expected, and lists Burst's session mod and the usage panel (claude-code-cost-sidebar) with Install or Update per mod. Every change to the Mac goes through the same native consent sheet as before. Burst's hotspot settings are never read or written by Plexiform.

What has been verified

Desktop, remote and site test suites pass on this build (desktop 5,340 tests, 0 failures) including a contract test that drives every Burst channel with a failing client, a 0.19 and a 0.20.36 fixture captured from a real install, and the privacy flow checks. On a Mac running the real Claude Burst v0.20.36: detection, all fourteen capability flags, the new state keys, the console, mods, keep-awake, Remote Control, the sidebar entry, the optimiser's Primary chip and embedded dashboard, the This Mac card and the healthy Home page were exercised live and screenshotted. Not exercised live: the setup flow's Install and Update steps and every Burst mutation (keep-awake, mod and panel install, Finder shortcuts, console repair), which rest on unit tests and the consent dialog; the non-empty loose-ends path, which rests on the captured fixture because the live scan found no loose ends.

Current limits

- Claude Burst is Andrew Baker's project; its install, update and repair run its own scripts in a Terminal after you confirm. Plexiform only reads its loopback admin API through a field-by-field whitelist.
- Mac builds remain ad-hoc signed and are not Apple-notarized; Apple Developer ID signing is still open. A changed build may require fresh authorization for Plexiform's own permissions.
- Public registration remains closed; invited teams use the sign-in methods offered by their hub.
- Real second-person acceptance of beta.90's team features, external teammate/device, real-device updater and rollback acceptance remain open, as recorded for beta.90.

Install

Use https://plexiform.dev/download for the published beta. Release assets include SHA256SUMS.txt. A signed update manifest verifies release bytes; it does not establish platform code signing or a completed device update check.
