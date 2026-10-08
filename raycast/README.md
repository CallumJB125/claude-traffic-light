# Plexiform for Raycast

Three [Raycast script commands](https://github.com/raycast/script-commands) that call the `plexiform` command line tool:

| Script | Mode | Shows |
| --- | --- | --- |
| `plexiform-status.sh` | inline, refreshed every minute | The traffic light, the rule behind it, how many sessions are running and how many need you |
| `plexiform-needs-me.sh` | full output | Sessions waiting on you, plus open permission prompts and questions |
| `plexiform-spend-today.sh` | compact | Today's spend at API list prices, against your daily budget if you set one |

## Set up

1. Install the command line tool: Plexiform Settings → Advanced → Command line → **Install command line tool**. It asks before it creates `~/.local/bin/plexiform`.
2. In Raycast, open Extensions → Script Commands → Add Directories, and add this `raycast` folder (or copy the three scripts into a folder you already use).

The scripts look for `plexiform` on your `PATH`, then at `~/.local/bin/plexiform`. To point them somewhere else, set `PLEXIFORM_BIN`.

## What they read

Everything stays on your computer. The tool reads Plexiform's data folder (`~/.claude-traffic-light`) and, when Plexiform is running, its local status page on `127.0.0.1`. Spend is worked out from the Claude Code transcripts in `~/.claude/projects`. Nothing is sent anywhere.

When Plexiform is not running, the status and needs-me scripts still answer from the data folder and say the app is not running.

## The command line tool

```
plexiform status [--short]        traffic-light state and what needs you
plexiform sessions [--all]        running sessions
plexiform spend [--today|--week]  spend today and this week
plexiform handover [<session>]    list handovers, or print one (--out <file> writes it)
plexiform waiting [--short]       permission prompts and questions waiting on you
plexiform doctor                  is the app running, is the hook connected
```

Add `--json` to any command for scripts. Exit codes: `0` ok, `1` Plexiform is not running (the answer came from disk), `2` error.
