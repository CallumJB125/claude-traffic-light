# Provider capability matrix

Verified 2026-10-02 on the build Mac. Machine-readable source: `src/provider-capabilities.json`; the Overview's unavailable reasons come from it, and `test/provider-capabilities.test.js` fails if a platform label is advertised anywhere in Plexiform without a recorded row. Regenerate this page from the JSON when it changes.

Installed on the verifying machine: macOS build Mac (darwin 25.4.0); installed here: claude 2.1.287, codex-cli 0.159.2 (inside ChatGPT.app), hermes 0.21.3, aider 0.86.2; NOT installed: gemini, cursor-agent/agent, copilot, opencode, ollama, lms, llama-server.

Rules this table follows:

- Every claim is backed by a primary provider doc URL, the local `--help`/schema/source of the installed tool, or a recorded real run (see Evidence per platform).
- A lifecycle hook or an MCP connection is observation or an outgoing tool surface. Neither is counted as inbound control of an existing app session.
- **Owned** means a session Plexiform started itself through the provider's documented headless channel. **Existing** means a session the person started in the provider's own app, terminal or IDE.
- Owned adapters for providers that are not installed here, or whose isolation has not been verified on a real install, are wired but listed **unavailable** with the exact reason. Nothing falls back silently.

Cell legend:

- `built`: Implemented in Plexiform and covered by tests (fake provider fixtures unless a real run is recorded).
- `docs: not built`: A primary provider doc or local --help/schema shows a supported channel; Plexiform does not use it yet.
- `provider-only`: The provider offers it only to its own apps/accounts; not available to a third-party app like Plexiform.
- `none`: No supported channel found in primary docs or local --help/schema.
- `n/a`: The concept does not exist for this platform.
- `wired, unverified`: Plexiform has the adapter code path (shared and fake-tested) but it has never been accepted against this provider; it stays unavailable.

## Summary

| Platform | Hosting | Managed vs existing | Discovery | Telemetry/hooks | Task reporting | Receive message | Reply | Resume | Steer busy turn | Interrupt | Remote control | AI handoff |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Claude Code** | local CLI; Claude Code on the web / --cloud sessions are Anthropic-hosted | owned: Plexiform-started `claude -p` stream-json child (built); existing terminal/IDE sessions: observe only | **built** | **built** | **built** | **built** | **built** | docs: not built | none | **built** | provider-only | between turns |
| **Codex** | local app-server; Codex Cloud tasks are OpenAI-hosted | owned: Plexiform-spawned `codex app-server` stdio threads (built); existing desktop/IDE threads: observe only; existing CLI sessions on the shared daemon: opt-in messaging (built) | **built** | **built** | **built** | **built** | **built** | docs: not built | **built** | **built** | **built** | mid-turn + between turns |
| **Cursor** | Cursor IDE and CLI local; Cloud Agents on Cursor-hosted VMs (or self-hosted pools) | owned: `agent acp` adapter wired but unavailable (not installed, isolation unverified); existing IDE/CLI chats: observe only | **built** | **built** | **built** | wired, unverified | wired, unverified | docs: not built | none | wired, unverified | docs: not built | between turns |
| **Gemini CLI** | local CLI | owned: `gemini --acp` adapter built but unavailable (not installed, isolation unverified); existing sessions: observe only (hooks, best effort) | **built** | **built** | **built** | wired, unverified | wired, unverified | docs: not built | none | wired, unverified | none | between turns |
| **Hermes Agent** | local agent; model per the user's Hermes config (here a tailnet vLLM) | owned: `hermes acp` reachable through the shared ACP client but kept unavailable (tools cannot be turned off); existing sessions: observe only if the user's Hermes posts to Plexiform's local signal endpoint | **built** | docs: not built | **built** | wired, unverified | wired, unverified | docs: not built | wired, unverified | wired, unverified | none | between turns |
| **OpenCode** | local CLI/server | owned: `opencode acp` adapter wired but unavailable (not installed); existing TUI sessions: not connected | docs: not built | docs: not built | **built** | wired, unverified | wired, unverified | docs: not built | none | wired, unverified | docs: not built | between turns |
| **Copilot CLI** | local CLI; model calls go to GitHub Copilot (or BYOK provider) | owned: `copilot --acp --stdio` adapter wired but unavailable (not installed, public preview); existing sessions: not connected | none | docs: not built | **built** | wired, unverified | wired, unverified | none | none | wired, unverified | none | between turns |
| **Ollama** | local HTTP (127.0.0.1:11434) or LAN/tailnet | owned: Plexiform-held conversation over the stateless native API (built) | **built** | n/a | n/a | **built** | **built** | **built** | none | **built** | n/a | between turns |
| **LM Studio** | local HTTP (127.0.0.1:1234) | owned: Plexiform-held conversation over OpenAI-compatible API (built) | **built** | n/a | n/a | **built** | **built** | **built** | none | **built** | n/a | between turns |
| **OpenAI-compatible local server** | local, LAN or tailnet HTTP (vLLM, llama.cpp llama-server, litellm proxy, others) | owned: Plexiform-held conversation (built) | **built** | n/a | n/a | **built** | **built** | **built** | none | **built** | n/a | between turns |
| **Claude apps (remote MCP connector)** | Anthropic-hosted; connector calls come from Anthropic infrastructure to the user's Plexiform hub | neither: the Claude app is a client of Plexiform's remote MCP board tools (docs/remote-mcp.md); Plexiform cannot start or message a Claude chat | none | none | **built** | provider-only | **built** | provider-only | none | none | provider-only | none |
| **ChatGPT** | OpenAI-hosted chat app | neither: README lets a user's own Shortcut/script POST activity to Plexiform's local endpoint | none | **built** | **built** | none | none | none | none | none | provider-only | none |
| **Windsurf** | local IDE | neither: Plexiform only recognises it as the app hosting a terminal (hostapp.js, set-status.js) | docs: not built | docs: not built | **built** | none | none | none | none | none | none | none |
| **Aider** | local CLI | neither | **built** | **built** | **built** | none | none | none | none | none | none | none |
| **Custom agent (local signal endpoint)** | whatever program the user wires up, on this computer | neither: a user's own script, Shortcut or other agent posts activity to Plexiform | **built** | **built** | **built** | none | none | none | none | none | none | none |

