/**
 * Reference WebRTC engine for `webrtc-v1`, using `node-datachannel`.
 *
 * This file is **not** a package dependency. `node-datachannel` is a native addon and the
 * published package keeps `dependencies: {}`; install it in a separate directory and point
 * `providerCommand` at this script with that directory as `providerCwd`:
 *
 *   mkdir -p ~/.w2m/webrtc-provider
 *   cd ~/.w2m/webrtc-provider
 *   npm init -y && npm install node-datachannel
 *   node /path/to/w2m/src/agent/webrtc/providers/node-datachannel-provider.mjs
 *
 * The provider owns only PeerConnection/DataChannel. SDP policy, ICE candidate accounting,
 * fragmentation and the Noise boundary stay in the transport, so swapping this file for another
 * engine does not change the W2M trust model.
 *
 * Protocol: one JSON object per line. Requests are `{id, method, params}`; replies are
 * `{id, ok, result}` or `{id, ok:false, error:{code,message}}`. Unsolicited events carry `event`.
 */

import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import readline from 'node:readline';

/** Resolve the optional addon from the caller's working directory, not from this package. */
function loadAddon() {
  const requireFromCwd = createRequire(resolvePath(process.cwd(), 'package.json'));
  return requireFromCwd('node-datachannel');
}

let addon;
try {
  addon = loadAddon();
} catch (error) {
  process.stderr.write(`node-datachannel is not installed in ${process.cwd()}: ${error.message}\n`);
  process.exit(2);
}

const api = addon?.default ?? addon;
// `node-datachannel` requires a callback argument even though it is only a log sink; calling it
// with one argument throws `Function expected` before the provider can announce ready.
api.initLogger?.('Error', () => {});

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result = {}) => out({ id, ok: true, result });
const fail = (id, code, message) => out({ id, ok: false, error: { code, message } });
const event = (name, value = {}) => out({ event: name, ...value });

/** @type {any} */
let pc = null;
/** @type {any} */
let dc = null;
let closed = false;

function attachDataChannel(channel) {
  dc = channel;
  channel.onOpen?.(() => event('open'));
  channel.onClosed?.(() => {
    dc = null;
    event('state', { state: 'disconnected' });
  });
  channel.onMessage?.((data) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    event('data', { data: bytes.toString('base64') });
  });
}

function iceServersFor(params) {
  const list = Array.isArray(params?.iceServers) ? params.iceServers : [];
  const withCredentials = (server, url) => {
    if (!server.username || !server.credential) return url;
    if (!/^(turn|turns):/i.test(url) || url.includes('@')) return url;
    // node-datachannel parses TURN credentials out of the URL; it does not accept a separate
    // username/credential object alongside an array-shaped `urls`.
    return url.replace(/^(turn|turns):/i, `$1:${encodeURIComponent(server.username)}:${encodeURIComponent(server.credential)}@`);
  };
  return list.flatMap((server) => {
    if (typeof server === 'string') return [server];
    if (server && typeof server === 'object') {
      if (Array.isArray(server.urls)) {
        // node-datachannel's native layer accepts a plain URL string and rejects both
        // `{urls: ["stun:..."]}` and `{urls: "stun:..."}` with "IceServer config error".
        // Flatten to strings instead of changing the transport's WebRTC-shaped input.
        return server.urls.map((url) => withCredentials(server, String(url)));
      }
    }
    return [];
  });
}

function makePeerConnection(params) {
  const PeerConnection = api.PeerConnection;
  return new PeerConnection('w2m-webrtc', {
    iceServers: iceServersFor(params),
    maxMessageSize: params?.maxMessageBytes ?? 4 * 1024 * 1024,
  });
}

function closeAll() {
  if (closed) return;
  closed = true;
  try {
    dc?.close?.();
  } catch {
    // already closed
  }
  try {
    pc?.close?.();
  } catch {
    // already closed
  }
  dc = null;
  pc = null;
}

