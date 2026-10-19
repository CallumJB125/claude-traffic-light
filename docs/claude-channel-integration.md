# Claude Code terminal channels

Plexiform can message a terminal Claude Code session after the person running
that terminal explicitly starts it with Plexiform's development MCP channel.
An ordinary terminal, Claude Desktop chat or Claude web chat stays observed-only.
This is Claude Code's research-preview Channels interface, documented at
https://code.claude.com/docs/en/channels and
https://code.claude.com/docs/en/channels-reference. Organization policy can
disable Channels. A successful transport connection does not prove that Claude
received a message.

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
