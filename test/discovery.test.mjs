import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DISCOVERY_SOURCE,
  createRelayDiscovery,
  createStaticDiscovery,
  mergeCandidates,
} from '../src/agent/discovery.mjs';

describe('W3: discovery providers produce candidates only', () => {
  it('reads relay candidates and the peer static key from /v1/peer', async () => {
    const discovery = createRelayDiscovery({
      getJson: async (path) => ({
        ok: true,
        status: 200,
        json: { peer: { candidates: [{ address: '192.168.1.5', port: 5000 }], static_key: 'abc' } },
        path,
      }),
    });
    const result = await discovery.discover('machine-a');
    assert.equal(result.ok, true);
    assert.equal(result.source, DISCOVERY_SOURCE.RELAY);
    assert.equal(result.candidates[0].address, '192.168.1.5');
    assert.equal(result.staticKey, 'abc');
  });

  it('names a relay miss and a bad machine id', async () => {
    const miss = createRelayDiscovery({ getJson: async () => ({ ok: false, status: 404, json: null }) });
    assert.equal((await miss.discover('m')).code, 'DISCOVERY_RELAY_MISS');
    const discovery = createRelayDiscovery({ getJson: async () => ({ ok: true, status: 200, json: { peer: {} } }) });
    assert.equal((await discovery.discover('')).code, 'DISCOVERY_BAD_MACHINE_ID');
    assert.equal(createRelayDiscovery({}).code, 'DISCOVERY_NO_GET_JSON');
  });

  it('merges by address:port, ranks relay first, and filters unusable addresses', async () => {
    const relay = createStaticDiscovery({ source: DISCOVERY_SOURCE.RELAY, candidates: [{ address: '10.0.0.5', port: 6000 }] });
    const mdns = createStaticDiscovery({
      source: DISCOVERY_SOURCE.MDNS,
      candidates: [
        { address: '10.0.0.5', port: 6000 },
        { address: '10.0.0.6', port: 6001 },
        { address: '0.0.0.0', port: 6002 },
        { address: '10.0.0.7', port: 0 },
      ],
    });
    const [relayResult, mdnsResult] = await Promise.all([relay.discover(), mdns.discover()]);
    const merged = mergeCandidates([mdnsResult, relayResult]);
    assert.deepEqual(merged.map((candidate) => candidate.address + ':' + candidate.port), ['10.0.0.5:6000', '10.0.0.6:6001']);
    assert.equal(merged[0].source, DISCOVERY_SOURCE.RELAY);
    assert.equal(merged[1].source, DISCOVERY_SOURCE.MDNS);
    assert.equal(mergeCandidates([mdnsResult], { limit: 1 }).length, 1);
  });
});
