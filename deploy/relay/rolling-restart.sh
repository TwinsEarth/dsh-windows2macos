#!/usr/bin/env bash
#
# Relay v3.0.0 rolling restart: tencent -> vultr -> primary, health-gated.
#
# Run this on an operator machine that can SSH to all three relays. Each node is
# restarted only after the other two answer /healthz with "ok":true, and the next
# node is not touched until the restarted one is back and its first cluster sync
# has either succeeded or hit the configured timeout (a timeout is recorded, not
# fatal: the relay is serving and will retry on its own schedule).
#
# The deploy artifact is a tar of  bin/ src/ package.json  from the relay v3.0.0
# build (tag v3.3.15 + cluster sync). It is copied to the relay and extracted over
# /opt/w2m/app after a timestamped backup.
#
# Usage:
#   RELEASE_TAR=/tmp/w2m-relay-3.0.0.tgz \
#   NODES="tencent=root@106.53.197.47 vultr=root@202.182.123.154 primary=root@43.142.74.71" \
#   ./rolling-restart.sh
#
# Optional:
#   SSH_KEY=~/.ssh/w2m-fleet-deploy     key for ssh/scp
#   RELAY_APP_DIR=/opt/w2m/app          app dir on each relay
#   BACKUP_ROOT=/opt/w2m                where app.bak-* goes
#   SERVICE=w2m-rabbit                  systemd unit
#   HEALTH_PORT=8787                    local health port on each relay
#   FIRST_SYNC_TIMEOUT=900              seconds to wait for the first cluster sync
#
set -euo pipefail

RELEASE_TAR="${RELEASE_TAR:?set RELEASE_TAR to the relay v3.0.0 tar (bin/ src/ package.json)}"
NODES="${NODES:?set NODES=\"name=user@host ...\" in restart order}"
RELAY_APP_DIR="${RELAY_APP_DIR:-/opt/w2m/app}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/w2m}"
SERVICE="${SERVICE:-w2m-rabbit}"
HEALTH_PORT="${HEALTH_PORT:-8787}"
FIRST_SYNC_TIMEOUT="${FIRST_SYNC_TIMEOUT:-900}"
SSH_KEY="${SSH_KEY:-}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)
if [ -n "$SSH_KEY" ]; then SSH_OPTS+=(-i "$SSH_KEY"); fi

log() { printf '[rolling-restart] %s\n' "$*"; }
die() { printf '[rolling-restart] ERROR: %s\n' "$*" >&2; exit 1; }

ssh_run() {
  local host="$1"; shift
  ssh "${SSH_OPTS[@]}" "$host" "$@"
}

remote_health_ok() {
  local host="$1"
  ssh_run "$host" "curl -fsS --max-time 5 http://127.0.0.1:${HEALTH_PORT}/healthz" 2>/dev/null \
    | grep -q '"ok":true'
}

remote_health_field() {
  local host="$1" field="$2"
  ssh_run "$host" "curl -fsS --max-time 5 http://127.0.0.1:${HEALTH_PORT}/healthz" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=j.$field;process.stdout.write(v===undefined||v===null?'':String(v));}catch{}})"
}

wait_healthy() {
  local name="$1" host="$2" deadline=$(( $(date +%s) + 120 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if remote_health_ok "$host"; then return 0; fi
    sleep 2
  done
  return 1
}

wait_first_sync() {
  local name="$1" host="$2" deadline=$(( $(date +%s) + FIRST_SYNC_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local synced; synced="$(remote_health_field "$host" 'cluster.last_sync_at')"
    if [ -n "$synced" ]; then
      log "$name: first cluster sync at $synced"
      return 0
    fi
    sleep 5
  done
  log "$name: WARNING first cluster sync not observed within ${FIRST_SYNC_TIMEOUT}s (relay is healthy; it will retry)"
  return 0
}

# --- parse nodes ---------------------------------------------------------
declare -a ORDER=() HOSTS=()
for entry in $NODES; do
  name="${entry%%=*}"
  host="${entry#*=}"
  [ -n "$name" ] && [ -n "$host" ] || die "bad NODES entry: $entry"
  ORDER+=("$name"); HOSTS+=("$host")
done
[ "${#ORDER[@]}" -ge 2 ] || die "need at least two relays in NODES for a health-gated rolling restart"

# --- pre-flight: all relays healthy --------------------------------------
for i in "${!ORDER[@]}"; do
  remote_health_ok "${HOSTS[$i]}" || die "pre-flight: ${ORDER[$i]} (${HOSTS[$i]}) is not healthy; refusing to start"
done
log "pre-flight: all ${#ORDER[@]} relays healthy"

# --- restart one at a time ----------------------------------------------
for i in "${!ORDER[@]}"; do
  name="${ORDER[$i]}"; host="${HOSTS[$i]}"

  # every OTHER relay must be healthy before this one is touched
  for j in "${!ORDER[@]}"; do
    [ "$j" -eq "$i" ] && continue
    remote_health_ok "${HOSTS[$j]}" || die "$name: refusing to restart while ${ORDER[$j]} is unhealthy"
  done

  log "=== $name ($host): stop + backup + deploy ==="
  ts="$(date +%Y%m%dT%H%M%S)"
  ssh_run "$host" "set -e
    systemctl stop ${SERVICE}
    if [ -d '${RELAY_APP_DIR}' ]; then cp -a '${RELAY_APP_DIR}' '${BACKUP_ROOT}/app.bak-${ts}'; fi
    mkdir -p '${RELAY_APP_DIR}'"
  # The tar is streamed over ssh's stdin, so the artifact never lands in /tmp on the relay.
  ssh "${SSH_OPTS[@]}" "$host" "tar -xzf - -C '${RELAY_APP_DIR}'" < "$RELEASE_TAR"
  ssh_run "$host" "systemctl start ${SERVICE}"

  wait_healthy "$name" "$host" || die "$name: did not become healthy after restart; rollback with ${BACKUP_ROOT}/app.bak-${ts}"
  version="$(remote_health_field "$host" 'relay_version')"
  log "$name: healthy, relay_version=$version"
  [ "$version" = "3.0.0" ] || log "$name: WARNING relay_version is '$version', expected 3.0.0 (check W2M_RELAY_VERSION drop-in)"
  wait_first_sync "$name" "$host"
done

log "rolling restart complete: ${ORDER[*]}"
log "verify: for each relay, curl http://<relay>:${HEALTH_PORT}/healthz | grep relay-cluster-sync-v1"