## AI-to-AI handoff readiness

Input to the handoff contract: which sessions can take a message while a turn runs (mid-turn) versus only between turns, through which channel, and what counts as acknowledgement. Mid-turn is claimed only where a steer channel with a turn precondition is built.

| Platform | Mid-turn | Between turns | Channel | Acknowledgement | Existing sessions |
|---|---|---|---|---|---|
| **Claude Code** | no | yes | owned stream-json new turn | command_lifecycle for our uuid | A Stop hook may return decision:block with a reason that continues the turn (documented); Plexiform does not use it: no delivery ack and it only fires when the turn ends. |
| **Codex** | yes | yes | owned turn/steer (mid-turn, precondition) or turn/start | server turn id + clientUserMessageId echo | none |
| **Cursor** | no | yes | owned ACP session/prompt (when verified) | first content session/update for our session | A stop hook may return followup_message, which Cursor submits as the next user message (documented); Plexiform does not use it: no delivery ack, between turns only. |
| **Gemini CLI** | no | yes | owned ACP session/prompt (when verified) | first content session/update | No hook can inject a prompt (AfterAgent can only retry/halt). |
| **Hermes Agent** | no | yes | owned ACP session/prompt (not offered) | first content session/update | none |
| **OpenCode** | no | yes | owned ACP session/prompt (when verified) | first content session/update | Possible via a user-started `opencode serve` (not built). |
| **Copilot CLI** | no | yes | owned ACP session/prompt (when verified) | first content session/update | none |
| **Ollama** | no | yes | next HTTP turn | HTTP 200 stream | not-applicable (no server-side sessions) |
| **LM Studio** | no | yes | next HTTP turn | HTTP 200 stream | not-applicable |
| **OpenAI-compatible local server** | no | yes | next HTTP turn | HTTP 200 stream | not-applicable |
| **Claude apps (remote MCP connector)** | no | no | pull only: the chat reads task messages/handovers when its human asks | tool call receipt (request_id), not chat delivery | none |
| **ChatGPT** | no | no | none (human copy/paste only) | none | none |
| **Windsurf** | no | no | none | none | none |
| **Aider** | no | no | none | none | none |
| **Custom agent (local signal endpoint)** | no | no | none | none | none |

## Per platform

### Claude Code

