/**
 * P2P signalling suite (v0.3.9): the relay's candidate rendezvous.
 *
 * The harness is a local copy rather than a shared import, matching the convention
 * in test/relay.test.mjs and test/stress.test.mjs: suites here must not be able to
 * break each other by editing a common helper.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createRelayServer } from '../src/relay/server.mjs';
import {
  DEFAULT_TTL_MS,
  MAX_CANDIDATES,
  MAX_TTL_MS,
  PeerRegistry,
  isIpv4,
} from '../src/relay/peers.mjs';

const OP = 'p2p-operator-token';

const PLATFORM = { os: 'macos', os_version: '27.0', arch: 'arm64', shell: 'zsh' };
const CAPS = { case_sensitive_fs: false, symlinks: true, exec_bit: true, python: null, npm: null, node: 'v24.21.0' };

function request(url, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function withRelay(fn) {
  const relay = createRelayServer({ logger: null, operatorToken: OP });
  await relay.listen({ host: '127.0.0.1', port: 0 });
  try {
    return await fn(relay);
  } finally {
    await relay.close();
  }
}

async function pairDevice(relay, machineId) {
  const res = await request(`${relay.url}/v1/pair`, {
    method: 'POST',
    body: {
      pairing_code: relay.state.createPairingCode(),
      machine_id: machineId,
      machine_name: machineId,
      platform: PLATFORM,
      caps: CAPS,
    },
  });
  assert.equal(res.status, 200, res.text);
  return { token: res.json.device_token, machineId };
}

/* -------------------------------------------------------------------------- */

describe('p2p signalling: candidate validation', () => {
  it('accepts dotted-quad IPv4 and rejects everything else', () => {
    assert.equal(isIpv4('203.0.113.7'), true);
    assert.equal(isIpv4('0.0.0.0'), true);
    assert.equal(isIpv4('255.255.255.255'), true);
    assert.equal(isIpv4('256.0.0.1'), false);
    assert.equal(isIpv4('203.0.113'), false);
    assert.equal(isIpv4('203.0.113.7.8'), false);
    assert.equal(isIpv4('010.0.0.1'), false, 'leading zeros are ambiguous between parsers');
    assert.equal(isIpv4('::1'), false, 'IPv6 is out of scope for v0.3.9');
    assert.equal(isIpv4('example.com'), false);
    assert.equal(isIpv4(1234), false);
  });
});

describe('p2p signalling: registry', () => {
  const registry = (now = () => 1_000_000) => new PeerRegistry({ nowMs: now });

  it('stores candidates under the authenticated machine, not a body field', () => {
    const peers = registry();
    peers.announce('machine-a', { candidates: [{ address: '203.0.113.7', port: 5000 }], machine_id: 'machine-b' });
    assert.ok(peers.get('machine-a'));
    assert.equal(peers.get('machine-b'), null, 'a body machine_id must not create an entry');
  });

  it('refuses an empty candidate list', () => {
    const peers = registry();
    assert.throws(() => peers.announce('m', { candidates: [] }), /non-empty/);
    assert.throws(() => peers.announce('m', {}), /non-empty/);
  });

  it('refuses more candidates than the ceiling', () => {
    const peers = registry();
    const many = Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => ({ address: '203.0.113.7', port: 1000 + i }));
    assert.throws(() => peers.announce('m', { candidates: many }), /too many candidates/);
  });

  it('refuses a bad address or port rather than passing it to a peer', () => {
    const peers = registry();
    assert.throws(() => peers.announce('m', { candidates: [{ address: 'nope', port: 1 }] }), /not IPv4/);
    assert.throws(() => peers.announce('m', { candidates: [{ address: '203.0.113.7', port: 0 }] }), /port out of range/);
    assert.throws(() => peers.announce('m', { candidates: [{ address: '203.0.113.7', port: 70000 }] }), /port out of range/);
    assert.throws(() => peers.announce('m', { candidates: [{ address: '203.0.113.7' }] }), /port out of range/);
  });

  it('de-duplicates repeated candidates instead of rejecting them', () => {
    const peers = registry();
    const result = peers.announce('m', {
      candidates: [
        { address: '203.0.113.7', port: 5000 },
        { address: '203.0.113.7', port: 5000 },
        { address: '198.51.100.2', port: 5000 },
      ],
    });
    assert.equal(result.candidates.length, 2);
  });

  it('expires an announcement on read, not only on sweep', () => {
    let now = 1_000_000;
    const peers = new PeerRegistry({ nowMs: () => now, defaultTtlMs: 5000 });
    peers.announce('m', { candidates: [{ address: '203.0.113.7', port: 5000 }] });
    assert.ok(peers.get('m'));
    now += 5001;
    assert.equal(peers.get('m'), null, 'a stale candidate must never be served between sweeps');
  });

  it('clamps a requested TTL to the allowed range', () => {
    const peers = registry();
    const tiny = peers.announce('a', { candidates: [{ address: '203.0.113.7', port: 1 }], ttl_ms: 1 });
    assert.ok(tiny.ttl_ms >= 1000, 'a sub-second TTL would expire before it could be used');
    const huge = peers.announce('b', { candidates: [{ address: '203.0.113.7', port: 1 }], ttl_ms: 999_999_999 });
    assert.equal(huge.ttl_ms, MAX_TTL_MS);
    const dflt = peers.announce('c', { candidates: [{ address: '203.0.113.7', port: 1 }] });
    assert.equal(dflt.ttl_ms, DEFAULT_TTL_MS);
  });

  it('sweeps expired entries and counts the rest', () => {
    let now = 1_000_000;
    const peers = new PeerRegistry({ nowMs: () => now, defaultTtlMs: 1000 });
    peers.announce('a', { candidates: [{ address: '203.0.113.7', port: 1 }] });
    peers.announce('b', { candidates: [{ address: '203.0.113.7', port: 2 }] });
    assert.deepEqual(peers.stats(), { peers_announced: 2 });
    now += 1001;
    assert.equal(peers.sweep(), 2);
    assert.deepEqual(peers.stats(), { peers_announced: 0 });
  });

  it('replaces a machine\'s previous announcement', () => {
    const peers = registry();
    peers.announce('m', { candidates: [{ address: '203.0.113.7', port: 5000 }] });
    peers.announce('m', { candidates: [{ address: '198.51.100.2', port: 6000 }] });
    assert.equal(peers.get('m').candidates.length, 1);
    assert.equal(peers.get('m').candidates[0].address, '198.51.100.2');
  });
});

