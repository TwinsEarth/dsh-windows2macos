import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { negotiateTransports, raceTransports } from '../src/agent/p2p-race.mjs';

const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe('multi-transport negotiation and race', () => {
  it('intersects capabilities and never invents a transport', () => {
    assert.deepEqual(negotiateTransports({ local: ['udp', 'iroh'], remote: ['udp', 'iroh'] }), ['iroh', 'udp']);
    assert.deepEqual(negotiateTransports({ local: ['udp', 'iroh'], remote: null }), ['udp']);
    assert.deepEqual(negotiateTransports({ local: ['udp'], remote: ['iroh'] }), []);
    assert.deepEqual(negotiateTransports({ local: [], remote: ['udp'] }), []);
  });

  it('lets the fastest usable transport win and aborts the loser', async () => {
    let udpAborted = false;
    const result = await raceTransports({
      budgetMs: 3000,
      candidates: [
        { name: 'iroh', timeoutMs: 2500, start: () => delay(200, { path: 'iroh' }) },
        { name: 'udp', timeoutMs: 1500, start: ({ signal }) => { signal.addEventListener('abort', () => { udpAborted = true; }); return delay(20, { path: 'udp' }); } },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.name, 'udp');
    assert.deepEqual(result.channel, { path: 'udp' });
    assert.equal(udpAborted, false, 'the winner must not be aborted');
  });

  it('falls through to the next transport when the first fails', async () => {
    const result = await raceTransports({
      budgetMs: 3000,
      candidates: [
        { name: 'iroh', timeoutMs: 2500, start: async () => { throw Object.assign(new Error('no relay'), { code: 'IROH_UNAVAILABLE' }); } },
        { name: 'udp', timeoutMs: 1500, start: ({ signal }) => { signal.addEventListener('abort', () => { throw new Error('aborted'); }); return delay(30, { path: 'udp' }); } },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.name, 'udp');
    assert.equal(result.attempts.find((a) => a.name === 'iroh').code, 'IROH_UNAVAILABLE');
  });

  it('reports ALL_TRANSPORTS_FAILED instead of falling back to relay', async () => {
    const result = await raceTransports({
      budgetMs: 300,
      candidates: [
        { name: 'iroh', timeoutMs: 100, start: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) },
        { name: 'udp', timeoutMs: 100, start: async () => { throw Object.assign(new Error('closed'), { code: 'UDP_CHANNEL_CLOSED' }); } },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ALL_TRANSPORTS_FAILED');
    assert.equal(result.attempts.length, 2);
  });
});
