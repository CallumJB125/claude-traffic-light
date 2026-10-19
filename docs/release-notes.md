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
- More character content: costumes witch, viking, tricorn, beret, antlers, astronaut and heartband; pets penguin, ghost, chick and owl; effects fireworks, bats, lightning, clouds, aurora and embers; poses dance, shrug and yawn. All appear in the Lights rule editor.
- Seasonal pack: around New Year, Valentine's Day, spring, Halloween and winter the character picks up a matching costume, pet and effect, but only on channels no rule sets. Turn it off with `"seasonalPack": false` in config.json (the older Seasonal looks setting still works).
- Sprite packs: put a folder with `pack.json` and PNG/SVG frames in `~/.plexiform/sprites/<pack>/` and set `"spritePack": "<pack>"` in config.json to show your own frames instead of the drawn character. Packs are checked strictly (plain file names, no links, 512 KB a frame, 64 frames a state, 8 MB a pack; SVGs with scripts or external references are refused) and never run; any problem falls back to the drawn character.

What has been verified

Desktop, remote and site test suites pass on this build (desktop 5,340 tests, 0 failures) including a contract test that drives every Burst channel with a failing client, a 0.19 and a 0.20.36 fixture captured from a real install, and the privacy flow checks. On a Mac running the real Claude Burst v0.20.36: detection, all fourteen capability flags, the new state keys, the console, mods, keep-awake, Remote Control, the sidebar entry, the optimiser's Primary chip and embedded dashboard, the This Mac card and the healthy Home page were exercised live and screenshotted. Not exercised live: the setup flow's Install and Update steps and every Burst mutation (keep-awake, mod and panel install, Finder shortcuts, console repair), which rest on unit tests and the consent dialog; the non-empty loose-ends path, which rests on the captured fixture because the live scan found no loose ends.

Current limits

- Claude Burst is Andrew Baker's project; its install, update and repair run its own scripts in a Terminal after you confirm. Plexiform only reads its loopback admin API through a field-by-field whitelist.
- Mac builds remain ad-hoc signed and are not Apple-notarized; Apple Developer ID signing is still open. A changed build may require fresh authorization for Plexiform's own permissions.
- Public registration remains closed; invited teams use the sign-in methods offered by their hub.
- Real second-person acceptance of beta.90's team features, external teammate/device, real-device updater and rollback acceptance remain open, as recorded for beta.90.

Install

Use https://plexiform.dev/download for the published beta. Release assets include SHA256SUMS.txt. A signed update manifest verifies release bytes; it does not establish platform code signing or a completed device update check.
