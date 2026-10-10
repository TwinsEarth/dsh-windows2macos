#!/bin/bash
# ============================================================================
#  WireGuard hub for a W2M fleet -- rung 4 of the ladder in ../README.md
# ============================================================================
#
#  WHAT THIS IS FOR, AND WHAT IT IS NOT
#
#  It makes every machine reachable by a stable address (10.66.0.x) no matter what its NAT does,
#  encrypted, with no third-party coordination service. That is rung 4.
#
#  It is NOT a direct path between two machines behind NAT. WireGuard has no NAT traversal: with
#  both machines as peers of this hub, their traffic to each other is forwarded through this VPS.
#  Direct paths are rungs 2 and 3 of the ladder -- the simultaneous punch and the reverse dial --
#  which live in the plugin, not here. Stated plainly because a tunnel that reports `p2p` in the
#  ledger while the bytes cross a server is exactly the kind of thing that misleads an operator.
#
#  RUN IT ON THE ALWAYS-ON HOST (the shared server), as root, once:
#
#    bash server-setup.sh                 # keys are generated if absent, config is rewritten, wg0 up
#    bash server-setup.sh --client mac    # print one client config to paste into the WireGuard app
#
#  Idempotent: re-running keeps existing keys (so paired clients keep working) and only rewrites the
#  hub config and its peers.
# ============================================================================
set -euo pipefail

HUB_ADDRESS="${HUB_ADDRESS:-10.66.0.1/24}"
LISTEN_PORT="${LISTEN_PORT:-51820}"
KEYS=/etc/wireguard/keys
WG=/etc/wireguard/wg0.conf
# Client name -> tunnel address. Add a line here to add a machine.
CLIENTS=("win-desktop:10.66.0.2" "macmini:10.66.0.3")

# 51820 is WireGuard's default and the fleet's own punch port is deliberately somewhere else
# (41235 on this fleet) so the two never contend.
if [ "$(id -u)" != "0" ]; then echo "run as root (this writes /etc/wireguard and edits the firewall)" >&2; exit 1; fi

export DEBIAN_FRONTEND=noninteractive
command -v wg >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq wireguard wireguard-tools >/dev/null; }

umask 077
mkdir -p "$KEYS"
[ -f "$KEYS/server.key" ] || wg genkey > "$KEYS/server.key"
wg pubkey < "$KEYS/server.key" > "$KEYS/server.pub"
for entry in "${CLIENTS[@]}"; do
  name="${entry%%:*}"
  [ -f "$KEYS/$name.key" ] || wg genkey > "$KEYS/$name.key"
  wg pubkey < "$KEYS/$name.key" > "$KEYS/$name.pub"
done

# Print one client's config and exit -- the only thing a client needs from this host.
if [ "${1:-}" = "--client" ]; then
  name="${2:-}"
  address=""
  for entry in "${CLIENTS[@]}"; do [ "${entry%%:*}" = "$name" ] && address="${entry##*:}"; done
  [ -n "$address" ] || { echo "unknown client '$name'; known: ${CLIENTS[*]%%:*}" >&2; exit 1; }
  endpoint="${ENDPOINT:-$(curl -fsS -m 8 https://api.ipify.org)}"
  cat <<EOF
[Interface]
# $name -- rung 4 of the W2M delivery ladder (see deploy/networking/README.md)
PrivateKey = $(cat "$KEYS/$name.key")
Address = $address/24
# No DNS line on purpose: only $HUB_ADDRESS is routed, so your resolver stays untouched.

[Peer]
PublicKey = $(cat "$KEYS/server.pub")
Endpoint = $endpoint:$LISTEN_PORT
AllowedIPs = $(echo "$HUB_ADDRESS" | cut -d/ -f1 | awk -F. '{print $1"."$2"."$3".0/24"}')
PersistentKeepalive = 25
EOF
  exit 0
fi

{
  echo "# W2M rung 4: a private hub so the fleet is reachable whatever the NATs do."
  echo "# Traffic between clients is forwarded here -- WireGuard does not punch. See README.md."
  echo "[Interface]"
  echo "Address = $HUB_ADDRESS"
  echo "ListenPort = $LISTEN_PORT"
  echo "PrivateKey = $(cat "$KEYS/server.key")"
  echo "# No PostUp MASQUERADE: clients route only the tunnel subnet here, so nothing needs NATing"
  echo "# and none of their other traffic can leak through this host."
  echo "SaveConfig = false"
  echo
  for entry in "${CLIENTS[@]}"; do
    name="${entry%%:*}"; address="${entry##*:}"
    echo "[Peer]"
    echo "# $name"
    echo "PublicKey = $(cat "$KEYS/$name.pub")"
    echo "AllowedIPs = $address/32"
    echo
  done
} > "$WG"
chmod 600 "$WG"

sysctl -qw net.ipv4.ip_forward=1
grep -q '^net.ipv4.ip_forward=1' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
command -v ufw >/dev/null 2>&1 && ufw allow "$LISTEN_PORT/udp" >/dev/null || true

systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
systemctl restart wg-quick@wg0
sleep 2
systemctl is-active wg-quick@wg0
wg show
echo
echo "client configs: bash $0 --client <name>   (known: ${CLIENTS[*]%%:*})"
