# Claude Traffic Light

A tiny, cute traffic-light widget that floats on top of every app on your Mac
and shows what Claude Code is doing **across every live session at once**:

- 🟢 **Green** — at least one session is working
- 🟡 **Amber** — everything's idle, waiting on your input
- 🔴 **Red** — a session hit a usage/rate limit (any red wins, so you never miss it)

Click the widget to jump to [claude.ai](https://claude.ai). Drag it anywhere,
resize it by dragging its edge — it remembers where you left it.

## Install (double-clickable app)

```bash
npm install
npm run dist        # builds dist/mac-arm64/Claude Traffic Light.app
```

Copy `dist/mac-arm64/Claude Traffic Light.app` to `/Applications` and double
click it. It's unsigned (no Apple Developer ID), so the first launch needs
right-click → Open once to bypass Gatekeeper.

On first launch the app automatically registers its Claude Code hooks in
`~/.claude/settings.json` (only appends — never touches anything else
already there). If you move the `.app` afterwards, use the tray menu's
**Reinstall Claude Code Hooks**, since the hook commands point at the
`.app`'s path at install time.

Restart any Claude Code sessions that were already running so they pick up
the new hooks.

## How multi-session monitoring works

Every Claude Code session writes its own status file to
`~/.claude-traffic-light/sessions/<session_id>.json` via hooks
(`UserPromptSubmit`, `PreToolUse` → green; `Notification`, `Stop` → amber;
`SessionEnd` removes the file). The app watches that whole directory and
aggregates all sessions less than 15 minutes stale — red beats green beats
amber, so one session running out of tokens always lights up red even if
three others are still working fine.

## Manual control

Right-click the tray icon (top menu bar) to install/reinstall the hooks, or
to force an override state for 5 minutes (handy for testing, or if a session
dies without firing its `SessionEnd` hook).

## Dev mode

```bash
npm start   # runs the widget straight from source, no packaging
```
