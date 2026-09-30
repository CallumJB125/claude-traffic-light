#!/bin/sh
# Manual isolation check against the member's REAL claude CLI (CONTRACT §13 exit j).
# Not part of `npm test`: it spends real money (haiku, budget-capped < $0.10).
# Asserts system/init tools + mcp_servers are ours only and the Bash tool shows
# no user aliases/functions (Gap A). Prints a JSON report; exit 0 = pass.
set -eu
cd "$(dirname "$0")/../.."
exec node runner/scripts/smoke-real.js "$@"
