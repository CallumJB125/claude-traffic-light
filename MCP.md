# Claude integration (MCP)

Plexiform ships an MCP server, `mcp-server.js`, so any Claude Code session can ask what the widget is showing and why. You don't need to read `~/.claude-traffic-light/sessions/*.json` or `app.log` by hand.

## Turning it on

**Settings → AI tools → Claude Code → Turn on Claude integration.** This writes one entry, `claude-buddy` (the server keeps its name from before the rename, so Claude's tool names stay the same), under the top-level `mcpServers` key of `~/.claude.json`. That is Claude Code's user scope, which every project sees ([docs](https://code.claude.com/docs/en/mcp)). Restart any open sessions afterwards. **Turn off** removes that one entry. Nothing else in the file is touched.

The packaged app registers itself like this:

```json
"claude-buddy": {
  "type": "stdio",
  "command": "/Applications/Plexiform.app/Contents/MacOS/Plexiform",
  "args": ["/Applications/Plexiform.app/Contents/Resources/app.asar/mcp-server.js"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" }
}
```

The app binary runs as plain Node here, because the SDK sits inside `app.asar`. No window opens. From a checkout, run it directly:

```sh
claude mcp add --scope user claude-buddy -- node /path/to/claude-traffic-light/mcp-server.js
```

## Tools

Every tool returns JSON.

| Tool | What it answers |
| --- | --- |
| `buddy_status` | The current look (lamp, pose, eyes, costume, effect, pet, cameo), the single global character (rules never change it), which rule owns each other channel, what fired, session and agent counts, current tool, online state, and whether the running app agrees |
| `buddy_sessions` | Every session file: raw and presented signal, cwd, tool, agents (kind, status, heartbeat), age, time until stale. Includes the files the widget is ignoring, with the reason |
| `buddy_why` | `query`: a rule id, a rule name or a channel. Says why that rule is or isn't firing (which `when` clause failed for each session, or which higher rule cut it off), or who owns the channel (`character` reports the one global character) |
| `buddy_rules` | The rules in priority order, with a compact when/then |
| `buddy_recent_transitions` | Parsed `[state]` lines from `app.log`, newest first (`limit`, `session`) |
| `buddy_model_mix` | Which models your turns ran on and what they cost (today, last 7 days), plus the read-only Opus→Sonnet recommendation line |
| `buddy_pending_requests` | Permission requests waiting on the widget's Allow/Deny |
| `buddy_burst_status` | Claude Burst's route (primary or secondary), secondary readiness, rate-limited models and when they return. Answers "Burst not present" when Burst isn't running |
| `buddy_burst_coordination` | Which session masters which file (`path`: a file path or its tail; omit for all). "Burst not present" without Burst |
| `buddy_burst_requests` | The last requests Burst routed, metadata only (`session`, `limit` up to 50) |

### Agent bus tools

`bus_hello`, `bus_handoff`, `bus_wait`, `bus_read` and `bus_status` reach the running app's local `/bus` endpoint (the same token as the team tools) and hand work between AI tools on this Mac (contract: `board/AGENT-BUS.md`). `bus_handoff` is the one that acts: in a repository on the bus it starts the other tool at once, with no approval, in its own git worktree with no network (it cannot push or open a pull request), stopped after the wall clock (20 min by default). The text is scrubbed of secrets and your home folder before it leaves the app. `bus_wait` waits up to 120 seconds for the result. Refusals come back as `{reason}` (`HALTED`, `SPEND_CAP`, `LOOP`, `RATE`, `TIER_NOT_ACCEPTED`, `NO_ELIGIBLE_AGENT`, `NO_LOCAL_CHECKOUT`). Which repositories are on the bus is set in Preferences → Advanced → Agent bus: automatic by default (any git checkout a Claude Code or Codex session on this Mac works in; never the home folder, hidden folders in it such as `~/.claude` or `~/.codex`, or `~/Library`), an optional "only these" list that restricts it, and a "never these" list that always wins. `bus_hello`'s `policy_summary.repo_enabled` says whether your folder's repository is on. A result's `from` names the AI that did the work (`codex` or `claude`) and its text says it came from that AI running in Plexiform. Tell results apart from your own messages by `from.tier`: `run_capability` means a run Plexiform started; `from.provider` can be your own tool's name. Runs the bus starts get `bus_result` and their own `bus_handoff` on their per-run task server instead.

The three Burst tools read a snapshot the running app writes (`burst-snapshot.json`, mode 0600, whitelisted fields, no prompts or paths). The server never contacts Burst; a missing snapshot or one older than two minutes means "Burst not present".

Every tool except `team_ask`, `team_hand_off`, `hand_off_to_tool` and `bus_handoff` is read-only. There is deliberately no tool that answers a permission request: a session that is waiting on a prompt can't call tools, so such a tool could only ever approve *another* session's tool call, and the server can't tell which session is calling it. Answer at the widget (or, later, from a paired phone).

The server works out the look from disk with the same `rules.js` the widget uses. Some things only the running app knows: a Lights preview, the walk to your terminal, and Electron's online flag. For those, `buddy_status` also asks the app's local `GET /status` endpoint and reports `app.agrees`.

## Example

> Use buddy_why to explain why my widget shows a green lamp while Claude is asking me something.

> What does buddy_status say, and does the app agree?
