# P2P WebRTC transport (`webrtc-v1`)

`webrtc-v1` is an **opt-in** second transport stack for W2M. It is P2P-first, carries the same
Noise-encrypted RPC/event bytes as the UDP path, and falls back to the existing UDP/relay path
instead of pretending a relay is a direct connection.

It is wired into `deliver.mjs`, the dispatcher and the Teams data plane: results and task offers try
`webrtc-v1` first, and Teams bulk bytes use exactly 33 WebRTC attempts before `TEAM_DATA_P2P_EXHAUSTED`
with no relay fallback. The UDP path remains the first fallback for `deliver`/`dispatch`; Teams
deliberately has none. `WebRtcTransportPool` is the single 1:1 pool per peer pair shared by all three.

## Why the WebRTC engine is external

`package.json` has **no runtime dependencies**, and `CONTRIBUTING.md` says adding one is a design
change that will be refused. A WebRTC stack is a real dependency — a native addon
(`node-datachannel`) or a large pure-JS graph (`werift`) — so the package cannot import one without
breaking that contract.

The transport therefore splits the stack:

| Layer                                           | Owner                          | Why                                     |
| ----------------------------------------------- | ------------------------------ | --------------------------------------- |
| Signaling (WebSocket, SDP/ICE exchange)         | this repository                | small, testable, no native code         |
| ICE policy / path accounting / fallback         | this repository                | product decisions, not engine decisions |
| Noise IK handshake + AEAD + replay/rekey        | this repository (`crypto.mjs`) | reuses the audited W2M handshake        |
| PeerConnection / DataChannel / STUN/TURN / DTLS | external engine process        | the only genuinely WebRTC-native part   |

An operator supplies `providerCommand`; a missing command is the named refusal
`WEBRTC_PROVIDER_UNAVAILABLE`, never a silent downgrade. Tests inject an in-process
`providerFactory`, so the full signaling + Noise + fragmentation path runs without a native addon.

## Architecture

```
host (W2M)                                      client (W2M)
  │                                                │
  ├── SignalingClient ── ws://signal-server ───────┤   control plane: join, offer/answer, ICE
  │        │                                       │
  │        └──────── SDP / candidates ─────────────┘
  │
  ├── ProviderBridge ── JSON lines ── WebRTC engine (node-datachannel / other)
  │        │
  │        └── PeerConnection ── ICE/STUN/TURN ── DataChannel ── ICE/STUN/TURN ── PeerConnection
  │                                                │
  └── SecureChannel (Noise_IK_25519_ChaChaPoly_SHA256) ── encrypted frames ── SecureChannel
           │                                                │
           └── Fragmenter / Reassembler (16 KiB fragments, 4 MiB message cap)
```

The signal server can disappear after the DataChannel opens; it never carries application bytes.
A TURN relay forwards DTLS ciphertext and the Noise-sealed payload inside it, so it cannot read
either the W2M machine identity or the RPC content.

## Wire protocol

### Frame format

Every DataChannel message is one frame:

```
kind u8 | session u32be | body
```

`session` is the Noise handshake session id. Kinds:

| Kind            | Value | Meaning                                                          |
| --------------- | ----- | ---------------------------------------------------------------- |
| `HELLO`         | 1     | Noise initiator handshake body (plaintext, authenticated inside) |
| `HELLO_ACK`     | 2     | Noise responder handshake body                                   |
| `DATA`          | 3     | one application payload, Noise-sealed                            |
| `CHUNK`         | 9     | one fragment of a payload larger than 16 KiB                     |
| `PING` / `PONG` | 6 / 7 | authenticated RTT probe                                          |
| `BYE`           | 8     | authenticated close, or a named handshake refusal                |

The 5-byte header is deliberately the same shape `src/agent/p2p.mjs` uses: `CryptoSession`
authenticates the complete frame header as AAD, so the WebRTC path can reuse the existing
handshake rather than grow a second one.

### Fragmentation

DataChannel implementations disagree about maximum message size (commonly 64 KiB, though the
reference remote transport used 4 MiB). `webrtc-v1` fragments at the application layer:

- threshold: `maxFragmentBytes` (default 16 KiB);
- message cap: 4 MiB;
- chunk header: `id u32 | seq u16 | total u16 | payload`;
- at most 8 incomplete messages per peer, 30 s expiry;
- duplicate fragment with different bytes is corruption, not last-write-wins;
- each fragment is Noise-sealed independently, so a relay never sees half a plaintext message.

The engine must use a **reliable, ordered** DataChannel (the WebRTC default for `createDataChannel`).
The fragment layer assumes ordered delivery; it does not add ACK/retransmit on top of SCTP.

## Noise boundary

`SecureChannel` runs the existing W2M handshake inside the DataChannel:

