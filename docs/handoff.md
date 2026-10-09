# Agent-to-agent handoff packet

"Hand off to <another AI tool>" starts from a card or running session and builds a small packet: goal, files touched, last summary, branch. `src/handoff-packet.js` is the pure builder and validator. It sends nothing, launches nothing and touches no hub.

## Rules

- No unattended editing AI run. A launch only happens after an explicit human confirm, and the existing launch path (`src/handoff.js`) stays text-only in an empty temporary folder.
- The packet stays local. Nothing is sent to the hub. The only places it can go are the clipboard (copy) or a launch the person confirmed.
- The person sees the exact text (`toPrompt`) before confirming.

## API

- `build({ from, to, goal, files, summary, branch }, { home })` returns a bounded packet. Free text and file names go through `scrub.redactSecretsPass` (secrets, emails, IPs, card/ID numbers); `home` is shown as `~`. File names are kept because the next tool needs them.
- `validate(packet)` returns `{ ok, errors }`: known version, a target tool id, a goal, different source and target, size limits.
- `toPrompt(packet)` renders the markdown shown to the person and delivered on confirm.
- `confirmation(packet)` is created by the UI when the person presses confirm for the packet shown. It carries a digest of the contents.
- `release(packet, confirmation)` throws unless the packet is valid and the confirmation matches its digest, then returns the prompt. Editing the packet after confirming invalidates the confirmation. Callers must go through `release` before `handoff.copy` or `handoff.hand`.

## In the app

Sessions: **Continue in…** then **Hand off to another AI…** lists the tools found on this Mac. The board card's Continue in menu has the same item as a submenu. Choosing a tool does not run anything: main builds the packet from the session's handover (goal = latest prompt, edited files, last assistant line, branch), scrubs it, and shows a native dialog with the exact text and two buttons, Cancel and Confirm and hand off.

- Cancel (or closing the dialog) does nothing: nothing is launched or copied.
- Confirm creates the confirmation in main (`confirmation`), calls `release`, and passes the released text to the existing continue-in launcher (`src/continue-in.js` `run`): Codex and Claude Code on Plus start a visible, text-only owned session shown on Sessions with Send and End; every other tool, and the free plan, get the text on the clipboard.
- The page only names a session key and a tool id (`continue:handoff`, Sessions page only, sender-checked like its neighbours). It cannot supply a confirmation.
- Nothing leaves this Mac beyond the existing continue-in paths, so PRIVACY.md has no new entry.
