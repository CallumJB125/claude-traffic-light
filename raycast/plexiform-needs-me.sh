#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Needs Me
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.packageName Plexiform

# Documentation:
# @raycast.description Sessions waiting on you, and permission prompts and questions still open.

PLEXIFORM="${PLEXIFORM_BIN:-$(command -v plexiform || echo "$HOME/.local/bin/plexiform")}"
NO_COLOR=1 "$PLEXIFORM" status
echo
NO_COLOR=1 "$PLEXIFORM" waiting
code=$?
[ "$code" -eq 1 ] && exit 0
exit "$code"
