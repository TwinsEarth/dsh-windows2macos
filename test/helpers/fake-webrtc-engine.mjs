/**
 * In-process fake WebRTC engine for the `webrtc-v1` tests.
 *
 * It implements the JSON-line provider protocol *as messages* (the same `{id, method, params}` /
 * `{id, ok, result}` shapes) and pairs two engines in one process. It is not a WebRTC
 * implementation: there is no ICE, no DTLS, no SDP parsing. What it does provide is the exact
 * control flow the transport depends on — offer/answer ordering, a DataChannel `open`, byte
 * delivery, stats and close — so the test exercises the real signaling server, real Noise handshake,
 * real framing and real fragmentation without a native addon.
 */

import { EventEmitter } from 'node:events';

import { DeviceKey } from '../../src/agent/crypto.mjs';

/**
 * @typedef {object} FakeNetwork
 * @property {(role: 'host'|'client') => () => object} factoryFor
 * @property {() => void} close
 * @property {Map<string, object>} engines
 */

/**
 * @param {{stats?: object, roleKey?: string}} [options]
 * @returns {FakeNetwork}
 */
export function createFakeWebRtcNetwork({ stats = null } = {}) {
  /** @type {Map<string, object>} */
  const engines = new Map();
  const opened = new Set();

  /**
   * @param {'host'|'client'} role
   * @returns {object}
   */
  const makeEngine = (role) => {
    const engine = new EventEmitter();
    let closed = false;
    const other = () => engines.get(role === 'host' ? 'client' : 'host') ?? null;
    const reply = (id, result) => engine.emit('message', { id, ok: true, result });
    const fail = (id, code, message) => engine.emit('message', { id, ok: false, error: { code, message } });
    const emit = (event, value = {}) => engine.emit('message', { event, ...value });

    engine.send = (message) => {
      if (closed) return;
      try {
        switch (message.method) {
          case 'create':
            engines.set(role, engine);
            reply(message.id, { provider: 'fake-webrtc', version: 'test' });
            return;
          case 'createOffer':
            queueMicrotask(() => {
              emit('local-description', { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' });
              reply(message.id, { type: 'offer' });
            });
            return;
          case 'setRemoteDescription':
            queueMicrotask(() => {
              if (message.params.type === 'offer') {
                emit('local-description', { type: 'answer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' });
              }
              if (!opened.has(role)) {
                opened.add(role);
                const target = other();
                setTimeout(() => {
                  emit('state', { state: 'connected' });
                  emit('open');
                  if (target !== null && !opened.has(role === 'host' ? 'client' : 'host')) {
                    opened.add(role === 'host' ? 'client' : 'host');
                    target.emit('message', { event: 'state', state: 'connected' });
                    target.emit('message', { event: 'open' });
                  }
                }, 0);
              }
              reply(message.id, {});
            });
            return;
          case 'addIceCandidate':
            queueMicrotask(() => reply(message.id, {}));
            return;
          case 'send': {
            const data = Buffer.from(message.params.data, 'base64');
            const target = other();
            queueMicrotask(() => {
              target?.emit('message', { event: 'data', data: data.toString('base64') });
              reply(message.id, { bufferedAmount: 0 });
            });
            return;
          }
          case 'getStats':
            queueMicrotask(() =>
              reply(message.id, {
                selectedPair: {
                  localCandidate: { type: 'host', protocol: 'udp', address: '127.0.0.1', port: 41000 },
                  remoteCandidate: { type: 'srflx', protocol: 'udp', address: '203.0.113.7', port: 41001 },
                },
                currentRoundTripTimeMs: 18,
                bytesSent: 4096,
                bytesReceived: 2048,
                ...(stats ?? {}),
              }),
            );
            return;
          case 'close':
            queueMicrotask(() => {
              reply(message.id, {});
              engine.emit('close');
            });
            return;
          default:
            fail(message.id, 'PROVIDER_METHOD_UNKNOWN', message.method);
        }
      } catch (error) {
        fail(message.id, 'PROVIDER_METHOD_FAILED', error.message);
      }
    };
    engine.close = () => {
      if (closed) return;
      closed = true;
      engine.emit('close');
    };
    setTimeout(() => {
      if (!closed) emit('ready', { provider: 'fake-webrtc', version: 'test' });
    }, 0);
    return engine;
  };

  return {
    engines,
    factoryFor: (role) => () => makeEngine(role),
    close: () => {
      for (const engine of engines.values()) engine.close();
      engines.clear();
    },
  };
}

/**
 * Generate two machine keys and the pair maps both sides need.
 * @returns {{a: DeviceKey, b: DeviceKey, peersForA: Map<string,string>, peersForB: Map<string,string>}}
 */
export function makePeerKeys() {
  const a = DeviceKey.generate('machine-a');
  const b = DeviceKey.generate('machine-b');
  return {
    a,
    b,
    peersForA: new Map([['machine-b', b.publicKeyBase64]]),
    peersForB: new Map([['machine-a', a.publicKeyBase64]]),
  };
}
