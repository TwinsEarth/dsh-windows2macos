#!/usr/bin/env bash
# Bootstrap the M1 maintenance runner on a Linux machine (run ONCE as root).
#
# What it does, and deliberately does not do:
#   * installs the root path unit + service that execute ONLY update/restart/diag
#   * creates the queue/done directories the unprivileged agent writes to
#   * optionally pins the operator public key supplied with --operator-key
#   * never runs a user-supplied shell string; the unit's ExecStart is fixed
#
# usage: sudo bash bootstrap.sh --app-dir /opt/w2m/app --machine-id <id> [--operator-key /path/op.pub.pem]
set -euo pipefail
APP_DIR="/opt/w2m/app"
MACHINE_ID=""
OPERATOR_KEY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --machine-id) MACHINE_ID="$2"; shift 2 ;;
    --operator-key) OPERATOR_KEY="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$MACHINE_ID" ]]; then echo "--machine-id is required" >&2; exit 2; fi
if [[ "$(id -u)" -ne 0 ]]; then echo "run as root" >&2; exit 2; fi

BASE=/var/lib/w2m/maintenance
mkdir -p "$BASE/queue" "$BASE/done" "$BASE/claimed"
# The agent runs as an unprivileged user; it must be able to create request files, and must NOT be able to execute them.
chown -R root:w2m "$BASE"
# The agent writes grant uses and the maintenance queue here; the directory itself must be group-writable.
chmod 0775 "$BASE"
chmod 0770 "$BASE/queue"
chmod 0750 "$BASE/done" "$BASE/claimed"

if [[ ! -f "$APP_DIR/bin/w2m-maintenance.mjs" ]]; then
  echo "missing $APP_DIR/bin/w2m-maintenance.mjs — deploy the package first" >&2
  exit 1
fi

sed -e "s|/opt/w2m/app|$APP_DIR|g" "$APP_DIR/deploy/server/w2m-maintenance.service" > /etc/systemd/system/w2m-maintenance.service
cp "$APP_DIR/deploy/server/w2m-maintenance.path" /etc/systemd/system/w2m-maintenance.path
printf 'W2M_MACHINE_ID=%s\n' "$MACHINE_ID" > /etc/w2m-maintenance.env
mkdir -p /etc
mv /etc/w2m-maintenance.env /etc/w2m/maintenance.env 2>/dev/null || true
mkdir -p /etc/w2m
printf 'W2M_MACHINE_ID=%s\n' "$MACHINE_ID" > /etc/w2m/maintenance.env

if [[ -n "$OPERATOR_KEY" ]]; then
  node "$APP_DIR/bin/w2m-maintenance.mjs" --once \
    --allow-nonroot \
    --queue-dir "$BASE/queue" --done-dir "$BASE/done" \
    --machine-id "$MACHINE_ID" \
    --pin-file "$BASE/operator-pins.json" \
    --operator-key "$OPERATOR_KEY" >/dev/null
  chown root:root "$BASE/operator-pins.json"
fi

systemctl daemon-reload
systemctl enable --now w2m-maintenance.path
systemctl status w2m-maintenance.path --no-pager | head -5
echo "maintenance runner bootstrapped for machine $MACHINE_ID"
