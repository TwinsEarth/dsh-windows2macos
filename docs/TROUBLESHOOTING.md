# W2M troubleshooting — cross-region and cross-network deployments

> Companion to `DEPLOY.md`. Every entry follows the same shape:
> **symptom → cause → fix**, with the exact command that confirms the
> diagnosis.
>
> First move for any problem: ask the relay what it thinks.

```bash
curl <rabbitUrl>/healthz
```

A healthy relay answers with `ok: true` plus the fields this document refers to
repeatedly:

| Field | What it tells you |
|---|---|
| `relay_id` | a fresh id per process start — **changed means the relay restarted** |
| `started_at` | when this process started (RFC3339) |
| `effective_scheme` | `http` or `https` as the relay believes it is reached |
| `base_path` | the prefix the relay expects (`/` unless started with `--base-path`) |
| `operator_token_required` | whether sending work needs the operator token |
| `pair_rate_limit` | pairing attempts allowed per IP per minute |
| `persistence` | `{enabled, dir, revived_devices, revived_tasks, …}` |
| `devices` / `tasks` | how many machines are registered, how many tasks exist |

---

## 1. "It connects, but no events ever arrive"

**Symptom.** A machine pairs successfully, `w2m_devices` lists it, but task
offers never reach it. The local-side log shows the stream opening and then
nothing. The UI/agent sits idle. A `curl` against `/v1/stream` returns HTTP 200
and then hangs without a body.

**Cause.** A reverse proxy in the path is **buffering the event stream**.
Proxies buffer responses by default; a buffered stream delivers frames in
batches (or not at all, for a stream that stays open), so the connection looks
established while nothing flows. The relay sends `X-Accel-Buffering: no`, which
nginx honours automatically, but nginx still needs `proxy_buffering off` for
correctness, and **Caddy does not honour that header at all**.

**Fix.**

nginx — the stream location needs all three:

```nginx
location = /v1/stream {
    proxy_pass http://w2m_relay/v1/stream;
    proxy_buffering off;          # the fix
    proxy_read_timeout 86400s;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
}
```

Caddy — buffering is disabled with `flush_interval -1`:

```caddy
handle /v1/stream {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1          # the fix
        transport http { read_timeout 0 write_timeout 0 }
    }
}
```

Also set `gzip off` for the stream: compressing an event stream re-enables
buffering.

**Confirm the diagnosis.** Read the response headers through the proxy and
check they are still the relay's, not the proxy's:

```bash
curl -sS -D - -o /dev/null -N \
  -H "Authorization: Bearer <device_token>" \
  -H "Accept: text/event-stream" \
  https://w2m.<your-domain>/v1/stream
```

You should see `content-type: text/event-stream` and
`x-accel-buffering: no`. Then watch the stream and time the first frame — a
buffered proxy typically shows nothing for many seconds:

```bash
time curl -sS -N -H "Authorization: Bearer <device_token>" \
  https://w2m.<your-domain>/v1/stream | head -c 200
```

A correct proxy delivers a frame in well under a second. If the same command
against `http://127.0.0.1:8787/v1/stream` on the relay host is instant but the
proxied one is not, the proxy is the problem — not the relay, not the client.

---

## 2. Every `/v1/*` call returns 404 (`NOT_FOUND`)

**Symptom.** `/healthz` may work, but `/v1/pair`, `/v1/stream`, `/v1/devices`
and friends all return `404`. The body reads something like:

```json
{"error":{"code":"NOT_FOUND","message":"path is outside the configured base path /w2m","detail":{"path":"/v1/devices"}}}
```

**Cause.** A **base-path mismatch**. Either the relay is mounted under a prefix
but was started without `--base-path`, or the client's `rabbitUrl` is missing
the prefix the relay expects. There are four ways to get this wrong, and they
look identical from the client:

