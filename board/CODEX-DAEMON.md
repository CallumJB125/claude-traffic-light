# Codex shared daemon: messaging existing Codex CLI sessions

Lane P4, 2026-10-02. Verified against codex-cli **0.159.2** at
`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` (its `--help`
output, `codex app-server generate-json-schema`, `codex features list`,
`codex app-server daemon version`) and against openai/codex `main` source and
READMEs (`codex-rs/app-server-daemon/README.md`,
`codex-rs/app-server-transport/src/transport/unix_socket.rs`,
`codex-rs/cli/src/main.rs`, `codex-rs/tui/src/daemon_startup.rs`,
`codex-rs/features/src/lib.rs`, `codex-rs/app-server/src/outgoing_message.rs`)
and the public app-server docs (learn.chatgpt.com/docs/app-server). Items
marked *source* were read in `main`, which can be newer than 0.159.2.

## Verified facts

| Fact | Evidence |
| --- | --- |
| Daemon lifecycle is a documented CLI: `codex app-server daemon start / stop / restart / version / bootstrap / enable-remote-control / disable-remote-control / update`. Experimental; each prints one JSON object. | 0.159.2 `--help`; daemon README |
| Control socket (rendezvous) is `$CODEX_HOME/app-server-control/app-server-control.sock` (default `~/.codex/...`). | `daemon version` error on this Mac: `failed to connect to /Users/callumbaker/.codex/app-server-control/app-server-control.sock` |
| The rendezvous path is a **symlink** to the real socket in a private shared-daemon directory; socket mode **0600**, parent created **0700**; startup refuses a parent not owned by the user/root or writable by group/other (unless sticky). No token auth: access = Unix file permissions, per user. | *source* `unix_socket.rs` (`CONTROL_SOCKET_MODE = 0o600`, `mode(0o700)`, `metadata.mode() & 0o022`) |
| The socket speaks **WebSocket over the Unix socket** (JSON-RPC text frames). Path `/daemon/shutdown` is a special shutdown handshake (managed daemons only); any other path is a normal client. | *source* `unix_socket.rs`; docs: "WebSocket connections over Codex's default app-server control socket" |
| `codex app-server proxy [--sock PATH]` is a raw stdio-to-UDS byte relay (`codex_stdio_to_uds::run`); it does **not** start the daemon and does not frame — a client must still do the WebSocket handshake. Plexiform therefore connects to the same socket directly with `ws+unix://` (identical bytes, no child process). | *source* `cli/src/main.rs` |
| Plain interactive `codex` **attaches to the shared daemon by default and starts it if missing** (`daemon_auto_start`, stage stable, default true; `codex features list` on this Mac: `daemon_auto_start stable true`). Excluded (embedded server instead): `--no-daemon`, `--oss`, `--profile`, `-c/--enable/--disable/--search` overrides (beyond a small allowlist), `--strict-config`, `--dangerously-bypass-hook-trust`, `CODEX_EXEC_SERVER_URL`. Explicit `codex --remote unix://` also attaches. `codex agents` browses all daemon sessions. | 0.159.2 `--help` (`--no-daemon`: "Run without the shared background server"); *source* `tui/src/daemon_startup.rs`, `features/src/lib.rs` |
| Daemon was **not running** on this Mac at test time (socket path absent). | `codex app-server daemon version` |
| Multiple clients per thread: `thread/resume` subscribes a connection; `thread/unsubscribe` removes it; the server keeps the thread loaded until no subscribers and 30 min idle. | docs |
| `thread/loaded/list` → `{data: [threadId], nextCursor}` = threads loaded in the daemon's memory. | 0.159.2 schema |
| `thread/list` returns `Thread` objects including **`preview` ("usually the first user message")**, `path`, `gitInfo`, `name`, `cwd`, `status`, `source`. `turns` is empty except on resume/fork/read. | 0.159.2 schema |
| `thread/resume {threadId, excludeTurns: true}` returns metadata without `thread.turns`; any other field (model, sandbox, approvalPolicy, cwd, ...) is an **override** of the thread's settings. | 0.159.2 schema |
| `thread/read`, `thread/turns/list`, `thread/items/list` return transcript content. | 0.159.2 schema |
| `turn/start {threadId, input, clientUserMessageId}` → `{turn: {id}}`; `turn/steer {threadId, expectedTurnId, input, clientUserMessageId}` → `{turnId}`, fails when `expectedTurnId` is not the active turn; `turn/interrupt {threadId, turnId}` → turn ends `interrupted`. | 0.159.2 schema; docs |
| Notifications (`turn/started`, `item/*`, `turn/completed`, `thread/status/changed`, `thread/closed`) for a thread go to **every subscribed connection**, including other clients' turns. | docs; *source* `outgoing_message.rs` (thread-scoped `connection_ids`) |
| **Server requests (approvals, elicitation, tool calls) are sent to every subscribed connection**; the first answer resolves them. An error reply from Plexiform would therefore deny the human's approval. | *source* `outgoing_message.rs` (`send_request_to_connections`) |
| Codex **desktop app** conversations run on the app's private stdio app-server, not on this daemon. `~/.codex/ipc/ipc.sock` is undocumented and is not used. | earlier lane; unchanged |

