#!/bin/sh
# Swaps an unsigned Plexiform.app for its verified update, after the running
# app has quit (src/updater/mac-swap.js writes and starts this, detached).
#
#   mac-swap-helper.sh PID CURRENT NEW PREVIOUS_DIR UPDATES_DIR OLD_VERSION [TIMEOUT] [LAUNCH]
#
# 1. wait for PID (the old app) to exit
# 2. move CURRENT to PREVIOUS_DIR/<name>.app, NEW into CURRENT
# 3. launch it with --updated-from=OLD_VERSION
# 4. the new app writes UPDATES_DIR/launched-ok once it is up; then the old
#    bundle, the zip and swap-pending.json go. If launched-ok has not appeared
#    within TIMEOUT seconds (90), stop it, put the old bundle back and launch
#    that with --update-failed (it reads and removes swap-pending.json)
# LAUNCH is "open" (LaunchServices), or "direct" to run the executable itself (tests).
set -u
PID="$1"; CURRENT="$2"; NEW="$3"; PREV_DIR="$4"; UPD="$5"; OLD_VERSION="$6"
TIMEOUT="${7:-90}"; LAUNCH="${8:-open}"
case "$PID" in ''|*[!0-9]*) exit 64 ;; esac
case "$TIMEOUT" in ''|*[!0-9]*) exit 64 ;; esac
NAME=$(basename "$CURRENT")
PREV="$PREV_DIR/$NAME"
MARKER="$UPD/launched-ok"
PIDFILE="$UPD/launched-pid"
LOG="$UPD/swap.log"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

launch() {
  if [ "$LAUNCH" = direct ]; then
    exe=$(ls "$1/Contents/MacOS" | head -n 1)
    "$1/Contents/MacOS/$exe" "$2" >/dev/null 2>&1 &
  else
    /usr/bin/open "$1" --args "$2"
  fi
}

log "swap start: pid $PID, $CURRENT <- $NEW (from $OLD_VERSION)"

i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 240 ]; then log "the app did not quit within 120 s; update abandoned"; exit 1; fi
  sleep 0.5
done

mkdir -p "$PREV_DIR"
rm -rf "$PREV"
if ! mv "$CURRENT" "$PREV"; then
  log "could not move the current app aside; update abandoned"
  launch "$CURRENT" --update-failed
  exit 1
fi
if ! mv "$NEW" "$CURRENT"; then
  log "could not move the new app into place; restoring"
  mv "$PREV" "$CURRENT"
  launch "$CURRENT" --update-failed
  exit 1
fi

rm -f "$MARKER" "$PIDFILE"
launch "$CURRENT" "--updated-from=$OLD_VERSION"

waited=0
while [ "$waited" -lt "$TIMEOUT" ]; do
  if [ -f "$MARKER" ]; then
    log "swap ok: the new version is up"
    rm -rf "$PREV" "$UPD/downloads" "$UPD/swap-pending.json"
    exit 0
  fi
  sleep 1
  waited=$((waited + 1))
done

log "no launched-ok after $TIMEOUT s; rolling back"
NEWPID=$(cat "$PIDFILE" 2>/dev/null || true)
case "$NEWPID" in ''|*[!0-9]*) ;; *) kill "$NEWPID" 2>/dev/null ;; esac
sleep 1
FAILED="$UPD/failed"
rm -rf "$FAILED"
mkdir -p "$FAILED"
if mv "$CURRENT" "$FAILED/$NAME" && mv "$PREV" "$CURRENT"; then
  log "rolled back to $OLD_VERSION"
else
  log "ROLLBACK FAILED: the previous app is in $PREV"
fi
launch "$CURRENT" --update-failed
exit 2
