#!/bin/bash
# ============================================================================
#  W2M shared server -- relay + STUN + reverse proxy, one command.
# ============================================================================
#
#  This is the script the shared server at 202.182.123.154 was deployed with (the
#  same steps, parameterised). It is idempotent: re-running it re-deploys the
#  package and restarts the services, which is how an upgrade is done.
#
#  Usage, on a fresh Debian/Ubuntu host as root:
#
#      curl -fsSL https://nodejs.org/... # not needed: this script installs Node itself
#      scp twinsearth-w2m-dsh-plugin-<version>.tgz root@<host>:/tmp/w2m-pkg.tgz
#      bash install.sh /tmp/w2m-pkg.tgz [PAIR-XXXXXXXX]
#
#  What it creates:
#      /opt/w2m/app                    the package (bin/, src/, lib/)
#      /var/lib/w2m/rabbit             relay state: devices.json, ledger, operator token
#      /etc/systemd/system/w2m-rabbit.service   relay on 0.0.0.0:8787
#      /etc/systemd/system/w2m-stun.service     STUN responder on 0.0.0.0:3478/udp
#      /etc/nginx/conf.d/w2m.conf      port 80 -> 127.0.0.1:8787, SSE-safe
#      ufw: 8787/tcp, 3478/udp
#
#  With a package tarball the archive root is `package/` (npm pack layout); a git
#  checkout tarball has no root directory. Both are handled below.
#
#  WHY THE RELAY BINDS 0.0.0.0 HERE, when deploy/systemd/w2m-rabbit.service
#  deliberately binds 127.0.0.1: on a *shared* server the relay IS the public
#  endpoint -- there is no private network in front of it and no TLS terminator
#  unless one is added. Port 80 through nginx is the same relay, so the two paths
#  differ in nothing but the port. See deploy/shared-server/README.md for the
#  security consequences, which are real: without TLS the operator token and every
#  result travel in clear text.
# ============================================================================
set -euo pipefail

PKG="${1:?usage: install.sh <package.tgz|checkout.tar.gz> [PAIR-XXXXXXXX]}"
PAIR_CODE="${2:-}"
RABBIT_PORT="${RABBIT_PORT:-8787}"
STUN_PORT="${STUN_PORT:-3478}"
NODE_DIR=/opt/node22
APP_DIR=/opt/w2m/app
STATE_DIR=/var/lib/w2m/rabbit
LOG_DIR=/var/log/w2m

say() { printf '\n== %s ==\n' "$1"; }

say "node"
if [ ! -x "${NODE_DIR}/bin/node" ]; then
  case "$(uname -m)" in
    x86_64) NODE_ARCH=linux-x64 ;;
    aarch64) NODE_ARCH=linux-arm64 ;;
    *) echo "unsupported architecture $(uname -m)"; exit 1 ;;
  esac
  NODE_VERSION=v22.14.0
  ( cd /tmp
    curl -fsSL -o "node.tar.xz" "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${NODE_ARCH}.tar.xz"
    mkdir -p "${NODE_DIR}"
    tar -xJf node.tar.xz -C "${NODE_DIR}" --strip-components=1
    rm -f node.tar.xz )
fi
ln -sf "${NODE_DIR}/bin/node" /usr/local/bin/node
ln -sf "${NODE_DIR}/bin/npm" /usr/local/bin/npm
node -v

say "package"
mkdir -p "${APP_DIR}" "${STATE_DIR}" "${LOG_DIR}"
STAGE="$(mktemp -d)"
tar -xzf "${PKG}" -C "${STAGE}"
if [ -d "${STAGE}/package/bin" ]; then APP_SRC="${STAGE}/package"; else APP_SRC="${STAGE}"; fi
[ -f "${APP_SRC}/bin/w2m-rabbit.mjs" ] || { echo "not a W2M package: ${PKG}"; exit 1; }
tar -C "${APP_SRC}" -cf - . | tar -C "${APP_DIR}" -xf -
rm -rf "${STAGE}"

if ! id w2m >/dev/null 2>&1; then useradd --system --home /var/lib/w2m --shell /usr/sbin/nologin w2m; fi
chown -R w2m:w2m /opt/w2m /var/lib/w2m "${LOG_DIR}"
node --check "${APP_DIR}/bin/w2m-rabbit.mjs"
node --check "${APP_DIR}/bin/w2m-stun.mjs"
echo "version: $(node -p "require('${APP_DIR}/package.json').version")"

