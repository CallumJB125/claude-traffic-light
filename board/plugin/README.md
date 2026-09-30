# team-board plugin

Packages the board MCP server (`../mcp/server.js`, server name `board`) as a Claude Code plugin. See `../CONTRACT.md` D34.

- Load it for one session: `claude --plugin-dir board/plugin`, or add this checkout as a local-directory marketplace. Both load the plugin in place, and the server uses `board/node_modules` (`npm install` in `board/` first).
- Outside a board run the server lists no tools: every board tool acts on the run's own card and needs the run's socket and token, which only the board runner has.
- A git or marketplace install copies only this folder into the plugin cache, so `../mcp` is not there. That distribution waits for the hub's remote MCP endpoint, when this `.mcp.json` becomes an `http` entry and no local code ships.