- Ids/aliases: `claude`, `claude-code`, `Claude`
- Installed here: 2.1.287. Advertised by Plexiform: yes.
- Exact supported channel: Owned: `claude -p --input-format stream-json --output-format stream-json --replay-user-messages` (src/claude-code-session.js). Existing: hooks (hooks/set-status.js) for observation only.
- Discovery: `built`. Hooks (SessionStart/UserPromptSubmit/PreToolUse/Stop/SubagentStart/SubagentStop/SessionEnd) report sessions to Plexiform.
- Telemetry/hooks: `built`. Hooks: working, waiting on permission, subagents, cost/limits.
- Task reporting: `built`. Board/MCP self-report (native-board) and work capture; task text is self-reported, never read from transcripts.
- Receive message: `built`. Owned sessions only: our stream-json user line with our uuid; ack = command_lifecycle queued/started for that uuid in our --session-id.
- Reply: `built`. Owned: stream_event text_delta + result in our session id.
- Resume: `docs: not built`. `claude -p --resume <id>` continues a finished session in a NEW process; it is not inbound control of a live terminal session. The board runner (board/runner/backends/claude.js) uses it for managed runs.
- Steer busy turn: `none`. No expected-turn precondition: a message sent mid-turn is queued as the next turn.
- Interrupt: `built`. Owned: stream-json control_request {subtype:'interrupt'} with control_response.
- Remote control: `provider-only`. Remote Control (`claude --remote-control`) lets claude.ai/code and the Claude apps drive a local session; Pro/Max/Team/Enterprise login, not an API for other apps.
- Missing prerequisite / human handoff: None for owned sessions (Claude Code installed and signed in with its own login). Existing sessions: none possible.
- ToS: Plexiform runs the user's own CLI with its own login; it never reads, copies or proxies Claude credentials. Remote Control is Anthropic's own surface and is not used.
- Shown on a session Plexiform did not start: "Claude Code terminal sessions have no supported inbound message channel; only sessions Plexiform starts with claude -p stream-json can be driven."
- Evidence: <https://code.claude.com/docs/en/headless>; <https://code.claude.com/docs/en/hooks>; <https://code.claude.com/docs/en/remote-control>; local: `claude --help` 2.1.287 (--input-format, --replay-user-messages, --remote-control); test: test/owned-adapters.test.js (fake stream-json fixture); real run notes plexiform-codex-claude-notes/session-interaction

### Codex

- Ids/aliases: `codex`, `Codex CLI`, `Codex Cloud`
- Installed here: codex-cli 0.159.2 (/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex). Advertised by Plexiform: yes.
- Exact supported channel: Owned: app-server JSON-RPC thread/start, turn/start, turn/steer, turn/interrupt (src/codex-app-server.js). Existing: hooks (adapters/codex.js).
- Discovery: `built`. Codex hooks + lifecycle (adapters/codex.js); app-server thread/list and thread/loaded/list exist but only on the server you connect to.
- Telemetry/hooks: `built`. Hooks: activity, waiting, completed turns, subagents (observation only).
- Task reporting: `built`. Self-report (src/agent-self-report.js, labelled self-reported) and board capture.
- Receive message: `built`. Owned threads only: turn/start returns the server turn id; echo = clientUserMessageId in the turn's input.
- Reply: `built`. item/agentMessage/delta and turn/completed for our thread.
- Resume: `docs: not built`. thread/resume reopens a stored thread on the server you started; desktop-app threads live on that app's private app-server.
- Steer busy turn: `built`. turn/steer with expectedTurnId: Codex itself refuses if it is not the active turn.
- Interrupt: `built`. turn/interrupt.
- Remote control: `built`. Opt-in (Preferences): Codex CLI sessions the human runs on `codex app-server daemon` are listed and messaged over its local control socket (src/codex-daemon.js); Plexiform never starts the daemon, steers or interrupts only its own turns and never answers approvals. `codex app-server proxy` is not used. Codex Cloud: `codex cloud exec|status|list|apply|diff` submit/inspect tasks; no follow-up into an existing cloud task.
- Missing prerequisite / human handoff: None for owned threads (Codex installed and signed in, its login stays in CODEX_HOME). Existing desktop-app threads: a provider-published socket; the private ~/.codex/ipc socket is refused. CLI sessions: the human runs them on the app-server daemon and turns on daemon messaging in Preferences (built, src/codex-daemon.js).
- ToS: Uses the user's own Codex install and login via the documented app-server; no ChatGPT/Codex app automation, private sockets or chat scraping.
- Shown on a session Plexiform did not start: "Plexiform can message sessions it starts itself. This one was started in Codex, which has no supported way for another app to send to it."
- Evidence: <https://learn.chatgpt.com/docs/app-server>; <https://learn.chatgpt.com/docs/hooks>; local: `codex app-server --help` (daemon, proxy, generate-json-schema) and `codex cloud --help` (exec/status/list/apply/diff), codex-cli 0.159.2; test: test/session-interaction.test.js; real run notes plexiform-codex-claude-notes/session-interaction/real-run-final.log; test: test/codex-daemon.test.js (fake daemon fixture); board/CODEX-DAEMON.md

### Cursor

