#!/usr/bin/env bash
# Install or update the cloud runner ON the Pi (as root). Idempotent; never touches the hub,
# its data dir, its env or its units. deploy-runner.sh calls it with a staged board/ tree:
#   sudo STAGE=/tmp/x/board bash install-runner.sh
# Without STAGE it only (re)creates the user, directories and unit from this checkout.
# It does not start the runner until /etc/buddy-runner/runner.env and runner.token exist,
# and it never installs packages or AI CLIs (docs/CLOUD-RUNNER-RUNBOOK.md lists those steps).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

RUSER=buddyrunner
ROOT=/opt/buddy-runner
STATE=/var/lib/buddy-runner
ETC=/etc/buddy-runner
UNIT=/etc/systemd/system/buddy-runner.service
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${STAGE:-$(cd "$HERE/../.." && pwd)}

[ -f "$SRC/runner/cli.js" ] || { echo "no runner/cli.js under $SRC" >&2; exit 1; }
case "$SRC" in /var/lib/buddy-hub*|/etc/buddy-hub*|/opt/buddy-hub*) echo "refusing a hub path as the source" >&2; exit 1 ;; esac

# 1. An unprivileged system user with no login and no sudo; its home is its own state dir.
if ! id "$RUSER" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE" --no-create-home --shell /usr/sbin/nologin --user-group "$RUSER"
fi
for g in sudo docker adm; do
  if id -nG "$RUSER" | tr ' ' '\n' | grep -qx "$g"; then echo "$RUSER must not be in group $g" >&2; exit 1; fi
done

# 2. State on the NVMe root disk: 0700, owned by the runner. Code and config are root-owned.
install -d -m 0700 -o "$RUSER" -g "$RUSER" "$STATE" "$STATE/home"
install -d -m 0755 -o root -g root "$ROOT" "$ROOT/cli"
install -d -m 0700 -o root -g root "$ETC"

# 3. Code: the staged board/ tree (npm ci already done by the caller), plus src/local-models.js
#    that the Hermes backend imports. The previous tree is kept for rollback.
if [ -n "${STAGE:-}" ]; then
  rm -rf "$ROOT/board.prev"
  [ -d "$ROOT/board" ] && mv "$ROOT/board" "$ROOT/board.prev"
  mv "$STAGE" "$ROOT/board"
  if [ -d "$(dirname "$STAGE")/src" ]; then rm -rf "$ROOT/src"; mv "$(dirname "$STAGE")/src" "$ROOT/src"; chown -R root:root "$ROOT/src"; fi
  chown -R root:root "$ROOT/board"
  SRC="$ROOT/board"
fi

# 4. The unit and the optional tailnet-model drop-in (installed, not enabled for egress).
install -m 0644 "$SRC/deploy/pi/buddy-runner.service" "$UNIT"
install -d -m 0755 "$UNIT.d"
install -m 0644 "$SRC/deploy/pi/hermes-dgx.conf" "$ETC/hermes-dgx.conf.example"
install -m 0600 -o root -g root "$SRC/deploy/pi/runner.env.example" "$ETC/runner.env.example"
systemctl daemon-reload

# 5. Start only when configured. A placeholder left in runner.env refuses to start.
if [ -f "$ETC/runner.env" ] && [ -f "$ETC/runner.token" ]; then
  if grep -Eq 'replace-with|owner/repo' "$ETC/runner.env"; then echo "$ETC/runner.env still has placeholders" >&2; exit 1; fi
  chmod 0600 "$ETC/runner.env" "$ETC/runner.token"; chown root:root "$ETC/runner.env" "$ETC/runner.token"
  systemctl enable buddy-runner.service >/dev/null
  systemctl restart buddy-runner.service
  sleep 3
  systemctl --no-pager --lines=0 status buddy-runner.service || true
  journalctl -u buddy-runner.service -n 20 --no-pager -o cat || true
else
  echo "installed; not started: create $ETC/runner.env (from runner.env.example) and $ETC/runner.token, then rerun"
fi