async function sendData(bytes) {
  if (!dc) throw new Error('DataChannel is not open');
  // 0.33 exposes `sendMessage` for strings and `sendMessageBinary` for bytes. Sending a Buffer
  // through `sendMessage` throws `String or Null expected` after the PeerConnection has opened.
  if (typeof dc.sendMessageBinary === 'function') {
    dc.sendMessageBinary(bytes);
  } else {
    const sender = dc.sendMessage ?? dc.send;
    if (typeof sender !== 'function') throw new Error('DataChannel has no send method');
    sender.call(dc, bytes);
  }
  const buffered = typeof dc.bufferedAmount === 'function' ? dc.bufferedAmount() : (dc.bufferedAmount ?? 0);
  return { bufferedAmount: Number.isFinite(buffered) ? buffered : 0 };
}

async function stats() {
  if (!pc) return {};
  // node-datachannel 0.33 has no `getStats`; it exposes the selected pair and RTT directly. A
  // `getSelectedCandidatePair() === null` before ICE completes is honest: the transport keeps its
  // previous path selection and does not invent a direct verdict.
  const pair = typeof pc.getSelectedCandidatePair === 'function' ? pc.getSelectedCandidatePair() : null;
  if (!pair) return {};
  const normalize = (candidate) => ({
    type: candidate?.type ?? 'unknown',
    protocol: candidate?.transportType ?? '',
    address: candidate?.address ?? null,
    port: candidate?.port ?? null,
    candidate: candidate?.candidate ?? null,
  });
  return {
    selectedPair: {
      localCandidate: normalize(pair.local),
      remoteCandidate: normalize(pair.remote),
      state: 'connected',
      nominated: true,
    },
    currentRoundTripTimeMs: typeof pc.rtt === 'function' ? pc.rtt() : null,
  };
}

async function handle(message) {
  const { id, method, params = {} } = message;
  try {
    if (method === 'create') {
      closeAll();
      closed = false;
      pc = makePeerConnection(params);
      pc.onLocalDescription?.((sdp, type) => event('local-description', { type, sdp }));
      pc.onLocalCandidate?.((candidate, mid) =>
        event('ice-candidate', { candidate: { candidate, sdpMid: mid ?? '0' } }),
      );
      pc.onStateChange?.((state) => event('state', { state }));
      pc.onDataChannel?.(attachDataChannel);
      reply(id, { provider: 'node-datachannel', version: addon?.version ?? null });
      return;
    }
    if (method === 'createOffer') {
      attachDataChannel(pc.createDataChannel('w2m', { ordered: true }));
      // node-datachannel negotiates when the DataChannel is created; there is no createOffer()
      // method in the 0.33 API. The offer arrives through `onLocalDescription`.
      reply(id);
      return;
    }
    if (method === 'setRemoteDescription') {
      pc.setRemoteDescription(params.sdp, params.type);
      // The answer is also emitted through `onLocalDescription`; the 0.33 API has no createAnswer().
      reply(id);
      return;
    }
    if (method === 'addIceCandidate') {
      const candidate = params.candidate?.candidate ?? params.candidate;
      const mid = params.candidate?.sdpMid ?? '0';
      if (typeof candidate !== 'string' || candidate === '') throw new Error('candidate is empty');
      pc.addRemoteCandidate(candidate, mid);
      reply(id);
      return;
    }
    if (method === 'send') {
      reply(id, await sendData(Buffer.from(params.data ?? '', 'base64')));
      return;
    }
    if (method === 'getStats') {
      reply(id, await stats());
      return;
    }
    if (method === 'close') {
      closeAll();
      reply(id);
      setTimeout(() => process.exit(0), 10).unref?.();
      return;
    }
    fail(id, 'PROVIDER_METHOD_UNKNOWN', String(method));
  } catch (error) {
    fail(
      id,
      'PROVIDER_METHOD_FAILED',
      `${String(method)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    event('error', { code: 'PROVIDER_BAD_JSON', message: 'request is not valid JSON' });
    return;
  }
  void handle(message);
});

input.on('close', () => {
  closeAll();
  process.exit(0);
});

event('ready', { provider: 'node-datachannel', version: addon?.version ?? null });
