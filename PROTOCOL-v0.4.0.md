# W2M Protocol — v0.4.0: the direct path, on by default

> Status: **implemented and wired into the task path.** v0.3.9 shipped the P2P transport and
> admitted in §8 that nothing read `p2p.mode` and the Localside announcer did not exist. This
> release is that admission being paid off: the announcer exists, the offer can arrive over a
> punched path, the result can return over it, and every message says which path it took.
> Protocol version stays **1** — this adds endpoints and fields and removes nothing. Read §8
> for what is measured, and §9 for what is still not.

## 0. Why the default changed

v0.3.9 documented the intent and shipped none of it. A deployment could set `p2p.mode: auto`,
see no error, and get relay-only behaviour — the worst outcome the feature can produce,
because an operator then debugs a NAT that was never used.

v0.4.0 makes the direct path the **default connection method between machines** and makes the
relay what the design always said it was: the rendezvous, the ledger, and the fallback.

## 1. Path selection

| `p2p.mode` | Dispatcher (the machine running `w2m_run`) | Executor (Localside) |
|---|---|---|
| `auto` (**default**) | Announce, punch to each target, push the offer over the direct channel. The relay's own offer is still emitted, so a failed punch costs latency rather than the task. | Accept an offer from **either** path. The first copy wins; a later copy of the same `task_id`+`attempt` is never executed again. |
| `direct` | Same, but a failed punch is not hidden: the executor refuses the relay copy. | **Refuse** an offer that did not arrive over the direct path: `status: refused`, `refusal_reason: P2P_UNAVAILABLE`. No silent fallback. |
| `relay` | Never dials. No UDP socket is bound at all. | v0.3.9 behaviour, byte for byte. |

Why `auto` and not `direct`: punching **cannot** succeed behind a symmetric NAT, and that is
not theoretical. Measured twice now, on two different networks, with three STUN servers
returning three different mapped ports for one socket:

* the authoring machine behind an iPhone hotspot (`endpoint-dependent`, v0.3.9);
* the reference Windows client behind China Mobile (`endpoint-dependent`, v0.4.0) — three
  servers, three ports: 36028, 5855, 26713.

A default that hard-required the direct path would break every deployment on such a network
the moment it was upgraded. `direct` is there for an operator who has measured their own path
and wants a failure to be loud.

### 1.1 The table is per machine, and it is the executor's own mode that refuses

`direct` is enforced where the refusal can be honest: the executor knows how the offer
arrived, so it is the executor that refuses a relay offer. The dispatcher's mode decides
whether it bothers to punch.

## 2. The shared server

A machine behind NAT cannot discover its own public address, and two such machines cannot find
each other. One always-on host provides both, and its address is now the default:

| Constant | Value | Used for |
|---|---|---|
| `SHARED_SERVER.rabbitUrl` | `http://202.182.123.154:8787` | The relay, when `rabbitUrl` is not configured |
| `SHARED_SERVER.stun` | `202.182.123.154:3478` | First entry of the default STUN list |

Precedence, highest first: `rabbitUrl` in the profile patch → `W2M_RABBIT_URL` →
the shared default. Which one was used is reported by `w2m_status` as `rabbit_source`
(`config` | `env` | `shared-default`), so "it works" and "it works because someone set it"
are distinguishable.

The public STUN servers (Cloudflare, Google, Nextcloud) stay in the list after the shared one.
That is deliberate: the shared responder is one machine, and a punch that is never attempted
because that one machine is down would be a self-inflicted outage.

## 3. Announcement — the announcer v0.3.9 did not have

Each machine, holding the same UDP socket it will punch from:

1. binds an ephemeral UDP port (`0.0.0.0:0`);
2. asks the STUN servers for its reflexive address and classifies mapping behaviour;
3. announces its candidates (`POST /v1/peer/announce`, device token):
   the **reflexive address first**, then its private address, capped at 8 and de-duplicated;
4. re-announces every 20 s with a 60 s TTL, on an `unref()`ed timer, so the entry stays live
   without keeping a process alive.

A STUN server that does not answer is **not** fatal: the machine announces its private
candidate, records `announce_ok: false` and the error, and a LAN punch can still work. This
is the same refusal-to-give-up that makes `unknown` punchable in v0.3.9 §2.

Announcements remain ephemeral and are still never persisted — a candidate is a NAT mapping,
and a mapping dies with the process that held it.

## 4. The offer over the direct path

The dispatcher, after `POST /v1/task` returns `{task_id, seq, leases[]}`:

1. reads the target's lease (`index`, `attempt`, `dedupe_key`) — the pushed offer must be
   recognisably the *same* work item the relay is offering, or exactly-once becomes
   at-least-twice;
