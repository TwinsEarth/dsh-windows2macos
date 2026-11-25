/**
 * `webrtc-v1`: a P2P-first transport for W2M.
 *
 * This is the composition layer the W2M scheduler can talk to through the existing
 * `assertTransportShape` contract:
 *
 *   signaling (WebSocket, outbound both sides)
 *        -> WebRTC PeerConnection / DataChannel (engine process)
 *        -> Noise_IK_25519_ChaChaPoly_SHA256 (SecureChannel)
 *        -> fragment/reassemble (Fragmenter/Reassembler)
 *        -> send/onMessage/paths/diagnostics
 *
 * The transport is 1:1 by design. A fleet has many pairs; a pair gets one transport instance. That
 * keeps the state machine honest: one room, one peer, one ICE generation, one Noise session.
 *
 * ## Why the engine is external
 *
 * `package.json` has no runtime dependencies, and `CONTRIBUTING.md` says adding one is a design
 * change that will be refused. A WebRTC stack is a real dependency (native addon or a large pure-JS
 * graph). The transport therefore owns signaling, policy and encryption, while an injected engine
 * process owns the PeerConnection. `provider.mjs` defines that boundary; a missing engine is a
 * named `WEBRTC_PROVIDER_UNAVAILABLE`, never a silent fallback.
 *
 * ## Fallback semantics
 *
 * The transport does not pretend to replace UDP/relay inside the agent: `deliver.mjs` still owns
 * dispatch. `PathSelector` reports `fallback` when the relay policy forbids the selected path or
 * when failures cross the configured threshold, so the caller can keep using the existing UDP
 * transport. A WebRTC path that is merely `relay` is reported as `relay`, not as `direct`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { assertTransportShape } from '../transport.mjs';
import { DeviceKey } from '../crypto.mjs';
import { PathSelector, normalizeIceServers } from './path.mjs';
import { Fragmenter, MAX_MESSAGE_BYTES, Reassembler, WEBRTC_TRANSPORT, FRAME_KIND } from './protocol.mjs';
import { ProviderBridge } from './provider.mjs';
import { SecureChannel, resolveDeviceKey } from './secure.mjs';
import { SignalingClient, buildSignalingUrl, randomPeerId } from './signaling.mjs';

/** Named transport failures. */
export const WEBRTC_TRANSPORT_CODE = Object.freeze({
  OK: 'WEBRTC_OK',
  MISCONFIGURED: 'WEBRTC_MISCONFIGURED',
  BAD_ROLE: 'WEBRTC_BAD_ROLE',
  BAD_ICE_SERVERS: 'WEBRTC_BAD_ICE_SERVERS',
  DEVICE_KEY_REQUIRED: 'WEBRTC_DEVICE_KEY_REQUIRED',
  PEER_KEY_REQUIRED: 'WEBRTC_PEER_KEY_REQUIRED',
  PROVIDER_UNAVAILABLE: 'WEBRTC_PROVIDER_UNAVAILABLE',
  SIGNAL_UNAVAILABLE: 'WEBRTC_SIGNAL_UNAVAILABLE',
  CONNECT_TIMEOUT: 'WEBRTC_CONNECT_TIMEOUT',
  NOT_READY: 'WEBRTC_NOT_READY',
  UNKNOWN_PEER: 'WEBRTC_UNKNOWN_PEER',
  CLOSED: 'WEBRTC_CLOSED',
  SEND_FAILED: 'WEBRTC_SEND_FAILED',
  STARTING: 'WEBRTC_STARTING',
  STOPPED: 'WEBRTC_STOPPED',
});

/** Default overall budget for connect (signal join + peer + ICE + Noise). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Validate a peer public key without trusting SDP. base64 of exactly 32 bytes.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPeerKey(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}

/**
 * Resolve the local static key. A caller may inject one (tests, an existing agent), or point at a
 * file/directory. Creation is opt-in: minting a new key silently would change this machine's
 * identity, and every peer that pinned the old one would refuse it.
 *
 * @param {object} options
 * @returns {{ok: true, key: DeviceKey, machineId: string} | {ok: false, code: string, detail: string}}
 */