- Ids/aliases: `cursor`, `Cursor CLI`, `cursor-agent`, `Cursor Cloud Agents`
- Installed here: no. Advertised by Plexiform: yes.
- Exact supported channel: Existing: ~/.cursor/hooks.json (adapters/cursor.js). Owned: ACP over stdio via the shared ACP client (src/acp-agents.js).
- Discovery: `built`. Hooks beforeSubmitPrompt/beforeShellExecution/beforeMCPExecution/afterFileEdit/stop carry conversation_id.
- Telemetry/hooks: `built`. Same hooks; Plexiform replies allow and never gates.
- Task reporting: `built`. Board capture/self-report via MCP; no transcript reading (transcript_path is ignored).
- Receive message: `wired, unverified`. Owned: ACP session/prompt; ack = first content session/update for our session. Code path shared with Gemini and tested on a fake ACP agent; never run against Cursor.
- Reply: `wired, unverified`. Owned: ACP agent_message_chunk + session/prompt stopReason.
- Resume: `docs: not built`. ACP session/load is documented; Cloud Agents API POST /v1/agents/{id}/runs sends a follow-up to an existing cloud agent (needs a Cursor API key).
- Steer busy turn: `none`. ACP has no steer; prompts are sequential.
- Interrupt: `wired, unverified`. Owned: ACP session/cancel. Cloud: POST /v1/agents/{id}/runs/{runId}/cancel.
- Remote control: `docs: not built`. Cloud Agents API (Basic/Bearer API key) for Cursor-hosted agents only; no API into existing IDE chats.
- Missing prerequisite / human handoff: Human: install Cursor CLI (`agent`) and sign in (`agent login` or CURSOR_API_KEY in its own environment), then verify on that install that an owned ACP session can be held to ask/plan mode with no user MCP (.cursor/mcp.json is loaded in ACP mode) before Plexiform enables it. Cloud Agents: a Cursor API key Plexiform would have to hold; not done (Plexiform never stores provider logins).
- ToS: Uses only documented CLI/ACP/hooks/Cloud Agents API. No IDE automation or chat scraping.
- Shown when Plexiform cannot start one: "unavailable: Cursor CLI is installed but Plexiform has not verified on a real install that it can keep your Cursor MCP servers (.cursor/mcp.json) and agent mode out of an owned ACP session; this stays off until that is checked"
- Shown on a session Plexiform did not start: "Cursor editor and CLI chats have no supported inbound channel for other apps; Cursor's stop hook can only queue a follow-up when a turn ends and Plexiform does not use it."
- Evidence: <https://cursor.com/docs/hooks>; <https://cursor.com/docs/cli/acp>; <https://cursor.com/docs/cli/headless>; <https://cursor.com/docs/cli/reference/output-format>; <https://cursor.com/docs/background-agent/api/overview>; test: test/provider-capabilities.test.js (ACP client on fake agent as cursor)

### Gemini CLI

- Ids/aliases: `gemini`, `Gemini`
- Installed here: no. Advertised by Plexiform: yes.
- Exact supported channel: Existing: hooks in ~/.gemini/settings.json (adapters/gemini.js). Owned: ACP (src/gemini-acp.js).
- Discovery: `built`. Hooks SessionStart/SessionEnd/BeforeTool/AfterTool/AfterAgent (best effort; Gemini not installed here).
- Telemetry/hooks: `built`. Same hooks.
- Task reporting: `built`. Board capture/self-report; no transcript reading.
- Receive message: `wired, unverified`. Owned: ACP session/prompt, ack = first content session/update for our session (fake ACP fixture only).
- Reply: `wired, unverified`. ACP agent_message_chunk.
- Resume: `docs: not built`. ACP loadSession documented.
- Steer busy turn: `none`. ACP has no steer.
- Interrupt: `wired, unverified`. ACP session/cancel (fake fixture).
- Remote control: `none`. No documented remote/inbound API for existing sessions.
- Missing prerequisite / human handoff: Human: install Gemini CLI and sign in, then verify Plexiform can keep user settings (MCP servers, extensions, hooks, approval mode) out of an owned ACP session.
- ToS: Uses the user's own Gemini CLI and login over its documented ACP mode.
- Shown when Plexiform cannot start one: "unavailable: Gemini CLI is installed but Plexiform cannot yet isolate it from your own Gemini settings (MCP servers, extensions, hooks, approval mode); this stays off until that is verified on a real install"
- Shown on a session Plexiform did not start: "Gemini CLI sessions started outside Plexiform expose no inbound channel; ACP sessions exist only on the agent process that created them."
- Evidence: <https://geminicli.com/docs/cli/acp-mode/>; <https://geminicli.com/docs/hooks/>; <https://agentclientprotocol.com/protocol/prompt-turn>; test: test/owned-adapters.test.js (fake ACP fixture)

### Hermes Agent

