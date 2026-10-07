# ============================================================================
#  W2M relay container image
# ============================================================================
#
#  A deliberately small image. The relay is a dependency-free `node:http`
#  server (package.json declares `"dependencies": {}`), so no package manager
#  runs at build time and there is no lockfile to go stale.
#
#  Build (from the repository root, so the COPY paths resolve):
#      docker build -f deploy/docker/Dockerfile -t w2m-relay:0.1.2 .
#
#  Verified how: docker is not installed on the authoring machine, so this
#  image was NOT built here, and `docker build` / `docker compose config` were
#  NOT run. What WAS verified locally is the runtime layout this file installs:
#  the same file set (`package.json`, `bin/`, `src/`, `lib/`,
#  `cordis.patch.yml`) was copied into a clean directory and the relay was
#  started from it successfully -- see docs/DEPLOY.md, "What was verified".
#
#  ---------------------------------------------------------------------------
#  WHY `node:22-bookworm-slim`, NOT `node:22-alpine`
#  ---------------------------------------------------------------------------
#  The relay has no native dependencies, so alpine would work, but alpine's
#  musl libc has bitten enough Node deployments that this file defaults to the
#  Debian-based image. Switch to node:22-alpine if image size matters more than
#  that (small) risk.
#
#  NOTE ON ENVIRONMENT VARIABLES: the relay reads exactly two from the
#  environment -- `DSH_HOME` (state directory fallback) and the two documented
#  W2M_* fallbacks `W2M_BASE_PATH` / `W2M_OPERATOR_TOKEN`. Everything else is a
#  command-line flag, so this image passes the bind address and port as
#  arguments rather than pretending they are env-driven.
# ============================================================================

FROM node:22-bookworm-slim

# The relay runs unprivileged. UID/GID are pinned so a bind-mounted state
# directory has predictable ownership on the host.
ARG W2M_UID=10001
ARG W2M_GID=10001

ENV NODE_ENV=production

WORKDIR /app

# --- runtime payload --------------------------------------------------------
# Only what the relay loads at run time. `test/`, `scripts/`, `docs/`,
# `deploy/` and the markdown files stay out: they are documentation and CI
# surface, not runtime.
COPY package.json /app/package.json
COPY bin/ /app/bin/
COPY src/ /app/src/
COPY lib/ /app/lib/
COPY cordis.patch.yml /app/cordis.patch.yml

# --- unprivileged user ------------------------------------------------------
RUN groupadd --gid "${W2M_GID}" w2m \
 && useradd --uid "${W2M_UID}" --gid "${W2M_GID}" --no-create-home --shell /usr/sbin/nologin w2m \
 && mkdir -p /var/lib/w2m \
 && chown -R w2m:w2m /var/lib/w2m /app

USER w2m

# --- state volume -----------------------------------------------------------
# devices.json (device tokens), ledger.jsonl (task ledger) and
# operator-token.txt (0600) live here. Losing this volume means every machine
# must pair again, so mount it.
VOLUME ["/var/lib/w2m"]

EXPOSE 8787

# --- health check -----------------------------------------------------------
# /healthz is the relay's unauthenticated liveness endpoint. `node -e` is used
# rather than curl/wget so the image needs no extra packages. The port is
# hard-coded to match CMD below; change both together.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# --- how it starts ----------------------------------------------------------
# `--host 0.0.0.0` is correct HERE and only here: inside a container the
# loopback interface is not reachable from outside the container's network
# namespace, so a loopback bind would make the published port useless. The
# container's exposure is controlled by the port mapping (see
# docker-compose.yml, which binds 127.0.0.1 on the host by default).
#
# TLS is terminated by the reverse proxy or tunnel in front, so the relay
# itself never needs --tls-cert/--tls-key in this image's default invocation.
#
# Override the whole command when the deployment shape needs more flags, e.g.
#   docker run ... w2m-relay:0.1.2 \
#       --host 0.0.0.0 --port 8787 --state /var/lib/w2m \
#       --base-path /w2m --trust-proxy
CMD ["--host", "0.0.0.0", "--port", "8787", "--state", "/var/lib/w2m"]
