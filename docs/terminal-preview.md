# Plexiform Terminal: recovered development preview

Status: implemented local development preview, **not a published release**. The approved separate-terminal design lives in the historical `outputs/plan-agent-terminal.md` Revision 3. Previously only PR 0s's contracts and stubs existed. This change adds a working, separate terminal rather than embedding a PTY inside Plexiform or relabeling the external-terminal dashboard.

## What the preview does

- A separate Electron app renders real terminal tabs with xterm.js. New shell, Claude and Codex buttons ask for a project folder. Provider tabs start the user's signed native CLI; no subscription credentials are copied. CLI login and provider permission prompts stay in that tab.
- A Swift Session Keeper owns the PTYs. Closing/reopening the Terminal window preserves the shell's PID and reconstructs its screen. Detach hides a tab without stopping it; Stop requires a native confirmation for the selected tab. A reboot or keeper crash ends these sessions; crash recovery is not implemented.
- A vertical session sidebar lists every agent session — keeper tabs and Claude/Codex/Gemini sessions observed through Plexiform's hooks — grouped as Needs you, Running, Finished, Idle and Shells. Each row shows a status indicator (distinct colour and shape), tool, project folder, branch, a one-line "doing / waiting on", elapsed time and today's folder spend when the usage rollup has it. A keeper row opens its terminal; an observed external row opens a read-only detail page and never receives input.
- The Overview home shows live agents, sessions needing you, spend today and terminals; a needs-you queue (longest wait first) with what each session is waiting on; and a card per agent with branch, uncommitted changes, latest GitHub PR/CI signal, subagents, folder spend and a recent-activity timeline (transitions observed since the window opened). It refreshes every three seconds. Missing values show "—"; nothing is estimated.
- Keyboard: ⌘0 Overview, ⌘1–⌘9 the sidebar rows in order, ⌘J next session needing you, ⌘P quick switch (sessions and new-session commands), ⌘T new shell, ↑/↓ within the sidebar. If the Session Keeper disconnects, observed agents stay visible and the sidebar offers Reconnect.
- Data is read-only from `~/.claude-traffic-light`: `sessions/*.json` (hook state, bounded, owner-only, no symlinks; prompts and transcripts are never read into rows), `usage/daily/<month>.json` (spend), `git-signals.json` (CI/PR) and `git status --no-optional-locks` per folder. Approval counts are not shown.
- Input is accepted only from the current sandboxed Terminal document, for its selected tab, while its window is focused. Multi-line/control-character paste receives a native review. Protocol responses, terminal title commands, external links and clipboard escape sequences are disabled in the renderer. No MCP, agent-bus, hub, phone or remote input API is exposed.

The native C shim stays entirely in async-signal-safe C between forkpty and execve. The keeper's headless emulator is MIT-licensed SwiftTerm pinned to revision `5c83a9d214e7354697624c11deb4e488bdcfabad` (v1.10.1); the renderer is xterm.js 5.5.0 plus fit addon 0.10.0. This follows the final design's separate keeper and xterm app, not the superseded embedded node-pty proposal.

The keeper is the sole DA/DSR protocol responder, both attached and detached. The renderer suppresses those replies during normal output and snapshot replay, so a reattach cannot send duplicate answers. Current-screen cells, colors, cursor, scroll region, application-cursor mode and bracketed-paste mode are reconstructed. Full VT-mode equivalence, image protocols and every provider TUI have not been established.

## Build and run

Current packaged target: **Apple Silicon macOS only**. The configured minimum is macOS 13; older-system runtime acceptance and Intel builds are still pending. Node, the macOS Command Line Tools and Node-API headers are required. No existing app is replaced by this command.

```sh
npm ci
npm --prefix apps/terminal ci --ignore-scripts
npm run terminal:build
```

`terminal:build` runs `node scripts/build-terminal.js --development`. It builds an explicitly marked KEEPER_DEV helper, its audit-token socket addon and an ad-hoc signed app/zip in `dist/terminal/`. Generated Swift dependencies and compiler products are under the neighboring `work/terminal-native-build/` scratch folder, outside the source checkout. Set `PLEXIFORM_NODE_HEADERS` if Node headers are not at `/opt/homebrew/include/node`.

Open `dist/terminal/mac-arm64/Plexiform Terminal.app`. It keeps its own preferences/helper copy in `~/Library/Application Support/Plexiform Terminal Development Preview`; this does not replace Plexiform.app. A private, owner-checked local socket is used. The helper exits ten minutes after it has no connected windows or running sessions. The app starts no shell or agent until you choose one.

The first preview uses keeper build 1 and socket `k1-b1.sock`. A future preview changing keeper behavior must bump both the signed keeper build and rendezvous/copy version. Never overwrite a helper holding live sessions.

## Verification

```sh
npm run test:terminal
npm run test:terminal:native
```

The focused tests cover bounded metadata, omission of private content/control identifiers, symlink/oversize rejection, framed-protocol parsing, channel assignment before coalesced screen bytes, and refusal to turn an unsigned build into a public release.

The native acceptance harness builds an ad-hoc test identity on a unique private temporary socket with a clean HOME. It proves an actual shell receipt, no inherited token canaries, one CPR reply, exact shell PID preservation, a full-screen vi edit surviving driver disconnect/reconnect, exact saved contents, subsequent input, unrelated-peer denial, arbitrary launch-shape denial and control-role denial. It does not use an existing user terminal or an AI provider quota. The fixture driver is never packaged.

The development app also has a fixed packaged acceptance path. It requires both `--lab-state-root=/private/tmp/pf-terminal-lab-<unique>` and `--lab-smoke`, uses that clean home plus an independent socket, starts only its own disposable `/bin/sh`, sends a fixed harmless receipt through renderer IPC, captures the actual visible terminal and writes a JSON receipt/screenshot inside the lab folder. This is a development-only test path, not a general remote-control interface. It stops its own shell and keeper afterward.

## Distribution and remaining work

The generated zip is a **local developer preview**. It is ad-hoc signed, not Apple Developer ID signed or notarized. There is no public download URL, automatic updater, upload or promote command for it. `build-terminal.js` refuses a public/signed invocation and never publishes. Its runtime banner remains visible.

The native production path checks peer audit tokens, exact identifiers, same-team signatures and signed build floors. Development builds accept ad-hoc identities on their private development socket; that is a laboratory trust boundary, not production authentication. Public distribution remains blocked until Developer ID/notarization, release entitlements without disabled library validation, current signed rendezvous agreement, per-release build floors, oldest-supported-macOS tests, full load/crash/TCC testing and independent security review pass. The existing Plexiform release workflow does not publish this package.

The preview does not yet implement authenticated Plexiform control-client takeover, `rows.publish`, exact external-session jump, chat-to-terminal-to-chat handoff, Terminal auto-update or public website downloads. These operations refuse instead of silently falling back or treating an observed session as controllable. Actual fresh Claude/Codex terminal opt-in and response acceptance remain separate from the disposable shell/editor evidence.
