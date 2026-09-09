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

Poses: think, run, wave, thumbs, sleep, blink, nod, bounce, look, spin, party,
tap, arms (crossed), bubble (a speech bubble with your text),
guitar, ak47, sniper, kickflip (a trick every 30 s), selfie (with a
blinding flash), grin, smoke (wisps off the ember, a slow exhale), zyn, line
(one every 40 s), juice (a jab, then the biceps grow until the state
changes), dead, and banner, which drops a sign over the traffic light
with your own text ("Banner says").

The guns aim at your cursor. The rifle on the widget physically turns to
face it, and a click-through overlay draws the rounds from the barrel's tip:
**ak47** fires a burst every 15 seconds; **sniper** scopes your cursor with a
reticle, then puts a single shot and a cracked-glass bullet hole exactly
where it was, every 7 seconds. The overlay closes the moment the state
changes and never runs under Reduce Motion.

Beyond the lamp, each rule can set any of these channels, all layered
independently:

- **Sign** — three lamps, a vertical post, one big lamp, or five lamps
  (red, amber, green, blue, pink); **lamp shape** — square, round, heart,
  star, skull; **sign effect** — wobble, spin, rattle, cracked glass, neon
  tube; **show a number** — sessions running, minutes waiting, or tasks
  left, as a digit in the state's colour instead of the lamps.
- **Screen** — whole-display effects on the click-through overlay: a red
  vignette pulse, confetti every 10 seconds, or a spotlight beam from Claude
  to your terminal's Dock icon. The lamps also flicker whenever a sound
  plays.
- **Lamp effect** — pulse, strobe, breathe, flicker (faulty neon), chase
  (lamps in sequence), police (red/blue), rainbow, all three lit, or SOS in
  morse.
- **Eyes** — a colour, closed, or a mood: heart, happy, angry, sad,
  surprised, wink, star, money, sleepy, suspicious, rolling, googly, dizzy,
  x, tears, laser.
- **Costume** — dog, cat, unicorn, crown, party hat, shades, halo, devil,
  wizard, top hat, santa, pumpkin, bunny. Seasonal ones apply themselves in
  December, at Halloween, on New Year's Day and around Easter (Preferences →
  Seasonal costumes) whenever no rule picked one.
- **Body** — Claude becomes a dog, cat, frog, robot or ghost; or keeps his
  shape in any colour (handy with **Only project**, so each project gets its
  own Claude).
- **Effect** — rain cloud, sun, snow, sparkles, fire, a beard that grows the
  longer you keep him waiting, or a **garden**. The garden lives on your
  actual screen, Desktop-Goose style: the widget drops to the bottom of the
  display and walks along it, off the screen edge and back with a pot each
  time (five pots, two minutes), then plants each one — pours dirt, drops a
  seed, waters it (three minutes) — while the bed, pots and crops are drawn
  along the bottom of the screen on the click-through overlay. Crops
  (carrots, tomatoes, berries, sunflowers, apple trees, flowers, at random)
  grow over two minutes; he then walks to an edible one every twenty seconds
  and eats it. Ten minutes after his first bite he pulls the crops and
  replants, and again every ten minutes. When the state changes he walks
  home and the garden clears. The editor previews a compact version at 30×.
- **Pet** — a duck, cat or blob at his feet.
- **Sound** — the system beep, any macOS system sound, or an audio file.

Rules can also be scoped to a project (folder name or `bondly*` prefix).

Rage meter: *Ignored for 10 / 20 / 30 minutes* are signals you can rule on;
the **Loud** preset escalates from foot-tapping to arms crossed and a beard
to a banner with laser eyes.

Presets: **Classic** (the original behaviour), **Minimal** (lamps only),
**Tool-aware** (eye colours per tool), **Loud** (sounds, bullets, rage meter),
**Party** (running, pets, costumes, hearts, fire) — plus your own: type a name at the
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

## Share your rules

Presets menu → **Copy share code** puts your whole ruleset on the clipboard
as a short `ctl1:…` code; **Paste a share code…** loads someone else's (then
Save to keep it). **Export to file…** / **Import from file…** do the same as
JSON.

## Other agents, not just Claude Code

Every session is tagged with its **source**, and rules can be scoped to one
agent (**Only agent**). Preferences → **Connect other agents** writes the
hook config for:

