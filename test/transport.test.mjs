import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TRANSPORT,
  assertTransportShape,
  createTransportRegistry,
  createUdpTransport,
  resolveTransports,
} from '../src/agent/transport.mjs';

class FakeChannel {
  constructor(peer) { this.peer = peer; this.handlers = new Map(); this.sent = []; }
  on(event, handler) { if (!this.handlers.has(event)) this.handlers.set(event, new Set()); this.handlers.get(event).add(handler); }
  emit(event, value) { for (const handler of this.handlers.get(event) ?? []) handler(value); }
  async send(payload) { this.sent.push(Buffer.from(String(payload))); return { ok: true }; }
  close() { this.emit('close'); }
}

const fakeNode = () => {
  const channels = new Map();
  let dials = 0;
  return {
    channels,
    get dials() { return dials; },
    async dial(peer) {
      dials += 1;
      if (peer === 'offline') return { ok: false, code: 'P2P_NO_CANDIDATES', error: 'offline' };
      const channel = new FakeChannel(peer);
      channels.set(peer, channel);
      return { ok: true, channel };
    },
    status() { return { candidates: [{ address: '127.0.0.1', port: 5000 }], encryption: { encrypted_channels: 1 }, last_error: null }; },
    close() { this.closed = true; },
  };
};

describe('W0: P2PTransport contract', () => {
  it('resolves configured transports without inventing one and always keeps udp', () => {
    assert.deepEqual(resolveTransports({}).transports, [TRANSPORT.UDP]);
    const resolved = resolveTransports({ transports: [TRANSPORT.IROH, TRANSPORT.UDP, 'bogus'] });
    assert.deepEqual(resolved.transports, [TRANSPORT.IROH, TRANSPORT.UDP]);
    assert.equal(resolved.refused[0].code, 'TRANSPORT_UNKNOWN');
    assert.deepEqual(resolveTransports({ transports: [] }).transports, [TRANSPORT.UDP]);
  });

  it('adapts a node as udp-v1: one dial per peer, messages fan out, close is named', async () => {
    const node = fakeNode();
    const created = createUdpTransport({ node });
    assert.equal(created.ok, true);
    const transport = created.transport;
    const seen = [];
    transport.onMessage((message) => seen.push(message));
    await transport.start();
    await transport.send('peer-a', 'one');
    await transport.send('peer-a', 'two');
    assert.equal(node.dials, 1, 'the channel is cached per peer');
    node.channels.get('peer-a').emit('message', Buffer.from('reply'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].peer, 'peer-a');
    assert.equal(seen[0].payload.toString(), 'reply');
    assert.equal(transport.paths()[0].transport, TRANSPORT.UDP);
    assert.equal(transport.diagnostics().channels, 1);
    const failed = await transport.send('offline', 'x');
    assert.equal(failed.code, 'P2P_NO_CANDIDATES');
    await transport.stop();
    const closed = await transport.send('peer-a', 'x');
    assert.equal(closed.code, 'TRANSPORT_CLOSED');
  });

  it('rejects a broken transport and keeps the valid ones', () => {
    const registry = createTransportRegistry({
      transports: [{ name: 'udp-v1', start() {}, stop() {}, send() {}, onMessage() {}, paths() {}, diagnostics() {} }, { name: 'iroh-v1' }],
    });
    assert.deepEqual(registry.names, ['udp-v1']);
    assert.equal(registry.refused.length, 1);
    assert.equal(registry.refused[0].detail, 'missing start');
    assert.equal(assertTransportShape(null).code, 'TRANSPORT_BAD_SHAPE');
  });
});