1. client (initiator) sends `HELLO`, built by `startHandshake`;
2. host (responder) verifies it with `respondHandshake` and returns `HELLO_ACK`;
3. both derive a `CryptoSession` with directional keys;
4. all `DATA`/`CHUNK`/`PING`/`PONG`/`BYE` frames are encrypted with ChaCha20-Poly1305;
5. replay is refused by `CryptoSession` after authentication;
6. rekey follows the existing `crypto.mjs` limits (1,048,576 messages / 120 s).

The peer's static key is **pinned**:

- client: `peerPublicKey` (or `peerKeys[peerMachineId]`) is required;
- host: `peerKeys` is required and must contain the initiator's machine id.

SDP/ICE are never used as trust material. A malicious signaling server can deny service or
substitute candidates, but it cannot make a different machine pass the Noise static-key proof.

## Signaling protocol

Client → server:

```json
{"type":"join","room":"w2m","role":"host","peer":"host-1","protocol":"w2m-webrtc/1"}
{"type":"signal","kind":"offer","payload":{"type":"offer","sdp":"v=0..."}}
{"type":"signal","kind":"candidate","payload":{"candidate":"candidate:...","sdpMid":"0","sdpMLineIndex":0}}
{"type":"ping"}
{"type":"leave"}
```

Server → client:

```json
{"type":"joined","room":"w2m","role":"host","peer":null,"protocol":"w2m-webrtc/1"}
{"type":"peer-joined","peer":"client-1","role":"client"}
{"type":"signal","from":"client-1","role":"client","kind":"offer","payload":{...}}
{"type":"peer-left","peer":"client-1","role":"client"}
{"type":"pong","at":1234567890}
{"type":"error","code":"SIGNAL_ROOM_FULL","message":"role host is already held"}
```

A room holds exactly one `host` and one `client`. Messages are capped at 64 KiB; SDP is normally
far below that. The server does not parse SDP, select candidates, or store a session.

### Running the server

```bash
w2m-webrtc-signal --port 8788 --host 0.0.0.0 --token-file ./signal-token.txt
# or
W2M_WEBRTC_SIGNAL_TOKEN=... w2m-webrtc-signal --port 8788
```

- Default bind is `127.0.0.1`; use `0.0.0.0` only behind a TLS terminator / private network.
- `token` is checked before the WebSocket upgrade with a constant-time compare.
- `/health` returns room/peer counts and uptime; no token is required for it.
- The printed URL never includes the token.

For a remote deployment, terminate TLS and use `wss://`; the server itself speaks cleartext
WebSocket so it can sit behind nginx/Caddy without duplicating certificate handling.

Production deployment (signal systemd/nginx, per-machine provider install, DSH rows, and the
read-only readiness script) is in [DESKTOP-PRODUCTION.md](./DESKTOP-PRODUCTION.md).

## Provider protocol

The engine is a child process speaking one JSON object per line in each direction.

Core → engine:

```json
{"id":1,"method":"create","params":{"role":"client","iceServers":[{"urls":["stun:stun.example:3478"]}],"iceTransportPolicy":"all","maxMessageBytes":4194304}}
{"id":2,"method":"createOffer","params":{}}
{"id":3,"method":"setRemoteDescription","params":{"type":"answer","sdp":"v=0..."}}
{"id":4,"method":"addIceCandidate","params":{"candidate":{"candidate":"candidate:...","sdpMid":"0"}}}
{"id":5,"method":"send","params":{"data":"<base64>"}}
{"id":6,"method":"getStats","params":{}}
{"id":7,"method":"close","params":{}}
```

Engine → core:

```json
{"id":1,"ok":true,"result":{"provider":"node-datachannel","version":"0.33.6"}}
{"event":"ready","provider":"node-datachannel","version":"0.33.6"}
{"event":"local-description","type":"offer","sdp":"v=0..."}
{"event":"ice-candidate","candidate":{"candidate":"candidate:...","sdpMid":"0","sdpMLineIndex":0}}
{"event":"state","state":"connected"}
{"event":"open"}
{"event":"data","data":"<base64>"}
{"event":"stats","payload":{"selectedPair":{"localCandidate":{"type":"host"},"remoteCandidate":{"type":"srflx"}},"currentRoundTripTimeMs":42}}
{"event":"error","code":"...","message":"..."}
```

Rules:

- `ready` must be emitted once the engine can accept `create`.
- `create` returns after the PeerConnection exists; the engine emits `local-description` and
  `ice-candidate` as ICE progresses.
- For `role:"client"` the core calls `createOffer`; for `role:"host"` the engine creates the answer
  after `setRemoteDescription({type:"offer"})`.