- Ids/aliases: `hermes`, `Hermes`, `hermes-dgx`
- Board runner ("Tackle with AI"): `hermes` (the member's own Hermes provider) and `hermes-dgx` (the same CLI against the first loopback/LAN/tailnet OpenAI-compatible endpoint in local-models.json) run `hermes chat --format stream-json --oneshot` one turn per process. Hermes has no OS sandbox, so the hub offers it only on the dispatcher's own machine and plan-approval runs are refused. Wired and fixture-tested only; a real Hermes or DGX turn has not completed under the runner.
- Installed here: 0.21.3 (git install, ~/.hermes/hermes-agent). Advertised by Plexiform: yes.
- Exact supported channel: Owned: ACP over stdio (`hermes acp`). Existing: none (Hermes gateway/peer/kanban are Hermes's own messaging surfaces).
- Discovery: `built`. Only via Plexiform's local /signal endpoint or emit.js with source hermes (board presence/work-capture accept 'hermes'); Plexiform installs no Hermes hooks.
- Telemetry/hooks: `docs: not built`. Hermes has shell-script hooks (`hermes hooks`); Plexiform does not install them.
- Task reporting: `built`. Self-reported via the signal endpoint / board MCP only.
- Receive message: `wired, unverified`. Owned ACP initialize + session/new succeeded on the real install; the one real prompt was not acknowledged within 120 s (see realRuns.hermes). Not offered: see reasons.owned.
- Reply: `wired, unverified`. ACP agent_message_chunk; no reply observed in the one real call.
- Resume: `docs: not built`. Hermes ACP implements load_session/resume_session/list_sessions (acp_adapter/server.py).
- Steer busy turn: `wired, unverified`. A prompt while a turn runs is queued for the next turn; a prompt starting `/steer` is injected into the running turn (acp_adapter/server.py). No ack tied to our message; not used.
- Interrupt: `wired, unverified`. ACP session/cancel.
- Remote control: `none`. Hermes gateway/peer are Hermes-to-platform bridges, not an API into a running session for other apps.
- Missing prerequisite / human handoff: Hermes would need an ACP option to restrict the session toolset (today ACP sessions always get the hermes-acp toolset: terminal, process, file write/patch, execute_code, delegate_task, web/browser, memory, skills) or Plexiform would need an isolated Hermes profile with those tools disabled, verified by a human.
- ToS: User's own local agent and config; no credentials read. Hermes stores ACP sessions in its own state DB.
- Shown when Plexiform cannot start one: "unavailable: Hermes ACP sessions always run Hermes's own tools (terminal, file writes, code execution, web, delegate) with your Hermes config and memory, and ACP gives Plexiform no way to switch them off, so Plexiform does not start one"
- Shown on a session Plexiform did not start: "Hermes sessions started outside Plexiform have no supported inbound channel for other apps."
- Evidence: local: ~/.hermes/hermes-agent/website/docs/user-guide/features/acp.md (v0.21.3); local: `hermes acp --check` -> 'Hermes ACP check OK'; `hermes --help`; local: ~/.hermes/hermes-agent/acp_adapter/session.py (_expand_acp_enabled_toolsets: always hermes-acp); real: see realRuns.hermes

### OpenCode

- Ids/aliases: `opencode`
- Installed here: no. Advertised by Plexiform: yes.
- Exact supported channel: Owned: ACP (`opencode acp`). Also documented: `opencode serve` HTTP API (POST /session, /session/:id/message with client messageID, /session/:id/abort, GET /event SSE).
- Discovery: `docs: not built`. GET /session on an `opencode serve` server; the TUI runs a server on a random port.
- Telemetry/hooks: `docs: not built`. GET /event SSE (session.status, message.updated, message.part.updated); plugins.
- Task reporting: `built`. Only via Plexiform's signal endpoint / board MCP self-report.
- Receive message: `wired, unverified`. Owned ACP session/prompt (shared ACP client, fake fixture only). HTTP alternative carries a client messageID (stronger ack); not built.
- Reply: `wired, unverified`. ACP agent_message_chunk.
- Resume: `docs: not built`. `opencode run --session <id>` / server session APIs.
- Steer busy turn: `none`. No documented steer.
- Interrupt: `wired, unverified`. ACP session/cancel; HTTP POST /session/:id/abort.
- Remote control: `docs: not built`. Documented server can drive a running TUI (/tui endpoint); requires the human to expose and share its port/password. Not built.
- Missing prerequisite / human handoff: Human: install OpenCode, configure its provider login, then verify an owned session can run with `permission: deny` for all tools before Plexiform enables it.
- ToS: Open-source CLI; user's own provider keys stay in OpenCode.
- Shown when Plexiform cannot start one: "unavailable: OpenCode is installed but Plexiform has not verified on a real install that an owned ACP session runs with every tool denied; this stays off until that is checked"
- Shown on a session Plexiform did not start: "OpenCode sessions started outside Plexiform are not connected; OpenCode's own server API would need you to share that server with Plexiform, which is not built."
- Evidence: <https://opencode.ai/docs/cli/>; <https://opencode.ai/docs/server/>; <https://opencode.ai/docs/sdk/>; <https://opencode.ai/docs/permissions/>

### Copilot CLI

- Ids/aliases: `copilot`, `Copilot`, `GitHub Copilot`
- Installed here: no. Advertised by Plexiform: yes.
- Exact supported channel: Owned: ACP server (public preview).
- Discovery: `none`. No documented session listing for other apps; Plexiform installs no Copilot hooks.
- Telemetry/hooks: `docs: not built`. Copilot CLI hooks run shell commands at session points; not installed by Plexiform.
- Task reporting: `built`. Only via Plexiform's signal endpoint / board MCP self-report.
- Receive message: `wired, unverified`. Owned ACP session/prompt (fake fixture only).
- Reply: `wired, unverified`. ACP agent_message_chunk.
- Resume: `none`. /resume is not handled over ACP (docs).
- Steer busy turn: `none`. ACP has no steer.
- Interrupt: `wired, unverified`. ACP session/cancel.
- Remote control: `none`. ACP TCP mode (--port) serves new sessions only.
- Missing prerequisite / human handoff: Human: install Copilot CLI and sign in to GitHub (or configure BYOK), then verify `--available-tools`/`--excluded-tools` keep an owned ACP session tool-free before Plexiform enables it.
- ToS: Public preview; user's own GitHub Copilot entitlement.
- Shown when Plexiform cannot start one: "unavailable: Copilot CLI is installed but its ACP server is a public preview and Plexiform has not verified on a real install that an owned session runs with no tools; this stays off until that is checked"
- Shown on a session Plexiform did not start: "Copilot CLI sessions started outside Plexiform have no supported inbound channel for other apps."
- Evidence: <https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server>; <https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli>; <https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/>

### Ollama

- Ids/aliases: `ollama`
- Installed here: no. Advertised by Plexiform: yes.
- Exact supported channel: POST /api/chat NDJSON stream; GET /api/tags discovery (src/local-models.js).
- Discovery: `built`. Read-only GET /api/tags on fixed loopback port 11434, plus configured endpoints.
- Telemetry/hooks: `n/a`. Stateless server; Plexiform owns the conversation.
- Task reporting: `n/a`. Plexiform owns the conversation.
- Receive message: `built`. HTTP 200 stream for our request = ack (ack: http-stream).
- Reply: `built`. message.content chunks until done:true.
- Resume: `built`. Plexiform replays bounded history each turn (API is stateless).
- Steer busy turn: `none`. One request per turn.
- Interrupt: `built`. Abort the HTTP request.
- Remote control: `n/a`. Network policy: loopback/RFC1918/tailnet only unless allowPublic.
- Missing prerequisite / human handoff: Human: install Ollama and pull a model. Not installed on this Mac (port 11434 closed).
- ToS: Local software; no account.
- Shown on a session Plexiform did not start: "Ollama has no server-side conversations; Plexiform can only hold its own."
- Evidence: <https://docs.ollama.com/api/chat>; test: test/local-models.test.js (fake Ollama NDJSON)

### LM Studio

- Ids/aliases: `lmstudio`
- Installed here: no. Advertised by Plexiform: yes.
- Exact supported channel: GET /v1/models, POST /v1/chat/completions stream (src/local-models.js).
- Discovery: `built`. Read-only GET /v1/models on loopback port 1234.
- Telemetry/hooks: `n/a`. Stateless.
- Task reporting: `n/a`. Plexiform owns the conversation.
- Receive message: `built`. HTTP 200 SSE stream for our request.
- Reply: `built`. choices[0].delta.content until [DONE].
- Resume: `built`. Bounded history replay.
- Steer busy turn: `none`. One request per turn.
- Interrupt: `built`. Abort the HTTP request.
- Remote control: `n/a`. Same network policy as Ollama.
- Missing prerequisite / human handoff: Human: install LM Studio, load a model, start its server. Not installed on this Mac (port 1234 closed).
- ToS: Local software.
- Shown on a session Plexiform did not start: "LM Studio's server has no conversations to join; Plexiform can only hold its own."
- Evidence: <https://lmstudio.ai/docs/developer/openai-compat>; test: test/local-models.test.js (fake OpenAI SSE)

### OpenAI-compatible local server

- Ids/aliases: `openai-compatible`, `local`, `Local model`, `Local AI`, `local-8000`, `local-8888`, `llama.cpp`, `vLLM`, `litellm`, `OpenAI-compatible`, `OpenAI-compatible :8000`, `OpenAI-compatible :8888`
- Installed here: none on this Mac; tailnet vLLM at 100.68.66.98:8888 (GLM-5.3-Flash-EXL3) reachable. Advertised by Plexiform: yes.
- Exact supported channel: GET /v1/models, POST /v1/chat/completions stream; discovery on loopback 8000/8888 or local-models.json endpoints.
- Discovery: `built`. Read-only loopback probes on 8000/8888; tailnet/LAN only when configured in local-models.json.
- Telemetry/hooks: `n/a`. Stateless.
- Task reporting: `n/a`. Plexiform owns the conversation.
- Receive message: `built`. HTTP 200 SSE stream for our request (real run: see realRuns.localModels).
- Reply: `built`. SSE deltas, or one JSON completion when the server ignores stream.
- Resume: `built`. Bounded history replay.
- Steer busy turn: `none`. One request per turn.
- Interrupt: `built`. Abort the HTTP request.
- Remote control: `n/a`. Public hosts refused unless allowPublic is set per endpoint.
- Missing prerequisite / human handoff: Human: run a server, or add a tailnet/LAN endpoint to local-models.json (an API key only by env var name). The DGX litellm proxy (:4000) answered HTTP 500 on /v1/models on 2026-10-02.
- ToS: User-operated servers; keys never stored by Plexiform.
- Shown on a session Plexiform did not start: "OpenAI-compatible servers have no conversations to join; Plexiform can only hold its own."
- Evidence: <https://docs.vllm.ai/en/stable/serving/openai_compatible_server.html>; <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md>; <https://docs.litellm.ai/docs/simple_proxy>; real: see realRuns.localModels

### Claude apps (remote MCP connector)

- Ids/aliases: `claude-apps`, `Claude Desktop`, `Claude web`, `claude.ai`
- Installed here: Claude.app present. Advertised by Plexiform: yes.
- Exact supported channel: Outgoing only: Streamable HTTP MCP at https://<hub>/api/mcp with OAuth+PKCE grant (read: list/read boards, cards, messages, work context; collaboration: create card, change task text, comment, write packet, send task message).
- Discovery: `none`. Plexiform sees only the MCP grant and the tool calls it makes, not chats.
- Telemetry/hooks: `none`. No lifecycle events from Claude apps.
- Task reporting: `built`. Remote MCP collaboration tools (explicit, grant-scoped, per board).
- Receive message: `provider-only`. Only the human can prompt the chat; it can pull task messages with the list-messages tool when asked.
- Reply: `built`. Pull model: the chat's tool calls (comment/send task message) are its reply; correlation is by card/message reference.
- Resume: `provider-only`. Claude apps' own conversation history.
- Steer busy turn: `none`. -
- Interrupt: `none`. -
- Remote control: `provider-only`. Claude's own apps and Remote Control for Claude Code.
- Missing prerequisite / human handoff: A deployed HTTPS hub with accounts, a custom connector added by the user (or org owner on Team/Enterprise) and a personal board grant; cloud connector acceptance is a separate human gate (docs/remote-mcp.md).
- ToS: Uses Anthropic's documented custom-connector path with the user's own consent; no chat scraping.
- Shown when Plexiform cannot start one: "unavailable: Claude web and desktop chats cannot be started or messaged by another app; they can only call Plexiform's board tools through a connector you add"
- Shown on a session Plexiform did not start: "Claude web and desktop chats have no inbound channel for other apps; they can read task messages through the Plexiform connector when you ask them to."
- Evidence: docs/remote-mcp.md; <https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors>; <https://code.claude.com/docs/en/remote-control>

### ChatGPT

- Ids/aliases: `chatgpt`, `ChatGPT desktop`
- Installed here: ChatGPT.app present. Advertised by Plexiform: yes.
- Exact supported channel: Inbound to Plexiform only: POST 127.0.0.1:47172/signal with the per-install token.
- Discovery: `none`. No documented API exposes ChatGPT app conversations to other apps.
- Telemetry/hooks: `built`. Only what the user's own script posts to /signal.
- Task reporting: `built`. Same, self-reported.
- Receive message: `none`. No documented inbound API into ChatGPT conversations; app automation is refused by policy.
- Reply: `none`. -
- Resume: `none`. -
- Steer busy turn: `none`. -
- Interrupt: `none`. -
- Remote control: `provider-only`. ChatGPT's own apps.
- Missing prerequisite / human handoff: A provider-published API for ChatGPT conversations. Codex inside ChatGPT.app is covered by the codex entry.
- ToS: No scraping or UI automation of ChatGPT.
- Shown when Plexiform cannot start one: "unavailable: ChatGPT has no supported way for another app to start or message a conversation"
- Shown on a session Plexiform did not start: "ChatGPT conversations have no supported inbound channel for other apps."
- Evidence: README.md (local signal endpoint); <https://learn.chatgpt.com/docs/app-server (Codex only; no ChatGPT chat API)>

### Windsurf

- Ids/aliases: `windsurf`, `Devin Desktop`, `Cascade`
- Installed here: no. Advertised by Plexiform: yes.
- Exact supported channel: None for AI. Cascade hooks exist (pre_user_prompt, post_cascade_response, ...) but Plexiform installs none.
- Discovery: `docs: not built`. Cascade hooks could report activity; not installed by Plexiform.
- Telemetry/hooks: `docs: not built`. Same.
- Task reporting: `built`. Only via Plexiform's signal endpoint.
- Receive message: `none`. Docs: hooks can block (exit 2) but cannot inject messages; no API/CLI into Cascade conversations.
- Reply: `none`. -
- Resume: `none`. -
- Steer busy turn: `none`. -
- Interrupt: `none`. -
- Remote control: `none`. -
- Missing prerequisite / human handoff: A Windsurf-published inbound API. Activity hooks would need a new adapter (not built).
- ToS: No IDE automation.
- Shown when Plexiform cannot start one: "unavailable: Windsurf has no supported way for another app to start or message a Cascade conversation"
- Shown on a session Plexiform did not start: "Windsurf Cascade conversations have no supported inbound channel for other apps."
- Evidence: <https://docs.devin.ai/desktop/cascade/hooks>

### Aider

- Ids/aliases: `aider`
- Installed here: 0.86.2. Advertised by Plexiform: no (recorded because it is installed here).
- Exact supported channel: None suitable: `aider --message` runs one message and exits (plain text); the Python API is explicitly unsupported.
- Discovery: `built`. Only via Plexiform's signal endpoint (`emit.js --source aider`).
- Telemetry/hooks: `built`. Same, self-posted.
- Task reporting: `built`. Same.
- Receive message: `none`. No streaming/structured or server channel; --message gives no ack and no session id.
- Reply: `none`. -
- Resume: `none`. -
- Steer busy turn: `none`. -
- Interrupt: `none`. -
- Remote control: `none`. -
- Missing prerequisite / human handoff: A documented structured (JSON/ACP) channel from Aider.
- ToS: -
- Shown when Plexiform cannot start one: "unavailable: Aider has no supported structured channel (only one-shot --message text and an unsupported Python API)"
- Shown on a session Plexiform did not start: "Aider sessions have no supported inbound channel for other apps."
- Evidence: <https://aider.chat/docs/scripting.html>; local: aider 0.86.2

### Custom agent (local signal endpoint)

- Ids/aliases: `custom`, `Custom`
- Installed here: no. Advertised by Plexiform: yes.
- Exact supported channel: Inbound to Plexiform only: POST 127.0.0.1:47172/signal with the per-install token, or `node hooks/emit.js <signal> --source <name>` (README).
- Discovery: `built`. Sessions appear when the program posts signals with a session id.
- Telemetry/hooks: `built`. Signals: prompt-submit, tool-use, tool-done, tool-failed, stop, permission-ask, limit-hit, idle-nudge, session-start/end, subagent-start/done.
- Task reporting: `built`. Self-reported only (board MCP / signals).
- Receive message: `none`. The endpoint is one-way; Plexiform has no channel back into an arbitrary program.
- Reply: `none`. -
- Resume: `none`. -
- Steer busy turn: `none`. -
- Interrupt: `none`. -
- Remote control: `none`. -
- Missing prerequisite / human handoff: An adapter for that specific program's documented control channel (add a row here first).
- ToS: User-owned programs.
- Shown when Plexiform cannot start one: "unavailable: Plexiform cannot start a custom agent; it only receives the activity that agent posts"
- Shown on a session Plexiform did not start: "This session only reports activity to Plexiform; the program that posts it has no channel for Plexiform to send back."
- Evidence: README.md (local signal endpoint, emit.js)

## Real runs

- **hermes**: 2026-10-02, one call, hermes 0.21.3 via src/gemini-acp.js (provider hermes, args ['acp'], verified forced on in a scratch script only) through createInteractionHub in an empty temp cwd: initialize (protocolVersion 1) and session/new OK -> session launched; session/prompt 'Reply with exactly the word PONG' got no content session/update and no prompt response within 120 s -> hub status 'unavailable', delivery 'refused', adapter sent session/cancel, child reaped (no process left). Hermes's configured model is the shared tailnet vLLM, which was saturated at the time (vllm:num_requests_running 4, waiting 1 for capacity). Not retried (one-call budget).
- **localModels**: 2026-10-02, one call, src/local-models.js against configured endpoint http://100.68.66.98:8888 (tailnet vLLM, GLM-5.3-Flash-EXL3): discovery listed the model (reachable); loopback discovery found nothing on this Mac (11434/1234/8000/8888 closed; :4000 is a non-model 'amass' listener). send -> 'acknowledged' in 23 ms (HTTP 200 stream) but no bytes for 60 s -> turn 'failed: The model stopped responding' (idleMs 60 s). Same saturated backend (4 running, 1 waiting). Send/ack path proven real; a streamed reply on a real endpoint is still unproven.

Owned Claude Code and Codex were real-run before this matrix (notes kept outside the repo). Every other owned ACP path here has only run against `test/fixtures/fake-gemini-acp.js`.
