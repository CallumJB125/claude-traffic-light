Plexiform 1.0.2-beta.88 — 18 October 2026

For macOS (Apple silicon and Intel) and Linux (x64).

What changed

- A calmer charcoal-and-copper interface, clearer navigation, and a new woven app icon across the desktop, installer, website and phone assets. The optional desktop characters and status lamps remain available.
- Find shared sessions by work, teammate or AI. Focus on sessions that are working, need input or have stale reports. The selected session shows the exact identity behind its available actions.
- Useful task overviews bring the request, reported progress, changed files, reported checks, decisions and next action together. Open that task's conversation or saved context directly.
- Save a report or note with a task and keep file or commit references alongside it. Reports are restored with the task and tied to checkpoint versions; file references point to current files, not frozen copies.
- Save interactive checklists, metrics and small tables in a task overview. People can edit cards and tick checklist items; managed AIs can save reports and cards to their own task. Cards keep their source and saved checkpoint version across restart, and conflicting edits retain your draft for review. Metrics and tables are saved data, not live calculations or executable actions.
- Take over an eligible managed Claude Code or Codex task in Terminal, continue its exact session, then exit and hand it back to Tasks. Plexiform stops the background run first, shows the existing permission context, and requests a single Terminal launch. A launch request is not an AI response; new tasks still start in the background.
- Before starting local work, inspect other known Tasks in the project, review possible overlap, narrow the request or keep the draft while waiting. These local checks are advisory; waiting does not start work automatically.
- Managed Claude Code and Codex tasks can request bounded help from each other, exchange messages and read reported results. Helpers use separate working copies of the same repository, committed starting context and the same or narrower permissions. They cannot discover or control arbitrary private sessions.
- Collaboration is limited to four helpers per task family and two levels. Durable request records prevent automatic duplicate effects after uncertain outcomes. Stored, delivered and answered remain distinct states; messages do not grant permissions or approvals. Task families with spend caps cannot delegate until aggregate budget enforcement exists.
- Reviewed integration checks current task ownership and saved context before applying changes. Reviewed provider handovers, scheduled follow-ups and draft pull-request workflows preserve their existing permission and confirmation boundaries.
- Each shared session card now says what its agent is doing right now, in plain words, with a four-step freshness (fresh, idle, stale, offline). Requests are held back from sessions that have stopped reporting, with the reason shown.
- Pin the teammates and sessions you care about to the top, and save your filter combinations as named views. Pins and saved views are yours alone and never change what is shared.
- Follow a teammate's shared session and be told once when it needs input, finishes or fails. Followed events appear in your Home Inbox until you mark them seen.
- Ask a shared session for a status update, a review of your change, its current plan, or to pause at a safe point. Each template drafts the exact text into the existing reviewed composer; nothing is sent until you press Send, and the card shows sent, acknowledged, answered or expired.
- Press ⌘K to find any teammate, project or shared session and open the exact one. Only work already shared with you is ever listed.
- Home gains an Inbox: approvals, questions, blockers, failed tasks, teammates' handoffs, requests you are waiting on and followed sessions, ordered by urgency with one action each. New teammates get a four-step tour, shown once per account.
- "Can you look at this?" sends a teammate a review request tied to your session. They see it in Agent mail with Seen, I'll handle this, reply, Done and Decline; you see its state under Waiting on, on the Sessions page and on Home.
- A project pinboard on each team board keeps the staging link, designs, useful commands, conventions and current priorities together. Any writer can pin or remove; pin straight from one of your sessions in Plexiform.
- Session Timeline can share a scrubbed summary of a session with its saved result cards and provenance to the team card, for repositories you opted in to handover sharing. The control appears only when a team hub supports it.

What has been verified

Build 1.0.2-beta.88 (source 6930e917ce9a77382426021d14c3c5e2c665e485) is the first candidate carrying the shared-workspace team features. Their checks so far: unit and page tests for the doing-now line, pins and saved views, follow events, Ask templates, the ⌘K palette, Home Inbox and tour; a full "Can you look at this?" exchange (sent, seen, I'll handle this, reply, done) against an in-process team hub; pinboard add, replace, remove and viewer refusal against the hub test tenancy; the privacy census for the new flows. Installed-app and two-person acceptance of these features are recorded separately when they happen. A real local Codex task requested a Claude review, received an acknowledgement and report, and exchanged a follow-up through the task connection. That exchange used normal task permissions and an explicit read-only review request. Claude's native Plan mode blocked the messaging tools; successful messaging in that mode is not claimed. This is local provider evidence, not installed-app, two-person or cross-device acceptance. A real local Codex task also saved a result card through the task connection; the card and its agent provenance survived an engine restart. A separate unpackaged Electron check verified all three card types, saving and restoration, and preservation of a conflicting draft with a fake provider. A controlled native check opened Apple Terminal once and preserved the selected session and working folder. This used a fixture provider; a launch request does not confirm a real model response. Final packaging, installed acceptance and publication are recorded separately.

Current limits

- Viewer presence on a session is shown only when the team hub publishes it; this build's hub does not yet. The Timeline summary share appears only when a hub connection for it is configured.
- Existing sessions need a supported connection and sharing permission. Activity visibility alone is not a messaging channel. The Codex CLI connection does not control Codex desktop conversations.
- Separate working copies and checked integration protect work managed by Plexiform. Independent agents can still conflict when editing the same shared checkout outside those boundaries; overlap warnings are not universal file locks.
- Undo preserves later edits and refuses deleted-file or mode reconstruction when original metadata is unavailable.
- External teammate/device, real-device updater and rollback acceptance remain open. Windows downloads, public phone access and Linear/Jira signed delivery stay gated.
- Mac builds remain ad-hoc signed and are not Apple-notarized. A changed build may require fresh authorization for Plexiform / Plexiform Safe Storage in the system Keychain dialog.
- Public registration remains closed; invited teams use the sign-in methods offered by their hub. Provider installation, sign-in, subscriptions and usage charges remain separate. Agent Mail remains free; inbox polling is off by default and sending requires confirmation.
- Privacy/legal review and an off-device gallery-key backup remain outstanding. No universal cross-platform completion claim is made by this candidate.

Install

Use https://plexiform.dev/download for the published beta. Release assets include SHA256SUMS.txt. A signed update manifest verifies release bytes; it does not establish platform code signing or a completed device update check.
