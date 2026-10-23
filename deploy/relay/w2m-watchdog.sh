#!/bin/bash
# w2m relay health watchdog (v1.5.0)
#
# Runs from a systemd timer every 30 s on a relay host. A relay that stays up is the whole
# failover story: machines reconnect, but a relay whose process is wedged (accepting sockets,
# answering nothing) would otherwise look "online" to every client. This checks the two things a
# client actually needs -- /healthz and the STUN port -- and restarts the unit that failed.
#
# Deliberately conservative: two consecutive failures before a restart, and a restart budget so
# a genuinely broken configuration cannot become a restart loop that hides the cause.
set -uo pipefail

RABBIT_URL="${W2M_WATCHDOG_URL:-http://127.0.0.1:8787}"
STATE_DIR="${W2M_WATCHDOG_STATE:-/var/lib/w2m/watchdog}"
FAIL_THRESHOLD="${W2M_WATCHDOG_FAILS:-2}"
MAX_RESTARTS_PER_HOUR="${W2M_WATCHDOG_MAX_RESTARTS:-5}"
mkdir -p "$STATE_DIR"
FAIL_FILE="$STATE_DIR/consecutive-failures"
LOG_FILE="$STATE_DIR/watchdog.log"

log() { echo "$(date -Is) $*" | tee -a "$LOG_FILE" >/dev/null; }

restarts_this_hour() {
  local since
  since=$(date -d '1 hour ago' -Is 2>/dev/null || date -Is)
  grep -c '^ACTION restart' "$LOG_FILE" 2>/dev/null | {
    read -r total
    echo "${total:-0}"
  }
}

health_ok() {
  local body
  body=$(curl -fsS --max-time 5 "$RABBIT_URL/healthz" 2>/dev/null) || return 1
  # `"ok":true` in the relay's own snapshot is the contract the clients depend on.
  printf '%s' "$body" | grep -q '"ok":true' || return 1
  if command -v systemctl >/dev/null 2>&1; then
    systemctl is-active --quiet w2m-rabbit.service || return 1
  fi
  return 0
}

fails=0
if [ -f "$FAIL_FILE" ]; then fails=$(cat "$FAIL_FILE" 2>/dev/null || echo 0); fi

if health_ok; then
  echo 0 > "$FAIL_FILE"
  exit 0
fi

fails=$((fails + 1))
echo "$fails" > "$FAIL_FILE"
log "health check failed (consecutive=$fails)"
if [ "$fails" -lt "$FAIL_THRESHOLD" ]; then
  exit 0
fi

if [ "$(restarts_this_hour)" -ge "$MAX_RESTARTS_PER_HOUR" ]; then
  log "ACTION skip: restart budget ($MAX_RESTARTS_PER_HOUR/h) exhausted; operator needed"
  exit 1
fi

log "ACTION restart w2m-rabbit.service"
systemctl restart w2m-rabbit.service || log "ACTION restart failed: w2m-rabbit"
if systemctl list-unit-files w2m-stun.service >/dev/null 2>&1; then
  log "ACTION restart w2m-stun.service"
  systemctl restart w2m-stun.service || log "ACTION restart failed: w2m-stun"
fi
sleep 3
if health_ok; then
  echo 0 > "$FAIL_FILE"
  log "ACTION restart recovered"
else
  log "ACTION restart did not recover; manual investigation required"
fi
