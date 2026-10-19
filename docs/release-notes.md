Plexiform app update — 19 October 2026 (1.0.2-beta.93)

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
- Fewer interruptions in meetings. Nudges and rule notifications wait while Plexiform sees a meeting or screen share.

What has been verified

Desktop, remote, site and board test suites pass on this build (desktop 5,478 tests, board 3,278, 0 failures), with the privacy census and the hub tenancy matrix.

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