- `send` must write to a reliable ordered DataChannel and return `{"ok":true,"result":{"bufferedAmount":N}}`.
- `getStats` should return the selected candidate pair and RTT in the shape above; `PathSelector`
  also tolerates browser-style `selectedCandidatePair` / `localCandidate` / `remoteCandidate`.
- Base64 `data` is decoded from the line; the engine is responsible for the DataChannel's own
  message size. `webrtc-v1` sends at most 16 KiB fragments by default.
- On `close`, flush or destroy the PeerConnection and exit.

### Reference `node-datachannel` provider

The package ships a runnable provider at
`src/agent/webrtc/providers/node-datachannel-provider.mjs`. It is a reference engine, not a
dependency: the addon is installed **outside** the package, and the provider resolves it from
`providerCwd` (its working directory), so the published package still has no runtime dependencies.

macOS / Linux:

```bash
mkdir -p ~/.w2m/webrtc-provider && cd ~/.w2m/webrtc-provider
npm init -y && npm install node-datachannel
cp <package>/src/agent/webrtc/providers/node-datachannel-provider.mjs .
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$HOME\.w2m\webrtc-provider" | Out-Null
Set-Location "$HOME\.w2m\webrtc-provider"
npm init -y; npm install node-datachannel
Copy-Item "<package>\src\agent\webrtc\providers\node-datachannel-provider.mjs" .
```

Run it directly once to see the expected dependency error before wiring it in; the engine exits with
`node-datachannel is not installed` when the addon is absent, rather than a generic stack trace.

Set `providerCommand: 'node'` and `providerArgs: ['<absolute path to provider.mjs>']`, with
`providerCwd: '<absolute path to the consumer directory>'`. **Use an absolute path**: child_process
`cwd` and the provider do not expand `~` or shell variables. Pointing `providerArgs` at the packaged
file also works: the provider resolves `node-datachannel` from `providerCwd`, not from its own
location.

The provider speaks the JSON-line protocol above: `create` builds the PeerConnection,
`createOffer` creates the client DataChannel, a host answers after
`setRemoteDescription({type:'offer'})`, and `data`/`open`/`state` are forwarded as events.
Base64 is used only on the JSON line; the DataChannel carries raw bytes.

The provider is intentionally thin. It does not select candidates, trust SDP, or add encryption;
those remain the transport's job. Engine versions differ in `DataChannel.send` vs `sendMessage`,
`bufferedAmount` as a field vs a method, and `getStats` callback vs promise; the reference handles
those variants defensively, but pin and test the engine version you deploy.

If you use another engine, implement the same seven methods and event names. A missing addon
produces a clear child-process failure (`WEBRTC_PROVIDER_SPAWN_FAILED`) rather than a silent
plaintext fallback.

## Per-peer pool

A fleet is many pairs, and `webrtc-v1` is one transport per pair. `src/agent/webrtc/pool.mjs`
owns that map without becoming a dispatcher:

- `pairRole(a, b)` — the lexicographically smaller machine id is the signaling `host`;
- `pairRoom(a, b)` — `w2m-pair-` plus the first 24 hex chars of `sha256(sorted(a,b))`;
- `createRelayPeerKeyResolver({getJson})` — reads `peer.static_key` from
  `GET /v1/peer/<machine_id>` and caches it for five minutes;
- `WebRtcTransportPool` — `ensure(peer)`, `prepare(peer)`, `send(peer, payload)`, `onMessage()`,
  `closePeer()`, `stop()`, `diagnostics()`.

Both ends derive the same room and opposite roles from the same two ids, so there is no
negotiation field to disagree about. A failed pair is kept in diagnostics but never reused; the
next `ensure()` closes it and starts a new transport. The pool does not retry a fixed number of
times and does not decide whether a failure should fall back to UDP or relay — those are
dispatch/data-plane policies.

The package seam is `@twinsearth/w2m-dsh-plugin/p2p-webrtc-pool` (`lib/p2p-webrtc-pool.js`).
Importing it does not open a socket or spawn an engine; `ensure()` is the first side effect.

## Configuration

The row ships disabled. Enable it only with a provider command and real peer identity.

