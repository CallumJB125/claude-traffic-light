Plexiform team collaboration preview — 19 October 2026

For macOS (Apple silicon and Intel) and Linux (x64).

What changed

- Comments and @mentions on cards and moments. Every card and every moment on the web board has a thread. Type @ in the composer to pick a teammate by name, GitHub login or the part of their email before the @ (up to ten per comment); mentions render as chips with the member's current name. On the desktop, the Sessions page offers a Comment input right after you mark a moment. Only the comment text and the ids of the mentioned members are sent.
- Inbox. Mentions, replies to your comments, teammates' moments, hand-off requests and answers, and inputs someone else answered on your run arrive in Home › Inbox with Open and a quiet Mark read; the dock badge counts them. Items reach the desktop live over the hub connection it already keeps for presence, with a once-a-minute poll as the fallback. The web board shows the same inbox as a bell in its top bar.
- Two silent macOS notifications. Only a mention and a hand-off request raise a notification, never a sound, and at most one per 30 seconds per hub. Everything else waits in the inbox.
- Who is looking, who is running. A card on the web board shows a small avatar stack while teammates have it open, and the team list says running on <repo> or viewing <card> per member. Desktop Team sessions person headers show the same line; opening a teammate's row tells the hub you are viewing that card and closing it clears you. Presence lives in the hub's memory only, expires after 90 seconds without a beat and is not journaled.
- Hand a card to a teammate. Hand to… in the card drawer picks a teammate and takes a note (up to 2,000 characters). The latest handover packet goes with it and the teammate is added as an assignee. They see Accept / Decline on the card and, on the desktop, a Needs you card on the Sessions page; Accept opens the packet there. The sender sees "Handed to <name>, waiting" with Take it back until they answer, and the outcome after. One open request per card at a time.
- Team moments, shared views and what shipped. Mark a moment on one of your sessions (ship, decision, demo or moment) and it lands on the linked team board; Pin to project sits beside it. Share view posts a saved Team sessions filter (name and filter values only) to the board's Shared views. Home › Team today shows Since you were away and Shipped this week from the board snapshot Plexiform already reads. Team sessions shows an availability badge per teammate (Active, Idle, Away, Offline) and keeps device-local session collections. Home › Inbox offers quick decision buttons on waiting requests, through the same checks as answering from the widget.
- Teammates on the widget. When a teammate sends "Can you look at this?" or you are waiting on one, the widget shows a small Teammates panel under the character; click a row to open Agent mail. The panel reads the Agent Mail inbox you already opted in to; nothing new is sent or fetched.
- Open in Terminal. The confirmation sheet for continuing a managed session in Terminal no longer grows off screen with a long command; the full command stays visible in the Tasks panel.
- Hub operators. Migration 076 rebuilds the comments table and adds moments, inbox and hand-off tables; it must apply before any later migration on every database. Deploy the hub before the desktop beta is adopted: against an older hub the desktop skips the new routes quietly (no inbox rows, no presence, no bell) and the Comment follow-up on a moment says the hub does not take comments there yet.

What has been verified

Hub, shared, web and desktop test suites pass on this build, including route-coverage and tenancy isolation for the new comment, inbox, presence and hand-off routes, a desktop test that pushes an inbox item over the presence socket and sees the badge change without a timer, and the privacy flow checks (no new network channel; the new files sit under the existing team-hub and pinboard flows). Real two-account acceptance on a hub (a mention from A reaching B's inbox, a hand-off accepted by the second person, presence seen from a second device) has not been run yet; the desktop presence link against a real accounts hub is verified by the hub's same-origin rule and unit tests with a fake socket only. Earlier evidence for delegation between managed Codex and Claude tasks, saved cards and the Terminal takeover stands as recorded for beta.89. Final packaging, installed acceptance and publication are recorded separately.

Current limits

- All of this needs a team signed in and a hub on the version that ships with this release. Existing sessions still need a supported connection and sharing permission; activity visibility alone is not a messaging channel.
- Moments are now stored in their own table; the board shows the 50 most recent until the read path moves to the table in a later beta. Removing a moment deletes its comments, and a mention of a departed member falls back to plain text.
- Presence is per connection: a member with two tabs appears once per tab in the hub's list (the pages dedupe). A hidden web tab keeps beating once a minute. Desktop hand-off cards are refreshed from board snapshots once a minute while the window is visible.
- Hand-off adds the recipient as an assignee; decline or cancel leave assignees as they are.
- Separate working copies and checked integration protect work managed by Plexiform. Independent agents can still conflict when editing the same shared checkout outside those boundaries; overlap warnings are not universal file locks.
- Real second-person acceptance of hand-off, mentions and presence on a second account, external teammate/device, real-device updater and rollback acceptance remain open. Windows downloads, public phone access and Linear/Jira signed delivery stay gated.
- Mac builds remain ad-hoc signed and are not Apple-notarized; Apple Developer ID signing is still open. A changed build may require fresh authorization for Plexiform / Plexiform Safe Storage in the system Keychain dialog.
- Public registration remains closed; invited teams use the sign-in methods offered by their hub. Provider installation, sign-in, subscriptions and usage charges remain separate. Agent Mail remains free; inbox polling is off by default and sending requires confirmation.
- Privacy/legal review and an off-device gallery-key backup remain outstanding. No universal cross-platform completion claim is made by this candidate.

Install

Use https://plexiform.dev/download for the published beta. Release assets include SHA256SUMS.txt. A signed update manifest verifies release bytes; it does not establish platform code signing or a completed device update check.