say "services"
cat > /etc/systemd/system/w2m-rabbit.service <<UNIT
[Unit]
Description=W2M Rabbit relay (P2P rendezvous, signalling and task ledger)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=w2m
Group=w2m
WorkingDirectory=${APP_DIR}
ExecStart=/usr/local/bin/node ${APP_DIR}/bin/w2m-rabbit.mjs --host 0.0.0.0 --port ${RABBIT_PORT} --state ${STATE_DIR}
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/w2m
StandardOutput=append:${LOG_DIR}/rabbit.log
StandardError=append:${LOG_DIR}/rabbit.log

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/w2m-stun.service <<UNIT
[Unit]
Description=W2M STUN responder - reflexive address discovery for P2P hole punching
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=w2m
Group=w2m
ExecStart=/usr/local/bin/node ${APP_DIR}/bin/w2m-stun.mjs --host 0.0.0.0 --port ${STUN_PORT} --log-level info
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
StandardOutput=append:${LOG_DIR}/stun.log
StandardError=append:${LOG_DIR}/stun.log

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable w2m-rabbit w2m-stun >/dev/null
systemctl restart w2m-stun
systemctl restart w2m-rabbit
sleep 2
systemctl is-active w2m-rabbit w2m-stun

say "firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw allow "${RABBIT_PORT}/tcp" >/dev/null
  ufw allow "${STUN_PORT}/udp" >/dev/null
  ufw status | grep -E "${RABBIT_PORT}|${STUN_PORT}" || true
else
  echo "ufw not installed; open ${RABBIT_PORT}/tcp and ${STUN_PORT}/udp yourself"
fi

say "reverse proxy on :80"
if command -v nginx >/dev/null 2>&1; then
  cat > /etc/nginx/conf.d/w2m.conf <<NGINX
# Port 80 in front of the relay. \`proxy_pass\` with no URI passes the path through
# unchanged, so the relay needs no --base-path here. /v1/stream is SSE: buffering must
# be off and the read timeout must exceed the stream's lifetime.
upstream w2m_relay {
    server 127.0.0.1:${RABBIT_PORT};
    keepalive 16;
}

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    client_max_body_size 8m;

    location = /healthz {
        proxy_pass http://w2m_relay/healthz;
        proxy_set_header Host \$host;
        proxy_read_timeout 30s;
        access_log off;
    }

    location = /v1/stream {
        proxy_pass http://w2m_relay/v1/stream;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location / {
        proxy_pass http://w2m_relay;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
NGINX
  # Transactional: this host may already front something else.
  if nginx -t 2>/tmp/w2m-nginx-test.log; then
    systemctl reload nginx
    echo "nginx reloaded"
  else
    echo "nginx config test failed:"
    cat /tmp/w2m-nginx-test.log
    rm -f /etc/nginx/conf.d/w2m.conf
    exit 1
  fi
else
  echo "nginx not installed; the relay is still reachable directly on :${RABBIT_PORT}"
fi

say "health"
curl -fsS "http://127.0.0.1:${RABBIT_PORT}/healthz" >/dev/null && echo "relay: ok"
node -e "
import('${APP_DIR}/src/agent/stun.mjs').then(async (stun) => {
  const { socket } = await stun.bindUdpSocket();
  const one = await stun.stunQuery(socket, '127.0.0.1:${STUN_PORT}');
  console.log('stun :', one.ok ? 'ok reflexive=' + JSON.stringify(one.reflexive) : 'FAILED ' + one.error);
  socket.close();
});
"
echo "operator token: ${STATE_DIR}/operator-token.txt"

say "optional: this host as a fleet machine"
if [ -n "${PAIR_CODE}" ]; then
  DEMO=/opt/w2m/demo
  mkdir -p "${DEMO}"
  printf '* text=auto eol=lf\n' > "${DEMO}/.gitattributes"
  printf 'console.log("w2m-wan-ok");\n' > "${DEMO}/demo.mjs"
  ( cd "${DEMO}"
    git config --global --add safe.directory "${DEMO}" >/dev/null 2>&1 || true
    [ -d .git ] || git init -q -b main
    git -c user.email=w2m@localhost -c user.name=w2m add -A
    git -c user.email=w2m@localhost -c user.name=w2m commit -qm "w2m demo project" || true )
  chown -R w2m:w2m "${DEMO}" /var/lib/w2m
  # `--once` streams after pairing, so the pair run is bounded by timeout on purpose.
  timeout 25 sudo -u w2m env HOME=/var/lib/w2m DSH_HOME=/var/lib/w2m/.dsh \
    /usr/local/bin/node "${APP_DIR}/bin/w2m-localside.mjs" \
      --rabbit "http://127.0.0.1:${RABBIT_PORT}" --pair "${PAIR_CODE}" \
      --project "${DEMO}" --name "$(hostname)" --state /var/lib/w2m/localside \
      --allowed-commands '["node --version","node -e","git status --porcelain"]' >/tmp/w2m-pair.log 2>&1 || true
  grep -E 'paired|error' /tmp/w2m-pair.log | head -3 || true
  chown -R w2m:w2m /var/lib/w2m
  echo "pairing done; start the agent with:"
  echo "  sudo -u w2m env HOME=/var/lib/w2m node ${APP_DIR}/bin/w2m-localside.mjs --rabbit http://127.0.0.1:${RABBIT_PORT} --project ${DEMO} --name $(hostname) --state /var/lib/w2m/localside --allowed-commands '[\"node --version\"]'"
fi

say "done"
echo "relay : http://<host>:${RABBIT_PORT}   (also http://<host>/ through nginx)"
echo "stun  : <host>:${STUN_PORT}/udp"