```yaml
- id: dsh-p2p-webrtc
  name: '@twinsearth/w2m-dsh-plugin/dsh-p2p-webrtc'
  disabled: false
  config:
    signalUrl: 'wss://signal.example.com/w2m/webrtc'
    signalToken: !!js process.env.W2M_WEBRTC_SIGNAL_TOKEN
    room: 'edge-01'
    role: 'host'
    machineId: 'machine-a'
    peerMachineId: 'machine-b'
    peerKeys:
      machine-b: '<base64 static public key>'
    deviceKeyDir: '<DSH_HOME>/xclient'
    providerCommand: 'node'
    # Absolute path. macOS/Linux: /Users/me/.w2m/...; Windows: C:/Users/me/.w2m/...
    providerArgs: ['/Users/me/.w2m/webrtc-provider/node-datachannel-provider.mjs']
    providerCwd: '/Users/me/.w2m/webrtc-provider'
    iceServers:
      - urls: ['stun:stun.l.google.com:19302']
    # Optional multi-TURN pool. Each pair gets a stable primary and the other node as fallback.
    turnServers:
      - urls: ['turn:w2m:<secret>@turn-a.example:3479']
      - urls: ['turn:w2m:<secret>@turn-b.example:3479']
    turnPolicy: balanced
    preferP2p: true
    allowRelay: true
    maxRttMs: 350
```

Security notes:

- `turn:` and `turns:` are both accepted. `turns:` is the TLS option; `turn:` is the normal UDP deployment. The DTLS/SCTP payload stays end-to-end encrypted even when TURN itself is cleartext, while TURN long-term credentials are only as private as the TURN transport.
- Multi-TURN is a client-side ordering policy, not a network load balancer: see [DUAL-TURN.md](./DUAL-TURN.md).
- `credential` is redacted in `p2p_webrtc_status`; `signalToken` is redacted in the URL and config.
- `deviceKey` creation is **opt-in** (`allowCreateDeviceKey: true`). A new key changes this
  machine's identity and peers that pinned the old key will refuse it.
- `peerKeys` values are public keys; they are not secrets, but they are the trust anchors.

## Tools

| Tool                | Behavior                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `p2p_webrtc_status` | Read-only configuration + live diagnostics. Safe before start.                                                    |
| `p2p_webrtc_start`  | Requires `confirm:"start"`. Spawns the engine and opens signaling. Refuses a second start while connecting/ready. |
| `p2p_webrtc_stop`   | Idempotent; closes secure channel, signaling socket and engine process.                                           |
| `p2p_webrtc_probe`  | Sends an authenticated Noise PING and returns RTT; refreshes ICE stats.                                           |

`status` reports the path verdict:

- `direct` — selected pair has no relay candidate and RTT is inside `maxRttMs`;
- `relay` — selected pair uses a TURN relay (usable, never called direct);
- `degraded` — direct but over the RTT budget, or relay while `preferP2p` is false;
- `fallback` — relay forbidden, or consecutive failures reached `degradeAfterFailures` (default 2);
- `none` — no selected pair yet.

The caller decides whether `fallback` means "use UDP/relay"; the transport does not silently switch.

## Tests

- `test/p2p-webrtc-protocol.test.mjs` — frame codec, chunking, reassembly bounds, oversized message;
- `test/p2p-webrtc-secure.test.mjs` — real Noise handshake, encrypted DATA, replay refusal, PING/PONG;
- `test/p2p-webrtc-signaling.test.mjs` — real WebSocket server + two clients, offer/answer forwarding,
  token refusal, room collision, peer-left;
- `test/p2p-webrtc-transport.test.mjs` — real signaling + fake engine + real Noise: start, send,
  chunked send, probe, status, stop;
- `test/p2p-webrtc-pool.test.mjs` — deterministic room/role, two pools over real signaling, key
  resolution/cache, missing-key refusal and retry, package seam;
- `test/p2p-webrtc-plugin.test.mjs` — patch row/export/tool wiring without a real engine;
- `test/p2p-webrtc-provider.test.mjs` — reference provider refuses to start when the optional addon
  is absent, instead of failing inside a PeerConnection.

Run:

```bash
npm run test:p2p-webrtc
```

## Limitations / next steps

- **No dispatch wiring yet.** `deliver.mjs` still constructs a `P2PNode`; adding `webrtc-v1` there
  requires a scheduler-level transport choice and a migration story for existing offers. The pool is
  the piece that makes one transport per pair manageable, but it is not yet called by `deliver.mjs`.
- **No trickle-ICE resubmit.** The engine emits candidates once; a provider that emits them after
  `setRemoteDescription` is supported, but there is no candidate queue/replay across reconnects.
- **No automatic reconnect inside one transport.** A closed signal/socket/provider fails the transport;
  the pool starts a new one on the next `ensure()`. There is no same-room engine re-create.
- **No multiplexing inside one transport.** One transport is one peer pair; the pool owns N instances.
  A fleet with many peers still pays one engine process and one signaling socket per pair.
- **Reference provider is not CI-tested against the native addon.** `node-datachannel` is installed
  outside the package and absent from CI, so the shipped provider is syntax/protocol-reviewed,
  not exercised end-to-end; pin and verify the engine version you deploy.
- **No frame-level ACK.** SCTP's reliable ordered delivery is assumed; the fragment layer only
  bounds memory and detects corruption.
