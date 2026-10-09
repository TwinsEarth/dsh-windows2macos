# W2M Protocol — v0.3.9: P2P hole punching

> Status: **the transport is implemented and tested; the task-path integration is
> partial.** Read §7 before relying on it. Protocol version stays **1** — v0.3.9
> adds endpoints and an out-of-band channel, and removes nothing.

## 0. Why

v1 is a star: every task offer and every result crosses the relay. That is what
makes it work through NAT with no inbound port and no `sshd`, and it is also the
design's two real costs — the relay carries all payload traffic, and it is a single
point of failure for every byte.

v0.3.9 adds a direct path. Both machines send to each other's reflexive address at
the same time, which opens both NAT mappings, and the payload then travels
peer-to-peer. The relay keeps doing what only it can do: rendezvous, the task
ledger, and the fallback.

## 1. Path selection

| `p2p.mode` | Behaviour |
|---|---|
| `auto` (**default**) | Discover, announce, try to punch. On success use the direct path. On failure use the relay and **say so**. |
| `direct` | Require the direct path. If the punch fails, the task fails with `P2P_UNAVAILABLE`. No silent fallback. |
| `relay` | Never attempt a direct path. Byte-for-byte the v0.3.8 behaviour. |

`auto` is the default because punching **cannot** succeed against a symmetric NAT.
That is not a theoretical caveat: measured on the authoring machine behind an iPhone
hotspot, three STUN servers reported three different mapped ports for the same
socket, i.e. endpoint-dependent mapping, so no punch from that network can work.
A default that hard-required the direct path would break every deployment on such a
network the moment it was upgraded.

### 1.1 Path reporting is mandatory, not decorative

Every offer and every result carries the path it actually took:

```json
{ "transport": "p2p",    "p2p": { "rtt_ms": 14.2, "peer": "203.0.113.7:51234" } }
{ "transport": "relay",  "p2p": { "reason": "P2P_PUNCH_TIMEOUT", "attempts": 8 } }
```

A fallback that is not reported is indistinguishable from a direct path that is
slow, and the operator then debugs the wrong thing. `w2m_wait` surfaces the field
per machine.

## 2. Discovery — STUN (RFC 5389)

Each machine, holding the same UDP socket it will later punch from:

1. sends a Binding Request to every configured STUN server in turn;
2. reads `XOR-MAPPED-ADDRESS` from the Binding Success Response;
3. classifies **mapping behaviour** by comparing the mapped port across servers:

| Observation | `mapping` | Punchable |
|---|---|---|
| server reports the socket's own address and port | `none` | yes (no NAT) |
| every server agrees on one port | `endpoint-independent` | yes |
| different port per server | `endpoint-dependent` | **no** — this is a symmetric NAT |
| fewer than two answers | `unknown` | attempted anyway |

`unknown` is attempted on purpose: one unreachable STUN server must not be the
reason a direct path is never tried. The punch is the test.

**Only mapping behaviour is detected.** Filtering behaviour (address-restricted vs
port-restricted cone) would need a second host to probe from, and claiming to
detect what was not probed is the failure mode this project refuses elsewhere.
**IPv4 only** in v0.3.9.

## 3. Signalling — two new endpoints

### 3.1 `POST /v1/peer/announce` — device token

```json
{ "candidates": [ { "address": "203.0.113.7", "port": 51234 },
                  { "address": "192.168.1.20", "port": 51234 } ],
  "nat": { "mapping": "endpoint-independent" },
  "ttl_ms": 60000 }
```

* The entry is keyed by the **authenticated** `device.machine_id`. A `machine_id`
  in the body is ignored: otherwise any paired machine could aim a peer's punch at
  a third party.
* `address` must be dotted-quad IPv4 (no leading zeros, no hostnames, no IPv6);
  `port` must be 1–65535. At most **16** candidates.
* `ttl_ms` is clamped to 1000 … 600000; the default is 60000.

### 3.2 `GET /v1/peer/{machine_id}` — device token

`200` with `{ peer: { machine_id, candidates, nat, announced_at, expires_at } }`,
or `404 NOT_FOUND` when the machine has never announced or its announcement expired.
A **named 404 rather than an empty list**: "nobody has announced" and "announced
nothing usable" require different responses from the caller, and an empty list would
send it into a punch that cannot work.

### 3.3 Announcements are ephemeral and never persisted

A candidate *is* a NAT mapping, and the mapping dies with the process that held it.
Persisting candidates would survive a restart and then hand out addresses that cannot
work. `/healthz` reports the live count as `peers_announced`.

## 4. Punching

Both peers send a `HELLO` to every one of the other's candidates every 250 ms until
one gets through (default timeout 5 s). The peer that receives a `HELLO` replies
`HELLO_ACK` and considers the path open — the arrival of a datagram is the entire
question the punch was asking. A peer that was never told about the initiator can
still answer, which is what lets the relay broker a punch with no extra round trip.

