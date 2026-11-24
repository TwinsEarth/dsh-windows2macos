#!/usr/bin/env bash
#
# Install or refresh one coturn node for a W2M TURN pair.
#
# Run on the TURN host itself:
#   sudo TURN_EXTERNAL_IP=... TURN_PRIVATE_IP=... TURN_SECRET=... ./deploy-turn.sh
#
# The script is deliberately idempotent: it writes the same config and restarts only coturn.
# The Tencent Cloud security group is outside this script; open the TURN port and relay range
# there before running the probe.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

TURN_PORT="${TURN_PORT:-3479}"
TURN_MIN_PORT="${TURN_MIN_PORT:-49160}"
TURN_MAX_PORT="${TURN_MAX_PORT:-49200}"
TURN_REALM="${TURN_REALM:-w2m.webrtc}"
TURN_USER="${TURN_USER:-w2m}"
TURN_NAME="${TURN_NAME:-w2m-turn}"
TURN_EXTERNAL_IP="${TURN_EXTERNAL_IP:-}"
TURN_PRIVATE_IP="${TURN_PRIVATE_IP:-}"
TURN_SECRET="${TURN_SECRET:-}"

if [[ -z "${TURN_EXTERNAL_IP}" || -z "${TURN_PRIVATE_IP}" || -z "${TURN_SECRET}" ]]; then
  echo "TURN_EXTERNAL_IP, TURN_PRIVATE_IP and TURN_SECRET are required" >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq coturn

sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn

cat >/etc/turnserver.conf <<EOF
listening-port=${TURN_PORT}
listening-ip=${TURN_PRIVATE_IP}
relay-ip=${TURN_PRIVATE_IP}
external-ip=${TURN_EXTERNAL_IP}/${TURN_PRIVATE_IP}
min-port=${TURN_MIN_PORT}
max-port=${TURN_MAX_PORT}
fingerprint
lt-cred-mech
user=${TURN_USER}:${TURN_SECRET}
realm=${TURN_REALM}
server-name=${TURN_NAME}
no-cli
no-tls
no-dtls
no-multicast-peers
stale-nonce=3600
simple-log
log-file=/var/log/turnserver.log
EOF

chmod 600 /etc/turnserver.conf
systemctl enable coturn >/dev/null
systemctl restart coturn
sleep 2
systemctl is-active coturn
ss -lntup | grep ":${TURN_PORT} " || true
echo "coturn ready on ${TURN_EXTERNAL_IP}:${TURN_PORT}; open UDP ${TURN_PORT} and UDP ${TURN_MIN_PORT}-${TURN_MAX_PORT} in the cloud firewall"
