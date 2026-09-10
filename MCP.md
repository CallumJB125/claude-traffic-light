# Claude integration (MCP)

Claude Buddy ships an MCP server, `mcp-server.js`, so any Claude Code session can ask what the widget is showing and why. You don't need to read `~/.claude-traffic-light/sessions/*.json` or `app.log` by hand.

## Turning it on

**Preferences → Claude integration → Enable Claude integration.** This writes one entry, `claude-buddy`, under the top-level `mcpServers` key of `~/.claude.json`. That is Claude Code's user scope, which every project sees ([docs](https://code.claude.com/docs/en/mcp)). Restart any open sessions afterwards. **Disable** removes that one entry. Nothing else in the file is touched.

The packaged app registers itself like this:

```json
"claude-buddy": {
  "type": "stdio",
  "command": "/Applications/Claude Buddy.app/Contents/MacOS/Claude Buddy",
  "args": ["/Applications/Claude Buddy.app/Contents/Resources/app.asar/mcp-server.js"],
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
| `buddy_status` | The current look (lamp, pose, eyes, costume, effect, pet, cameo), which rule owns each channel, what fired, session and agent counts, current tool, online state, and whether the running app agrees |
| `buddy_sessions` | Every session file: raw and presented signal, cwd, tool, agents (kind, status, heartbeat), age, time until stale. Includes the files the widget is ignoring, with the reason |
| `buddy_why` | `query`: a rule id, a rule name or a channel. Says why that rule is or isn't firing (which `when` clause failed for each session, or which higher rule cut it off), or who owns the channel |
| `buddy_rules` | The rules in priority order, with a compact when/then |
| `buddy_recent_transitions` | Parsed `[state]` lines from `app.log`, newest first (`limit`, `session`) |
| `buddy_savings` | Routing and context-diet savings, plus the routing review with escalation cost once routing is on |
| `buddy_router_status` | Router on/off, policy, per-project overrides, launcher and delegation state, recent decisions |
| `buddy_pending_requests` | Permission requests waiting on the widget's Allow/Deny |
| `buddy_answer_request` | Answers one of those requests (`id`, `allow`/`deny`) by writing the same file the widget's buttons write |

The server works out the look from disk with the same `rules.js` the widget uses. Some things only the running app knows: a Lights preview, the walk to your terminal, and Electron's online flag. For those, `buddy_status` also asks the app's local `GET /status` endpoint and reports `app.agrees`.

## Example

> Use buddy_why to explain why my widget shows a green lamp while Claude is asking me something.

> What does buddy_status say, and does the app agree?
