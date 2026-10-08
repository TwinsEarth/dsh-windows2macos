# Running the W2M relay in Docker

The relay is a single dependency-free `node:http` server. This directory builds
it into an image, and the image installs **nothing from npm** — that is not an
optimisation, it is the project's zero-runtime-dependency promise carried into
the container.

| File | What it is |
|---|---|
| `Dockerfile` | The image: `node:22.23.3-bookworm-slim` + 7 source files, non-root, state as a volume |
| `docker-compose.yml` | A runnable example with the state volume, port mapping, healthcheck and restart policy |
| `README.md` | This file |
| `../../.github/workflows/docker.yml` | CI job that builds `linux/amd64` **and** `linux/arm64` |

---

## 1. The image installs nothing — here is the proof

The relay's complete import closure is **7 files / ~175 KiB**, and every module
it reaches is a `node:` builtin:

```
bin/w2m-rabbit.mjs
  -> src/relay/server.mjs      -> src/relay/state.mjs
                              -> src/relay/persistence.mjs
                              -> src/relay/report.mjs
                              -> src/signing.mjs
  -> src/util/cli.mjs
builtins used: node:crypto node:fs node:http node:https node:os node:path node:util
```

No module specifier in that closure is a bare package name. Consequently the
Dockerfile contains **no `npm install`, `npm ci`, `pnpm`, `yarn` or `corepack`**,
and there is no `node_modules` in the image at all. `package.json` still declares
`"dependencies": {}`.

You can re-derive this yourself at any time:

```bash
# Closure + Dockerfile audit (kept outside the repo so it is not packed into
# the published tarball; path is the task work directory on the authoring machine)
node E:/DS/_work/xclient/task-29/verify-no-docker.mjs
```

…or with nothing but grep, which is what the CI job does:

```bash
grep -nE '^[[:space:]]*(RUN[[:space:]]+)?(npm|pnpm|yarn|corepack)[[:space:]]+(install|ci|add|i)\b' deploy/docker/Dockerfile \
  && echo 'FAIL: a package manager appeared in the image' \
  || echo 'no package-manager install in the Dockerfile'
```

**Why `lib/` is not copied.** `package.json`'s `main` is `lib/index.js`, which is
the *DSH plugin* entry point for a host running `w2m_devices`/`w2m_run`. The relay
CLI never imports it, so it stays out. `cordis.patch.yml` is likewise plugin-host
configuration, not relay runtime.

---

## 2. Build

From the **repository root** — the COPY paths are relative to the build context:

```bash
# Single architecture (your machine)
docker build -f deploy/docker/Dockerfile -t w2m-relay:0.3.4 .

# Both supported architectures, without needing the hardware
docker buildx build --platform linux/amd64,linux/arm64 \
    -f deploy/docker/Dockerfile -t w2m-relay:0.3.4 .
```

The base tag is pinned to an exact patch release (`node:22.23.3-bookworm-slim`),
not `22` and not `latest`, so two builds of the same commit produce the same
image. For byte-for-byte reproducibility, resolve the digest and pin that
instead:

```bash
docker buildx imagetools inspect node:22.23.3-bookworm-slim
# then: FROM node:22.23.3-bookworm-slim@sha256:<digest>
```

A digest names a single platform, so a **multi-arch** build needs the per-arch
digests from the manifest list rather than one digest on the `FROM` line.

---

## 3. Run

### With compose (recommended)

```bash
docker compose -f deploy/docker/docker-compose.yml up -d --build
docker compose -f deploy/docker/docker-compose.yml ps
```

### With plain docker

```bash
docker volume create w2m-state
docker run -d --name w2m-relay \
    -p 127.0.0.1:8787:8787 \
    -v w2m-state:/var/lib/w2m \
    --restart unless-stopped \
    w2m-relay:0.3.4
```

The container listens on **`0.0.0.0:8787`** unconditionally. That is correct
inside a container: a loopback bind would be unreachable from outside the
container's network namespace, making the published port useless. Exposure is
controlled by the port **mapping** — `127.0.0.1:8787:8787` means only this host
can reach it, which is what you want whenever a proxy or tunnel runs alongside.

> **Keep the internal port at 8787 in every deployment.** The image `HEALTHCHECK`
> probes `127.0.0.1:8787`. If you must change `--port`, override the healthcheck
> too, or the container will report unhealthy while serving fine.

---

## 4. Read the pairing code — the first thing an operator needs

The relay prints it at startup, so it is in the container log:

```bash
# compose
docker compose -f deploy/docker/docker-compose.yml logs relay | grep -i 'pairing code'

# plain docker
docker logs w2m-relay 2>&1 | grep -i 'pairing code'
```

Measured output, both streams shown:

