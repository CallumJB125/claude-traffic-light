#!/bin/sh
# claude-buddy router shim — asks Claude Buddy which model a new session
# should start on, then hands over to the real `claude`. Written by Claude
# Buddy when you switch routing on (Lights → Router); switching it off
# removes this file. Pass --model yourself, or set
# CLAUDE_TRAFFIC_LIGHT_ROUTER=off, and it steps aside.
CTL_ROUTER=__CTL_ROUTER__
CTL_ELECTRON=__CTL_ELECTRON__
CTL_ROOT=__CTL_ROOT__
CTL_CONFIG=__CTL_CONFIG__
CTL_SHIM_DIR=__CTL_SHIM_DIR__

# exec keeps the pid, so seeing our own pid here means one router shim just
# exec'd another: a second copy of this file sits on PATH.
if [ "${CTL_ROUTER_SHIM_PID:-}" = "$$" ]; then
  echo "claude-buddy router: another router shim is on your PATH ahead of the real claude — remove it, or switch routing off in Claude Buddy." >&2
  exit 127
fi
CTL_ROUTER_SHIM_PID=$$
export CTL_ROUTER_SHIM_PID

real=
oldifs=$IFS
IFS=:
set -f
for d in $PATH; do
  [ -n "$d" ] || d=.
  [ "${d%/}" = "$CTL_SHIM_DIR" ] && continue
  c="$d/claude"
  if [ -f "$c" ] && [ -x "$c" ] && ! [ "$c" -ef "$0" ]; then
    real=$c
    break
  fi
done
set +f
IFS=$oldifs

if [ -z "$real" ]; then
  echo "claude-buddy router: can't find the real claude on your PATH (looked everywhere except $CTL_SHIM_DIR). Install Claude Code, or switch routing off in Claude Buddy → Lights → Router." >&2
  exit 127
fi

# Any failure here means "no pick": claude still starts, just unrouted.
route=
if [ -f "$CTL_ROUTER" ]; then
  if command -v node >/dev/null 2>&1; then
    route=$(node "$CTL_ROUTER" decide --sh --home "$CTL_ROOT" --config "$CTL_CONFIG" --cwd "$PWD" -- "$@" 2>/dev/null)
  elif [ -x "$CTL_ELECTRON" ]; then
    route=$(ELECTRON_RUN_AS_NODE=1 "$CTL_ELECTRON" "$CTL_ROUTER" decide --sh --home "$CTL_ROOT" --config "$CTL_CONFIG" --cwd "$PWD" -- "$@" 2>/dev/null)
  fi
fi

case ${route%%|*} in
  opus|sonnet|haiku)
    CLAUDE_TRAFFIC_LIGHT_ROUTE=$route
    export CLAUDE_TRAFFIC_LIGHT_ROUTE
    exec "$real" --model "${route%%|*}" "$@"
    ;;
esac
unset CLAUDE_TRAFFIC_LIGHT_ROUTE
exec "$real" "$@"
