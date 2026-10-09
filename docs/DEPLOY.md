# Deploying the W2M relay across regions and networks

> Version covered: **0.1.2** (protocol version stays **1**; 0.1.2 is a
> backwards-compatible addition — see `PROTOCOL-v0.1.2.md`).
>
> This document is the operational companion to the protocol spec. The spec
> says what the wire looks like; this says what to type.
>
> **Reading order**: §1 chooses your deployment shape. §2–§4 are the three
> shapes, each end-to-end. §5 is the `rabbitUrl` reference table. §6 covers
> SSE and reverse proxies. §7 is what was actually verified on the authoring
> machine, and what was not. §8 is the current implementation status.

---

## 0. The four shapes at a glance

| | **0. The shared server** (v0.4.0 default) | A. Tailscale / WireGuard | B. Public VPS + domain + TLS | C. Tunnel (Cloudflare / ngrok) |
|---|---|---|---|---|
| **TLS terminated by** | nothing — plaintext, stated up front | the network (WireGuard) | the relay (`--tls-cert`) **or** a proxy | the tunnel service |
| **Relay listens on** | `0.0.0.0:8787`, plus `:80` through nginx | the tailnet address, e.g. `100.x.y.z:8787` | `127.0.0.1:8787` (proxy) or `0.0.0.0:8443` (self-TLS) | `127.0.0.1:8787` |
| **Client `rabbitUrl`** | `http://202.182.123.154:8787` (already the default) | `http://100.x.y.z:8787` | `https://w2m.<your-domain>` | `https://<random>.example.com` or `https://<host>/w2m` |
| **Plaintext HTTP on the wire?** | **yes** — see §10 | **yes, and that is correct** — see §2.3 | no | no |
| **Certificate to manage** | none (and none to leak) | none | yes (Let's Encrypt or self-signed) | none (the tunnel service has one) |
| **Firewall opens** | 8787/tcp, 3478/udp (+80 for the proxy) | nothing (tailnet only) | 443 only | nothing inbound |
| **Best for** | getting two machines talking today, and as a fallback rendezvous | machines you own, private mesh | a stable public endpoint you control | quick access, no public IP, no DNS |
| **Main risk** | tokens and results are readable on the path; the allow-list is the load-bearing control | none added — but you must not bind `0.0.0.0` by mistake | a public hostname, so pairing/rate limits are your only fence | free tiers reconnect and rotate hostnames |

**All four need the same client-side step**: pair each machine with a pairing
code, then point it at the relay with `--rabbit` (or leave `rabbitUrl` empty for
shape 0).

---

## 1. Before you start: pick the relay host

The relay is a single process. Put it wherever it is reachable by every machine
that must take part, and where it can stay up:

| Situation | Recommended shape |
|---|---|
| You have neither a mesh nor a VPS, and want it working now | **0** — the shared server is already running, and it is the default |
| All machines can join a private mesh (Tailscale/WireGuard) | **A** — least moving parts, no certificates |
| You have a VPS and a domain | **B** |
| You have a public host but no domain | **0 with your own host** — `deploy/shared-server/install.sh` |
| You have neither, and want a throwaway | **C** |

Whichever you pick, three things stay true:

1. **The relay holds no project code and no model credentials.** It routes task
   envelopes. Compromise of the relay leaks the task ledger and device tokens,
   not your repository or your API key.
2. **The operator token is the only thing that can send work.** A paired
   machine can take work and return results, but cannot dispatch. See §5 of the
   protocol spec.
3. **State must survive restarts.** Devices and the task ledger live in
   `--state`; put it somewhere persistent or every restart forces every machine
   to pair again.

---

## 2. Shape A — Tailscale / WireGuard

### 2.1 Why this is the recommended shape

WireGuard (which Tailscale is built on) is a layer-3 encrypted tunnel: every
packet between two tailnet members is encrypted and authenticated with
WireGuard's own keys, and membership is controlled by your tailnet ACLs. The
relay's traffic never touches a public network in cleartext **even though the
relay itself speaks `http://`**.

### 2.2 Install and find the address

On the relay host (Linux shown; the same steps work on macOS, and on Windows
via the Tailscale tray app):

```bash
# Install (Debian/Ubuntu shown; see tailscale.com/download for others)
curl -fsSL https://tailscale.com/install.sh | sh

# Join the tailnet, then confirm it is up
sudo tailscale up
tailscale status

# The address the relay must bind, and clients must dial
tailscale ip -4
# => 100.x.y.z          (100.64.0.0/10 is the CGNAT range Tailscale uses)
```

Join every participating machine to the same tailnet the same way. From a
second machine, verify reachability before touching W2M:

```bash
tailscale ping <relay-host>          # should report a direct or relayed path
curl http://100.x.y.z:8787/healthz   # after step 2.4; refused before that is expected
```

### 2.3 Why plain HTTP over `100.x` is correct (read this if nothing else)

This is the one place the deployment looks wrong and is not.

- **The encryption is already there.** WireGuard encrypts and authenticates
  every packet between tailnet nodes with ChaCha20-Poly1305. Adding TLS on top
  would encrypt an already-encrypted stream.
- **TLS would add nothing an attacker can exploit the absence of.** The threat
  TLS defends against is a network attacker reading or modifying traffic in
  transit. On a WireGuard link there is no such position to occupy: an observer
  sees ciphertext, and cannot forge packets without a tailnet key.
- **TLS here would cost real things.** A certificate for a `100.x` address
  cannot be issued by a public CA (the address is not publicly resolvable), so
  you would either run a private CA and distribute its root to every machine,
  or use self-signed certificates and teach every client to skip verification.
  The second option is strictly worse than plain HTTP: it trains operators to
  ignore certificate errors, on a link that is already encrypted.
- **The relay's own token model still applies.** Device tokens and the operator
  token are enforced regardless of transport. TLS is not part of that model.

So: **bind the tailnet address, leave TLS off, and do not add a certificate.**

```bash
# Correct for shape A
w2m-rabbit --host 100.x.y.z --port 8787 --state /var/lib/w2m
```

### 2.4 Start the relay

```bash
# Foreground, to read the pairing code and operator token once.
# Without --json the banner below goes to stdout; WITH --json stdout is a single
# JSON line and every line shown here moves to stderr (see §8).
w2m-rabbit --host 100.x.y.z --port 8787 --state /var/lib/w2m
```

The startup output prints (measured on a live relay — the order below is the
real one):

```
[w2m-rabbit] listening on http://127.0.0.1:8787  pairing code: PAIR-65TWL21P
[w2m-rabbit] relay_id=68dfbfa9d982319a
[w2m-rabbit] base_path=/ (root)
[w2m-rabbit] trust_proxy=false (X-Forwarded-* ignored)
[w2m-rabbit] pair_rate_limit=5/min/IP
[w2m-rabbit] persistence=on dir=/var/lib/w2m revived_devices=0 revived_tasks=0
  ... plus a banner repeating the OPERATOR TOKEN, which is also written to
      <state>/operator-token.txt with mode 0600
```

With `--json`, all of the above goes to **stderr** and stdout carries exactly
one JSON line; the operator token is reported only as
`"operatorTokenPresent": true`. Read the token from
`<state>/operator-token.txt`, never from stdout.

- the **pairing code** (`PAIR-XXXXXXXX`) — hand this to each machine, once. It
  **rotates after every successful pairing**, and the new one is printed, so you
  can onboard several machines without restarting the relay.
- the **operator token** — **keep this secret**; it authorises sending work.
- the **`relay_id`** — a fresh id per process start; clients use it to notice a
  relay restart.

For a long-lived relay, install the systemd unit instead of leaving a terminal
open:

```bash
sudo install -m 0644 deploy/systemd/w2m-rabbit.service /etc/systemd/system/
# edit it first: replace @RELAY_BIN@ with your node path and the absolute
# path to bin/w2m-rabbit.mjs, and set --host to the tailnet address
sudo systemctl daemon-reload
sudo systemctl enable --now w2m-rabbit
journalctl -u w2m-rabbit -f
```

### 2.5 Pair each machine

On every machine that should take part (Windows, macOS, Linux):

```bash
w2m-localside \
  --rabbit http://100.x.y.z:8787 \
  --pair PAIR-XXXXXXXX \
  --project /path/to/the/project \
  --name <machine-name> \
  --allowed-commands '["node --test","git status"]'
```

- `--pair` is only needed once; the device token is stored afterwards.
- `--allowed-commands` is **default-deny**. With no allow-list, every offer is
  refused. Start read-only (`git status`, `node --test`) and widen deliberately.
- `--name` is how the machine appears in `w2m_devices`; use the hostname.
- **Do not add `--operator-token` here.** It is only for a host that also
  dispatches tasks; see §8.1.

### 2.6 Verify

```bash
# 1. The relay is alive and reachable from a client machine
curl http://100.x.y.z:8787/healthz

# 2. Every machine is registered (needs a device token; the client stores one
#    after pairing, under $DSH_HOME/xclient/)
curl -H "Authorization: Bearer <device_token>" http://100.x.y.z:8787/v1/devices

# 3. From the model side, the five tools should now list the machines:
#    w2m_devices
```

**What "healthy" looks like**: `/healthz` returns `ok: true`, `devices` matches
the number of machines you paired, and `relay_id` stays constant. If `relay_id`
changed since you last looked, the relay restarted (see `TROUBLESHOOTING.md`).

### 2.7 Risks and boundaries

- **Do not bind `0.0.0.0`.** On a machine that is also on a public or untrusted
  network, `0.0.0.0` exposes the relay to that network as well as the tailnet.
  Always name the tailnet address.
- **The pairing code is a bearer credential.** Anyone who can reach the relay
  and has the code can join. Codes rotate after each successful pairing, and
  `/v1/pair` is rate-limited per IP (`--pair-rate-limit`, default 5/minute).
- **Tailscale ACLs are your real fence.** Restrict which nodes may reach
  `100.x.y.z:8787`; do not rely on the relay's own limits for that.
- **`--trust-proxy` must stay off here.** There is no proxy, so no
  `X-Forwarded-*` header should be believed. Leaving it off means a malicious
  client cannot forge its address to escape the pairing rate limit.

---

## 3. Shape B — public VPS + domain + TLS

### 3.1 Pick who terminates TLS (exactly one)

| Option | Relay flag | When |
|---|---|---|
| **B1. Reverse proxy terminates TLS** (recommended) | none; relay stays on `127.0.0.1:8787` | you want certificate renewal, access logs and rate limiting in one familiar place |
| **B2. Relay terminates TLS itself** | `--tls-cert <fullchain.pem> --tls-key <privkey.pem>` | you want a single process with no proxy, and you will handle renewal yourself |

**Never both.** If a proxy terminates TLS and the relay also expects
`--tls-cert`, the proxy's plain-HTTP request hits a TLS listener and every
request fails.

### 3.2 DNS and firewall

```bash
# Point the name at the VPS (replace with your own values)
#   A     w2m.<your-domain>   ->  <vps-ipv4>
#   AAAA  w2m.<your-domain>   ->  <vps-ipv6>   (optional)
dig +short w2m.<your-domain>

# Open 443 (and 80 only if you use the HTTP-01 challenge for Let's Encrypt)
sudo ufw allow 443/tcp
sudo ufw allow 80/tcp
# The relay port itself must NOT be exposed: keep it on 127.0.0.1.
```

Confirm from outside that only 443 answers:

```bash
nc -zv w2m.<your-domain> 443
nc -zv w2m.<your-domain> 8787   # must fail/refuse
```

### 3.3 Certificate

**Let's Encrypt (recommended, needs a public name and port 80 or DNS-01):**

```bash
sudo apt install certbot
sudo certbot certonly --standalone -d w2m.<your-domain>
# or, with nginx already installed:
sudo certbot --nginx -d w2m.<your-domain>
# renewal is automatic via the certbot timer; verify with:
sudo certbot renew --dry-run
```

**Self-signed (only when every client machine is under your control):**

```bash
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout /etc/w2m/w2m.key -out /etc/w2m/w2m.crt \
  -subj "/CN=w2m.<your-domain>" \
  -addext "subjectAltName=DNS:w2m.<your-domain>"
chmod 600 /etc/w2m/w2m.key
```

A self-signed certificate is not trusted by clients. Either distribute the CA
to every machine, or accept that the local-side HTTP client will refuse the
connection. **Do not disable verification** — fix the trust instead.

### 3.4 Start the relay

**B1 — behind a proxy:**

```bash
w2m-rabbit \
  --host 127.0.0.1 --port 8787 \
  --state /var/lib/w2m \
  --trust-proxy
```

`--trust-proxy` is required here: without it the relay sees every connection as
coming from `127.0.0.1`, so the pairing rate limit becomes one shared budget for
the whole internet, and `effective_scheme` in `/healthz` stays `http`.

**B2 — self-terminating TLS:**

```bash
w2m-rabbit \
  --host 0.0.0.0 --port 8443 \
  --state /var/lib/w2m \
  --tls-cert /etc/letsencrypt/live/w2m.<your-domain>/fullchain.pem \
  --tls-key  /etc/letsencrypt/live/w2m.<your-domain>/privkey.pem
```

`--tls-cert` and `--tls-key` must be given together; giving one alone is a
usage error and the relay exits with code 2.

### 3.5 Install the reverse proxy

Copy `deploy/nginx/w2m.conf.example` to `/etc/nginx/conf.d/w2m.conf` (or
`deploy/caddy/Caddyfile.example` to `/etc/caddy/Caddyfile`), replace
`<your-domain>`, then **validate before reloading**:

```bash
sudo nginx -t && sudo systemctl reload nginx
# or
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

The nginx file carries the three SSE settings this deployment cannot work
without — see §6.

### 3.6 Point the model side at the relay, and pair machines

```bash
w2m-localside --rabbit https://w2m.<your-domain> --pair PAIR-XXXXXXXX \
  --project /path/to/project --name <machine-name> \
  --allowed-commands '["node --test","git status"]'
```

To send work from the model side, the plugin needs the operator token — on the
**dispatching** host only:

```bash
# On the host that runs w2m_run (not on every executor):
export W2M_OPERATOR_TOKEN=<read it from <state>/operator-token.txt>
# or set `operatorToken` in the plugin configuration
```

Do **not** copy this to machines that only execute work; see §8.1.

### 3.7 Verify

```bash
# From outside the VPS
curl https://w2m.<your-domain>/healthz
# => {"ok":true,...,"effective_scheme":"https","base_path":"/",...}

# The SSE route must deliver a frame immediately, not hang:
curl -N -H "Authorization: Bearer <device_token>" \
     -H "Accept: text/event-stream" \
     https://w2m.<your-domain>/v1/stream
# => a ready frame within a second, then ": keepalive" comments every ~15s
```

### 3.8 Risks and boundaries

- **The relay is now reachable by the whole internet.** Your fences are the
  pairing code, the per-IP pairing rate limit, and the two tokens. Keep
  `--pair-rate-limit` at its default or lower; never set it to `0` on a public
  host.
- **`--trust-proxy` is only correct behind a proxy you control.** With it on
  and the relay directly reachable, a client can forge `X-Forwarded-For` and
  get a fresh rate-limit budget per request. See §6.3.
- **HTTP, not just HTTPS, must be considered.** If port 80 stays open with a
  redirect, that is fine; if the relay itself is reachable on 8787, close it.
- **Single point of failure.** There is no relay HA and no multi-relay
  federation in 0.1.2. Back up `<state>/` so a rebuilt relay resumes the same
  device table.

---

## 4. Shape C — Cloudflare Tunnel / ngrok

This shape needs no public IP, no inbound firewall rule and no DNS record of
your own. The relay stays on `127.0.0.1:8787`; the tunnel client dials out.

### 4.1 Cloudflare Tunnel

```bash
# Install cloudflared (Debian/Ubuntu shown)
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
  https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared

# Authenticate once (opens a browser; needs a Cloudflare account)
cloudflared tunnel login

# Create a named tunnel and route a hostname to it
cloudflared tunnel create w2m
cloudflared tunnel route dns w2m w2m.<your-domain>

# Run it in the foreground first, to see errors directly
cloudflared tunnel run --url http://127.0.0.1:8787 w2m
```

> **Not verified on the authoring machine** — `cloudflared` is not installed
> there, so the commands above are written from Cloudflare's documented CLI and
> were not executed. Verify each one on the server before trusting it.

**Quick alternative, no account and no DNS** (a random `trycloudflare.com`
hostname, for a smoke test only — it changes on every restart):

```bash
cloudflared tunnel --url http://127.0.0.1:8787
# prints e.g.  https://<random-words>.trycloudflare.com
```

### 4.2 ngrok

```bash
# Install
curl -sSL https://ngrok.com/download | sudo tar -xz -C /usr/local/bin ngrok

# Authenticate with the token from your ngrok dashboard
ngrok config add-authtoken <your-ngrok-authtoken>

# Expose the relay
ngrok http 127.0.0.1:8787
# prints e.g.  Forwarding  https://<random-subdomain>.ngrok-free.app -> http://127.0.0.1:8787
```

> **Not verified on the authoring machine** — `ngrok` is not installed there.
> The `ngrok config add-authtoken` line above also needs **your own** token;
> this document deliberately does not contain one.

### 4.3 Which `rabbitUrl` to use

Read the hostname the tunnel printed and use **exactly** that:

```bash
# Cloudflare quick tunnel
w2m-localside --rabbit https://<random-words>.trycloudflare.com --pair ... 

# ngrok
w2m-localside --rabbit https://<random-subdomain>.ngrok-free.app --pair ...
```

### 4.4 Sub-path deployments — the easiest thing to get wrong

Both tunnel products can publish the relay under a **prefix** instead of at the
root of a hostname, for example `https://<host>/w2m/`. When they do, **two
places must agree**:

| Place | Value |
|---|---|
| Relay | `--base-path /w2m` |
| Client | `--rabbit https://<host>/w2m` |

If the relay is started without `--base-path` while the tunnel strips or
forwards a prefix, **every `/v1/*` call fails** — usually with `404 NOT_FOUND`,
or with a redirect loop if the tunnel adds one. The relay is explicit about
this: with `--base-path /w2m`, a request to `/v1/devices` is answered

```
404 {"error":{"code":"NOT_FOUND","message":"path is outside the configured base path /w2m"}}
```

while `/w2m/v1/devices` proceeds to authentication. That message is the
signature of this misconfiguration — see `TROUBLESHOOTING.md` §2.

Notes:

- `--base-path /w2m` also keeps `/healthz` answering at **both** `/healthz` and
  `/w2m/healthz`, because monitoring probes are often pointed at the bare path.
- A trailing slash in `rabbitUrl` is harmless: the client normalises
  `https://<host>/w2m/` and `https://<host>/w2m` to the same base.
- Do **not** configure the tunnel to strip the prefix while the relay also
  expects it (nginx `proxy_pass http://relay/;`, Caddy `handle_path`). Pick one
  side and be consistent.

### 4.5 `--trust-proxy` with a tunnel

Set it **only if the tunnel sets `X-Forwarded-For` and you control the tunnel**:

```bash
w2m-rabbit --host 127.0.0.1 --port 8787 --state /var/lib/w2m --trust-proxy
```

Without it, every client appears to come from `127.0.0.1`, so the pairing rate
limit is a single shared budget (and `/healthz` reports
`"effective_scheme":"http"` even though clients use `https`). With it on a
tunnel that does **not** set the header, the relay falls back to the socket
address, which is also fine.

### 4.6 The free-tier reality

- **Free tunnels disconnect.** Cloudflare quick tunnels and free ngrok tunnels
  are not uptime products: expect the connection to drop and the hostname to
  change across restarts. ngrok's free tier in particular shows an interstitial
  page on first browser visit and enforces session limits.
- **A rotating hostname means re-pairing is not required, but re-pointing is.**
  The device token survives, so a machine that reconnects to a *new* hostname
  still holds its credentials; what breaks is the configured `--rabbit` value.
  Pin a stable hostname (a named Cloudflare tunnel with your own DNS) before
  relying on this in daily use.
- **The tunnel provider sees your traffic.** TLS terminates at the tunnel edge,
  so the provider can read the relay's HTTP content. For project task payloads
  that may be acceptable; decide deliberately rather than by default.
- **Idle timeouts.** Both products close idle connections. The relay's SSE
  stream is idle apart from a `: keepalive` comment every 15s, which is usually
  enough to keep it open; if you see repeated reconnects, see
  `TROUBLESHOOTING.md` §6.

### 4.7 Risks and boundaries

- **A quick tunnel is a public URL** with no authentication beyond the relay's
  own tokens, and anyone who learns the hostname can reach `/v1/pair`. Keep the
  pairing rate limit on, and close the tunnel when you are done.
- **No inbound firewall change is needed** — that is the point — but the tunnel
  client itself becomes a process you must keep running and updated.
- **Do not use shape C as the permanent answer for a machine you can simply put
  on a tailnet.** Shape A has fewer moving parts and no third party in the
  data path.

---

## 5. `rabbitUrl` reference — what to put in each shape

The client takes a **base address**. It may include a sub-path; it must not
include a query string or a fragment.

| Shape | Relay started with | `rabbitUrl` (client `--rabbit`) | Notes |
|---|---|---|---|
| **A. Tailscale** | `--host 100.x.y.z --port 8787` | `http://100.x.y.z:8787` | plain HTTP on purpose (§2.3) |
| **B1. VPS, proxy terminates TLS** | `--host 127.0.0.1 --port 8787 --trust-proxy` | `https://w2m.<your-domain>` | no port: it is 443 |
| **B1′. VPS, proxy on a non-standard port** | same | `https://w2m.<your-domain>:8443` | port must match what clients dial |
| **B2. VPS, relay terminates TLS** | `--host 0.0.0.0 --port 8443 --tls-cert … --tls-key …` | `https://w2m.<your-domain>:8443` | `https`, and the port is required |
| **C1. Cloudflare named tunnel** | `--host 127.0.0.1 --port 8787` (no `--trust-proxy` needed) | `https://w2m.<your-domain>` | the tunnel's public hostname |
| **C2. Cloudflare quick tunnel** | same | `https://<random-words>.trycloudflare.com` | changes on every restart |
| **C3. ngrok** | same | `https://<random-subdomain>.ngrok-free.app` | changes unless you have a reserved domain |
| **C4. Any tunnel with a prefix** | `--host 127.0.0.1 --port 8787 --base-path /w2m` | `https://<host>/w2m` | **both sides must carry `/w2m`** |
| **Local development** | `--port 8787` (defaults to `127.0.0.1`) | `http://127.0.0.1:8787` | the default; nothing else to configure |

**Illegal and rejected at startup** (the client fails loudly, naming
`rabbitUrl`, rather than silently degrading):

```
https://w2m.<your-domain>?token=x      # query string
https://w2m.<your-domain>#frag         # fragment
ftp://w2m.<your-domain>                # not http/https
```

**Rule of thumb:** the value you pass must be the exact prefix under which
`/healthz` answers. Verify with:

```bash
curl <rabbitUrl>/healthz
```

If that returns `ok: true`, the base address is right, and the client will
build `<rabbitUrl>/v1/stream` correctly.

---

## 6. SSE and reverse proxies

The event stream (`GET /v1/stream`) is the part of W2M that reverse proxies
break most often, because it is a long-lived, chunked, mostly-idle HTTP
response, and proxies are optimised for the opposite.

The relay already helps: every SSE response carries

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

verified by reading the live response headers. `X-Accel-Buffering: no` is
honoured by nginx automatically. **Caddy does not honour it** (it is an
nginx-specific convention), so Caddy needs `flush_interval -1` explicitly.

### 6.1 nginx — the three settings

From `deploy/nginx/w2m.conf.example`:

```nginx
location = /v1/stream {
    proxy_pass http://w2m_relay/v1/stream;
    proxy_buffering off;          # 1. send frames immediately
    proxy_read_timeout 86400s;    # 2. do not time out a long-lived response
    proxy_http_version 1.1;       # 3. chunked transfer, required for SSE
    proxy_set_header Connection "";
}
```

Dropping any one produces a different symptom:

| Missing setting | What the operator sees |
|---|---|
| `proxy_buffering off` | connects, HTTP 200, **no events ever arrive** (the classic "connected but dead") |
| `proxy_read_timeout` long enough | stream dies after the default 60s of quiet |
| `proxy_http_version 1.1` | stream ends immediately after the first frame |

Also set `gzip off` for the stream location: compressing an event stream makes
nginx buffer it again.

### 6.2 Caddy

```caddy
handle /v1/stream {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
        transport http {
            read_timeout 0
            write_timeout 0
        }
    }
}
```

Caddy handles HTTP/2 and TLS correctly by itself; the only SSE-specific
requirement is `flush_interval -1`.

### 6.3 `--trust-proxy`, both sides of it

**Turn it on only when the relay is behind a proxy or tunnel you control.**

| | `--trust-proxy` off (default) | `--trust-proxy` on |
|---|---|---|
| Client IP used for `/v1/pair` rate limiting | the socket address | first entry of `X-Forwarded-For` |
| `/healthz` `effective_scheme` | the actual listener scheme | `X-Forwarded-Proto` |
| Behind a proxy | **every client shares one rate-limit budget** (`127.0.0.1`) | correct per-client budgets |
| Exposed directly | safe | **a client can forge `X-Forwarded-For` and get unlimited pairing attempts** |

So the two failure modes are symmetric, and both are visible in `/healthz`:

- Rate limiting that never triggers on a public deployment → you forgot
  `--trust-proxy`.
- `429 RATE_LIMITED` for all clients at once → `--trust-proxy` is off, so they
  share the loopback budget.

A rate-limit rejection is now a proper `429` with a `Retry-After: 60` header and
`detail.retry_after_seconds`, so ordinary retry logic works without special
cases.

---

## 7. What was verified, and what was not

This section exists so you can tell an untested claim from a tested one.

### Verified on the authoring machine (Windows, Node 24.21.0)

Each item was executed against the real relay process, not read from source.

| Check | Result |
|---|---|
| Runtime layout the Dockerfile installs (`package.json`, `bin/`, `src/`, `lib/`, `cordis.patch.yml` copied into a clean dir) | relay starts and serves |
| `GET /healthz` field set | all 0.1.2 fields present, incl. `relay_id`, `started_at`, `effective_scheme`, `base_path`, `operator_token_required`, `pair_rate_limit`, `persistence{...}` |
| `POST /v1/pair` with an auto-generated code | `200` + `device_token` |
| `w2m-localside --pair <code>` (the real client) | pairs, stores the device token, opens the stream, `/healthz` `devices` becomes 1 |
| `--base-path /w2m` | `/w2m/healthz` **and** `/healthz` → `200`; `/w2m/v1/devices` → `401` (correct: auth required); `/v1/devices` → `404 NOT_FOUND` with "path is outside the configured base path" |
| `--operator-token <t>` on `POST /v1/task` | operator token → `200` + `task_id`; device token / none / wrong → `401 OPERATOR_REQUIRED` |
| `--pair-rate-limit 2` | 3rd attempt → `429 RATE_LIMITED` with `retry_after_seconds: 60`, `limit: 2`, and a `Retry-After: 60` header |
| `--trust-proxy` | `/healthz` `effective_scheme` follows `X-Forwarded-Proto` (`https` → `https`) |
| `--no-persist` | `persistence.enabled: false`, no state directory created |
| Persistence across restart | `devices.json`, `ledger.jsonl`, `operator-token.txt` written; after a restart `revived_devices: 1` and the **same** device token still authenticates (`200`) |
| `--tls-cert` without `--tls-key` | usage error, exit code `2` |
| `--json` stdout purity | exactly **one** JSON line, `JSON.parse` succeeds, diagnostics on stderr, and the token value appears **nowhere** on stdout |
| `--json` after a pairing-code rotation | still exactly one line, still parseable (the rotation notice goes to stderr) |
| `--json` field set | `operatorTokenPresent: true` and **no** `operatorToken` key |
| `w2m-localside --operator-token` | accepted; `--help` documents it as needed only when the host also submits tasks |
| SSE response headers | `text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` all observed on a live response |
| Structural checks on all four deploy files | braces/quotes/directive termination balanced; the required SSE directives present; placeholder discipline clean (script: `check-configs.mjs`, kept in the task work directory) |

### NOT verified here — verify on your server

| Claim | Why it was not verified | How to verify |
|---|---|---|
| `nginx -t` accepts `deploy/nginx/w2m.conf.example` | nginx is not installed on the authoring machine | `sudo nginx -t` after installing the file |
| `caddy validate` accepts `deploy/caddy/Caddyfile.example` | caddy is not installed | `caddy validate --config Caddyfile` |
| `systemd-analyze verify` accepts `deploy/systemd/w2m-rabbit.service` | systemd is not available on Windows | `sudo systemd-analyze verify /etc/systemd/system/w2m-rabbit.service` |
| `docker build` / `docker compose config` | docker is not installed | `docker build -f deploy/docker/Dockerfile -t w2m-relay:0.1.2 .` then `docker compose -f deploy/docker/docker-compose.yml config` |
| `cloudflared` and `ngrok` command sequences (§4.1, §4.2) | neither tool is installed | run them on the server; both are quick to smoke-test with `--url`/`http` |
| TLS termination end-to-end (B2) | no certificate was available for a routable name | `curl -v https://w2m.<your-domain>/healthz` |
| Tailscale reachability (§2) | Tailscale is not installed | `tailscale ping <relay-host>`, then `curl http://100.x.y.z:8787/healthz` |

---

## 8. Current implementation status (0.1.2, re-measured 2026-10-07)

The deployment material in this directory targets the 0.1.2 contract in
`PROTOCOL-v0.1.2.md`. Every behaviour this document relies on was re-measured
against a live relay process, and at the time of writing **all of it is
implemented**:

| Behaviour | Measured result |
|---|---|
| `--base-path /w2m` | `/w2m/healthz` **and** `/healthz` → `200`; `/w2m/v1/devices` → `401`; `/v1/devices` → `404 NOT_FOUND` naming the base path |
| `--trust-proxy` | `/healthz` `effective_scheme` follows `X-Forwarded-Proto` |
| `--operator-token` | `POST /v1/task`: operator token → `200`; device token / none / wrong → **`401`** `OPERATOR_REQUIRED` |
| `--pair-rate-limit` | over-limit → **`429`** `RATE_LIMITED`, `retry_after_seconds: 60`, and a `Retry-After: 60` header |
| `--pairing-code <fixed>` | fixed code registered (`pairing_codes: 1`) and accepted (`200`) — use this for unattended/automated pairing |
| `--no-persist` | `persistence.enabled: false`, no state directory created |
| Persistence across restart | `devices.json` / `ledger.jsonl` / `operator-token.txt` written; after a restart `revived_devices: 1` and the **same** device token still authenticates |
| `/healthz` v0.1.2 fields | all present, including a non-null `relay_id` |
| `--tls-cert` without `--tls-key` | usage error, exit code `2` |
| SSE headers | `text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` |

### `--json` output contract

`--json` is meant to be piped into a log or a parser, so the contract is
narrow and worth relying on:

- **stdout is exactly one line of JSON** — no banner, no diagnostics, and no
  extra line even after a pairing-code rotation. `JSON.parse(stdout.trim())`
  works; `ConvertFrom-Json` in PowerShell works.
- **every diagnostic goes to stderr**, including the listening banner, the
  `relay_id`/`base_path`/`pair_rate_limit` lines, the pairing-code rotation
  notice, and the operator token.
- **the operator token never appears on stdout.** The JSON reports
  `"operatorTokenPresent": true|false` and nothing more.

Measured fields (live relay, 0.1.2):

```json
{"event":"listening","url":"http://127.0.0.1:8787","publicUrl":"http://127.0.0.1:8787",
 "host":"127.0.0.1","port":8787,"scheme":"http","basePath":"/","stateDir":"/var/lib/w2m",
 "persist":true,"trustProxy":false,"pairRateLimit":5,
 "operatorTokenRequired":true,"operatorTokenPresent":true,
 "pairingCode":"PAIR-XXXXXXXX","relayId":"<hex>","protocolVersion":1}
```

`operatorToken` deliberately has **no** value field: `--json` is exactly what
people redirect into a file (`> relay.log`), and a credential in a log is a
leak. To obtain the token, read `<state>/operator-token.txt` (mode 0600) or
watch stderr — both are outside the machine-readable stream. If you need the
token in an automated flow, read the file, not stdout.

### Known rough edges

1. **`POST /v1/pair` does not echo `machine_id`.** A successful pairing returns
   exactly `{device_token, protocol_version, rabbit_time, next_pairing_code}` —
   verified live — even though the `machine_id` you sent is stored and the
   device works. A script that wants the id must call `/v1/devices` or read it
   from the client's stored identity. This is accepted behaviour, not a
   pending fix: the client already knows its own `machine_id`.
2. **`w2m-localside --state <dir>` does not move `device.json`** — intentional,
   see below.

### Three behaviours that look like bugs but are intentional

- **`w2m-localside --state <dir>` does not move `device.json`.** Machine
  identity and `device_token` always live at `$DSH_HOME/xclient/device.json`;
  `--state` controls only spool/runtime files. This is deliberate: identity
  must follow `DSH_HOME` so that two profiles on one machine cannot share a
  `machine_id` (early versions did, and the second pairing silently evicted the
  first machine's token). **To simulate two machines on one host, give each a
  different `DSH_HOME`:**
  ```bash
  DSH_HOME=/tmp/w2m-machine-a w2m-localside --rabbit ... --name machine-a ...
  DSH_HOME=/tmp/w2m-machine-b w2m-localside --rabbit ... --name machine-b ...
  ```
- **The operator token is not in the `--json` stream.** See the contract above:
  `operatorTokenPresent` is a boolean, and the value lives in
  `<state>/operator-token.txt` (0600) and on stderr. That is a deliberate
  credential-hygiene choice, not a missing field.
- **Only a machine that dispatches needs the operator token.** A machine that
  only executes work needs a device token, which pairing gives it. Configure the
  operator token on the dispatching host only; putting it on every executor
  would widen the blast radius of one compromised machine for no benefit. See
  §8.1 for the client-side flag that carries it.

### 8.1 Client side: where the operator token goes

`w2m-localside` accepts `--operator-token <t>` (or `$W2M_OPERATOR_TOKEN`). Read
its own `--help` wording, because it states the boundary precisely:

```
--operator-token <t>      Operator token (or $W2M_OPERATOR_TOKEN). Only needed
                          when this host also submits tasks; the Localside
                          agent itself never sends it.
```

That is exactly the rule:

| Machine's role | Operator token needed? |
|---|---|
| Executes work only (takes offers, returns results) | **No** — pairing gives it a device token, which is all it uses |
| Also dispatches tasks (the host running `w2m_run`) | **Yes** — via `--operator-token`, `$W2M_OPERATOR_TOKEN`, or the plugin's `operatorToken` config |
| The relay host itself | Only if you also dispatch from there |

Two things worth knowing about the implementation:

- The agent **never sends** the operator token on its own requests. It is made
  available to the host's submit-capable side; the relay still sees only device
  tokens on machine traffic. Configuring it does not widen what the machine can
  do on the wire by itself.
- The startup log records only that it is configured and its **length**, never
  its value — so a localside log is safe to share.

**Do not** put `--operator-token` on every machine. The whole point of the
device/operator split (protocol §5) is that one compromised executor cannot
command the group; handing the operator token to every executor removes that
property.

### Automated (unattended) pairing

`--pairing-code <fixed>` registers the code you supply, so a provisioning script
can pair machines without scraping the log for a rotating code:

```bash
# Relay: pin the code for an automated rollout
w2m-rabbit --host 127.0.0.1 --port 8787 --state /var/lib/w2m \
           --pairing-code "$W2M_PAIRING_CODE"

# Client: pair with the pinned code
w2m-localside --rabbit https://w2m.<your-domain> --pair "$W2M_PAIRING_CODE" \
              --project /srv/project --name "$(hostname)" \
              --allowed-commands '["node --test"]'
```

Verified: the pinned code is registered (`/healthz` → `pairing_codes: 1`), a
pairing request with it returns `200`, and the response carries the next
rotated code. Keep the pinned code out of shell history and out of the
repository — pass it through an environment variable as above.

---

## 9. Where to go next

- `TROUBLESHOOTING.md` — cross-region symptoms, causes and fixes (including the
  P2P fallback reasons and the allow-list trap, §9 and §10 there).
- `PROTOCOL-v0.4.0.md` — the current wire additions: path selection, the shared
  server's constants, the announce/punch/offer flow and the `transport` fields.
- `PROTOCOL-v0.1.2.md` — the wire contract shape B and C were written against.
- `README.md` — what W2M is and how the eight tools are used.

---

## 10. Shape 0 — the shared server

v0.4.0 ships a default rendezvous so that "install it and try it" does not begin
with provisioning a host. With an empty `rabbitUrl` the plugin and the agent use:

| Constant | Value |
|---|---|
| `SHARED_SERVER.rabbitUrl` | `http://202.182.123.154:8787` |
| `SHARED_SERVER.stun` | `202.182.123.154:3478` (first entry of the default STUN list) |

Precedence: `rabbitUrl` in the profile patch → `W2M_RABBIT_URL` → the shared
default. `w2m_status` reports which one was used (`rabbit_source`).

**What is running there.** The relay (`:8787`, and `:80` through nginx), an
RFC 5389 STUN responder (`:3478/udp`), and — for this project's own verification —
a Localside agent, so the host is also a machine in the fleet. `deploy/shared-server/`
builds exactly this on a fresh host:

```bash
scp twinsearth-w2m-dsh-plugin-0.4.0.tgz root@<host>:/tmp/w2m-pkg.tgz
scp deploy/shared-server/install.sh      root@<host>:/tmp/
ssh root@<host> 'bash /tmp/install.sh /tmp/w2m-pkg.tgz [PAIR-XXXXXXXX]'
```

**TLS: there is none, and this document will not pretend otherwise.** Without a
hostname there is nothing to issue a certificate for. Pairing codes, device
tokens, the operator token and every result cross the wire in clear text. What
limits the damage:

* the payload path is the direct one when the network allows it, so the relay sees
  the ledger rather than the traffic (`transport` says which happened);
* the relay holds no project code and no model credentials — it can forge tasks,
  and the machine-side allow-list is the load-bearing control;
* the operator token is a bearer credential: treat it as compromised if the path is
  hostile, and rotate it by deleting `operator-token.txt` and restarting the relay.

To add TLS, point a subdomain at the host, issue a certificate (the nginx block the
installer writes already serves `/` on :80 for the HTTP-01 challenge), and add the
443 server from `deploy/nginx/w2m.conf.example`. Only `rabbitUrl` changes on the
machines.

**Verify it, rather than trusting it:**

```bash
# the relay answers, with the shared server's identity in the reply
curl -fsS http://202.182.123.154:8787/healthz | head -c 200
curl -fsS http://202.182.123.154/healthz       | head -c 120   # the :80 path

# the STUN responder answers, and this number is what the punch will aim at
node -e "import('./src/agent/stun.mjs').then(async (s) => {
  const { socket } = await s.bindUdpSocket();
  console.log(await s.stunQuery(socket, '202.182.123.154:3478')); socket.close(); })"
```

If the second command reports an address, the responder is reachable from where
you are. If you then run `discoverReflexive` against it **and two public STUN
servers** and the three mapped ports differ, your network is symmetric and the
punch cannot succeed from it — see `TROUBLESHOOTING.md` §9. That is a property of
your network, not of this deployment.