2. `GET /v1/peer/{machine_id}` for the target's live candidates;
3. punches (`HELLO` to every candidate, 250 ms apart, 5 s default budget);
4. on success, sends `{type: 'task.offer', ...}` — the same JSON object the relay would have
   sent over SSE, with `origin_machine_id` and `p2p` added — over the channel;
5. on failure, does nothing further. The relay's offer is already on its way.

### 4.1 The relay holds its own offer back, briefly, or the direct path could never win

An SSE offer is a push over a connection that is **already open**; a punch costs at least one
round trip. Emitting both at the same moment therefore means the relay copy arrives first
essentially always, and `transport` reads `relay` on networks where the punch succeeded. That
was measured on loopback while writing this contract: the direct copy consistently lost.

So when — and only when — the task carries both `origin_machine_id` and a `p2p.mode` of `auto`
or `direct`, the relay defers its own offer by `p2pOfferGraceMs` (default **1200 ms**) and
cancels it if the lease has moved out of `queued` by then. No new message is needed for that
test: the executor's first act on any offer it accepts is a lease heartbeat, which is exactly
the fact that says "the direct copy arrived".

Consequences, stated because they are the cost of the feature:

* a punch that fails costs one grace period of extra latency per task, and nothing else;
* a duplicate can still arrive in both directions — the grace is a window, not a lock — so the
  executor's dedupe remains load-bearing and is tested in both arrival orders;
* a v0.3.9 dispatcher (no `origin_machine_id`, no `p2p`) gets the old timing byte for byte.

**Both copies can arrive, in either order.** The executor dedupes on `task_id` + `attempt`
(+ `dedupe_key` when present) rather than on the arrival path: the second copy of a task that
is queued, running or finished is not executed again. A duplicate is not an error to report;
it is the mechanism working.

## 5. The result, and the ledger copy that is not optional

The executor returns the result on the channel the offer arrived on, when there is one:

```
executor                                     dispatcher
   |  {type:'task.result', task_id, machine_id}  ->
   |  <-  {type:'result.ack', task_id}            |   (only after the dispatcher has stored it)
```

* **What travels on that frame, and what deliberately does not.** It carries the frame type, the
  task id and the machine id — *not* the envelope. `result_path` is one of the envelope's own
  fields and `envelope_sha256` covers the whole envelope, so the acknowledgement has to be known
  before the envelope is built; sending the envelope first and stamping `result_path` afterwards
  would produce a hash that does not cover the bytes it claims to. The direct path therefore
  saves the dispatcher the wait for the relay's copy, **not the bytes**: the payload still reaches
  it through the ledger. This is a real narrowing of what "the payload path is direct" means, and
  it is written here rather than left for a reader to infer from a frame that looks short.
* The direct copy is bounded: if the dispatcher does not ack within the timeout (2 s default), the
  channel is not waited on any longer and the envelope records `result_path: 'relay'`.
* **The relay copy is always sent, from the executor, unchanged in shape and ordering.** The
  relay is the ledger, the report source and the only writer allowed to store a machine's own
  result. v0.4.0 does not move the ledger, and a direct path that silently replaced it would
  make the aggregate less trustworthy, not more.
* The dispatcher stores what the frame told it and acks; the durable record arrives on its own
  schedule. A dead dispatcher — crashed DSH, closed laptop — costs the direct copy and nothing
  else: the relay copy is sent after a bounded wait, never instead of it.
* A task's channel outlives its attempt by `p2pChannelLingerMs` (30 s default) so a duplicate of a
  finished attempt can still be answered on it, and is released afterwards rather than accumulating
  one live session per task an agent has ever run.

## 6. Path reporting is mandatory, not decorative

Every result carries the path it actually took:

```json
{
  "transport": "p2p",
  "p2p": {
    "mode": "auto",
    "offer_path": "p2p",
    "result_path": "p2p",
    "reason": null,
    "rtt_ms": 43.8,
    "peer": "202.182.123.154:51234",
    "session": 3141592653,
    "mapping": "endpoint-dependent"
  }
}
```

```json
{
  "transport": "relay",
  "p2p": { "mode": "auto", "offer_path": "relay", "result_path": "relay",
           "reason": "P2P_PUNCH_TIMEOUT", "rtt_ms": null, "peer": null,
           "session": null, "mapping": "endpoint-dependent" }
}
```

* `transport` is how the **offer** arrived (`p2p` | `relay`); `result_path` is how the result
  returned. They are separate because a punch can open in one direction only in principle, and
  a single field would have to lie about one of them.
* `peer` and `session` describe the channel **this machine opened**. On the responding side — the
  machine that accepted a punch — they are `null`: a HELLO carries a session, not an identity, and
  reporting the initiator's address as a peer of the responder would be inventing a fact. `mapping`
  is always this machine's own measurement.