| Relay | Client `rabbitUrl` | Result |
|---|---|---|
| `--base-path /w2m` | `https://host/w2m` | correct |
| `--base-path /w2m` | `https://host` | 404 — client asks for `/v1/...`, relay only answers under `/w2m` |
| no `--base-path` | `https://host/w2m` | 404 — client asks for `/w2m/v1/...`, relay only answers at the root |
| `--base-path /w2m` **and** the proxy strips the prefix | `https://host/w2m` | 404 — the relay receives `/v1/...` and rejects it |

The fourth case is the one that bites hardest, because both the relay and the
client look correctly configured: the **proxy** is silently rewriting the path.
nginx strips a prefix when `proxy_pass` has a URI (`proxy_pass
http://relay/;`); Caddy strips it with `handle_path` instead of `handle`.

**Fix.** Decide which side owns the prefix and make all three agree.

1. Ask the relay what it expects:

   ```bash
   curl https://w2m.<your-domain>/healthz | grep -o '"base_path":"[^"]*"'
   # or, at the root:
   curl https://w2m.<your-domain>/w2m/healthz | grep -o '"base_path":"[^"]*"'
   ```

   `"base_path":"/"` means the relay is at the root and the tunnel/proxy must
   forward paths unchanged. `"base_path":"/w2m"` means the relay expects the
   prefix and the client must include it.

2. Make the client match:

   ```bash
   w2m-localside --rabbit https://<host>/w2m --pair ...   # prefix included
   w2m-localside --rabbit https://<host>       --pair ...   # root
   ```

3. Make the proxy pass the prefix through unchanged (nginx `proxy_pass
   http://w2m_relay;` with no URI; Caddy `handle`, not `handle_path`).

**Note.** `--base-path /w2m` keeps `/healthz` answering at **both**
`/healthz` and `/w2m/healthz` on purpose, because monitoring probes are often
pointed at the bare path. So a working `/healthz` does **not** prove the base
path is right — check `/v1/*`, or read `base_path` from `/healthz`.

**Related, easily confused:** `/v1/*` returning **401** is not this problem.
401 means the path was found and authentication was required — the base path is
correct and the credential is not.

---

## 3. Sending a task returns `401 OPERATOR_REQUIRED`

**Symptom.** `w2m_run` (or a direct `POST /v1/task`) fails with
`OPERATOR_REQUIRED`, while `w2m_devices`, `w2m_status` and taking work all
succeed on the same machine.

**Cause.** Two different credentials are being confused. In 0.1.2:

| Credential | Held by | Can do |
|---|---|---|
| `device_token` | every paired machine | take work, return results, read device/task state |
| `operator_token` | **only you** | **send work** (`POST /v1/task`) |

A `device_token` cannot dispatch tasks — deliberately, so that one compromised
executor cannot command the whole group. The relay's error message says exactly
this ("this is a device_token … dispatching tasks requires the operator_token"),
but the distinction is easy to miss if you only read the status code.

**Fix.** Put the operator token where the dispatching side can read it:

```bash
# 1. Find it. It is written at first start, mode 0600:
cat /var/lib/w2m/operator-token.txt

#    If the relay was started with --no-persist or the file is gone, read the
#    startup log instead (it prints the token once, on stderr):
journalctl -u w2m-rabbit | grep -A2 'operator token'
#    or, for a container:
docker compose -f deploy/docker/docker-compose.yml logs relay | grep -A2 'operator token'

#    Do NOT expect it in `--json` output: stdout carries only
#    "operatorTokenPresent": true|false, deliberately (a token in a log is a
#    leak). See docs/DEPLOY.md §8.

# 2. Give it to the dispatching side (environment or plugin config):
export W2M_OPERATOR_TOKEN=<token>

# 3. Confirm the relay requires it:
curl https://w2m.<your-domain>/healthz | grep -o '"operator_token_required":[a-z]*'
```

**What "correct" looks like** (measured against a live relay):

| Authorization header on `POST /v1/task` | Result |
|---|---|
| `Bearer <operator_token>` | `200` with a `task_id` |
| `Bearer <device_token>` | `401` with error code `OPERATOR_REQUIRED` |
| no header | `401` with error code `OPERATOR_REQUIRED` |
| `Bearer <anything else>` | `401` with error code `OPERATOR_REQUIRED` |

