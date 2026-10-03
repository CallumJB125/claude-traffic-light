# Claude integration (MCP)

Plexiform ships an MCP server, `mcp-server.js`, so any Claude Code session can ask what the widget is showing and why. You don't need to read `~/.claude-traffic-light/sessions/*.json` or `app.log` by hand.

## Turning it on

**Preferences → Claude integration → Enable Claude integration.** This writes one entry, `claude-buddy` (the server keeps its name from before the rename, so Claude's tool names stay the same), under the top-level `mcpServers` key of `~/.claude.json`. That is Claude Code's user scope, which every project sees ([docs](https://code.claude.com/docs/en/mcp)). Restart any open sessions afterwards. **Disable** removes that one entry. Nothing else in the file is touched.

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

Every tool is read-only. There is deliberately no tool that answers a permission request: a session that is waiting on a prompt can't call tools, so such a tool could only ever approve *another* session's tool call, and the server can't tell which session is calling it. Answer at the widget (or, later, from a paired phone).

The server works out the look from disk with the same `rules.js` the widget uses. Some things only the running app knows: a Lights preview, the walk to your terminal, and Electron's online flag. For those, `buddy_status` also asks the app's local `GET /status` endpoint and reports `app.agrees`.

## Example

> Use buddy_why to explain why my widget shows a green lamp while Claude is asking me something.

> What does buddy_status say, and does the app agree?
