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

## Not done yet

UI wiring. The continue-in menu (`continue-menu.js`, `src/continue-in.js`) already hands over a session's handover; a packet preview with a Confirm step does not fit it as a small addition, so it is left for a follow-up.
