#!/usr/bin/env bash
# Relay upgrade + cleanup (G0-3), runnable ON the relay host.
#
#   W2M_VERSION=2.0.0-beta.1 bash relay-upgrade.sh
#   W2M_DRY_RUN=1 bash relay-upgrade.sh          # print the plan, change nothing
#
# Steps: snapshot state/service/version -> stop -> install -> scrub (backup outside state)
#        -> start -> healthz assertions (relay_version, features, blobs=0) -> rollback on failure.
set -euo pipefail

VERSION="${W2M_VERSION:?set W2M_VERSION, e.g. 2.0.0-beta.1}"
STATE_DIR="${W2M_STATE_DIR:-/var/lib/w2m/rabbit}"
BACKUP_DIR="${W2M_BACKUP_DIR:-/root/w2m-upgrade-backups}"
SERVICE="${W2M_SERVICE:-w2m-rabbit}"
PKG="${W2M_PACKAGE:-@twinsearth/w2m-dsh-plugin@$VERSION}"
HEALTH_URL="${W2M_HEALTH_URL:-http://127.0.0.1:8787/healthz}"
SCRUB_BIN="${W2M_SCRUB_BIN:-}"
DRY_RUN="${W2M_DRY_RUN:-0}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$BACKUP_DIR/$STAMP"
OLD_VERSION="$(npm ls -g --depth=0 @twinsearth/w2m-dsh-plugin 2>/dev/null | awk -F@ '/@twinsearth\/w2m-dsh-plugin@/{print $NF}' | head -n1 || true)"

log() { echo "[relay-upgrade] $*"; }

if [ "$DRY_RUN" = "1" ]; then
  cat <<EOF
PLAN (dry-run)
  version       : $VERSION  (installed now: ${OLD_VERSION:-unknown})
  state dir     : $STATE_DIR
  backup        : $BACKUP
  service       : $SERVICE
  package       : $PKG
  scrub         : ${SCRUB_BIN:-<not set: skip>}
  1) cp -a $STATE_DIR $BACKUP/state ; cp service unit ; save old version
  2) systemctl stop $SERVICE
  3) npm i -g $PKG
  4) if scrub set: node \$SCRUB_BIN --state $STATE_DIR --apply --backup-dir $BACKUP_DIR/scrub
  5) systemctl start $SERVICE ; sleep 3
  6) assert $(curl -fsS $HEALTH_URL) has relay_version/features and persistence.blobs==0
  7) on any failure: restore state + reinstall ${OLD_VERSION:-previous package} + restart
EOF
  exit 0
fi

rollback() {
  log "ROLLBACK: restoring $BACKUP"
  systemctl stop "$SERVICE" || true
  if [ -d "$BACKUP/state" ]; then rm -rf "$STATE_DIR"; cp -a "$BACKUP/state" "$STATE_DIR"; fi
  if [ -f "$BACKUP/service.unit" ]; then cp -a "$BACKUP/service.unit" "/etc/systemd/system/$SERVICE.service"; fi
  if [ -n "${OLD_VERSION:-}" ]; then npm i -g "@twinsearth/w2m-dsh-plugin@$OLD_VERSION" >/dev/null 2>&1 || true; fi
  systemctl start "$SERVICE" || true
  log "ROLLBACK done; healthz: $(curl -fsS "$HEALTH_URL" || echo unreachable)"
}
trap 'rollback' ERR

mkdir -p "$BACKUP"
if [ -d "$STATE_DIR" ]; then cp -a "$STATE_DIR" "$BACKUP/state"; fi
if [ -f "/etc/systemd/system/$SERVICE.service" ]; then cp -a "/etc/systemd/system/$SERVICE.service" "$BACKUP/service.unit"; fi
log "backed up to $BACKUP (old version: ${OLD_VERSION:-unknown})"

systemctl stop "$SERVICE"
log "installing $PKG"
npm i -g "$PKG"

if [ -n "$SCRUB_BIN" ] && [ -f "$SCRUB_BIN" ]; then
  log "scrubbing $STATE_DIR"
  node "$SCRUB_BIN" --state "$STATE_DIR" --apply --backup-dir "$BACKUP_DIR/scrub"
else
  log "no W2M_SCRUB_BIN set; skipping scrub (relay must not hold blobs already)"
fi

systemctl start "$SERVICE"
sleep 3

BODY="$(curl -fsS "$HEALTH_URL")"
node -e '
const body = JSON.parse(process.argv[1]);
const version = body.relay_version ?? body.version ?? null;
const features = Array.isArray(body.features) ? body.features : [];
const blobs = body.persistence?.blobs ?? null;
const missing = ["target-machines", "result-projection"].filter((f) => !features.includes(f));
if (version === null) { console.error("ASSERT FAILED: no relay_version"); process.exit(1); }
if (missing.length > 0) { console.error("ASSERT FAILED: missing features " + missing.join(",")); process.exit(1); }
if (blobs !== null && blobs !== 0) { console.error("ASSERT FAILED: persistence.blobs=" + blobs + " (scrub before accepting)"); process.exit(1); }
console.log(JSON.stringify({ ok: true, relay_version: version, features, blobs }));
' "$BODY"

log "OK: $(echo "$BODY" | head -c 200)"
trap - ERR
