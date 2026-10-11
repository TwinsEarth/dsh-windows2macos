# Encrypting the peer-to-peer data plane

Status: **stage 1 implemented and verified** (v0.5.3); stages 2 and 3 are not. This document is the
contract the implementation follows, so that a wire-format change is agreed before it is written
rather than discovered in a diff. What was built, what deviated, and what is still open are in §9
below rather than edited into the sections above — the contract should read as it was agreed.

## 1. Why not simply ship WireGuard

The obvious request is "make the fleet use WireGuard, installed automatically, with nothing for the
user to do". That is not achievable on any desktop platform, and the reason is a security property
rather than an engineering gap: a VPN intercepts *all* traffic, so every operating system requires an
explicit elevation or consent once.

| Platform | Official implementation | What makes "no install, no operation" impossible |
|---|---|---|
| Windows | [wireguard-windows](https://github.com/WireGuard/wireguard-windows) | Needs the **Wintun driver** (userspace mode included) or the WireGuardNT kernel driver → **administrator** to load a driver; service mode installs a system service |
| macOS | [wireguard-apple](https://github.com/WireGuard/wireguard-apple) | Uses a **Network Extension** (packet tunnel provider) → a signed, entitled app, and the system's **"allow VPN configuration" prompt cannot be bypassed by any app** |
| Linux | [wireguard-linux](https://github.com/WireGuard/wireguard-linux) | Loading the module and creating an interface needs **root / CAP_NET_ADMIN** |
| Android | [wireguard-android](https://github.com/WireGuard/wireguard-android) | Uses `VpnService` → the **consent dialog is mandatory** |
| iOS | wireguard-apple | Same Network Extension + consent rule |

So the fleet's own transport does not go through WireGuard. What we take from WireGuard is the part
that is actually valuable here and needs no privileges: **its cryptography and its handshake shape.**

## 2. What this protects, and what it does not

**Protects**

* A passive observer anywhere on the path between two machines: task offers, results and file
  fingerprints on the direct UDP channel become unreadable.
* An off-path attacker who knows a peer's address: without the peer's static private key a forged
  `HELLO` cannot complete the handshake.
* Replay and reordering of data frames: counters plus a replay window, not hope.
* A *curious relay operator* reading task data **that travels over the direct channel**. Note the
  relay still sees the control plane — see below.

**Does not protect**

* A compromised endpoint. If the machine is owned, the plaintext is there.
* The control plane: the relay still learns which machines exist, which task was dispatched to whom,
  when, and the aggregate verdict. Metadata is not hidden by this work, and pretending otherwise would
  be worse than saying so.
* Traffic analysis, or an attacker who can drop packets (availability is the relay's job).
* Any traffic that falls back to the relay, **unless** the relay leg is separately protected. Stage 1
  leaves the relay leg as it is and says so in the ledger (`encrypted: false` for that machine).

## 3. Cryptographic mapping, and the one gap

Everything needed is already in `node:crypto`; the zero-dependency rule survives.

| Purpose | Primitive | Node API |
|---|---|---|
| Static and ephemeral key agreement | X25519 | `generateKeyPairSync('x25519')`, `diffieHellman({privateKey, publicKey})` |
| Key derivation | HKDF-SHA256 | `hkdfSync('sha256', ikm, salt, info, len)` |
| Handshake hash | BLAKE2s-256 | `createHash('blake2s256')` |
| AEAD | ChaCha20-Poly1305 | `createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })` |
| Random | CSPRNG | `randomBytes` |

**The gap:** WireGuard's optional `mac1`/`mac2` fields use **keyed** BLAKE2s, which Node's crypto does
not expose (OpenSSL has it; the binding does not). Stage 1 therefore implements **neither** field and
records that as an accepted limitation: they mitigate CPU-exhaustion denial of service, not
confidentiality or authenticity. Stage 2 either implements BLAKE2s' compression function in plain
JavaScript (it is short and well specified) or argues explicitly for leaving it out. It is not silently
dropped.

**Licence:** `wireguard-windows`, `wireguard-apple` and `wireguard-go` are MIT; `wireguard-linux` is
GPL-2.0. This project is MIT, so the kernel module's code must not enter it. Nothing here is copied
from any of them: the construction is from the published protocol description, and the implementation
is ours.

## 4. Stage 1 — what gets implemented

**Identity.** Each machine generates an X25519 keypair the first time it pairs and stores it beside
its device identity (`…/xclient/device.key`, mode 0600 where the platform honours it). The public key
is registered with the relay as part of the device record.

**Distribution, with no `[Peer]` block for anyone to fill in.** When a task is dispatched, the relay
already tells each machine who the peers are; it now also includes each peer's *static public key* in
that same offer. A machine therefore learns the keys of exactly the peers it has been asked to talk
to, and no configuration is written by hand. This is the part that is genuinely better than
WireGuard's manual peer configuration, and it is the whole reason the key exchange belongs in the
relay we already have.

**Handshake, two messages, modelled on Noise IK.** Written out so the implementation cannot drift:

```
initiator → responder   HELLO     e_i, mac           mac = AEAD(k0, nonce=0, hash(prologue || s_i.pub || s_r.pub))
responder → initiator   HELLO_ACK e_r, mac'          mac' = AEAD(k0', nonce=0, hash(HELLO))
session key             k  = HKDF( ECDH(e_i, e_r) ‖ ECDH(s_i, e_r) ‖ ECDH(e_i, s_r) )
                        k0 = HKDF( ECDH(s_i, s_r) )   -- proves possession of the static key
```

* The triple DH gives **mutual authentication and forward secrecy**: a later compromise of both static
  keys does not decrypt recorded sessions.
* A replayed `HELLO` cannot produce a session key, because the responder's fresh `e_r` never existed
  at the time the original was captured.
* A machine that does not know the initiator's static key cannot verify `mac` and refuses, naming the
  reason — never silently downgrading to plaintext.

**Transport.** ChaCha20-Poly1305 per frame; nonce = four zero bytes followed by a 64-bit
little-endian counter, per direction (WireGuard's layout). A 64-message sliding replay window. Rekey
after 2^20 messages or 120 seconds, whichever comes first, by running the handshake again — the old
key is retained briefly so frames in flight are not lost.

**What does not change.** Frames, fragmentation and the reliable-channel logic keep their shape; the
payload of each frame gains an authentication tag. Anchors, allow-list gating, leases and verdicts are
untouched.

**Fallback, and it is not optional.** If the handshake fails — an older peer, an unknown key, a
tampered packet — the task proceeds **exactly as today**, over the relay, and the ledger records
`p2p.encrypted: false` together with the reason. A fleet must never lose a machine because a security
upgrade could not complete; it must only *say* that it did not.

**Compatibility.** Additive: an older peer ignores the unknown offer fields (that property is already
pinned by tests) and its frames are plaintext, which the newer peer accepts while recording
`encrypted: false`. `PROTOCOL.md` gains a section; `envelope_version` stays `1.0` because the
extension rides inside the existing optional `p2p` object.

## 5. Stage 2 — the full handshake

`Noise_IKpsk2` with its actual message layout, a `psk` mixed in from the pairing secret, `mac1`/`mac2`
(either implemented in JS or consciously omitted, per §3), cookie reply under load, rekey timers
aligned with WireGuard's, and a fuzz test for the framing. Stage 1's transport encryption and replay
window carry over unchanged.

## 6. Stage 3 — WireGuard as an optional reachability path

Unchanged from `deploy/networking/`: the hub makes machines reachable regardless of NAT, and it does
**not** make them peers — traffic between two clients is forwarded by the hub. It stays a fallback for
reachability, and the ledger must never label tunnelled traffic as direct.

## 7. How any of this is believed

Tests that must exist before stage 1 is called done:

1. two peers with keys complete a handshake and exchange a frame;
2. a peer with the **wrong** static key is refused, with the reason recorded;
3. a replayed `HELLO` is refused;
4. a data frame with one bit flipped fails authentication and is dropped, not processed;
5. a frame whose counter was already seen is dropped (replay window);
6. an older peer that never learned a key still completes its task over the relay, with
   `encrypted: false`;
7. a capture of the direct channel contains no plaintext marker (a string planted in the command);
8. rekey does not lose a frame that was in flight.

## 8. Open questions for the implementation

* Where the session key cache lives, and its bound — one live session per (peer, punch) today.
* Whether the relay should refuse to introduce a peer whose key has changed since the last dispatch
  (a key-change notice is cheap and catches a silent substitution).
* Windows has no 0600: what the key file's protection actually is there, stated honestly in the
  deployment notes rather than assumed.

### Raised by the v0.4.0 agent workstream, and still open

* **`envelope_sha256` currently covers the transport facts, and that is why the direct result frame is
  not the envelope.** The direct frame carries only `{type:'task.result', task_id}`: `result_path`
  cannot be known until the bounded `result.ack` wait finishes, the envelope is hashed when it is
  built, and stamping `result_path` afterwards would produce a hash that does not cover its own bytes —
  `verifyEnvelope` would then reject an envelope nobody tampered with. The forced choice was an
  accurate `result_path` on the ledger copy at the price of posting that copy up to the bound late
  (`p2pAckTimeoutMs`, default 2000 ms). Consequence: **the fast path saves the dispatcher a wait, not
  the bytes**, because the dispatcher still reads the envelope from the relay. Fixing it means
  splitting the transport facts out of the hashed region (or hashing them in a second, separate
  digest) — a deliberate protocol decision, not a patch, and stage 1 must settle it before claiming
  that the direct channel carries the result.
* **Stage 1's `encrypted` flag lands in the same `p2p` block**, so whatever is decided above decides
  where that flag is trustworthy: inside the authenticated envelope (readable only by the dispatcher)
  or beside it (readable by the relay too). The second is simpler; the first is the one that cannot be
  forged by the relay.
* **`result.ack` has only ever been sent by a test dispatcher**, never by the production plugin when
  that work was done — so the ack contract is proven against a faithful stand-in, not against the real
  caller. Stage 1's rekey path makes the same assumption.
* `direct` mode refusing *every* relay-arrived offer is a contract interpretation, not a measurement.

## 9. Stage 1 as delivered (v0.5.3)

Eight acceptance cases from §7 exist as `test/p2p-crypto.test.mjs` (33 tests), and the gated suites went
from 430 tests / 427 passing to **464 / 461**, the single failure being the pre-existing bundled-python
case. eslint: 0 errors. **These tests earned their keep: they caught seven real defects during
implementation**, three of which are worth naming because each was a silent failure of exactly the kind
this project keeps finding —

* a replay window that **accepted replays of frame 2** (the bit shift slid the wrong way);
* a lookahead bound that capped our **own** send epoch;
* and a plain-ACK race that could **downgrade a live encrypted session to plaintext** — the one outcome
  §4 forbids. It is now structurally impossible: an encrypted channel is never replaced by a plaintext
  one for the same session.

### The three deviations from §4, and why each is an improvement rather than a shortcut

1. **The MACs are additionally bound to the session id and the handshake version.** As §4 was written,
   every input to `mac` is identical for every punch between one pair of machines, so a `HELLO` captured
   from one punch would verify in the next. No field §4 names changed; the binding was added.
2. **The rekey is an HKDF ratchet, not a second handshake.** §4 said "run the handshake again", which
   costs a round trip inside the data path and a state machine to survive it. The epoch instead rides in
   one cleartext byte and both ends derive epoch n+1 from n. Same 2^20-message / 120-second thresholds,
   same 15-second retention of the previous key, and a test that a frame in flight across the boundary
   still decrypts. The security property is unchanged; only the round trip is gone.
3. **`mac1`/`mac2` remain unimplemented**, as §3 required, and the omission is a named value in the code
   with its consequence written down: they mitigate CPU-exhaustion denial of service on the handshake
   path, never confidentiality or authenticity. The interim bound is a TTL- and count-capped nonce cache.

### The interface question this document raised, now decided

§8 asked where the `encrypted` flag belongs, and the answer is **inside the `p2p` block, therefore
inside `envelope_sha256`** — so the relay cannot rewrite it without breaking a hash the dispatcher
verifies. That is the stricter of the two options, and it means the flag is not in `COMPARABLE_FIELDS`
(it describes the transport, not the result). The consequence from §8 stands and is accepted: the direct
`task.result` frame still carries `{type, task_id}` rather than the envelope, because `result_path` — and
now `encrypted` — are only known after the acknowledgement, and an envelope hashed afterwards would not
cover its own bytes. **The fast path saves the dispatcher a wait, not the bytes.** Making it carry the
envelope means moving the transport facts out of the hashed region, which remains a deliberate protocol
decision nobody has needed yet.

### Honest limits, unchanged by this work

* Every socket in the new suite is **loopback**: it crosses no NAT and is not evidence that a real
  translation can be crossed. The suite says so in its header.
* **Self-dial is plaintext by design**: a machine holds no peer key for itself, so a handshake would be
  refused by its own responder and the task lost. Documented at the branch rather than left to be
  rediscovered.
* A v0.4.x/v0.5.x peer is unaffected: it gets the plain channel it always had, and our side records
  `encrypted: false` with a reason. Never silently downgraded, never dropped from the fleet.