### 4.1 The session id

Every frame carries a 32-bit session id, so frames from an earlier punch are ignored
rather than corrupting a new one. Two peers that each invented their own id would
each discard the other's `HELLO` and time out while both insist they were sending —
which looks exactly like a NAT problem. So:

* both peers MUST pass the same `session`, normally from `deriveSession(...)` over
  inputs both already share (the task id and the two machine ids);
* a peer that has no session may pass `allowSessionAdoption: true` and adopt the
  initiator's id, echoing it back;
* `punch()` **throws** if neither is given, rather than generating one and failing
  later with a misleading diagnosis.

## 5. Channel framing

```
u8  kind
u32 session
... body
```

| kind | id | body |
|---|---|---|
| `HELLO` | 1 | — |
| `HELLO_ACK` | 2 | — |
| `DATA` | 3 | `u32 messageId, u32 fragmentIndex, u32 fragmentTotal, payload` |
| `ACK` | 4 | `u32 messageId, u32 fragmentIndex` (selective, per fragment) |
| `DONE` | 5 | `u32 messageId` |
| `PING` | 6 | — |
| `PONG` | 7 | — (the answer to `PING`, and never a `PING`) |
| `BYE` | 8 | — |

* Payload is at most **1160 bytes** per fragment, keeping a frame inside 1200 so it
  passes a 1280-byte IPv6 minimum MTU and a 1500-byte Ethernet MTU with room for a
  WireGuard tunnel.
* Every fragment is acknowledged and retransmitted (RTO 300 ms, doubling to 3 s,
  at most 8 attempts, window 32). A message is delivered only when all fragments
  have arrived.
* Messages sent **one at a time** arrive in order; concurrent `send()` calls may
  complete in either order.
* Largest message: 8 MiB (a single stdout sample is capped at 2 MiB upstream).
* `PING` is answered with `PONG`. Answering with `PING` makes two peers bounce
  datagrams between them forever, and the loop looks exactly like healthy keep-alive.

## 6. Security

* Signalling requires a **device token**; the two new routes are covered by the
  existing `v0.3.0` request-signing layer when it is enabled.
* A machine can only announce for itself (§3.1).
* Candidate addresses are validated (IPv4 shape, port range, count ceiling) because
  this is the one place where a peer supplies an address that another peer will send
  UDP datagrams to.
* **The P2P channel is not authenticated.** Session ids are random 32-bit values and
  UDP source addresses are spoofable. Do not treat a direct path as more trustworthy
  than the relay path: correlate payloads with the task they belong to, and enable
  request signing if the threat model includes an on-path attacker. This is stated
  rather than fixed because fixing it properly needs the `v0.3.0` signing secret to
  be available on both machines, which is a separate design decision.

## 7. What is verified, and what is not

**Verified on macOS 27.0 / arm64, Node 24.21.0:**

| Item | Evidence |
|---|---|
| STUN against real public servers | Cloudflare, Google and Nextcloud all answered; `XOR-MAPPED-ADDRESS` decoded correctly |
| NAT mapping classification | measured `endpoint-dependent` on an iPhone hotspot (three servers, three ports) |
| Wire format, including a frozen captured response | `test/p2p-stun.test.mjs` |
| Punch, fragmentation, selective ACK, retransmit of an injected loss, timeout reporting, close semantics | `test/p2p-transport.test.mjs`, real UDP sockets |
| Both signalling endpoints, validation, 404 semantics, self-only announce, non-persistence | `test/p2p-signaling.test.mjs` |

**NOT verified — and cannot be, on one machine:**

| Claim | Why |
|---|---|
| A punch across a **real** NAT | needs two hosts behind two *different* NATs. Two sockets on one host share a loopback path with no translator between them: "the punch succeeded" says nothing about NAT traversal. |
| Punching through a cone NAT | as above |
| The direct path under packet loss / reordering on a real WAN | loopback loss was injected deterministically; a real path was not exercised |
| IPv6 | not implemented |
| Filtering behaviour (restricted cone) | needs a second host to probe from |

## 8. Integration status

Implemented and tested: STUN discovery and mapping classification, punching, the
reliable channel, and the two signalling endpoints.

**Not yet wired:** the `p2p.mode` configuration surface (its semantics are defined
in §1 and default to `auto`, but nothing reads the setting yet), the Localside
announcer, and direct-path preference in `w2m_run`. Until those land, the task path
behaves exactly as v0.3.8 and the signalling layer is live but idle — a caller that
tries `transport: "p2p"` gets the relay path, because there is no `transport` field
being produced at all.

This is stated here, in `CHANGELOG.md` and in the README rather than left for a
reader to discover from a `transport` field that never appears. The one thing this
section exists to prevent is a deployment that believes it is running over a direct
path when it is not.