So a bare `401` on `POST /v1/task` while every other call works is **this**
problem, not a broken device token. The `error.code` in the body says
`OPERATOR_REQUIRED` and the message names the credential confusion.

**Only the dispatching machine needs this token.** Adding it to every executor
would let any one of them dispatch work, which is the exact scenario the split
exists to prevent. On the client side the flag that carries it is
`w2m-localside --operator-token <t>` (or `$W2M_OPERATOR_TOKEN`), and its own
`--help` says it is "only needed when this host also submits tasks; the
Localside agent itself never sends it". See `DEPLOY.md` §8.1.

**Escape hatch, for isolated debugging only:** `--operator-token ''` turns the
requirement off and prints a loud warning; `/healthz` then reports
`"operator_token_required": false`. Never do this on a reachable deployment.

---

## 4. `429 RATE_LIMITED` — or the limit that never triggers

This entry has two opposite symptoms and one shared cause: whether
`--trust-proxy` matches reality.

### 4a. Everyone gets rate-limited at once

**Symptom.** Pairing a new machine fails with `RATE_LIMITED`, even though you
have made fewer than `pair_rate_limit` attempts. A second machine pairing right
after the first fails immediately.

**Cause.** `--trust-proxy` is **off**, so the relay reads each client's IP from
the socket — which is the reverse proxy's or tunnel's loopback address for
every client. All machines therefore share one budget.

**Fix.** Start the relay with `--trust-proxy` when it sits behind a proxy or
tunnel you control, and make sure the proxy actually sets the header:

```bash
w2m-rabbit --host 127.0.0.1 --port 8787 --state /var/lib/w2m --trust-proxy
```

nginx must forward the client address (`deploy/nginx/w2m.conf.example` does):

```nginx
proxy_set_header X-Real-IP       $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

### 4b. The limit never triggers

**Symptom.** A public deployment accepts unlimited pairing attempts. Brute-forcing
a pairing code looks feasible.

**Cause.** Either `--trust-proxy` is on while the relay is **directly
reachable** — so a client can forge `X-Forwarded-For` and get a fresh budget per
request — or `pair_rate_limit` was set to `0` (disabled).

**Fix.** Keep `--trust-proxy` on only when the relay is *not* directly
reachable. In shape B that means the relay stays on `127.0.0.1` and only the
proxy listens on 443; confirm from outside:

```bash
nc -zv w2m.<your-domain> 443     # must succeed
nc -zv w2m.<your-domain> 8787    # must fail
curl https://w2m.<your-domain>/healthz | grep -o '"pair_rate_limit":[0-9]*'
```

A non-zero `pair_rate_limit` in `/healthz` means the limit is configured. `0`
means it is off; set it back (default `5`) unless you are on a private network.

**Reading a rejection.** The error body carries everything you need:

```json
{"error":{"code":"RATE_LIMITED",
          "message":"too many /v1/pair attempts from <ip>: limit is 2 per 60s",
          "detail":{"retry_after_seconds":60,"limit":2,"window_seconds":60}}}
```

The response is a real **`429`** with a `Retry-After: 60` header, so ordinary
HTTP retry logic works. `detail.retry_after_seconds` says how long to wait; the
message names the IP the relay counted against, which tells you immediately
whether it is the real client or the proxy. Successful pairings count toward the
limit as well, so scripted onboarding of many machines may need a higher
`--pair-rate-limit` (on a trusted network only).

---

## 5. Every machine must re-pair after the relay restarts

**Symptom.** The relay (or the VPS, or the container) restarts, and
`w2m_devices` comes back empty. Every machine has to be paired again, and any
stored `device_token` is now rejected with `401 UNAUTHORIZED`.

**Cause.** Persistence is off, or `--state` points somewhere ephemeral:

| Cause | How to recognise it |
|---|---|
| `--no-persist` was used | `/healthz` → `"persistence":{"enabled":false,"dir":null,…}` |
| `--state` points into `/tmp`, a container's writable layer, or a path that is wiped | `/healthz` → `"dir": "/tmp/…"` or a path you do not recognise |
| The state directory is not writable by the relay's user | `/healthz` → `persistence.warnings` non-empty, or `dir` set but nothing written |
| A systemd unit without `StateDirectory=` runs as a service user with no home | the directory does not exist after start |

**Fix.** Give the relay a durable directory and confirm the relay reports it:

```bash
# systemd: StateDirectory=w2m creates /var/lib/w2m and exports %S
w2m-rabbit --host 127.0.0.1 --port 8787 --state /var/lib/w2m