describe('p2p signalling: routes', () => {
  it('requires a device token on both routes', async () => {
    await withRelay(async (relay) => {
      const announce = await request(`${relay.url}/v1/peer/announce`, { method: 'POST', body: { candidates: [] } });
      assert.equal(announce.status, 401);
      const read = await request(`${relay.url}/v1/peer/some-machine`);
      assert.equal(read.status, 401);
    });
  });

  it('round-trips candidates from one paired machine to another', async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const b = await pairDevice(relay, 'machine-b');

      const announced = await request(`${relay.url}/v1/peer/announce`, {
        method: 'POST',
        token: a.token,
        body: {
          candidates: [
            { address: '203.0.113.7', port: 51234 },
            { address: '192.168.1.20', port: 51234 },
          ],
          nat: { mapping: 'endpoint-independent' },
        },
      });
      assert.equal(announced.status, 200, announced.text);
      assert.equal(announced.json.candidates.length, 2);

      const read = await request(`${relay.url}/v1/peer/machine-a`, { token: b.token });
      assert.equal(read.status, 200, read.text);
      assert.equal(read.json.peer.machine_id, 'machine-a');
      assert.deepEqual(read.json.peer.candidates[0], { address: '203.0.113.7', port: 51234 });
      assert.equal(read.json.peer.nat.mapping, 'endpoint-independent');
    });
  });

  it('ignores a machine_id in the body, so a peer cannot announce for someone else', async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const b = await pairDevice(relay, 'machine-b');

      const res = await request(`${relay.url}/v1/peer/announce`, {
        method: 'POST',
        token: a.token,
        body: {
          machine_id: 'machine-b',
          candidates: [{ address: '203.0.113.7', port: 5000 }],
        },
      });
      assert.equal(res.status, 200);

      const asB = await request(`${relay.url}/v1/peer/machine-b`, { token: b.token });
      assert.equal(asB.status, 404, 'machine-b must not have gained an announcement');
      const asA = await request(`${relay.url}/v1/peer/machine-a`, { token: b.token });
      assert.equal(asA.status, 200);
    });
  });

  it('answers 404 with a reason when a machine has not announced', async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const res = await request(`${relay.url}/v1/peer/nobody`, { token: a.token });
      assert.equal(res.status, 404);
      assert.match(res.json.error.message, /no live P2P announcement/);
      assert.match(res.json.error.detail.hint, /announce/);
    });
  });

  it('answers 400 with the specific reason for a malformed candidate', async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const res = await request(`${relay.url}/v1/peer/announce`, {
        method: 'POST',
        token: a.token,
        body: { candidates: [{ address: '203.0.113.7', port: 99999 }] },
      });
      assert.equal(res.status, 400);
      assert.match(res.json.error.message, /port out of range/);
    });
  });

  it('reports live announcements in /healthz', async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const before = await request(`${relay.url}/healthz`);
      assert.equal(before.json.peers_announced, 0);

      await request(`${relay.url}/v1/peer/announce`, {
        method: 'POST',
        token: a.token,
        body: { candidates: [{ address: '203.0.113.7', port: 5000 }] },
      });

      const after = await request(`${relay.url}/healthz`);
      assert.equal(after.json.peers_announced, 1);
    });
  });

  it('does not persist announcements across a relay restart', async () => {
    // A candidate is a NAT mapping; a restart guarantees the mapping is gone. Serving
    // it after a restart would send a peer into a punch that cannot possibly work.
    const first = createRelayServer({ logger: null, operatorToken: OP });
    await first.listen({ host: '127.0.0.1', port: 0 });
    const device = await pairDevice(first, 'machine-a');
    await request(`${first.url}/v1/peer/announce`, {
      method: 'POST',
      token: device.token,
      body: { candidates: [{ address: '203.0.113.7', port: 5000 }] },
    });
    assert.equal((await request(`${first.url}/v1/peer/machine-a`, { token: device.token })).status, 200);
    await first.close();

    const second = createRelayServer({ logger: null, operatorToken: OP });
    await second.listen({ host: '127.0.0.1', port: 0 });
    try {
      const after = await request(`${second.url}/v1/peer/machine-a`, { token: device.token });
      assert.equal(after.status, 404);
      const health = await request(`${second.url}/healthz`);
      assert.equal(health.json.peers_announced, 0);
    } finally {
      await second.close();
    }
  });
});
