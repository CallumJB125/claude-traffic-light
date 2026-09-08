# Claude Traffic Light

A tiny, cute traffic-light widget that floats on top of every app on your Mac
and shows what Claude Code is doing:

- 🟢 **Green** — Claude is thinking / working
- 🟡 **Amber** — Claude is waiting on your input
- 🔴 **Red** — you're out of tokens / hit a usage limit

Click the widget to jump to [claude.ai](https://claude.ai). Drag it anywhere,
resize it by dragging its edge — it remembers where you left it.

## Install

```bash
npm install
npm run install-hooks   # wires the widget into Claude Code's hooks
npm start                # launch the floating widget
```

`npm run install-hooks` adds a few entries to `~/.claude/settings.json`
(`UserPromptSubmit`, `PreToolUse`, `Notification`, `Stop`) that call
`hooks/set-status.js` to update `~/.claude-traffic-light/status.json`
whenever your Claude Code session changes state. It only appends new hook
entries — it won't touch anything else already in your settings file.

Restart any running Claude Code sessions after installing the hooks.

## Manual control

Right-click the tray icon (top menu bar) for "Set state" options if you want
to override the light by hand, or just edit
`~/.claude-traffic-light/status.json` directly — the widget picks up changes
within a few seconds:

```json
{ "state": "red", "updatedAt": "...", "reason": "manual" }
```

## Packaging as a standalone app

This repo runs via `npm start` for development. To ship a double-clickable
`.app`, add [electron-builder](https://www.electron.build/) and run its
`build` command — not included here to keep the project dependency-light.
