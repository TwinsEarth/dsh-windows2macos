/**
 * Package-facing entry for the P2P V2 file plane:
 * `@twinsearth/w2m-dsh-plugin/dsh-p2p-v2`.
 *
 * The seam re-exports the Cordis row and the optional-engine primitives. Mounting it does not
 * import `webtorrent`; only `p2p_v2_share` / `p2p_v2_add` do, through the dynamic loader.
 */

export {
  apply,
  buildTools,
  describeConfig,
  inject,
  name,
  normalizePluginConfig,
  P2P_V2_ROW_ID,
  TOOL_NAMES,
} from '../src/plugin/p2p-v2-plugin.mjs';
export {
  P2PV2Service,
  P2P_V2_CODE,
  infoHashFromMagnet,
} from '../src/agent/webtorrent/service.mjs';
export {
  P2P_V2_ENGINE_CODE,
  createWebTorrentClient,
  loadWebTorrentModule,
  resetWebTorrentModuleCache,
  webTorrentClientOptions,
} from '../src/agent/webtorrent/engine.mjs';
export {
  TORRENT_FRAME_HEADER_BYTES,
  TORRENT_FRAME_MAGIC,
  TORRENT_FRAME_MAX_CHUNK_BYTES,
  decodeTorrentFrame,
  encodeTorrentFrame,
  isTorrentFrame,
  normalizeInfoHash,
  shareIdFor,
} from '../src/agent/webtorrent/multiplex.mjs';
export {
  TORRENT_ADAPTER_MAX_WRITE_BYTES,
  createTorrentPeerAdapter,
} from '../src/agent/webtorrent/peer-adapter.mjs';