```
# stderr  — the machine-readable line
[w2m-rabbit] listening on http://127.0.0.1:8787  pairing code: PAIR-AXNJSSQD

# stdout  — the human banner, same code
  ┌──────────────────────────────────────────────┐
  │  配对码 / PAIRING CODE:  PAIR-AXNJSSQD       │
  └──────────────────────────────────────────────┘
    w2m-localside --rabbit http://127.0.0.1:8787 --pair PAIR-AXNJSSQD \
                  --project <path-to-project> --name <machine-name>
```

Then pair each machine (on the machine, not in the container):

```bash
w2m-localside --rabbit http://<relay-host>:8787 --pair PAIR-AXNJSSQD \
    --project /path/to/project --name <machine-name> \
    --allowed-commands '["node --test"]'
```

**The code rotates after every successful pairing**, and the relay prints the
next one, so you can onboard several machines without restarting.

**Two traps:**

- `docker logs w2m-relay 2>/dev/null` drops the stderr line that carries the
  code. `docker logs` merges both streams by default; add `2>&1` when you redirect.
- The banner uses box-drawing characters and does not always render in a
  non-UTF-8 terminal. Grep for `PAIR-` (or `pairing code`) instead of eyeballing
  it.

### Also in the log: the operator token

The operator token is what authorises **sending** work. It is printed once at
startup and written to `<state>/operator-token.txt` with mode `0600`:

```bash
docker compose -f deploy/docker/docker-compose.yml exec relay \
    cat /var/lib/w2m/operator-token.txt
```

Only the machine that *dispatches* tasks needs it. A machine that only executes
work needs just its device token, which pairing gives it.

> The log therefore contains a credential. It is the fastest way to recover a
> pairing code after a restart, but treat the log file as sensitive: the compose
> example bounds it to 5 × 10 MB for that reason.

---

## 5. Verify

### Is it alive?

```bash
docker compose -f deploy/docker/docker-compose.yml ps      # look for (healthy)
```

`/healthz` requires **no token** — that is exactly why it is the probe:

```bash
# from the host
curl -fsS http://127.0.0.1:8787/healthz | head -c 200

# from inside the container, which is what HEALTHCHECK runs
docker exec w2m-relay node -e \
  "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
  && echo healthy || echo unhealthy
```

Measured response shape (`200 application/json`):

```json
{"ok":true,"protocol_version":1,"relay_id":"…","started_at":"…",
 "effective_scheme":"http","base_path":"/","operator_token_required":true,
 "pair_rate_limit":5,"persistence":{"enabled":true,"dir":"/var/lib/w2m",
 "revived_devices":0,"revived_tasks":0},"signing":{…},"rtt":{…}}
```

`relay_id` is the field to watch across restarts: a changed value means the
process restarted, which invalidates clients' sequence cursors (they resync
automatically).

### Is the state volume being used?

```bash
docker compose -f deploy/docker/docker-compose.yml exec relay ls -l /var/lib/w2m
# operator-token.txt immediately; devices.json and ledger.jsonl after first pairing

curl -fsS http://127.0.0.1:8787/healthz | grep -o '"persistence":{[^}]*}'
```

### Does it survive a restart?

```bash
docker compose -f deploy/docker/docker-compose.yml restart relay
curl -fsS http://127.0.0.1:8787/healthz | grep -o '"revived_devices":[0-9]*'
```

`revived_devices` greater than zero means the device table came back from the
volume and existing device tokens are still valid — no re-pairing.

### Is the image actually multi-arch?

```bash
docker buildx imagetools inspect w2m-relay:0.3.4
docker run --rm --platform linux/arm64 w2m-relay:0.3.4 --help
```

(The second command needs QEMU registered on the host, e.g. via
`docker run --privileged --rm tonistiigi/binfmt --install arm64`.)

---

## 6. Deployment shapes

All three shapes run the same image. Only the port binding and the flag list
change. The compose file documents each one inline; the summary:

| Shape | Port binding | Extra relay flags | TLS terminates |
|---|---|---|---|
| **A. Tailscale / WireGuard** | `100.x.y.z:8787:8787` (tailnet only) | none — **do not** set `--trust-proxy` | the network (WireGuard); plain HTTP over 100.x is correct |
| **B. Public VPS + domain** | `127.0.0.1:8787:8787` (default) | **`--trust-proxy` required** | nginx/Caddy on the host, on 443 |
| **C. Cloudflare Tunnel / ngrok** | `127.0.0.1:8787:8787` (default) | `--trust-proxy` if the tunnel sets `X-Forwarded-*`; add `--base-path /w2m` if it publishes a prefix | the tunnel service |

**TLS terminates at the proxy, not here.** The image ships no certificate and no
`--tls-cert`; the hop from the proxy to the container is a loopback-only VPS
hop. That is also why the compose default binds `127.0.0.1` — the relay has no
TLS and no authentication beyond its tokens, so it must not be directly
reachable.