- **Cursor** — `~/.cursor/hooks.json` (prompt, shell, MCP, file edits, stop)
- **Codex CLI** — `notify` in `~/.codex/config.toml` (turn complete)
- **Gemini CLI** — `hooks` in `~/.gemini/settings.json` (best effort)

Anything else — ChatGPT desktop via a Shortcut, a script, another IDE — can
POST to the local endpoint or run the emitter:

```bash
curl -X POST http://127.0.0.1:47172/signal -H 'content-type: application/json' \
  -d '{"source":"chatgpt","session":"abc","signal":"tool-use","tool":"Bash","cwd":"/path"}'
node hooks/emit.js permission-ask --source myagent --session abc --cwd /path
curl http://127.0.0.1:47172/status     # the resolved look + live sessions
```

Signals: prompt-submit, tool-use, tool-done, tool-failed, stop,
permission-ask, limit-hit, idle-nudge, session-start, session-end,
subagent-start, subagent-done.

## Windows

`npm run dist:win` builds an x64 installer and a portable exe (cross-built
from macOS works). The widget,
Lights, rules, overlay effects, sounds (system beep or a file), speech and
the local endpoint all work; Dock-icon roaming, macOS Shortcuts and the
menu-bar template icon are macOS-only.

## Answer permission prompts from the widget

Preferences → **Answer permission prompts from the widget** (off by default)
installs a `PermissionRequest` hook. When Claude asks to run a tool, the
widget shows what it wants (`Bash: git push origin main`) with **Allow** /
**Deny** buttons; your answer goes straight back to Claude Code. If you don't
answer within a minute the hook steps aside and the normal terminal prompt
appears, so nothing can get stuck. Restart open sessions after toggling it.

## Running to your terminal

When something needs you and the terminal isn't the front app, Claude runs
across the screen to that app's Dock icon (Ghostty, iTerm, Terminal, Warp…),
knocks, and runs home — once per waiting episode, then every 10 minutes while
ignored. Preferences → **Run to the terminal and knock**.

## Program the clicks

Each rule has an **On click** section: what a click, a double-click and an
⌥-click do while that state is showing. Actions: jump to the session that
needs you, bring the terminal forward, allow or deny the pending permission,
poke / pet / feed, open Lights or Stats, open the session's folder in Finder
or in an app of your choice, copy its path, open a URL, run a shell command
(the session folder is in `$CLAUDE_CWD`), run a macOS Shortcut, say
something out loud, or hide the widget for 30 minutes. Gestures a rule
leaves on "keep" fall through to the rules below and finally to the
defaults: click jumps (or pokes when nothing is waiting), double-click pets,
⌥-click feeds. Right-click always opens Lights.

## Task progress, rare events, reactions

- A tiny **3/7** on the sign's crossbar while Claude works through a task
  list (Preferences → Show task progress).
- **Rare events**: a UFO abduction, a portal, or a meteor — roughly once per
  45 minutes of working time, and on your 10th/50th/100th/500th session.
- **Reactions**: click Claude for a poke (or to jump to whoever needs you),
  double-click to pet him, ⌥-click to feed him a cookie.

## Stats

The Stats tab in Lights shows the last seven days as stacked bars — working,
waiting on you (hatched), idle — with totals, a per-project ranking and a
day table. If [ccusage](https://github.com/ryoppippi/ccusage) is installed
it also shows **spend**: today and this week, per project (sessions are
mapped to folders through their transcripts), the costliest sessions, and a
cost column per day. Time accrues in 4-second ticks while the app runs and is kept for
60 days in `~/.claude-traffic-light/stats.json`.

## Menu bar mode

Tray → **Claude in the Menu Bar** animates the menu bar icon with the same
lights, eyes, pose and costume as the widget; **Floating Widget** hides the
desktop widget if you would rather live in the menu bar only. Both are also
in Preferences.

## How multi-session monitoring works

Every Claude Code session writes its own status file to
`~/.claude-traffic-light/sessions/<host>-<session_id>.json` via hooks. The
hook only records the raw signal — what it *means* is decided by your rules
in the app, so changing a rule never touches the hooks:

- `UserPromptSubmit` → `prompt-submit`
- `PreToolUse` / `PostToolUse` / `PostToolUseFailure` → `tool-use` /
  `tool-done` / `tool-failed` (with the tool name)
- `SubagentStart` / `SubagentStop` → `subagent-start` / `subagent-done`
- `PermissionDenied` → `permission-denied`; `StopFailure` → `turn-failed`
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
