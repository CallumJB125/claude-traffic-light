# Claude Code terminal channels

Plexiform can message a terminal Claude Code session after the person running
that terminal explicitly starts it with Plexiform's development MCP channel.
An ordinary terminal, Claude Desktop chat or Claude web chat stays observed-only.
This is Claude Code's research-preview Channels interface, documented at
https://code.claude.com/docs/en/channels and
https://code.claude.com/docs/en/channels-reference. Organization policy can
disable Channels. A successful transport connection does not prove that Claude
received a message.

## Remote Control and ordinary terminal recovery

Claude's `--remote-control` flag starts an interactive local session with
Anthropic's phone/web control enabled (installed Claude 2.1.318 `--help`). It
does not give Plexiform an inbound API. The local session can still report
activity through installed hooks. Do not treat a green provider-health check,
hook activity or a Remote Control connection as proof of Plexiform delivery.

To receive Plexiform messages, open Overview → **Connect a Claude terminal**,
select the project, and run the generated command yourself in that project.
Confirm Claude's research-preview channel prompt, then select **Claude terminal
channel** → **Find sessions** and attach the connection. To continue prior work,
add `--resume` using Claude's normal resume workflow. An ordinary already-running
terminal cannot be attached silently; connecting it requires that explicit
startup opt-in. Retain its existing permission policy.

Use `--remote-control` alongside the generated startup arguments only where the
provider permits both features. Coexistence requires a real Claude acceptance
run; the local channel fixtures do not prove Remote Control compatibility. A
`claude remote-control` server which spawns sessions, a hosted cloud session and
a session on another computer are separate cases: a loopback grant on this Mac
does not attach to those remote processes. Use the existing paired/team sharing
path for another device, with its own explicit session share.

If Claude's own Remote Control is unavailable while Burst is enabled, inspect
Burst's actual mode in Plexiform settings. Base-URL mode reports Remote Control
off; transparent mode reports it expected to work. This is a mode diagnostic,
not a completed provider test. A mode change is a separate explicit setup action.

Before claiming success, verify the selected terminal/project, one harmless
message, Claude's exact acceptance receipt and correlated reply, and the visible
response/state in Plexiform. Repeat with Remote Control enabled if that is the
intended workflow. A receipt timeout is unconfirmed and must not trigger an
automatic retry.

### Windows controlling a Mac through Plexiform

This is a separate feature from Claude Remote Control. Plexiform's own-account
relay requires the Mac's **Let my other devices use sessions Plexiform started
on this Mac** opt-in and both devices signed in to the same account on the same
hub. Its list contains sessions launched through the account remote host;
ordinary terminal sessions and sessions started in Overview are outside that
list. Turning on hosting does not attach to them.

Team sessions use a separate explicit share: watch permits reads; Allow sending
permits supported sends, steering and interruption by acting teammates. The
owner's host checks its own share record as well as the hub's authorization.
The team-share route refuses the owner's own account, so it is not an alternate
way to reach a Mac Overview session from that owner's Windows device. A new
own-device connection to an existing Overview session needs an explicit
owner-device grant and UI; it is not supplied by the current terminal channel.

Own-device relay callers have a client device role. A desktop currently hosting
sessions cannot also use that own-device route with its host credential; a
separately enrolled browser client has its own client credential. Hosting
desktops can still use another owner's explicitly shared team session. Do not
change device roles or turn off team sharing automatically to make a request fit.

`board/hub/test/interaction-relay.test.js` proves same-account "Windows" → "Mac"
send, provider acknowledgement, exact recorded input, correlated reply and
completion over a disposable local accounts hub with a fake provider.
`interaction-shares.test.js` checks team control, scope/role enforcement and
revocation; `relay-e2e.test.js` checks paired encrypted transport. These labels
model device roles on the test host. They do not prove a Windows installer,
Windows-to-Mac network, deployed hub, retained login or real-provider acceptance.

## Main-process setup boundary

1. Register `createClaudeChannelSession()` as `claude-channel` with the interaction
   hub, and await `start()` before making a grant.
2. Require a focused trusted app window, a selected board and a user-selected
   project directory. Recheck that authority after the directory dialog returns.