# container: mount a named volume
#   volumes: [ "w2m-state:/var/lib/w2m" ]
docker compose -f deploy/docker/docker-compose.yml exec relay ls -l /var/lib/w2m

# confirm what the relay actually used:
curl https://w2m.<your-domain>/healthz | grep -o '"persistence":{[^}]*}'
```

You should see `"enabled":true` and the directory you intended, holding:

| File | Contents |
|---|---|
| `devices.json` | machine table with device tokens |
| `ledger.jsonl` | task ledger (append-only, one JSON per line) |
| `operator-token.txt` | the operator token, mode 0600 |

**Confirm recovery worked.** Restart and check that the devices came back:

```bash
sudo systemctl restart w2m-rabbit
curl https://w2m.<your-domain>/healthz | grep -o '"revived_devices":[0-9]*'
```

`revived_devices` greater than zero means the device table was restored from
disk and existing device tokens remain valid — no re-pairing needed.

**If `devices.json` is corrupt**, the relay starts with an empty table and says
so (`persistence.devices_corrupt: true`) rather than failing to start. Pair
again, and restore from backup if you have one. A corrupt `ledger.jsonl` line is
skipped and counted in `ledger_lines_skipped`, with details in
`persistence.warnings` — the relay keeps running.

**Back up before you need it:**

```bash
sudo tar czf w2m-state-$(date +%F).tgz -C /var/lib w2m
```

---

## 6. The event stream disconnects frequently

**Symptom.** The local-side log shows the stream opening and closing
repeatedly, with backoff retries. Task offers are delayed or missed. The
`notice` frames mention reconnection attempts.

**Cause.** Something in the path is imposing an **idle timeout** shorter than
the stream's quiet periods, or the tunnel itself is dropping.

The relay keeps the stream alive with a `: keepalive` comment every 15 seconds,
which is enough for most proxies. Reconnects usually mean one of:

| Cause | Where to look |
|---|---|
| Proxy read timeout shorter than the gaps | nginx `proxy_read_timeout` (default 60s); Caddy `read_timeout` |
| Tunnel idle timeout on a free tier | the tunnel client's log; Cloudflare/ngrok both close idle connections |
| MTU / path issues on the tunnel | large frames stall while keepalives survive — see §6's note below |
| The relay restarted | `/healthz` `relay_id` changed; the client logs a `relay_id` change |

**Fix.**

1. Raise the proxy's read timeout past the keepalive interval — `86400s` in the
   provided nginx example, `read_timeout 0` in the Caddy example.
2. On a tunnel, prefer a stable named tunnel over a quick one, and check the
   tunnel client's own idle settings.
3. Treat reconnects as normal-but-visible: the client **is** designed to
   reconnect with jittered backoff, and it exposes the attempt number in a
   `notice` frame precisely so remote debugging does not require guessing.
   A handful of reconnects after a network blip is fine. A tight loop is not.

**Confirm the diagnosis.** Watch the stream and measure the gap between frames:

```bash
curl -sS -N -H "Authorization: Bearer <device_token>" \
  https://w2m.<your-domain>/v1/stream \
  | while IFS= read -r line; do printf '%s  %s\n' "$(date +%T)" "$line"; done
