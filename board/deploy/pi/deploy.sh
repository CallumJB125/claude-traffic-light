#!/usr/bin/env bash
# Push the committed board/ tree at HEAD to the hub host and restart the hub.
#   PI="ssh -i ~/.ssh/key user@host" deploy/pi/deploy.sh                 # production unit buddy-hub
#   PI=… TARGET=staging deploy/pi/deploy.sh                              # second instance buddy-hub-staging
# First run also needs the env file (from hub.env.example): /etc/buddy-hub/hub.env, or staging.env for staging.
# Staging runs beside production with its own code tree, data dir, port and unit, and never touches
# production's backup timer. Override any of these: UNIT APP_ROOT ENV_FILE DATA_DIR PORT.
set -euo pipefail
: "${PI:?set PI to the ssh command for the hub host}"

TARGET=${TARGET:-production}
case "$TARGET" in
  production) d_unit=buddy-hub;         d_root=/opt/buddy-hub;         d_env=/etc/buddy-hub/hub.env;     d_data=/var/lib/buddy-hub;         d_port=8787 ;;
  staging)    d_unit=buddy-hub-staging; d_root=/opt/buddy-hub-staging; d_env=/etc/buddy-hub/staging.env; d_data=/var/lib/buddy-hub-staging; d_port=8788 ;;
  *) echo "TARGET must be production or staging" >&2; exit 1 ;;
esac
UNIT=${UNIT:-$d_unit}; APP_ROOT=${APP_ROOT:-$d_root}; ENV_FILE=${ENV_FILE:-$d_env}; DATA_DIR=${DATA_DIR:-$d_data}; PORT=${PORT:-$d_port}
for v in UNIT APP_ROOT ENV_FILE DATA_DIR; do
  [[ "${!v}" =~ ^[A-Za-z0-9_./-]+$ ]] || { echo "$v has unexpected characters" >&2; exit 1; }
done
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "PORT must be a number" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"
sha=$(git rev-parse HEAD)
git diff --quiet HEAD -- board || { echo "board/ has uncommitted changes; commit first" >&2; exit 1; }
prod=0; [ "$UNIT" = buddy-hub ] && prod=1

git archive --format=tar HEAD board | $PI "set -e
  stage=\$(mktemp -d); tar -x -C \"\$stage\" -f -
  cd \"\$stage/board\" && npm ci --omit=dev --no-audit --no-fund >/dev/null
  echo $sha > \"\$stage/board/DEPLOYED_SHA\"
  sudo test -f $ENV_FILE || { echo 'missing $ENV_FILE (create it from deploy/pi/hub.env.example first)' >&2; exit 1; }
  sudo mkdir -p $APP_ROOT
  sudo rm -rf $APP_ROOT/board.prev
  [ -d $APP_ROOT/board ] && sudo mv $APP_ROOT/board $APP_ROOT/board.prev
  sudo mv \"\$stage/board\" $APP_ROOT/board && sudo chown -R root:root $APP_ROOT/board && rm -rf \"\$stage\"
  sudo install -d -m 0700 -o buddyhub -g buddyhub $DATA_DIR
  sed -e 's#^Description=.*#Description=Board hub ($UNIT)#' -e 's#/opt/buddy-hub/board#$APP_ROOT/board#g' -e 's#/etc/buddy-hub/hub.env#$ENV_FILE#' -e 's#/var/lib/buddy-hub\$#$DATA_DIR#' $APP_ROOT/board/deploy/pi/buddy-hub.service | sudo tee /etc/systemd/system/$UNIT.service >/dev/null
  if [ $prod = 1 ]; then
    sudo install -m 0644 $APP_ROOT/board/deploy/pi/buddy-hub-backup.service $APP_ROOT/board/deploy/pi/buddy-hub-backup.timer /etc/systemd/system/
  fi
  sudo systemctl daemon-reload
  [ $prod = 1 ] && sudo systemctl enable --now buddy-hub-backup.timer >/dev/null
  sudo systemctl enable $UNIT >/dev/null && sudo systemctl restart $UNIT
  for i in \$(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:$PORT/api/health && break; sleep 0.5; done
  curl -fsSi http://127.0.0.1:$PORT/api/health | grep -i '^board-protocol'
"
echo "deployed $sha to $UNIT (port $PORT)"
