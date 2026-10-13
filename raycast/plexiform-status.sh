#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Plexiform Status
# @raycast.mode inline
# @raycast.refreshTime 1m

# Optional parameters:
# @raycast.packageName Plexiform

# Documentation:
# @raycast.description The traffic light, how many sessions are running, and how many need you.

PLEXIFORM="${PLEXIFORM_BIN:-$(command -v plexiform || echo "$HOME/.local/bin/plexiform")}"
NO_COLOR=1 "$PLEXIFORM" status --short
code=$?
[ "$code" -eq 1 ] && exit 0
exit "$code"
