#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Spend Today
# @raycast.mode compact

# Optional parameters:
# @raycast.packageName Plexiform

# Documentation:
# @raycast.description What your AI sessions cost today, at API list prices, against your Plexiform budget.

PLEXIFORM="${PLEXIFORM_BIN:-$(command -v plexiform || echo "$HOME/.local/bin/plexiform")}"
NO_COLOR=1 "$PLEXIFORM" spend --today --short
