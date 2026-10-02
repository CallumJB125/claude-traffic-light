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
| `thread/resume {threadId, excludeTurns: true}` returns metadata without `thread.turns`; any other field (model, sandbox, approvalPolicy, cwd, ...) is an **override** of the thread's settings. The response reports the thread's effective `approvalPolicy` (`untrusted` / `on-request` / `never` / `{granular}`) and `sandbox` (`{type: readOnly / workspaceWrite / externalSandbox / dangerFullAccess}`), both required. | 0.159.2 schema (`ThreadResumeResponse`) |
| `Thread.source` (required) is `cli` / `vscode` / `exec` / `appServer` / `unknown` / `{custom}` / `{subAgent}`; `Thread.ephemeral` is required; sub-agent threads also carry `parentThreadId`, `agentNickname`, `agentRole`. | 0.159.2 schema |
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
- **Socket check before and after connecting**: realpath of the rendezvous
  symlink must be a socket owned by this uid with no group/other bits, in a
  directory owned by this uid with no group/other bits (no root-owned or
  sticky shared directory). Once the WebSocket opens, the check runs again and
  the realpath and inode must be unchanged; otherwise the connection is closed
  before `initialize`.
- **Method allowlist** (enforced in the adapter): `initialize`,
  `thread/loaded/list`, `thread/list`, `thread/resume` (only
  `{threadId, excludeTurns:true}`, no overrides), `turn/start` (no effort or
  other overrides), `turn/steer`, `turn/interrupt`, `thread/unsubscribe`.
  Transcript methods cannot be sent.
- **Discovery** = loaded thread ids ∩ `thread/list`, keeping only id, name,
  cwd basename, status, updatedAt; `preview`, `path`, `gitInfo`, turns are
  dropped at parse. Only `source: "cli"`, `ephemeral: false` threads without
  `parentThreadId` / `agentNickname` / `agentRole` are kept; a loaded id
  without such metadata is not listed at all (sub-agent, exec, app-server,
  ephemeral, custom and unknown-source threads never appear). The renderer
  gets opaque per-discovery handles, never thread ids; a new discovery retires
  old handles, and a window that goes away has its handles pruned.
- **Attach** re-checks the thread is still loaded and passes the same metadata
  filter (`thread/list`) *before* resuming, so a hidden thread is never
  subscribed, then resumes exactly that id. The session is bound to the
  thread id + generation; same title/folder on a new thread is a different
  session. Concurrent attaches of one thread from one window share one attempt
  and one session. Labelled `existing-unmanaged`, "Unmanaged — started outside
  Plexiform".
- **Disclosure**: the resume response's `approvalPolicy` and `sandbox` type are
  kept (nothing else) and shown on the attached session, with warnings when
  the policy is `never` or the sandbox is `dangerFullAccess`, and (unless the
  policy is `never`) that Plexiform cannot tell whether a Codex terminal is
  still attached to answer approvals. Messages sent from Plexiform run with
  that session's own permissions.
- **Send**: busy (known or unknown active turn) → `busy` refusal; ack =
  Codex's own turn id; `recorded` only when Codex echoes our
  `clientUserMessageId` + text.
- **Only Plexiform's own turns are steered or interrupted.** A turn counts as
  Plexiform's only when its id came back in the response to Plexiform's own
  `turn/start` on that thread. Steer (`expectedTurnId`) and interrupt of any
  other turn are refused in the hub (`busy`, "started outside Plexiform") and
  again in the adapter, which never sends `turn/steer` / `turn/interrupt` for
  it. A foreign running turn is shown as working with no steerable turn.
- **Content filter**: deltas/messages/error text are passed on only for turns
  Plexiform started, on the thread they were started on (a forged thread id
  with Plexiform's turn id is dropped). Other clients' user messages, replies
  and error text are never emitted, stored or logged.
- **Approvals** are never answered (no response at all); a notice says to
  answer it in a Codex terminal attached to the session, or to interrupt the
  turn if none is open (it is Plexiform's own turn, so that is allowed).
- **Detach / reload / opt-out**: `thread/unsubscribe` only, and only when no
  other Plexiform window still uses that thread on the shared connection;
  never interrupts anyone's work. Interrupt happens only on the user's
  explicit click, and only for Plexiform's own turn.

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

Real proof (one tiny message, prints no thread ids or transcript). Run it
**only against a session whose approval policy is `on-request` and which has
a sandbox** (Codex's default in a trusted project folder): the proof message
runs with that session's own permissions. The script prints the permissions
on attach and detaches without sending anything otherwise.

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
- Steering or interrupting any turn Plexiform did not start (the human's own
  turns, other apps' turns, turns already running before Plexiform
  subscribed). Send refuses as busy until such a turn finishes.
- Sub-agent, `codex exec`, app-server, ephemeral or other non-CLI threads on
  the daemon.
- Knowing whether a Codex terminal is still attached to a session.
- Answering approvals, reading history, changing a session's settings.