* `reason` names the failure (`P2P_NO_CANDIDATES`, `P2P_PUNCH_TIMEOUT`, `P2P_DISABLED`,
  `P2P_UNAVAILABLE`) instead of leaving "not p2p" to be interpreted, and is **absent** (not null)
  when the direct path worked: a key that is present is a claim.
* The task aggregate and the report's per-machine object carry both fields; the markdown
  report's table has a trailing `路径` column.
* **Neither field is comparable.** A path is not a result: two machines that ran the same
  bytes and disagree only about how the offer reached them are `consistent`, and a test says
  so explicitly. Adding a transport field to `COMPARABLE_FIELDS` would turn a network
  difference into a false bug report, which is the exact failure the six aggregation states
  exist to prevent.

## 7. The relay, extended

Additive only:

* `POST /v1/task` accepts `origin_machine_id` (string ≤ 128 chars) and `p2p` (`{mode}` with
  `mode ∈ auto|direct|relay`). Both are validated shallowly and loudly — a bad value is
  `BAD_REQUEST`, names the field, and creates **no** task and emits **no** offer.
* Every emitted offer carries both fields (`null` when the caller sent nothing).
* They are stored in the task and in the `task.created` ledger entry, so a relay restart
  re-emitting offers (`redeliverPendingOffers`, lease takeover) does not quietly strip the
  direct-push hint.
* `GET /v1/tasks/{id}` and `GET /v1/tasks/{id}/report` expose `transport`/`p2p` per machine.
  A result envelope with a malformed `transport` or `p2p` is refused rather than stored: a
  ledger entry reading `transport: "satellite"` would render as a path that does not exist.

## 8. `w2m-stun` — the responder

The shared server also answers STUN itself (RFC 5389 Binding, UDP `:3478`), so a fleet does
not depend on three third-party servers being reachable from every network it runs in. It
replies `0x0101` with `XOR-MAPPED-ADDRESS`, `MAPPED-ADDRESS` and `SOFTWARE`, echoes the
transaction id, drops anything whose magic cookie is wrong, and answers `0x0111`/400 only for
an unknown comprehension-required attribute.

Deliberately **not** implemented: RFC 5780 (`CHANGE-REQUEST` / `OTHER-ADDRESS`), so this
responder cannot classify filtering behaviour. That would need a second address, and claiming
to detect what was not probed is the failure mode this project keeps refusing.

The v0.3.9 client needed no change to talk to it — the responder was written against the same
message layout, and the test that proves it is a frozen byte-level vector, not a round trip
through the encoder it was written next to.

## 9. What is verified, and what is not

**Verified:**

| Claim | Evidence |
|---|---|
| Announce → rendezvous → punch → offer → execute → result, over real UDP sockets | `test/p2p-node.test.mjs`, `test/p2p-agent.test.mjs` |
| The responder's wire format, including a frozen byte vector and error path | `test/stun-server.test.mjs` |
| The relay's pass-through, validation and restart durability | `test/p2p-transport-fields.test.mjs` |
| A transport difference never changes a verdict | `test/p2p-transport-fields.test.mjs`, `test/p2p-plugin.test.mjs` |
| Exactly-once under double delivery (relay + direct, both orders) | `test/p2p-agent.test.mjs` |
| One real WAN hop, with numbers: dispatcher on a Chinese residential network behind a **symmetric** NAT, executor on the shared server in Tokyo — `HELLO`→`HELLO_ACK` in **331.61 ms**, ledger `transport: "p2p"`, `result_path: "p2p"` | `_ops/wan-p2p-verify.mjs`, recorded in `RELEASE-STATUS.md` and `CHANGELOG.md` |
| The shared server's relay, STUN responder and proxy, reachable from the public internet | `deploy/shared-server/`, live instance |

**Not verified — and the release says so rather than implying otherwise:**

| Claim | Why it is still open |
|---|---|
| A punch between **two** hosts behind two **different** NATs | Needs two such networks at once. Measured here: the client network is symmetric, so a two-NAT punch from it cannot succeed — which is exactly what the fallback is for. |
| Punching through a cone NAT | Same reason. |
| The direct path under real packet loss / reordering | Loopback loss is injected deterministically; a lossy WAN path was not exercised. |
| IPv6 | Not implemented in the transport, and the responder's IPv6 branch is unexercised (no `udp6` socket was created while testing). |
| The UDP channel's authenticity | Unchanged from v0.3.9 §6: session ids are random 32-bit values and UDP source addresses are spoofable. A direct path is not more trustworthy than the relay; enable request signing when the threat model includes an on-path attacker. |

A loopback punch is **not** evidence of NAT traversal: two sockets on one host share a path
with no translator between them. The WAN measurement is one hop with one NAT, and it is
labelled as one hop with one NAT.