function resolveLocalKey({
  deviceKey,
  deviceKeyFile = '',
  deviceKeyDir = '',
  machineId = '',
  allowCreateDeviceKey = false,
}) {
  if (deviceKey instanceof DeviceKey) {
    if (typeof deviceKey.publicKeyBase64 !== 'string') {
      return {
        ok: false,
        code: WEBRTC_TRANSPORT_CODE.DEVICE_KEY_REQUIRED,
        detail: 'deviceKey is not a DeviceKey',
      };
    }
    if (typeof machineId !== 'string' || machineId === '') {
      if (typeof deviceKey.machineId !== 'string' || deviceKey.machineId === '') {
        return {
          ok: false,
          code: WEBRTC_TRANSPORT_CODE.DEVICE_KEY_REQUIRED,
          detail: 'machineId is required and the key has none',
        };
      }
      machineId = deviceKey.machineId;
    }
    if (deviceKey.machineId === null) deviceKey.machineId = machineId;
    return { ok: true, key: deviceKey, machineId };
  }
  if (typeof machineId !== 'string' || machineId === '') {
    return { ok: false, code: WEBRTC_TRANSPORT_CODE.DEVICE_KEY_REQUIRED, detail: 'machineId is required' };
  }
  const file = deviceKeyFile || (deviceKeyDir ? join(deviceKeyDir, 'device.key') : '');
  if (file === '') {
    return {
      ok: false,
      code: WEBRTC_TRANSPORT_CODE.DEVICE_KEY_REQUIRED,
      detail: 'deviceKey, deviceKeyFile or deviceKeyDir is required',
    };
  }
  if (allowCreateDeviceKey !== true && !existsSync(file)) {
    return {
      ok: false,
      code: WEBRTC_TRANSPORT_CODE.DEVICE_KEY_REQUIRED,
      detail: `${file} does not exist (set allowCreateDeviceKey=true to mint a new identity intentionally)`,
    };
  }
  const resolved = resolveDeviceKey({ file, machineId });
  if (resolved.ok !== true) return resolved;
  return { ok: true, key: resolved.key, machineId };
}

/**
 * Create a `webrtc-v1` transport. The result is always an object; a configuration failure is a
 * named refusal, never a thrown exception, so a status tool can show it.
 *
 * @param {object} [options]
 * @param {string} [options.name]
 * @param {'host'|'client'} [options.role]
 * @param {string} [options.signalUrl] Full `ws://`/`wss://` URL.
 * @param {string} [options.room]
 * @param {string} [options.peerId]
 * @param {string} [options.peerMachineId] The other machine's W2M id.
 * @param {string} [options.machineId] This machine's W2M id.
 * @param {string} [options.peerPublicKey] The peer's pinned static key (initiator).
 * @param {Map<string,string>} [options.peerKeys] Peer key map (responder).
 * @param {DeviceKey} [options.deviceKey]
 * @param {string} [options.deviceKeyFile]
 * @param {string} [options.deviceKeyDir]
 * @param {boolean} [options.allowCreateDeviceKey]
 * @param {string} [options.providerCommand]
 * @param {string[]} [options.providerArgs]
 * @param {string} [options.providerCwd]
 * @param {Record<string,string|undefined>} [options.providerEnv]
 * @param {Function} [options.providerFactory]
 * @param {Function} [options.signalingFactory]
 * @param {Array<object>} [options.iceServers]
 * @param {boolean} [options.preferP2p]
 * @param {boolean} [options.allowRelay]
 * @param {number} [options.maxRttMs]
 * @param {number} [options.connectTimeoutMs]
 * @param {number} [options.handshakeTimeoutMs]
 * @param {number} [options.peerTimeoutMs]
 * @param {number} [options.statsPollMs]
 * @param {number} [options.maxFragmentBytes]
 * @param {Function} [options.WebSocketImpl]
 * @returns {{ok: true, transport: object} | {ok: false, code: string, detail: string}}
 */
