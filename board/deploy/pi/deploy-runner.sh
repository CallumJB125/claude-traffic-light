#!/usr/bin/env bash
# Push the committed board/ tree at HEAD to the Pi and install/update the cloud runner.
#   PI="ssh bondly-pi" board/deploy/pi/deploy-runner.sh
# The runner is a separate unit (buddy-runner) with its own user, code tree (/opt/buddy-runner)
# and state (/var/lib/buddy-runner); this never restarts or touches buddy-hub or its staging twin.
set -euo pipefail
: "${PI:?set PI to the ssh command for the Pi}"

cd "$(git rev-parse --show-toplevel)"
sha=$(git rev-parse HEAD)
git diff --quiet HEAD -- board src/local-models.js src/result-cards.js || { echo "board/ has uncommitted changes; commit first" >&2; exit 1; }

git archive --format=tar HEAD board src/local-models.js src/result-cards.js | $PI "set -e
  stage=\$(mktemp -d); tar -x -C \"\$stage\" -f -
  cd \"\$stage/board\" && npm ci --omit=dev --no-audit --no-fund >/dev/null
  echo $sha > \"\$stage/board/DEPLOYED_SHA\"
  sudo STAGE=\"\$stage/board\" bash \"\$stage/board/deploy/pi/install-runner.sh\"
  rm -rf \"\$stage\"
"
echo "deployed cloud runner $sha"
