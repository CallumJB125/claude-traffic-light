Plexiform 1.0.2-beta.77 public beta — 15 October 2026

This preview is available for macOS (Apple silicon and Intel) and Linux (x64).

**What changed**
- Restoring a saved team account while Home, Overview or another local page is open refreshes the cached board target without changing the page you are using. Opening Board afterward shows the restored team's board; an explicit choice to use the local board stays local.
- Team-account restore and save use asynchronous secure storage on macOS and Windows. Saved sign-ins restore after app readiness while local navigation stays usable; a sign-in succeeds only after its credential is saved securely.
- On macOS, team-account cryptography runs in a disposable helper so a pending Keychain authorization cannot hold normal Quit open. The helper verifies its running Plexiform parent before accessing secure storage. Quitting retires the helper, and late completions cannot restore an account or resume a runner.
- The sidebar explains when a saved sign-in is unlocking or being saved. If secure storage is locked, it shows recovery guidance and an explicit Retry saved sign-in action. Ordinary reads do not repeatedly retry a denied authorization. Restoring an account preserves the selected page and remembered workspace, including a local-board choice made while waiting.
- Cancelling a browser sign-in while secure saving is pending discards its result and requests revocation of the newly issued device token. Signing out prevents a late restore or save from bringing the account back; a cancelled attempt cannot clear a newer sign-in.
- Home's optional starter-pack detection reads recent project folders in a separate helper process with a deadline. An unavailable folder cannot freeze navigation or leave shutdown waiting for a blocked thread. Dismissed or unnecessary suggestions do not scan those folders.
- Open a shared Team session to see its task, current reported activity, messages, exact-text receipts and streamed output. Send to the selected session, steer its current turn or request interruption where the provider and explicit share allow it. Every final action is bound to the reviewed session generation and turn.
- Codex and Claude report fixed activity categories such as thinking, reading, searching and editing. Tool arguments and raw commands are not included. A steering receipt is separate from evidence that the requested correction was applied; its output view starts after that message.
- Busy sessions without steering let you keep a local draft until sending becomes available. Drafts are not queued or sent automatically. Refused and uncertain actions preserve drafts and are never retried automatically.
- Watch-only shares remain read-only. Changed accounts, sessions, turns, team views and revoked shares retire pending controls. Sharing excludes earlier history, including same-millisecond history and immediate steering receipts. Passive directory caching keeps larger teams within the existing relay request limits; the selected conversation reads fresh state.
- Captured AI-session cards now show recorded Activity, editable Task context, exact-session controls, reported files, and relevant Handover actions. Context can be imported into a draft, reviewed, saved, and refreshed without losing edits.
- Handovers support refresh, copy, native Markdown export, continuation in another supported tool, and timeline navigation. Historical handover text is readable. Comments offer agent delivery only for a current managed run.
- Session actions recheck the originating window, document, team, workspace, account, and sharing scope after asynchronous work. Native export opens from the correct board window.
- Optional Burst configuration reads are asynchronous and bounded, reducing a source of desktop startup stalls. Terminal memory-worker shutdown cannot reopen after an explicit stop.
- Agent Mail is free, including Ask my AI. Inbox polling is off by default, and sending still requires confirmation.
- Claude Tasks is available on macOS and Linux; Codex remains the default provider. AI tools require their own installation, sign-in, permissions, and provider subscriptions or usage credits.

**Current limits**
- Existing sessions need a supported, explicitly enabled connection. The Codex shared daemon supports explicitly attached CLI sessions; it does not reach Codex desktop conversations. Observed activity hooks alone do not provide a messaging channel. Claude/Gemini/local adapters do not all support current-turn steering; only available actions are offered.
- Real Codex and Claude disposable-session checks passed. Desktop shared-session send, steer and interrupt passed through the real transport with local test accounts and real Codex. Two independent external teammates/devices and every provider/device combination have not been accepted yet. Durable next-turn executable queues, owner-reviewed proposals and granular new delegation records are not included in this preview.
- Plexiform provides session visibility, shared context, handovers, and isolation for managed Tasks. It does not yet universally prevent independent agents from overwriting work in a shared checkout. Ownership declarations and captured-session collision alerts are advisory.
- Windows downloads remain unavailable pending runtime and privacy acceptance. Public phone access and Linear/Jira delivery remain gated.
- Public account registration remains closed. Existing invited teams use Google or GitHub sign-in; production email sign-in is not enabled.
- Mac builds use ad-hoc signing and are not Apple-notarized. Follow the installation guidance at https://plexiform.dev/download; verify the download checksum.
- A newly installed ad-hoc Mac build can require a fresh owner approval in the macOS Keychain dialog. Verify that it names Plexiform and Plexiform Safe Storage, and complete that approval directly on your Mac.
- The asynchronous account change does not make every credential operation nonblocking. Runner tokens and local-board credentials retain their existing storage paths, and Linux retains its guarded desktop password-store backend. Windows runtime acceptance remains open.
- macOS folder permissions can affect filesystem features. Normal installed beta.67 Home navigation stalled on synchronous directory scanning; the follow-up isolates the optional starter scan with a deadline and process cleanup. Other earlier file-access stalls do not all have a proven cause. Linux device acceptance beyond CI continues.
- A signed update feed verifies release bytes; it does not establish Apple/Windows platform signing or a completed real-device update acceptance check.
- Privacy/legal review and the external teammate, device and provider acceptance gates remain open.

**Install**
Download the installer for your platform at https://plexiform.dev/download. SHA-256 checksums are included in SHA256SUMS.txt. The one-line installer selects the newest published beta by default; PLEXIFORM_CHANNEL=stable selects the stable channel.
