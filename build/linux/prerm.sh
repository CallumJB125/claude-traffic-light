#!/bin/sh
# Plexiform .deb prerm (electron-builder.config.js, deb.fpm --before-remove).
#
# On remove, takes Plexiform's entries out of each user's coding-agent configs
# and ~/.claude.json while the binary is still here, so no agent is left
# running a hook command that points at a deleted file. An upgrade keeps them:
# the new version rewrites them itself.
#
# It runs as each person who has used the app (a login account, uid 1000 and
# up, or root, with ~/.claude-traffic-light), never as root for someone else,
# so every file keeps its owner, and each run is cut off after 30 s.
# hooks/uninstall-hooks.js only removes Plexiform's own entries. Nothing here
# can fail the removal. PLEXIFORM_BIN overrides the binary's link (tests).
case "$1" in
  remove|purge) ;;
  *) exit 0 ;;
esac

# after-install links /usr/bin/<linux.executableName> to the installed binary.
BIN="${PLEXIFORM_BIN:-/usr/bin/plexiform}"
APP="$(readlink -f "$BIN" 2>/dev/null)"
[ -n "$APP" ] && [ -x "$APP" ] || exit 0
SCRIPT="$(dirname "$APP")/resources/hooks/uninstall-hooks.js"
[ -f "$SCRIPT" ] || exit 0
command -v getent >/dev/null 2>&1 || exit 0
command -v runuser >/dev/null 2>&1 || exit 0
LIMIT=""
command -v timeout >/dev/null 2>&1 && LIMIT="timeout 30"

getent passwd | while IFS=: read -r user _ uid _ _ home _; do
  case "$uid" in ''|*[!0-9]*) continue ;; esac
  [ "$uid" -eq 0 ] || { [ "$uid" -ge 1000 ] && [ "$uid" -ne 65534 ]; } || continue
  [ -n "$home" ] && [ -d "$home/.claude-traffic-light" ] || continue
  $LIMIT runuser -u "$user" -- env HOME="$home" ELECTRON_RUN_AS_NODE=1 "$APP" "$SCRIPT" </dev/null >/dev/null 2>&1 || true
done
exit 0
