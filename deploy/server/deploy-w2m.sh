#!/usr/bin/env bash
#
# Deploy one release tarball to a running relay, with a rollback that is automatic rather than
# remembered.
#
# This is the script the live server was updated with (v0.6.3 -> v0.7.7 -> v0.7.10). It is in the
# repository because a deployment that exists only in someone's shell history is a deployment nobody
# can review — and because the order of these steps is the whole safety argument:
#
#   1. verify the checksum BEFORE unpacking, so a truncated upload cannot become a running service
#   2. back up the tree in place, so rollback does not depend on the network
#   3. stage and check for entry points BEFORE swapping, so a bad tarball never reaches the
#      live path
#   4. restart and health-check, and roll back automatically if the health check fails
#
# Step 3 is the one that matters most: `git archive` of a wrong subdirectory produces a tarball that
# unpacks cleanly and contains no `bin/`, and without the entry-point check that becomes a service
# that starts, finds nothing to run, and reports a confusing error.
#
# Usage: deploy-w2m.sh <tarball> <expected-sha256> [--fleet <account-code>]
#
set -euo pipefail

APP_DIR=/opt/w2m/app
BACKUP_ROOT=/opt/w2m
STATE_DIR=/var/lib/w2m
SERVICES=(w2m-rabbit w2m-stun w2m-localside)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

TARBALL="${1:-}"
EXPECTED="${2:-}"
FLEET=""
if [ "${3:-}" = "--fleet" ]; then FLEET="${4:-}"; fi

if [ -z "$TARBALL" ] || [ -z "$EXPECTED" ]; then
  echo "usage: $0 <tarball> <expected-sha256> [--fleet <account-code>]" >&2
  exit 2
fi
if [ ! -f "$TARBALL" ]; then echo "no such tarball: $TARBALL" >&2; exit 2; fi

echo "=== 1. verify the artefact ==="
ACTUAL=$(sha256sum "$TARBALL" | awk '{print $1}')
echo "  expected $EXPECTED"
echo "  actual   $ACTUAL"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "  CHECKSUM MISMATCH -- refusing to deploy. A truncated upload must never become a service." >&2
  exit 1
fi
echo "  checksum OK"

echo
echo "=== 2. what is running now ==="
if [ -f "$APP_DIR/package.json" ]; then
  echo "  $APP_DIR is version $(node -e "process.stdout.write(require('$APP_DIR/package.json').version)")"
else
  echo "  $APP_DIR has no package.json (first deploy?)"
fi
for s in "${SERVICES[@]}"; do
  printf '  %-16s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || echo inactive)"
done

echo
echo "=== 3. back up the current tree ==="
BACKUP="$BACKUP_ROOT/backup-$STAMP"
if [ -d "$APP_DIR" ]; then
  cp -a "$APP_DIR" "$BACKUP"
  echo "  $APP_DIR -> $BACKUP"
else
  echo "  nothing to back up"
fi

echo
echo "=== 4. unpack to staging and check it ==="
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
tar -xzf "$TARBALL" -C "$STAGING"
# The tarball contains a single `package/` root, by npm convention.
SRC="$STAGING/package"
if [ ! -d "$SRC" ]; then SRC="$STAGING"; fi

STAGED_VERSION=$(node -e "process.stdout.write(require('$SRC/package.json').version)" 2>/dev/null || echo "?")
echo "  staged version: $STAGED_VERSION"

# The check that turns a confusing runtime failure into a clear deployment failure.
MISSING=""
for f in bin/w2m-rabbit.mjs bin/w2m-stun.mjs bin/w2m-localside.mjs package.json; do
  [ -e "$SRC/$f" ] || MISSING="$MISSING $f"
done
if [ -n "$MISSING" ]; then
  echo "  MISSING ENTRY POINTS:$MISSING" >&2
  echo "  refusing to swap: this tarball would install a service that cannot start." >&2
  exit 1
fi
echo "  entry points present"

echo
echo "=== 5. swap into place ==="
rm -rf "$APP_DIR.old"
if [ -d "$APP_DIR" ]; then mv "$APP_DIR" "$APP_DIR.old"; fi
cp -a "$SRC" "$APP_DIR"
chown -R w2m:w2m "$APP_DIR" 2>/dev/null || true
echo "  swapped; previous tree kept at $APP_DIR.old"

echo
echo "=== 6. restart ==="
# The relay's fleet binding: omitted means unscoped, which is the pre-v0.7.8 behaviour.
if [ -n "$FLEET" ]; then
  echo "  --fleet $FLEET requested"
  if grep -q -- '--fleet' /etc/systemd/system/w2m-rabbit.service; then
    sed -i "s|--fleet [^ ]*|--fleet $FLEET|" /etc/systemd/system/w2m-rabbit.service
  else
    sed -i "s|\(--state [^ ]*\)|\1 --fleet $FLEET|" /etc/systemd/system/w2m-rabbit.service
  fi
  systemctl daemon-reload
  echo "  WARNING: the relay is now scoped. A device with no fleet reaches NOTHING."
  echo "           Every device must be re-paired with a code issued by this relay."
fi
systemctl restart "${SERVICES[@]}"

echo
echo "=== 7. health check ==="
sleep 4
HEALTHY=1
for s in "${SERVICES[@]}"; do
  STATE=$(systemctl is-active "$s" 2>/dev/null || echo inactive)
  printf '  %-16s %s\n' "$s" "$STATE"
  [ "$STATE" = "active" ] || HEALTHY=0
done

if command -v curl >/dev/null 2>&1; then
  HEALTH=$(curl -fsS --max-time 10 http://127.0.0.1:8787/healthz 2>/dev/null || echo "")
  if [ -n "$HEALTH" ]; then
    echo "  healthz: $HEALTH"
  else
    echo "  healthz: NO ANSWER"
    HEALTHY=0
  fi
fi

if [ "$HEALTHY" != "1" ]; then
  echo
  echo "=== 8. ROLLBACK ==="
  if [ -d "$BACKUP" ]; then
    rm -rf "$APP_DIR"
    mv "$BACKUP" "$APP_DIR"
    systemctl restart "${SERVICES[@]}"
    echo "  rolled back to the previous tree and restarted" >&2
  else
    echo "  no backup to roll back to" >&2
  fi
  exit 1
fi

echo
echo "=== deployed ==="
echo "  version:  $STAGED_VERSION"
echo "  backup:   $BACKUP"
echo "  previous: $APP_DIR.old (removable once this is proven)"
echo
echo "  NOTE: relay state lives in $STATE_DIR and was NOT touched by this script."
echo "        The ledger and the operator token survive a deploy; that is deliberate."
