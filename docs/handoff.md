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
- A hand-off to a tool leaves this Mac only into that tool. A hand-off to a teammate (below) is a PRIVACY.md flow (`flow:handoff`).

## To a teammate (agent mail)

While signed in to a team, the same submenu ends with **A teammate…** (Sessions) or the teammates' names (board card). The names come from the members of the team board the session's folder is linked to (`AgentMail.teammates`, same rule as `team_ask`). The packet is built with `to: 'teammate'`, shown in the same native dialog, and on Confirm `AgentMail.sendHandoff` holds it on the hub exactly like an AI's `team_hand_off` draft and releases it at once (the confirm was the Send), so it reaches the teammate's Agent mail, scrubbed again by the hub, with `via.label` "Hand off from Plexiform". The teammate accepts it the usual way (folder, native confirm, a Tasks run in its own worktree) or declines.

**Status back.** The hand-offs that left this Mac show on Sessions → Agent mail under *Hand-offs you sent* with their state: offered, accepted, done, failed, declined, expired. The receiver's app remembers the task an accepted hand-off became (`AgentMail.acceptedTasks`); when the tasks snapshot shows it at `in_review`/`done` or `failed`, main calls `taskEnded`, which posts `decision: done|failed` with the task's short reason to `POST /messages/:id/handoff` (hub: only the receiver, only once `accepted`, migration 073). The sender's AI reads the same outcome through `team_agent_mail`.

## Asked for by the AI (hand-off requests)

A running session can ask for a hand-off to another tool on this Mac in two ways, and both end in the same place:

- The local MCP tool `hand_off_to_tool { to, title, reason, brief, files, branch }` (`/team/mail` op `request_handoff`).
- One line in its reply: `plexiform: handoff to codex: <why>` (`src/handoff-requests.js` `parseMarker`). The handover writer (`src/session-handover.js` `onRendered`) passes the session's last assistant text and facts to `HandoffRequests.fromText`; one marker makes one request per session and target, however often the handover is re-rendered, and a dismissed request does not come back.

`src/handoff-requests.js` keeps at most 8 pending requests in memory (an hour each, finished ones kept ten minutes) and never launches anything. Each shows on Sessions → **Hand-off requests** with Confirm… and Dismiss, plus a notification. Confirm calls `continueIn.handoffPacket`: the same native preview, `release`, and `run` as a hand-off the person started. The launched session's `done`/`closed` events write the outcome (state and the other tool's last message, 500 chars) back on the card; the asking AI reads only states and outcomes through `hand_off_status`. Free plan or a copy-only tool: the packet is copied and the request ends as *copied*.
