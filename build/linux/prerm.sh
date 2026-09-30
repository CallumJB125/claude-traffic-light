#!/bin/sh
# Plexiform .deb prerm (electron-builder.config.js, deb.fpm --before-remove).
#
# On remove, takes Plexiform's entries out of each user's coding-agent configs
# and ~/.claude.json while the binary is still here, so no agent is left
# running a hook command that points at a deleted file. An upgrade keeps them:
# the new version rewrites them itself.
#
# It runs as each user who has used the app (has ~/.claude-traffic-light),
# never as root, so every file keeps its owner. hooks/uninstall-hooks.js
# only removes Plexiform's own entries. Nothing here can fail the removal.
case "$1" in
  remove|purge) ;;
  *) exit 0 ;;
esac

# after-install links /usr/bin/<linux.executableName> to the installed binary.
APP="$(readlink -f /usr/bin/plexiform 2>/dev/null)"
[ -n "$APP" ] && [ -x "$APP" ] || exit 0
SCRIPT="$(dirname "$APP")/resources/hooks/uninstall-hooks.js"
[ -f "$SCRIPT" ] || exit 0
command -v runuser >/dev/null 2>&1 || exit 0

getent passwd | while IFS=: read -r user _ _ _ _ home _; do
  [ -n "$home" ] && [ -d "$home/.claude-traffic-light" ] || continue
  runuser -u "$user" -- env HOME="$home" ELECTRON_RUN_AS_NODE=1 "$APP" "$SCRIPT" || true
done
exit 0
