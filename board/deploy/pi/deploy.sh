#!/usr/bin/env bash
# Push the committed board/ tree at HEAD to the hub host and restart the hub.
#   PI="ssh -i ~/.ssh/key user@host" deploy/pi/deploy.sh
# First run also needs /etc/buddy-hub/hub.env (from hub.env.example).
set -euo pipefail
: "${PI:?set PI to the ssh command for the hub host}"
cd "$(git rev-parse --show-toplevel)"
sha=$(git rev-parse HEAD)
git diff --quiet HEAD -- board || { echo "board/ has uncommitted changes; commit first" >&2; exit 1; }

git archive --format=tar HEAD board | $PI "set -e
  stage=\$(mktemp -d); tar -x -C \"\$stage\" -f -
  cd \"\$stage/board\" && npm ci --omit=dev --no-audit --no-fund >/dev/null
  echo $sha > \"\$stage/board/DEPLOYED_SHA\"
  sudo rm -rf /opt/buddy-hub/board.prev
  [ -d /opt/buddy-hub/board ] && sudo mv /opt/buddy-hub/board /opt/buddy-hub/board.prev
  sudo mv \"\$stage/board\" /opt/buddy-hub/board && sudo chown -R root:root /opt/buddy-hub/board && rm -rf \"\$stage\"
  sudo install -m 0644 /opt/buddy-hub/board/deploy/pi/buddy-hub.service /opt/buddy-hub/board/deploy/pi/buddy-hub-backup.service /opt/buddy-hub/board/deploy/pi/buddy-hub-backup.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now buddy-hub-backup.timer >/dev/null
  sudo systemctl enable buddy-hub >/dev/null && sudo systemctl restart buddy-hub
  for i in \$(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:8787/api/health && break; sleep 0.5; done
  curl -fsSi http://127.0.0.1:8787/api/health | grep -i '^board-protocol'
"
echo "deployed $sha"
