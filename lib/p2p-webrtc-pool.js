/**
 * Package-facing entry for the per-peer `webrtc-v1` transport pool:
 * `@twinsearth/w2m-dsh-plugin/p2p-webrtc-pool`.
 *
 * This is a seam, not a second transport. The composition layer is
 * `src/agent/webrtc/pool.mjs`; the 1:1 data plane it manages is
 * `src/agent/webrtc/transport.mjs`.
 *
 * Not re-exported from `lib/index.js`: importing the pool must not open a signaling socket or spawn
 * an engine. A caller constructs it only when it has a signaling URL, a device key and a peer-key
 * resolver, and `ensure()` is the first thing that starts anything.
 */
export {
  createRelayPeerKeyResolver,
  createWebRtcTransportPool,
  pairRole,
  pairRoom,
  PEER_KEY_CACHE_TTL_MS,
  WEBRTC_POOL_CODE,
  WebRtcTransportPool,
} from '../src/agent/webrtc/pool.mjs';