## What Plexiform does (src/codex-daemon.js, provider id `codex-daemon`)

- **Opt-in**: Preferences → "Let Plexiform message Codex CLI sessions running
  on the shared Codex daemon" (`codexDaemonMessaging`, default false). Off →
  `interaction:capabilities` lists `codex-daemon` with `available:false` and
  that reason; nothing touches the socket. Unticking disconnects at once.
- **Never starts the daemon.** Not running → `available:false` with the exact
  human command (the real CLI path, since `codex` is not on PATH here).
- **Socket check before connecting**: realpath of the rendezvous symlink must
  be a socket owned by this uid with no group/other bits, in a directory owned
  by this uid (or root) that others cannot write.
- **Method allowlist** (enforced in the adapter): `initialize`,
  `thread/loaded/list`, `thread/list`, `thread/resume` (only
  `{threadId, excludeTurns:true}`, no overrides), `turn/start` (no effort or
  other overrides), `turn/steer`, `turn/interrupt`, `thread/unsubscribe`.
  Transcript methods cannot be sent.
- **Discovery** = loaded thread ids ∩ `thread/list`, keeping only id, name,
  cwd basename, status, updatedAt; `preview`, `path`, `gitInfo`, turns are
  dropped at parse. Sub-agent and ephemeral threads are skipped. The renderer
  gets opaque per-discovery handles, never thread ids; a new discovery retires
  old handles.
- **Attach** re-checks the thread is still loaded, then resumes exactly that id.
  The session is bound to the thread id + generation; same title/folder on a
  new thread is a different session. Labelled `existing-unmanaged`,
  "Unmanaged — started outside Plexiform".
- **Send**: busy (known or unknown active turn) → `busy` refusal; steer only
  with the exact active turn id (`expectedTurnId`); ack = Codex's own turn id;
  `recorded` only when Codex echoes our `clientUserMessageId` + text.
- **Content filter**: deltas/messages are passed on only for turns Plexiform
  started (all agent items) or steered (only agent items that start after the
  steer ack). Other clients' user messages, replies and error text are never
  emitted, stored or logged.
- **Approvals** are never answered (no response at all); a notice says to
  answer in the Codex terminal.
- **Detach / reload / opt-out**: `thread/unsubscribe` only; never interrupts
  the human's work. Interrupt happens only on the user's explicit click.

## Human steps

To attach your sessions (after ticking the preference):

```sh
# in Terminal, in your project folder (no --no-daemon/--profile/--oss/-c flags):
'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
```

That starts the shared daemon if needed and attaches the session. Optionally
start the daemon first with
`'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex' app-server daemon start`.
Then in Plexiform: Overview → "Codex CLI sessions you started yourself" →
Find sessions → Message this session.

Real proof (one tiny message, prints no thread ids or transcript):

```sh
cd <this worktree>
node scripts/codex-daemon-proof.js          # lists sessions: "1. <title> · <folder> · idle"
node scripts/codex-daemon-proof.js --send 1 # sends "Plexiform daemon proof: reply with just the word OK."
```

Expected: `send: acknowledged`, then `state: completed`, `recorded: true`,
`response: "OK"`, and the message plus reply visible in the Codex terminal.

## Unsupported

- Codex desktop-app conversations (private stdio app-server; no supported channel).
- CLI sessions run with `--no-daemon`, `--oss`, `--profile`, `-c` overrides,
  `--strict-config` or `CODEX_EXEC_SERVER_URL` (embedded server).
- Interrupting a turn that was already running before Plexiform subscribed and
  whose id it has not seen (send refuses as busy until it finishes).
- Answering approvals, reading history, changing a session's settings.