export function createWebRtcTransport({
  name = WEBRTC_TRANSPORT,
  role = '',
  signalUrl = '',
  signalToken = '',
  room = 'w2m',
  peerId = randomPeerId(),
  peerMachineId = '',
  machineId = '',
  peerPublicKey = '',
  peerKeys = null,
  deviceKey = null,
  deviceKeyFile = '',
  deviceKeyDir = '',
  allowCreateDeviceKey = false,
  providerCommand = '',
  providerArgs = [],
  providerCwd = '',
  providerEnv = undefined,
  providerFactory = null,
  signalingFactory = null,
  iceServers = [],
  preferP2p = true,
  allowRelay = true,
  maxRttMs = 350,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  handshakeTimeoutMs = 15_000,
  peerTimeoutMs = 20_000,
  statsPollMs = 2_000,
  maxFragmentBytes = 16 * 1024,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  if (role !== 'host' && role !== 'client') {
    return {
      ok: false,
      code: WEBRTC_TRANSPORT_CODE.BAD_ROLE,
      detail: `role must be host or client, got ${String(role)}`,
    };
  }
  if (typeof signalUrl !== 'string' || signalUrl === '') {
    return { ok: false, code: WEBRTC_TRANSPORT_CODE.MISCONFIGURED, detail: 'signalUrl is required' };
  }
  if (typeof peerMachineId !== 'string' || peerMachineId === '') {
    return { ok: false, code: WEBRTC_TRANSPORT_CODE.MISCONFIGURED, detail: 'peerMachineId is required' };
  }
  const built = buildSignalingUrl(signalUrl, { room, role, peerId, token: signalToken });
  if (built.ok !== true) return built;
  const ice = normalizeIceServers(iceServers);
  if (ice.ok !== true) return ice;
  if (ice.refused.length > 0) {
    return {
      ok: false,
      code: WEBRTC_TRANSPORT_CODE.BAD_ICE_SERVERS,
      detail: `refused ICE server(s): ${JSON.stringify(ice.refused)}`,
    };
  }
  const key = resolveLocalKey({ deviceKey, deviceKeyFile, deviceKeyDir, machineId, allowCreateDeviceKey });
  if (key.ok !== true) return key;

  let pinnedPeerKey = typeof peerPublicKey === 'string' ? peerPublicKey : '';
  if (pinnedPeerKey === '' && peerKeys instanceof Map) {
    pinnedPeerKey = peerKeys.get(peerMachineId) ?? '';
  }
  if (role === 'client' && !isPeerKey(pinnedPeerKey)) {
    return {
      ok: false,
      code: WEBRTC_TRANSPORT_CODE.PEER_KEY_REQUIRED,
      detail: 'the client needs peerPublicKey (or a peerKeys entry) for the pinned static key',
    };
  }
  if (role === 'host' && !(peerKeys instanceof Map)) {
    return {
      ok: false,
      code: WEBRTC_TRANSPORT_CODE.PEER_KEY_REQUIRED,
      detail: 'the host needs a peerKeys Map keyed by machine id',
    };
  }

  const path = new PathSelector({ iceServers: ice.servers, preferP2p, allowRelay, maxRttMs });
  const fragmenter = new Fragmenter({ maxFragmentBytes });
  const reassembler = new Reassembler({ maxMessageBytes: MAX_MESSAGE_BYTES });
  const handlers = new Set();
  let state = 'idle';
  let bridge = null;
  let signal = null;
  let secure = null;
  const peerActual = peerMachineId;
  let lastError = null;
  let startPromise = null;
  let settleStart = null;
  let startDeadline = null;
  let statsTimer = null;
  let startedAt = null;
  let secureAt = null;
  let stopped = false;
  const stats = {
    starts: 0,
    messages_sent: 0,
    messages_received: 0,
    bytes_sent: 0,
    bytes_received: 0,
    fragments_sent: 0,
    fragments_received: 0,
    providers: 0,
  };

  const finishStart = (value) => {
    if (settleStart !== null) {
      const resolve = settleStart;
      settleStart = null;
      resolve(value);
    }
    if (startDeadline !== null) {
      clearTimeout(startDeadline);
      startDeadline = null;
    }
  };

  const fail = (code, detail) => {
    lastError = { code, detail };
    if (state !== 'stopped') state = 'failed';
    finishStart({ ok: false, code, detail });
    // A named failure must not leave a provider process or a signaling socket alive. `teardown` is
    // idempotent, and queueing it keeps `fail` safe to call from inside a socket callback.
    queueMicrotask(() => {
      void teardown();
    });
    return lastError;
  };

  const emitMessage = (payload, kind) => {
    for (const handler of handlers) {
      try {
        handler({ peer: peerActual, payload, kind, transport: name });
      } catch (error) {
        lastError = {
          code: 'WEBRTC_HANDLER_THREW',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };

  const pollStats = async () => {
    if (bridge === null || state !== 'ready') return;
    const result = await bridge.call('getStats', {}, { timeoutMs: 2_000 });
    if (result.ok === true && result.result) path.recordStats(result.result);
  };

  const onSecureFrame = ({ kind, body }) => {
    if (kind === FRAME_KIND.DATA) {
      stats.messages_received += 1;
      stats.bytes_received += body.length;
      emitMessage(body, 'data');
      return;
    }
    if (kind === FRAME_KIND.CHUNK) {
      stats.fragments_received += 1;
      const assembled = reassembler.push(body);
      if (assembled.ok === true) {
        stats.messages_received += 1;
        stats.bytes_received += assembled.payload.length;
        emitMessage(assembled.payload, 'chunked');
      }
    }
  };

  const openSecure = async () => {
    if (secure !== null || state === 'stopped') return;
    if (typeof WebSocketImpl !== 'function') {
      fail(
        WEBRTC_TRANSPORT_CODE.SIGNAL_UNAVAILABLE,
        'no global WebSocket; use Node 22+ or inject WebSocketImpl',
      );
      return;
    }
    secure = new SecureChannel({
      role: role === 'client' ? 'initiator' : 'responder',
      deviceKey: key.key,
      peerMachineId,
      peerPublicKey: role === 'client' ? pinnedPeerKey : '',
      peerKeys: role === 'host' ? peerKeys : null,
      handshakeTimeoutMs,
      sendRaw: (frame) => bridge.sendData(frame),
    });
    secure.on('frame', onSecureFrame);
    secure.on('error', (error) => {
      lastError = error;
    });
    secure.on('close', (reason) => {
      if (state === 'ready') {
        state = 'closed';
        path.recordFailure(reason);
      }
    });
    secure.on('secure', () => {
      state = 'ready';
      secureAt = Date.now();
      path.recordSuccess();
      finishStart({
        ok: true,
        transport: name,
        role,
        peer: peerActual,
        path: path.verdict(),
        secure: secure.diagnostics(),
      });
    });
    const started = secure.start();
    if (started !== null && typeof started === 'object' && typeof started.then === 'function') {
      const result = await started;
      if (result.ok !== true)
        fail(
          result.code ?? WEBRTC_TRANSPORT_CODE.SEND_FAILED,
          result.detail ?? 'Noise handshake failed to send',
        );
    } else if (started.ok !== true) {
      fail(
        started.code ?? WEBRTC_TRANSPORT_CODE.SEND_FAILED,
        started.detail ?? 'Noise handshake failed to send',
      );
    }
  };

  const attachBridge = () => {
    bridge.on('ready', () => {
      stats.providers += 1;
    });
    bridge.on('local-description', (event) => {
      const type = event.type === 'answer' ? 'answer' : 'offer';
      const sdp = event.sdp ?? event.description?.sdp;
      if (typeof sdp !== 'string' || signal === null) {
        lastError = {
          code: 'WEBRTC_LOCAL_DESCRIPTION_BAD',
          detail: 'engine emitted a local description without sdp',
        };
        return;
      }
      const sent = signal.sendSignal(type, { type, sdp });
      if (sent.ok !== true) lastError = { code: sent.code, detail: sent.detail };
    });
    bridge.on('ice-candidate', (event) => {
      if (signal === null) return;
      const candidate = event.candidate ?? event;
      const payload = typeof candidate === 'string' ? { candidate } : candidate;
      const sent = signal.sendSignal('candidate', payload);
      if (sent.ok !== true) lastError = { code: sent.code, detail: sent.detail };
    });
    bridge.on('state', (event) => {
      const next = typeof event.state === 'string' ? event.state : 'unknown';
      if (next === 'failed') {
        path.recordFailure('WEBRTC_ICE_FAILED');
        fail('WEBRTC_ICE_FAILED', 'the WebRTC engine reported failed');
      } else if (next === 'disconnected') {
        path.recordFailure('WEBRTC_ICE_DISCONNECTED');
      } else if (next === 'connected' || next === 'completed') {
        path.recordSuccess();
      }
    });
    bridge.on('open', () => {
      void openSecure();
    });
    bridge.on('data', (data) => {
      if (secure !== null) secure.handle(data);
    });
    bridge.on('stats', (event) => {
      path.recordStats(event.payload ?? event);
    });
    bridge.on('error', (error) => {
      lastError = error;
      if (state !== 'ready' && state !== 'closed')
        fail(error.code ?? 'WEBRTC_PROVIDER_ERROR', error.detail ?? 'engine error');
    });
    bridge.on('close', (reason) => {
      if (state === 'ready' || state === 'connecting') {
        if (state === 'ready') {
          state = 'closed';
          path.recordFailure('WEBRTC_PROVIDER_CLOSED');
          lastError = { code: 'WEBRTC_PROVIDER_CLOSED', detail: String(reason) };
        } else {
          fail('WEBRTC_PROVIDER_CLOSED', String(reason));
        }
      }
    });
  };

  let remoteDescriptionSet = false;
  const pendingRemoteCandidates = [];
  const attachSignal = () => {
    signal.on('signal', (message) => {
      if (bridge === null) return;
      if (message.kind === 'offer' || message.kind === 'answer') {
        const sdp = message.payload?.sdp ?? message.payload;
        if (typeof sdp !== 'string') {
          lastError = { code: 'WEBRTC_REMOTE_DESCRIPTION_BAD', detail: 'signal payload has no sdp' };
          return;
        }
        bridge.call('setRemoteDescription', { type: message.kind, sdp }).then((result) => {
          if (result.ok !== true) { lastError = { code: result.code, detail: result.detail }; return; }
          remoteDescriptionSet = true;
          for (const candidate of pendingRemoteCandidates.splice(0)) {
            bridge.call('addIceCandidate', { candidate }).then((added) => {
              if (added.ok !== true) lastError = { code: added.code, detail: added.detail };
            });
          }
        });
        return;
      }
      if (message.kind === 'candidate') {
        const candidate = message.payload?.candidate ?? message.payload;
        if (!remoteDescriptionSet) { pendingRemoteCandidates.push(candidate); return; }
        bridge
          .call('addIceCandidate', { candidate })
          .then((result) => {
            if (result.ok !== true) lastError = { code: result.code, detail: result.detail };
          });
      }
    });
    signal.on('peer-joined', () => {
      // The signaling `peer` is a room-scoped socket id, not a W2M machine id. The transport is
      // bound to `peerMachineId` (which is what `send(peer, ...)` and the Noise handshake use);
      // keeping them separate prevents "send to the machine" from accidentally naming a socket.
    });
    signal.on('peer-left', () => {
      path.recordFailure('WEBRTC_PEER_LEFT');
      if (state !== 'stopped') fail('WEBRTC_PEER_LEFT', 'the signaling peer left');
    });
    signal.on('error', (error) => {
      lastError = error;
    });
    signal.on('close', (reason) => {
      if (state === 'ready' || state === 'connecting') {
        if (state === 'ready') {
          state = 'closed';
          path.recordFailure('WEBRTC_SIGNAL_CLOSED');
          lastError = { code: 'WEBRTC_SIGNAL_CLOSED', detail: String(reason) };
        } else {
          fail('WEBRTC_SIGNAL_CLOSED', String(reason));
        }
      }
    });
  };

  const doStart = async () => {
    if (state === 'ready') return { ok: true, transport: name, role, peer: peerActual, path: path.verdict() };
    if (state === 'stopped')
      return { ok: false, code: WEBRTC_TRANSPORT_CODE.STOPPED, detail: 'transport is stopped' };
    state = 'connecting';
    startedAt = Date.now();
    stats.starts += 1;
    let resolveStart;
    startPromise = new Promise((resolve) => {
      resolveStart = resolve;
    });
    settleStart = resolveStart;
    startDeadline = setTimeout(() => {
      fail(WEBRTC_TRANSPORT_CODE.CONNECT_TIMEOUT, `no secure channel within ${connectTimeoutMs} ms`);
      void teardown();
    }, connectTimeoutMs);
    startDeadline.unref?.();

    bridge = new ProviderBridge({
      command: providerCommand,
      args: providerArgs,
      cwd: providerCwd,
      env: providerEnv,
      factory: providerFactory,
    });
    attachBridge();
    const started = await bridge.start();
    if (started.ok !== true) {
      fail(
        started.code ?? WEBRTC_TRANSPORT_CODE.PROVIDER_UNAVAILABLE,
        started.detail ?? 'provider did not start',
      );
      await teardown();
      return startPromise;
    }

    if (typeof WebSocketImpl !== 'function') {
      fail(
        WEBRTC_TRANSPORT_CODE.SIGNAL_UNAVAILABLE,
        'no global WebSocket; use Node 22+ or inject WebSocketImpl',
      );
      await teardown();
      return startPromise;
    }
    signal =
      typeof signalingFactory === 'function'
        ? signalingFactory({ url: built.url, room, role, peerId, WebSocketImpl })
        : new SignalingClient({
            url: built.url,
            room,
            role,
            peerId,
            WebSocketImpl,
          });
    attachSignal();
    const connected = await signal.connect();
    if (connected.ok !== true) {
      fail(
        connected.code ?? WEBRTC_TRANSPORT_CODE.SIGNAL_UNAVAILABLE,
        connected.detail ?? 'signaling did not connect',
      );
      await teardown();
      return startPromise;
    }
    const peer = await signal.waitForPeer(peerTimeoutMs);
    if (peer.ok !== true) {
      fail(peer.code ?? WEBRTC_TRANSPORT_CODE.CONNECT_TIMEOUT, peer.detail ?? 'no signaling peer');
      await teardown();
      return startPromise;
    }
    // `peer.peer` is the signaling socket's room id. The data-plane peer identity stays
    // `peerMachineId`, because that is what the Noise handshake and `send(peer)` name.

    const effectiveIceServers = allowRelay
      ? ice.servers
      : ice.servers.filter((server) => !server.urls.some((url) => /^turns?:/i.test(url)));
    const created = await bridge.call('create', {
      role,
      iceServers: effectiveIceServers,
      // `all` lets ICE use host/srflx; when relay is forbidden we removed TURN servers rather than
      // forcing `relay`, because `relay` would forbid the direct path this transport exists for.
      iceTransportPolicy: 'all',
      maxMessageBytes: MAX_MESSAGE_BYTES,
    });
    if (created.ok !== true) {
      fail(
        created.code ?? WEBRTC_TRANSPORT_CODE.PROVIDER_UNAVAILABLE,
        created.detail ?? 'engine refused create',
      );
      await teardown();
      return startPromise;
    }
    if (role === 'client') {
      const offered = await bridge.call('createOffer', {});
      if (offered.ok !== true) {
        fail(
          offered.code ?? WEBRTC_TRANSPORT_CODE.PROVIDER_UNAVAILABLE,
          offered.detail ?? 'engine refused createOffer',
        );
        await teardown();
        return startPromise;
      }
    }
    if (statsPollMs > 0) {
      statsTimer = setInterval(() => {
        void pollStats();
      }, statsPollMs);
      statsTimer.unref?.();
    }
    return startPromise;
  };

  const teardown = async () => {
    if (stopped) return;
    stopped = true;
    if (startDeadline !== null) {
      clearTimeout(startDeadline);
      startDeadline = null;
    }
    if (statsTimer !== null) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    if (secure !== null) {
      try {
        secure.close('transport-stop', { sendBye: true });
      } catch {
        // already closed
      }
    }
    secure = null;
    if (signal !== null) {
      try {
        signal.close('transport-stop');
      } catch {
        // already closed
      }
    }
    signal = null;
    if (bridge !== null) {
      try {
        await bridge.close();
      } catch {
        // already closed
      }
    }
    bridge = null;
    reassembler.clear();
    if (state !== 'failed') state = 'stopped';
  };

  const transport = {
    name,
    async start() {
      if (state === 'ready')
        return { ok: true, transport: name, role, peer: peerActual, path: path.verdict() };
      if (state === 'connecting' && startPromise !== null) return startPromise;
      if (state === 'stopped')
        return { ok: false, code: WEBRTC_TRANSPORT_CODE.STOPPED, detail: 'transport is stopped' };
      return doStart();
    },
    async stop() {
      await teardown();
      return { ok: true, state };
    },
    async send(peer, payload) {
      if (state !== 'ready' || secure === null) {
        return { ok: false, code: WEBRTC_TRANSPORT_CODE.NOT_READY, detail: state };
      }
      if (typeof peer === 'string' && peer !== '' && peer !== peerActual) {
        return {
          ok: false,
          code: WEBRTC_TRANSPORT_CODE.UNKNOWN_PEER,
          detail: `this transport is bound to ${peerActual}`,
        };
      }
      let frames;
      try {
        frames = fragmenter.split(payload);
      } catch (error) {
        return {
          ok: false,
          code: error?.code ?? WEBRTC_TRANSPORT_CODE.SEND_FAILED,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      let bytes = 0;
      for (const frame of frames) {
        const result = await secure.send(frame.body, { kind: frame.kind });
        if (result.ok !== true) {
          return {
            ok: false,
            code: result.code ?? WEBRTC_TRANSPORT_CODE.SEND_FAILED,
            detail: result.detail ?? 'secure send failed',
          };
        }
        bytes += frame.body.length;
        stats.fragments_sent += 1;
      }
      stats.messages_sent += 1;
      stats.bytes_sent += bytes;
      path.recordSuccess();
      return { ok: true, peer: peerActual, bytes, fragments: frames.length };
    },
    onMessage(handler) {
      if (typeof handler !== 'function') return () => {};
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    paths() {
      return path.paths();
    },
    diagnostics() {
      return {
        name,
        state,
        role,
        room,
        peer_id: peerId,
        peer_machine_id: peerMachineId,
        peer_actual: peerActual,
        signal_peer: signal?.peer ?? null,
        signal_url: built.url.replace(/token=[^&]*/, 'token=<redacted>'),
        started_at: startedAt,
        secure_at: secureAt,
        path: path.diagnostics(),
        secure: secure?.diagnostics() ?? null,
        signal: signal?.diagnostics() ?? null,
        provider: bridge?.diagnostics() ?? null,
        reassembly: { incomplete: reassembler.size(), dropped: reassembler.dropped },
        stats: { ...stats },
        last_error: lastError,
      };
    },
    async probe(timeoutMs = 5_000) {
      if (secure === null || state !== 'ready') {
        return { ok: false, code: WEBRTC_TRANSPORT_CODE.NOT_READY, detail: state };
      }
      const result = await secure.probe(timeoutMs);
      if (result.ok === true) {
        const statsResult = await bridge.call('getStats', {}, { timeoutMs: 2_000 });
        if (statsResult.ok === true && statsResult.result) path.recordStats(statsResult.result);
      }
      return result;
    },
  };

  const shape = assertTransportShape(transport);
  if (shape.ok !== true) {
    return { ok: false, code: 'WEBRTC_BAD_SHAPE', detail: shape.detail };
  }
  return { ok: true, transport };
}
