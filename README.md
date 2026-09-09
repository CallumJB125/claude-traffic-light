# Claude Traffic Light

A tiny pixel-Claude widget that floats on top of every app on your Mac and
holds up a traffic-light sign showing what Claude Code is doing **across
every live session at once**:

- 🟢 **Green** — at least one session is working
- 🟡 **Amber** — something's genuinely waiting on you (a permission prompt,
  not just "finished and idle") — Claude swings the sign overhead-to-side
- 🔴 **Red** — a session hit a usage/rate limit — Claude falls asleep, and
  gets visibly grumpy if it drags on past a few minutes
- Between tasks, when nothing's working or waiting, a session that just
  finished shows **eyes-green + thumbs up** with a little confetti burst

Click the widget to jump to whichever session needs you — it copies that
session's folder to your clipboard and brings the terminal app forward (and,
best-effort, the exact window if its title happens to mention the folder).
With more than one session waiting, each click cycles to the next. Drag it
anywhere, resize by dragging its edge or scrolling on it, or use the tray
menu's Bigger/Smaller.

## Install (double-clickable app)

```bash
npm install
npm run dist        # builds dist/mac-arm64/Claude Traffic Light.app
```

Copy `dist/mac-arm64/Claude Traffic Light.app` to `/Applications` and double
click it. It's unsigned (no Apple Developer ID), so the first launch needs
right-click → Open once to bypass Gatekeeper.

On first launch the app:
- registers its Claude Code hooks in `~/.claude/settings.json` (only
  appends/migrates its own entries — never touches anything else already
  there), and re-checks every 10 minutes in case something wipes them out
- turns on **Open at Login** (a one-time default — turning it off again in
  the tray menu sticks)

If you move the `.app` afterwards, use the tray menu's **Reinstall Claude
Code Hooks**, since the hook commands point at the `.app`'s path at install
time.

Restart any Claude Code sessions that were already running so they pick up
the new hooks.

## How multi-session monitoring works

Every Claude Code session writes its own status file to
`~/.claude-traffic-light/sessions/<host>-<session_id>.json` via hooks:

- `UserPromptSubmit` / `PreToolUse` → green (working)
- `Notification` → amber, but **only** when the message text looks like a
  real permission/approval request. Claude Code also fires `Notification`
  for a routine "still waiting on you" idle nudge after a task finishes
  normally — that's not treated as needing input.
- `Stop` → a distinct "done" state (green eyes + thumbs up), not amber
- `SessionEnd` → removes the file

The app aggregates all non-stale sessions: **red > amber > green > done**.
A working session pings constantly, so it's dropped after 6 minutes of
silence (assumed closed); a waiting session only ever gets one event, so it
gets a 4-hour leash instead (both configurable — see Preferences below).

### Syncing across machines

Set `CLAUDE_TRAFFIC_LIGHT_HOME` to the same synced folder path (iCloud
Drive, a Tailscale share, etc) in the environment on every machine — before
installing hooks there — and sessions from all of them merge into one
widget. Session filenames are hostname-prefixed so they can't collide.

## Manual control

Right-click the tray icon (top menu bar) for:
- **Preferences…** — staleness windows and the alert-sound toggle
- **Bigger** / **Smaller** — resize
- **Install/Reinstall Claude Code Hooks**
- **Override: Green/Amber/Red (5 min)** and **Clear override** — force a
  state for testing, or if a session dies without firing `SessionEnd`
- **Open at Login** toggle

## Dev mode

```bash
npm start   # runs the widget straight from source, no packaging
```
