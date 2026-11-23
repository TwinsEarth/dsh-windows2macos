/**
 * Package-facing entry for the opt-in P2P WebRTC subplugin:
 * `@twinsearth/w2m-dsh-plugin/dsh-p2p-webrtc`.
 *
 * This is a seam, not a second implementation. The composition root is
 * `src/plugin/p2p-webrtc-plugin.mjs`; the transport is `src/agent/webrtc/transport.mjs`; the
 * signaling server is `src/agent/webrtc/signaling-server.mjs`.
 *
 * Not re-exported from `lib/index.js`: installing the fleet plugin must not spawn a WebRTC engine
 * or open a signaling socket. `cordis.patch.yml` ships this row `disabled: true`; enabling it is the
 * operator's decision.
 */
export {
  apply,
  buildTools,
  describeConfig,
  inject,
  name,
  normalizePluginConfig,
  P2P_WEBRTC_ROUTE_PREFIX,
  P2P_WEBRTC_ROW_ID,
  P2P_WEBRTC_MODES,
  P2P_WEBRTC_POOL_CODE,
  P2P_WEBRTC_POOL_OWNER,
  P2PWebRtcService,
  TOOL_NAMES,
} from '../src/plugin/p2p-webrtc-plugin.mjs';
export {
  createWebRtcTransport,
  DEFAULT_CONNECT_TIMEOUT_MS,
  WEBRTC_TRANSPORT_CODE,
} from '../src/agent/webrtc/transport.mjs';
export { createSignalingServer, SIGNAL_SERVER_CODE } from '../src/agent/webrtc/signaling-server.mjs';
export {
  buildSignalingUrl,
  randomPeerId,
  redactSignalingUrl,
  SIGNAL_CODE,
  SignalingClient,
} from '../src/agent/webrtc/signaling.mjs';