```

A healthy stream prints `: keepalive` roughly every 15 seconds and stays up. If
keepalives stop but the connection stays open, a proxy is buffering (see §1).
If the connection closes at a regular interval — 30s, 60s, 100s — that interval
is an idle timeout, and the component owning that number is the culprit.

**After a relay restart, expect one reconnect and a sequence reset.** The `ready`
frame carries the relay's `relay_id`; when it changes, the client clears its
local sequence cursor because old sequence numbers mean nothing in a new
process. If a stream is resumed and the relay no longer has the needed history,
the client receives `notice/REPLAY_TRUNCATED` with `oldest_available_seq`,
which tells it where to re-align instead of just "cannot catch up".

---

## 7. Latency is high — how high is too high?

**Symptom.** Tasks take noticeably longer to be picked up than on a LAN. The
question "is this normal for this link?" has no answer without numbers.

**How to measure.** `w2m_status` exposes the round-trip time the agent measures
on each heartbeat, kept as a rolling window of the last five samples
(`state.rttMs`). Ask for it from the model side:

```
w2m_status
```

and read `rttMs`. Cross-check the raw link with the platform tools:

```bash
# From a client machine to the relay
ping -c 5 <relay-host>                 # macOS/Linux
ping -n 5 <relay-host>                 # Windows
# TCP-level, which includes TLS handshake cost:
curl -o /dev/null -sS -w 'connect=%{time_connect}s tls=%{time_appconnect}s total=%{time_total}s\n' \
  https://w2m.<your-domain>/healthz
```

**What is normal.** Latitude, not hops, dominates — a same-continent link is
single-digit to low-tens of milliseconds; an intercontinental link is routinely
150–300 ms. Rough expectations:

| Path | Typical RTT | Notes |
|---|---|---|
| Same LAN / tailnet, same region | < 5 ms | if you see more, suspect the tunnel, not physics |
| Same continent, over the internet | 20–80 ms | normal |
| Cross-continent | 150–300 ms | normal; task *dispatch* latency is dominated by this |
| Cross-continent via a free tunnel | 200–500 ms | the tunnel adds a hop and a TLS handshake |
| Anything above ~500 ms sustained | investigate | usually a mis-routed tunnel edge, not distance |

**Interpretation.** RTT affects how quickly an offer reaches a machine, not how
long the command itself takes — the command runs locally on the target machine.
A 200 ms RTT added to a 30-second build is irrelevant; added to a hundred tiny
commands it is not. If `rttMs` is far above what `ping` reports, the difference
is handshake/TLS overhead, and reusing a stable connection (a named tunnel
rather than a quick one) is the fix.

**Persistent outliers.** If one machine has much higher `rttMs` than the
others, check whether it is going through a different tunnel edge or a relayed
(instead of direct) Tailscale path:

```bash
tailscale ping <relay-host>     # "via DERP" means a relayed path, not direct
```

---

## 8. Other things worth checking before you file a bug

| Symptom | Likely cause | First command |
|---|---|---|
| `401 UNAUTHORIZED` on every endpoint | the machine never paired, or the device token was replaced by a later pairing | check `$DSH_HOME/xclient/device.json` exists; re-pair |
| Two "machines" on one host share an identity | both processes share one `DSH_HOME` | give each a separate `DSH_HOME` (see `DEPLOY.md` §8) |
| `400 PAIRING_INVALID: unknown pairing code` | the code was already consumed (codes rotate after each successful pairing) or it expired | read the **current** code from the relay log |
| `/healthz` `relay_id` changes on every request | the relay is crash-looping and restarting | `journalctl -u w2m-rabbit -n 200` |
| `403` from the proxy, never reaching the relay | proxy-level rule (IP allow-list, WAF, auth) | check the proxy's own access log |
| The model-side tools report no machines | the plugin is pointed at a different relay, or the operator token is missing for dispatch | compare `rabbitUrl` with `curl <rabbitUrl>/healthz` |

**A note on which status code to trust.** The relay now returns correct HTTP
statuses — `401` for `UNAUTHORIZED` and `OPERATOR_REQUIRED`, `429` for
`RATE_LIMITED`, `404` for `NOT_FOUND` — **and** a JSON `error.code`. Use the
status for retry/backoff decisions and the code for diagnosis; the code is the
stable contract (`PROTOCOL.md`), the status is the HTTP-idiomatic view of it.
