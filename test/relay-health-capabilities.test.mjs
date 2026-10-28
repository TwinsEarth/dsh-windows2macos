/** G0-2: relays advertise version/features, and a dispatcher refuses when a required feature is absent. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRelayServer } from '../src/relay/server.mjs';
import { negotiateFeatures, readRelayCapabilities } from '../src/plugin/relay-capabilities.mjs';

const fetchReturning = (doc, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => doc });

describe('relay health advertises version and features', () => {
  it('healthz carries relay_version and a features array', async () => {
    const relay = createRelayServer({ logger: null, operatorToken: 'op-token-for-test' });
    await relay.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await fetch(`${relay.url}/healthz`);
      assert.equal(response.status, 200);
      const doc = await response.json();
      assert.equal(typeof doc.relay_version, 'string');
      assert.ok(Array.isArray(doc.features), 'features must be an array');
      assert.ok(doc.features.includes('target-machines'));
      assert.ok(doc.features.includes('result-projection'));
    assert.ok(doc.features.includes('chat-enc-v2'), 'AEAD v2 encrypted chat envelope is supported');
    } finally {
      await relay.close();
    }
  });
});

describe('capability negotiation', () => {
  it('reads and keeps the advertised fields', async () => {
    const caps = await readRelayCapabilities({ rabbitUrl: 'http://relay.test', fetchImpl: fetchReturning({ relay_version: '1.9.16', features: ['target-machines', 'result-projection'] }) });
    assert.equal(caps.ok, true);
    assert.equal(caps.relay_version, '1.9.16');
    assert.deepEqual(caps.features, ['target-machines', 'result-projection']);
    assert.equal(negotiateFeatures(caps).ok, true);
  });

  it('refuses when a required feature is missing', async () => {
    const caps = await readRelayCapabilities({ rabbitUrl: 'http://relay.test', fetchImpl: fetchReturning({ relay_version: '1.9.16', features: ['relay-version-v1'] }) });
    const verdict = negotiateFeatures(caps);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'RELAY_CAPABILITIES_MISSING');
    assert.deepEqual(verdict.missing, ['target-machines', 'result-projection']);
  });

  it('refuses when an older relay advertises no features at all', async () => {
    const caps = await readRelayCapabilities({ rabbitUrl: 'http://relay.test', fetchImpl: fetchReturning({ relay_id: 'old' }) });
    assert.equal(caps.ok, true);
    const verdict = negotiateFeatures(caps);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'RELAY_CAPABILITIES_MISSING');
    assert.equal(verdict.unknown, true);
  });

  it('reports the relay as unavailable when healthz fails', async () => {
    const caps = await readRelayCapabilities({ rabbitUrl: 'http://relay.test', fetchImpl: fetchReturning({}, 503) });
    assert.equal(caps.ok, false);
    const verdict = negotiateFeatures(caps);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'RELAY_CAPABILITIES_UNAVAILABLE');
  });
});