3. Call `createGrant({cwd, title})` in the main process. Its token-bearing result
   must never cross IPC, appear in a command line or be logged.
4. Create a canonical app-owned mode0700 temporary directory, then call
   `writeClaudeChannelConfig({grant, directory, command, args, electronRunAsNode})`.
   `command` and `args` are fixed by the app: its bundled executable and the
   packaged `src/claude-channel-server.js`, with `electronRunAsNode: true` for
   Electron. The writer adds `ELECTRON_RUN_AS_NODE=1` only to the private config.
   It refuses Windows until a separately reviewed native private publisher is
   wired. If publication fails, revoke the grant and remove its private directory.
5. Show only the returned `file` and `claudeArgs` to the person. Quote each
   argument with the app's shell-argument quoting function; the recipe is
   `claude --mcp-config <private-file> --dangerously-load-development-channels server:plexiform`.
   The user runs it in the selected project terminal. Continuing an existing
   session requires their normal Claude resume workflow and this same explicit
   channel opt-in. Do not silently modify project or Claude settings.
6. Explain before setup that this terminal retains its own permissions: messages
   can use its tools and provider quota. Plexiform never relays permission
   approvals. The server does not advertise `claude/channel/permission`.
7. Discovery lists connected grants only. Attach to the exact discovered target;
   bind any team share to that same local attachment. Release/close, board/window
   retirement and application exit revoke grants. Remove private config folders
   on app exit. Reconnecting requires a new grant and user opt-in.

The broker listens exclusively on an ephemeral `127.0.0.1` port. A per-grant
256-bit token plus a connection nonce identify one channel; browser origins,
wrong Host headers, foreign grants, unknown routes, altered inputs, reused message
IDs, late receipts and replies without an accepted request are refused. Grants
expire after 12 hours and disconnected clients after 30 seconds. Each grant has
at most 1000 send IDs and each app at most 32 active grants.

## Honest delivery

The server sends `notifications/claude/channel` with content and a message ID.
Claude must call `plexiform_accept` with the exact ID and exact content before
acting, then `plexiform_reply` with that ID and its answer. The accept tool is the
provider receipt; writing a channel notification never marks a message delivered.
A 30-second receipt timeout returns `DELIVERY_UNCONFIRMED`, revokes the grant and
forbids automatic retry: Claude might still act on the written notification.
An accepted turn without a reply after five minutes fails and revokes the grant.
The terminal itself remains running, and Plexiform cannot interrupt or steer it.

This receipt protocol can prove the selected channel's tool calls, not that the
model obeyed every instruction or that a semantic answer is correct. A model
which never calls the required tools remains unconfirmed. Real provider acceptance
must verify opt-in, exact terminal/project identity, receipt, correlated reply,
busy refusal, revocation, absence of permission relay and the org-policy-blocked
case before release.

## Offline adversarial checks and mutation review

Run `node --test test/claude-channel-session.test.js`. It starts only loopback
HTTP and an actual MCP SDK in-memory client/server. It never starts Claude,
uses a provider login or reads a transcript. Private-file fixtures are under
`/private/tmp` and removed after each test.

An independent reviewer should copy the two source files and fixture test into a
scratch directory, preserving their relative paths; copy `session-interaction.js`
and `secret-patterns.js` only as test dependencies, and link the already installed
`node_modules`. Change one guard at a time and run the fixture test with a bounded
timeout. Each of these mutants must fail a targeted assertion:

- Treat a write as accepted, or remove the exact input-text check.
- Remove the grant-token, Host, Origin or connection-nonce guard.
- Permit a reply before acceptance, an unknown ID or a duplicate receipt.
- Remove the post-body `valid(g)` check and revoke during a streamed body.
- Keep a grant after receipt timeout or after `release({target})`.
- Permit a completed message ID to be sent again.
- Advertise `claude/channel/permission` or allow a non-loopback endpoint.
- Change config publication to mode0644, allow a public/symlink directory or
  overwrite an existing grant file.

A written independent security report is required before integrating this code;
the author does not approve their own implementation. Real Claude acceptance is
a separate release gate from these offline checks.
