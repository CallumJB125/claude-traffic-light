Plexiform 1.0.2-beta.87 — 18 October 2026

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

What has been verified

A real local Codex task requested a Claude review, received an acknowledgement and report, and exchanged a follow-up through the task connection. That exchange used normal task permissions and an explicit read-only review request. Claude's native Plan mode blocked the messaging tools; successful messaging in that mode is not claimed. This is local provider evidence, not installed-app, two-person or cross-device acceptance. A real local Codex task also saved a result card through the task connection; the card and its agent provenance survived an engine restart. A separate unpackaged Electron check verified all three card types, saving and restoration, and preservation of a conflicting draft with a fake provider. A controlled native check opened Apple Terminal once and preserved the selected session and working folder. This used a fixture provider; a launch request does not confirm a real model response. Final packaging, installed acceptance and publication are recorded separately.

Current limits

- Existing sessions need a supported connection and sharing permission. Activity visibility alone is not a messaging channel. The Codex CLI connection does not control Codex desktop conversations.
- Separate working copies and checked integration protect work managed by Plexiform. Independent agents can still conflict when editing the same shared checkout outside those boundaries; overlap warnings are not universal file locks.
- Undo preserves later edits and refuses deleted-file or mode reconstruction when original metadata is unavailable.
- External teammate/device, real-device updater and rollback acceptance remain open. Windows downloads, public phone access and Linear/Jira signed delivery stay gated.
- Mac builds remain ad-hoc signed and are not Apple-notarized. A changed build may require fresh authorization for Plexiform / Plexiform Safe Storage in the system Keychain dialog.
- Public registration remains closed; invited teams use the sign-in methods offered by their hub. Provider installation, sign-in, subscriptions and usage charges remain separate. Agent Mail remains free; inbox polling is off by default and sending requires confirmation.
- Privacy/legal review and an off-device gallery-key backup remain outstanding. No universal cross-platform completion claim is made by this candidate.

Install

Use https://plexiform.dev/download for the published beta. Release assets include SHA256SUMS.txt. A signed update manifest verifies release bytes; it does not establish platform code signing or a completed device update check.