`--trust-proxy` is deliberately **not** in the default command. Turning it on
makes the relay believe `X-Forwarded-For` and `X-Forwarded-Proto`; with it on
and the relay directly reachable, a client can forge its address and get a fresh
pairing-rate-limit budget per request. Turn it on when a proxy you control is
genuinely in front — which is Shape B and usually Shape C.

---

## 7. What was verified

Docker is **not installed** on the machine these files were authored on
(`docker --version` → not found; likewise `podman`, `buildah`, `nerdctl`), and
Docker Hub is unreachable from it. Everything below is therefore split into what
was actually executed and what was not.

### Verified by execution

| Check | Result |
|---|---|
| Every `COPY` source exists in the repo | 4/4 sources present |
| The Dockerfile's COPY set covers the relay's real import closure | 7/7 closure files covered — no missing transitive import |
| Nothing is copied that the relay never loads | 1 exception, reported below |
| No package manager anywhere in the Dockerfile | none; `package.json` still `"dependencies": {}` |
| Base image is an exact patch tag | `node:22.23.3-bookworm-slim`; **the Node version is verified** (v22.23.3 is the current 22.x LTS, released 2026-09-23, per `https://nodejs.org/dist/index.json`) |
| Non-root `USER`, `COPY --chown=<uid>:<gid>`, state `VOLUME`, `HEALTHCHECK` on `/healthz`, `--host 0.0.0.0` | all present (numeric `--chown` so the classic builder and BuildKit behave the same) |
| `docker-compose.yml` parses as YAML with `services.relay`, a named volume, healthcheck, `restart: unless-stopped`, port mapping, volume mount | all present |
| `.github/workflows/docker.yml` parses as YAML | one job; uses `setup-qemu` + `setup-buildx` + `build-push-action`; `platforms: linux/amd64,linux/arm64`; `push: false`; `cache-from/to: type=gha`; no registry named |
| No credential **value** in the compose file | only `${…}` references and commented examples |

**Ran the container's command for real.** The exact CMD was executed against a
copy of the exact COPY set:
`node /app/bin/w2m-rabbit.mjs --host 0.0.0.0 --port 8891 --state <dir>`

| Result | Value |
|---|---|
| Relay started | yes |
| `GET /healthz` with no token | `200 application/json` |
| The `HEALTHCHECK` command string | exit code `0` |
| Pairing code on stderr | `PAIR-FFBO727A` (also on stdout in the banner) |
| State directory after start | `operator-token.txt` |
| `GET /` and `GET /v1/devices` with no token | `401 UNAUTHORIZED` (correct) |

This is strong evidence the image would start, **but it is not a build**: it
exercises the file set, not the Docker layer stack, and it ran on Windows under
Node 24 rather than inside Linux under Node 22.

### UNVERIFIED — needs Docker or a registry

| Item | Why it is unverified |
|---|---|
| `docker build` succeeds at all | Docker not installed |
| `docker buildx build --platform linux/amd64,linux/arm64` succeeds | Docker not installed; the arm64 leg additionally needs QEMU |
| `node:22.23.3-bookworm-slim` **exists in the registry** | Docker Hub is unreachable from this machine (`auth.docker.io`, `registry-1.docker.io`, `hub.docker.com` all time out). The version number is verified; the tag's presence is not |
| The `HEALTHCHECK` transitions a real container to `(healthy)` | needs the Docker health daemon |
| `docker compose config` accepts the compose file | Compose not installed — the file was validated structurally instead |
| `docker compose up` starts the service and the volume is writable as uid 10001 | needs Docker |
| The multi-arch manifest actually contains both platforms | needs a build or a registry push |
| The GitHub Actions workflow runs green | needs a runner; only its YAML and inputs were checked |
| Any **push** | there are no registry credentials in this repository, and the workflow sets `push: false` on purpose |

### Reported, not fixed

`src/relay/metrics.mjs` is copied into the image but **nothing imports it**: the
relay's import closure does not include it, and `GET /metrics` returns `401`
(the auth gate, not a metrics route). It is an untracked work-in-progress file
for the v0.3.3 "metrics" item — `CHANGELOG.md` lists metrics as still untouched.

It is harmless today (a few KB of dead payload). The Dockerfile copies
`src/relay/` as a directory rather than four named files so that wiring metrics
up later cannot silently produce an image missing a module; the cost is that the
directory's contents are not individually reviewed. If you would rather the
image contain only what runs, replace the `src/relay/` COPY with the four
current files (`server.mjs`, `state.mjs`, `persistence.mjs`, `report.mjs`) — but
then any new relay module must be added there in the same change that imports it.
