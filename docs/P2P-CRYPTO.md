# Encrypting the peer-to-peer data plane

Status: **design, stage 1 not yet implemented.** This document is the contract the implementation
follows, so that a wire-format change is agreed before it is written rather than discovered in a diff.

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
