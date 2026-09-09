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

## Lights — decide what the widget means

Right-click the widget (or tray → **Lights…**, ⌘L) to open the rules editor.
Every Claude Code event is a *signal*; a rule says which signal lights which
lamp, what colour the eyes go, which pose Claude strikes, and whether to beep
or throw confetti. The channels are independent and resolve top-down, so a
"Subagent running" rule can turn the eyes purple while "Claude is working"
still owns the green lamp. Rules can be scoped to one tool (`Agent`, `Bash`,
`mcp__*` …), reordered by drag, and previewed live on the real widget with
**Try on widget**. Two safety rules (permission asks, usage limits) are
locked above everything else so a stray rule can't hide a real block.

Poses: think, wave, thumbs, sleep, blink, nod, bounce, look, spin, party,
guitar, ak47 (tracer rounds stream across your whole screen from the widget —
click-through, closes the moment the state changes) and banner, which drops a
sign over the traffic light with your own text ("Banner says").

Presets: **Classic** (the original behaviour), **Minimal** (lamps only),
**Tool-aware** (eye colours per tool) — plus your own: type a name at the
bottom of the Presets menu to save the current rules, and pick or delete
them there later. Everything is stored in `~/.claude-traffic-light/config.json`
under `rules` and `presets`.

Signals you can build rules on: you send a prompt · Claude uses a tool · a
tool finishes · a tool fails · a subagent finishes · Claude finishes a task ·
Claude is waiting for you · Claude asks permission · usage limit hit · a
session starts · context compacts · working over 10 minutes · 3+ sessions at
once · no sessions running. Tool signals can be scoped to one tool name or a
prefix (`mcp__*`).

Resolution: rules apply top to bottom; the first rule that lights a lamp is
the state, and rules above it may layer accents (eyes, pose, sound) on top.
A rule below the lamp owner never leaks into the look.

## How multi-session monitoring works

Every Claude Code session writes its own status file to
`~/.claude-traffic-light/sessions/<host>-<session_id>.json` via hooks. The
hook only records the raw signal — what it *means* is decided by your rules
in the app, so changing a rule never touches the hooks:

- `UserPromptSubmit` → `prompt-submit`
- `PreToolUse` / `PostToolUse` / `PostToolUseFailure` → `tool-use` /
  `tool-done` / `tool-failed` (with the tool name)
- `SubagentStop` → `subagent-done`
- `Stop` → `stop`
- `Notification` → `permission-ask`, `limit-hit` or `idle-nudge`, sniffed
  from the message text
- `SessionStart` / `PreCompact` → `session-start` / `compact`
- `SessionEnd` → removes the file

The app aggregates all non-stale sessions through your rules. A working
session pings constantly, so it's dropped after 6 minutes of silence; a
waiting session (permission ask, limit) only ever gets one event, so it gets a
4-hour leash instead (both configurable — see Preferences).

### Syncing across machines

Set `CLAUDE_TRAFFIC_LIGHT_HOME` to the same synced folder path (iCloud
Drive, a Tailscale share, etc) in the environment on every machine — before
installing hooks there — and sessions from all of them merge into one
widget. Session filenames are hostname-prefixed so they can't collide.

## Manual control

Right-click the tray icon (top menu bar) for:
- **Lights…** — the rules editor (what each light, eye colour and pose means)
- **Preferences…** — staleness windows and the alert-sound toggle
- **Bigger** / **Smaller** — resize
- **Install/Reinstall Claude Code Hooks**
- **Override: Green/Amber/Red (5 min)** and **Clear override** — force a
  state for testing, or if a session dies without firing `SessionEnd`
- **Open at Login** toggle

## Dev mode

```bash
npm test                           # engine + hook script + installer tests
npx electron . --lights --playtest # drives the editor UI end to end
npm start                          # runs the widget straight from source
npx electron . --lights            # …and opens the Lights editor immediately
npx electron . --lights --shot out.png [--select <ruleId>] [--mode live]
                                   # captures the editor to a PNG and quits
```
