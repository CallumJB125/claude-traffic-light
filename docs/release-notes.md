Plexiform 1.0.2 public beta — 14 October 2026

This preview is available for macOS (Apple silicon and Intel) and Linux (x64).

**What changed**
- Captured AI-session cards now show recorded Activity, editable Task context, exact-session controls, reported files, and relevant Handover actions. Context can be imported into a draft, reviewed, saved, and refreshed without losing edits.
- Handovers support refresh, copy, native Markdown export, continuation in another supported tool, and timeline navigation. Historical handover text is readable. Comments offer agent delivery only for a current managed run.
- Session actions recheck the originating window, document, team, workspace, account, and sharing scope after asynchronous work. Native export opens from the correct board window.
- Optional Burst configuration reads are asynchronous and bounded, reducing a source of desktop startup stalls. Terminal memory-worker shutdown cannot reopen after an explicit stop.
- Agent Mail is free, including Ask my AI. Inbox polling is off by default, and sending still requires confirmation.
- Claude Tasks is available on macOS and Linux; Codex remains the default provider. AI tools require their own installation, sign-in, permissions, and provider subscriptions or usage credits.

**Current limits**
- Plexiform provides session visibility, shared context, handovers, and isolation for managed Tasks. It does not yet universally prevent independent agents from overwriting work in a shared checkout. Ownership declarations and captured-session collision alerts are advisory.
- Windows downloads remain unavailable pending runtime and privacy acceptance. Public phone access and Linear/Jira delivery remain gated.
- Public account registration remains closed. Existing invited teams use Google or GitHub sign-in; production email sign-in is not enabled.
- Mac builds use ad-hoc signing and are not Apple-notarized. Follow the installation guidance at https://plexiform.dev/download; verify the download checksum.
- macOS folder permissions can affect startup. The installed Mac passed launch, saved-context, and native-export verification after the owner's permission changes; every earlier stall's cause is not proven. Linux device acceptance beyond CI continues.
- A signed update feed verifies release bytes; it does not establish Apple/Windows platform signing or a completed real-device update acceptance check.

**Install**
Download the installer for your platform at https://plexiform.dev/download. SHA-256 checksums are included in SHA256SUMS.txt. The one-line installer selects the newest published beta by default; PLEXIFORM_CHANNEL=stable selects the stable channel.
