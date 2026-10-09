# The shared server

One always-on host that gives every machine in the fleet the two things a machine behind
NAT cannot provide for itself: **a place to meet** (rendezvous + signalling + the task
ledger) and **an honest answer about its own address** (a STUN responder, so a hole punch
has somewhere to aim).

This directory deploys that host in one command. It is the same sequence the public
instance was built with.

## What runs where

| Component | Listens | Why it is there |
|---|---|---|
| `w2m-rabbit` (relay) | `0.0.0.0:8787` tcp | Pairing, the SSE downlink, task offers, the result ledger, `POST /v1/peer/announce` and `GET /v1/peer/{machine_id}` — the rendezvous the punch needs |
| `w2m-stun` | `0.0.0.0:3478` udp | Answers "what address and port does the world see me as", which is the address a peer must aim at |
| nginx | `:80` tcp | A second path to the same relay on a port that is open on most hosts, with SSE-safe settings (`proxy_buffering off`, 24 h read timeout on `/v1/stream`) |
| (optional) `w2m-localside` | outbound only | Makes the server itself a machine in the fleet — useful for a cross-region check that does not involve a second laptop |

Everything is outbound from the machines' point of view. The server never dials a machine;
it answers, and it introduces peers to each other.

## Install

```bash
scp twinsearth-w2m-dsh-plugin-<version>.tgz root@<host>:/tmp/w2m-pkg.tgz
scp deploy/shared-server/install.sh root@<host>:/tmp/
ssh root@<host> 'bash /tmp/install.sh /tmp/w2m-pkg.tgz'          # relay + STUN + proxy
ssh root@<host> 'bash /tmp/install.sh /tmp/w2m-pkg.tgz PAIR-XXXXXXXX'   # ... and join the fleet
```

The pairing code comes from the relay's first start (`journalctl -u w2m-rabbit` or
`/var/log/w2m/rabbit.log`); it rotates after each successful pairing.

Then point every machine at it — in v0.4.0 that is the **default**, so an empty `rabbitUrl`
already means "the shared server":

```yaml
- id: w2m
  config:
    rabbitUrl: 'http://202.182.123.154:8787'   # optional: this is the default anyway
    operatorToken: '<from /var/lib/w2m/rabbit/operator-token.txt>'
    p2pMode: auto
```

## The two decisions worth knowing

**1. The relay binds `0.0.0.0`, unlike `deploy/systemd/w2m-rabbit.service`.** That template
binds loopback on purpose, because on a private host something else terminates TLS or the
network is already encrypted. A *shared* server has no such thing in front of it: it is the
public endpoint. Binding loopback would mean the machines cannot reach it at all, so the
public port is the point rather than an oversight. Port 80 through nginx reaches exactly the
same relay; the two differ in nothing but the port number.

**2. There is no TLS on the reference instance, and that is a real, stated cost.** Without a
hostname there is nothing to issue a certificate for. Everything the relay sees — pairing
codes, device tokens, the operator token, task offers and every result — crosses the wire in
clear text. What can be said honestly about the exposure:

* the two sockets that matter most for a fleet are still the machines' own: with the direct
  path up, the payload does not traverse the relay at all (`transport` says which path a task
  actually took);
* the relay is not a shell: it can forge tasks, and the machine-side allow-list is the
  load-bearing control;
* the operator token is a bearer credential in clear text. Treat it as compromised if the
  path is hostile, and rotate it by deleting `operator-token.txt` and restarting the relay.

**To add TLS**, point a subdomain at the host (`w2m.example.com`), then run certbot with the
webroot inside the nginx block this script installs, and add the `listen 443 ssl` server from
`deploy/nginx/w2m.conf.example`. Nothing on the machines has to change except `rabbitUrl`.

## Verify the deployment

```bash
# 1. the relay answers
curl -fsS http://127.0.0.1:8787/healthz | head -c 200

# 2. the relaying is real: pair a machine and watch it appear
curl -fsS -H "Authorization: Bearer $(cat /var/lib/w2m/rabbit/operator-token.txt)" ...   # needs a device token, not the operator token

# 3. STUN answers through the responder (the number it returns is the NAT's opinion of you)
node -e "import('/opt/w2m/app/src/agent/stun.mjs').then(async (s) => {
  const { socket } = await s.bindUdpSocket();
  console.log(await s.stunQuery(socket, '<host>:3478')); socket.close(); })"
```

A healthy instance answers all three. From a machine **behind another network**, run
`src/agent/stun.mjs`'s `discoverReflexive` against two or three servers: if every server
reports the same mapped port, the network is `endpoint-independent` and punching can work; if
each reports a different one, the network is `endpoint-dependent` (symmetric) and the punch
cannot succeed **from that network** whatever the server does. Measured, and written down
rather than discovered later: the reference client network (China Mobile) is
`endpoint-dependent`, so it falls back to the relay — which is exactly why `auto` and not
`direct` is the default.

## Operating it

```bash
systemctl status w2m-rabbit w2m-stun
journalctl -u w2m-rabbit -f
tail -f /var/log/w2m/rabbit.log /var/log/w2m/stun.log
```

* State lives in `/var/lib/w2m/rabbit` (`devices.json` + `ledger.jsonl`), so a restart keeps
  every paired machine and the task history. Losing that directory means every machine pairs
  again — see `docs/TROUBLESHOOTING.md`.
* `ufw` needs `8787/tcp` and `3478/udp`; port 80 only if you use the proxy path.
* Upgrades are the same command: fetch the new tarball, run `install.sh` again. The relay
  restarts; machines reconnect on their own (the agent's stream reconnects with backoff).
