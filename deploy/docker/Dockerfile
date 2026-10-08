# ============================================================================
#  W2M relay (Rabbit) — multi-architecture container image
# ============================================================================
#
#  Build from the repository root (the COPY paths are relative to the context):
#
#      docker build -f deploy/docker/Dockerfile -t w2m-relay:0.3.4 .
#
#  Multi-arch, without needing the target hardware:
#
#      docker buildx build --platform linux/amd64,linux/arm64 \
#          -f deploy/docker/Dockerfile -t w2m-relay:0.3.4 .
#
#  ---------------------------------------------------------------------------
#  ZERO RUNTIME DEPENDENCIES — this is the reason the image is so small
#  ---------------------------------------------------------------------------
#  The relay declares `"dependencies": {}` and genuinely has none. Its complete
#  import closure is 7 files / ~175 KiB and resolves to exactly seven node:
#  builtins:
#
#      bin/w2m-rabbit.mjs -> src/relay/server.mjs, src/util/cli.mjs
#      src/relay/server.mjs -> state.mjs, persistence.mjs, report.mjs, ../signing.mjs
#      src/relay/{state,report,persistence}.mjs -> state.mjs
#      builtins: node:crypto node:fs node:http node:https node:os node:path node:util
#
#  Therefore **no package manager runs in this image** — there is no `npm
#  install`, no `npm ci`, no lockfile to go stale and no registry access at
#  build time. If a future change needs an npm package, that would break a core
#  project promise and should be raised, not added here.
#
#  `lib/` is deliberately absent: it is the DSH *plugin* entry
#  (`package.json` "main": "lib/index.js") and the relay CLI never imports it.
#  `cordis.patch.yml` is likewise plugin-host configuration, not relay runtime.
#
#  ---------------------------------------------------------------------------
#  PINNING
#  ---------------------------------------------------------------------------
#  The base tag is pinned to an exact patch release, not `22` or `latest`: a
#  floating tag makes two builds of the same commit produce different images.
#
#  `node:22.23.3-bookworm-slim` is the current 22.x LTS line (v22.23.3 released
#  2026-09-23, verified against https://nodejs.org/dist/index.json). The *tag's
#  existence in the registry* could not be checked from the authoring machine —
#  see deploy/docker/README.md, "What was verified".
#
#  For byte-for-byte reproducibility, pin the digest instead. Resolve it with:
#      docker buildx imagetools inspect node:22.23.3-bookworm-slim
#  and replace the FROM line with `node:22.23.3-bookworm-slim@sha256:<digest>`.
#  Note a digest names ONE platform, so a multi-arch build needs the per-arch
#  digests from the manifest list.
# ============================================================================

FROM node:22.23.3-bookworm-slim

# Fixed uid/gid so a bind-mounted state directory has predictable ownership on
# the host (a random uid would make `ls -l` on the host meaningless).
ARG W2M_UID=10001
ARG W2M_GID=10001

# `production` keeps any transitive tooling quiet and is honest about intent:
# nothing in this image is a dev dependency.
ENV NODE_ENV=production

# ---------------------------------------------------------------------------
# Runtime payload — exactly the import closure above, nothing else.
# ---------------------------------------------------------------------------
WORKDIR /app

# `--chown` takes the numeric uid/gid, which is portable (BuildKit and the
# classic builder both accept it) and avoids a separate `RUN chown -R /app`
# layer that would duplicate every file's bytes.
COPY --chown=10001:10001 bin/w2m-rabbit.mjs /app/bin/w2m-rabbit.mjs
COPY --chown=10001:10001 src/relay/ /app/src/relay/
COPY --chown=10001:10001 src/util/ /app/src/util/
COPY --chown=10001:10001 src/signing.mjs /app/src/signing.mjs

# ---------------------------------------------------------------------------
# Unprivileged user
# ---------------------------------------------------------------------------
# The uid/gid above are pinned by ARG, so keep the numbers in the COPY lines
# equal to the defaults here. (Docker cannot interpolate an ARG inside --chown,
# so if you change W2M_UID/W2M_GID you must change these four lines too.)
RUN groupadd --gid "${W2M_GID}" w2m \
 && useradd --uid "${W2M_UID}" --gid "${W2M_GID}" --no-create-home --shell /usr/sbin/nologin w2m \
 && mkdir -p /var/lib/w2m \
 && chown "${W2M_UID}:${W2M_GID}" /var/lib/w2m

USER w2m

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
# devices.json (device tokens), ledger.jsonl (task ledger) and
# operator-token.txt (0600) live here. Losing this volume means every paired
# machine must pair again, so it is a VOLUME rather than image content.
#
# /var/lib/w2m is also the relay's $HOME, which is where it falls back to
# `$HOME/.dsh/xclient/rabbit` when `--state` is not given — so the volume covers
# the default and the explicit path alike.
ENV HOME=/var/lib/w2m
VOLUME ["/var/lib/w2m"]

EXPOSE 8787

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
# GET /healthz needs NO credential, which is exactly why it is the right probe
# here: the container must be able to report itself healthy without holding the
# operator token (that token authorises SENDING work and must not leak into
# image configuration).
#
# `node -e` is used instead of curl/wget so the image needs no extra packages —
# keeping the "install nothing" property intact through the health check too.
#
# The probe is deliberately hard-coded to 8787. The container's listen port is
# fixed at 8787 and the *host* port is what varies (see docker-compose.yml), so
# this probe never needs to change. If you override the command's --port, you
# must override this HEALTHCHECK to match.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# ---------------------------------------------------------------------------
# How it starts
# ---------------------------------------------------------------------------
# `--host 0.0.0.0` is correct HERE and only here. Inside a container the loopback
# interface is unreachable from outside its network namespace, so a loopback
# bind would make the published port useless. Exposure is controlled by the port
# *mapping* instead — docker-compose.yml binds 127.0.0.1 on the host by default,
# so nothing is published to the outside world until the operator says so.
#
# TLS terminates in front of this container (nginx/Caddy on the host, or a
# tunnel), which is why the default invocation carries no --tls-cert/--tls-key:
# the relay behind a proxy speaks plain HTTP over a loopback-only VPS hop.
# `--trust-proxy` is NOT in the default command on purpose — turn it on only
# when a proxy you control really is in front, because with it on the relay
# believes X-Forwarded-For and a directly-reachable client could forge its
# address past the pairing rate limit.
#
# Add flags per deployment shape, e.g. behind nginx/Caddy:
#   docker run ... w2m-relay:0.3.4 --host 0.0.0.0 --port 8787 \
#       --state /var/lib/w2m --trust-proxy
ENTRYPOINT ["node", "/app/bin/w2m-rabbit.mjs"]
CMD ["--host", "0.0.0.0", "--port", "8787", "--state", "/var/lib/w2m"]
