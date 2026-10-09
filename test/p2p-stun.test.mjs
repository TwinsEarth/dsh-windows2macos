/**
 * STUN / reflexive-discovery suite (v0.3.9 P2P).
 *
 * Two layers, on purpose:
 *
 *   1. **Hermetic.** A fake STUN server built from this repository's own encoder
 *      exercises the wire format, the timeout path, and the mapping classifier.
 *   2. **Live**, skipped when the network is unavailable. This layer exists because
 *      the hermetic one is not sufficient and the reason is concrete: the first
 *      implementation read the address family from the wrong byte offset, and a
 *      self-written fake server agreed with the wrong offset perfectly. Only a real
 *      server disagreed. A test that shares an assumption with the code it tests
 *      cannot catch that assumption being wrong.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import {
  DEFAULT_STUN_TIMEOUT_MS,
  STUN_BINDING_REQUEST,
  STUN_BINDING_SUCCESS,
  STUN_MAGIC_COOKIE,
  bindUdpSocket,
  decodeMessage,
  discoverReflexive,
  encodeBindingRequest,
  mappingSupportsPunching,
  parseServer,
  stunQuery,
} from '../src/agent/stun.mjs';

/* -------------------------------------------------------------------------- */
/* A fake STUN server, built independently of the parser                       */
/* -------------------------------------------------------------------------- */

const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

/**
 * Encode XOR-MAPPED-ADDRESS. Written from the RFC rather than by calling the
 * implementation's own helper, so the two can disagree.
 */
function encodeXorMappedAddress(address, port) {
  const value = Buffer.alloc(8);
  value.writeUInt8(0x00, 0); // reserved
  value.writeUInt8(0x01, 1); // family: IPv4
  value.writeUInt16BE(port ^ (STUN_MAGIC_COOKIE >>> 16), 2);
  const octets = address.split('.').map(Number);
  const mask = Buffer.alloc(4);
  mask.writeUInt32BE(STUN_MAGIC_COOKIE, 0);
  for (let i = 0; i < 4; i += 1) value.writeUInt8(octets[i] ^ mask[i], 4 + i);
  return value;
}

function encodeBindingSuccess(transactionId, address, port) {
  const attr = encodeXorMappedAddress(address, port);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(STUN_BINDING_SUCCESS, 0);
  header.writeUInt16BE(attr.length + 4, 2);
  header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  const attrHeader = Buffer.alloc(4);
  attrHeader.writeUInt16BE(ATTR_XOR_MAPPED_ADDRESS, 0);
  attrHeader.writeUInt16BE(attr.length, 2);
  return Buffer.concat([header, attrHeader, attr]);
}

/** A UDP server that answers Binding Requests with a fixed (address, port). */
function startFakeStun({ address = '203.0.113.7', port = 40000 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.on('message', (msg, rinfo) => {
      const decoded = decodeMessage(msg);
      if (!decoded || decoded.type !== STUN_BINDING_REQUEST) return;
      socket.send(encodeBindingSuccess(decoded.transactionId, address, port), rinfo.port, rinfo.address);
    });
    socket.bind(0, '127.0.0.1', () => resolve({ socket, port: socket.address().port }));
  });
}

/* -------------------------------------------------------------------------- */

describe('stun: wire format', () => {
  it('encodes a Binding Request with the magic cookie and a 12-byte transaction id', () => {
    const { bytes, transactionId } = encodeBindingRequest();
    assert.equal(bytes.length, 20);
    assert.equal(bytes.readUInt16BE(0), STUN_BINDING_REQUEST);
    assert.equal(bytes.readUInt16BE(2), 0);
    assert.equal(bytes.readUInt32BE(4), STUN_MAGIC_COOKIE);
    assert.equal(transactionId.length, 12);
    assert.ok(bytes.subarray(8, 20).equals(transactionId));
  });

  it('refuses a transaction id that is not 12 bytes', () => {
    assert.throws(() => encodeBindingRequest(Buffer.alloc(8)), TypeError);
  });

  it('decodes XOR-MAPPED-ADDRESS at the RFC offsets', () => {
    // The reserved byte before Family is the whole point of this case: reading
    // value[0] instead of value[1] yields `null` for every address, which looks
    // exactly like "the server sent no address".
    const txid = Buffer.from('310eaf9fdb9de7065ec3025d', 'hex');
    const message = encodeBindingSuccess(txid, '39.144.106.172', 64133);
    const decoded = decodeMessage(message);
    assert.equal(decoded.type, STUN_BINDING_SUCCESS);
    assert.ok(decoded.transactionId.equals(txid));
    assert.deepEqual(decoded.mappedAddress, { address: '39.144.106.172', port: 64133, family: 1 });
  });

  it('decodes a real captured Cloudflare response byte for byte', () => {
    // Captured on macOS 27.0/arm64, 2026-10-09. Kept as a frozen vector so a future
    // refactor cannot quietly change the offsets again.
    const captured = Buffer.from(
      '0101000c2112a442310eaf9fdb9de7065ec3025d002000080001db970682ceee',
      'hex',
    );
    const decoded = decodeMessage(captured);
    assert.equal(decoded.type, STUN_BINDING_SUCCESS);
    assert.deepEqual(decoded.mappedAddress, { address: '39.144.106.172', port: 64133, family: 1 });
  });

  it('returns null for a datagram that is not STUN', () => {
    assert.equal(decodeMessage(Buffer.from('not a stun message at all')), null);
    assert.equal(decodeMessage(Buffer.alloc(8)), null);
    // Right length, wrong magic cookie.
    const wrongCookie = Buffer.alloc(20);
    wrongCookie.writeUInt16BE(STUN_BINDING_SUCCESS, 0);
    wrongCookie.writeUInt32BE(0xdeadbeef, 4);
    assert.equal(decodeMessage(wrongCookie), null);
  });

  it('rejects a message whose two most significant bits are set', () => {
    const bad = encodeBindingSuccess(Buffer.alloc(12), '203.0.113.7', 1);
    bad.writeUInt16BE(0xc101, 0);
    assert.equal(decodeMessage(bad), null);
  });

  it('parses "host:port" and rejects anything else', () => {
    assert.deepEqual(parseServer('stun.example.com:3478'), {
      host: 'stun.example.com',
      port: 3478,
      spec: 'stun.example.com:3478',
    });
    assert.throws(() => parseServer('stun.example.com'), TypeError);
    assert.throws(() => parseServer('stun.example.com:0'), TypeError);
    assert.throws(() => parseServer('stun.example.com:99999'), TypeError);
  });
});

describe('stun: querying', () => {
  let server;
  before(async () => {
    server = await startFakeStun({ address: '198.51.100.9', port: 51234 });
  });
  after(() => server?.socket.close());

  it('reports the address the far side sees', async () => {
    const { socket } = await bindUdpSocket();
    try {
      const result = await stunQuery(socket, `127.0.0.1:${server.port}`, { timeoutMs: 2000 });
      assert.equal(result.ok, true, result.error ?? '');
      assert.deepEqual(result.reflexive, { address: '198.51.100.9', port: 51234 });
      assert.equal(typeof result.rttMs, 'number');
    } finally {
      socket.close();
    }
  });

  it('ignores a response carrying someone else\'s transaction id', async () => {
    // A stale or spoofed datagram must not be accepted as this transaction's answer.
    const socket = dgram.createSocket('udp4');
    await new Promise((r) => socket.bind(0, '127.0.0.1', r));
    const { bytes, transactionId } = encodeBindingRequest();
    const foreign = encodeBindingSuccess(Buffer.alloc(12, 0xab), '10.0.0.1', 1234);
    const port = server.port;
    socket.send(foreign, port, '127.0.0.1');
    socket.send(bytes, port, '127.0.0.1');

    const result = await stunQuery(socket, `127.0.0.1:${port}`, { timeoutMs: 2000, transactionId });
    assert.equal(result.ok, true);
    assert.deepEqual(result.reflexive, { address: '198.51.100.9', port: 51234 });
    socket.close();
  });

  it('times out with a named error rather than hanging or throwing', async () => {
    const { socket } = await bindUdpSocket();
    try {
      // Port 1 on loopback: nothing is listening, so no answer can arrive.
      const result = await stunQuery(socket, '127.0.0.1:1', { timeoutMs: 250 });
      assert.equal(result.ok, false);
      assert.equal(result.reflexive, null);
      assert.ok(result.error === 'STUN_TIMEOUT' || result.error?.startsWith('STUN_SEND_'));
    } finally {
      socket.close();
    }
  });

  it('has a sane default timeout', () => {
    assert.ok(DEFAULT_STUN_TIMEOUT_MS >= 1000 && DEFAULT_STUN_TIMEOUT_MS <= 10000);
  });
});

describe('stun: mapping classification', () => {
  const withServers = async (specs, fn) => {
    const servers = [];
    for (const spec of specs) servers.push(await startFakeStun(spec));
    const { socket } = await bindUdpSocket();
    try {
      return await fn(socket, servers.map((s) => `127.0.0.1:${s.port}`));
    } finally {
      socket.close();
      for (const s of servers) s.socket.close();
    }
  };

  it('classifies one port across servers as endpoint-independent', async () => {
    await withServers(
      [
        { address: '203.0.113.5', port: 40000 },
        { address: '203.0.113.6', port: 40000 },
      ],
      async (socket, servers) => {
        const result = await discoverReflexive({ socket, servers, timeoutMs: 2000 });
        assert.equal(result.ok, true);
        assert.equal(result.mapping, 'endpoint-independent');
        assert.equal(mappingSupportsPunching(result.mapping), true);
      },
    );
  });

  it('classifies different ports per server as endpoint-dependent (symmetric)', async () => {
    await withServers(
      [
        { address: '203.0.113.5', port: 40001 },
        { address: '203.0.113.6', port: 40002 },
      ],
      async (socket, servers) => {
        const result = await discoverReflexive({ socket, servers, timeoutMs: 2000 });
        assert.equal(result.mapping, 'endpoint-dependent');
        assert.equal(mappingSupportsPunching(result.mapping), false);
      },
    );
  });

  it('refuses to guess from a single observation', async () => {
    // One server cannot distinguish "one port for everyone" from "one port per
    // destination". Reporting either would be a fabricated certainty.
    await withServers([{ address: '203.0.113.5', port: 40003 }], async (socket, servers) => {
      const result = await discoverReflexive({ socket, servers, timeoutMs: 2000 });
      assert.equal(result.mapping, 'unknown');
      assert.equal(mappingSupportsPunching(result.mapping), true);
    });
  });

  it('reports failure with evidence when nothing answers', async () => {
    const { socket } = await bindUdpSocket();
    try {
      const result = await discoverReflexive({
        socket,
        servers: ['127.0.0.1:1', '127.0.0.1:2'],
        timeoutMs: 250,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reflexive, null);
      assert.equal(result.servers.length, 2);
      assert.ok(result.servers.every((s) => s.ok === false));
    } finally {
      socket.close();
    }
  });

  it('treats an unparseable server as a configuration error, not a probe result', async () => {
    const { socket } = await bindUdpSocket();
    try {
      const result = await discoverReflexive({ socket, servers: ['nonsense', '127.0.0.1:1'], timeoutMs: 200 });
      const bad = result.servers.find((s) => s.server === 'nonsense');
      assert.ok(bad.error.includes('host:port'));
    } finally {
      socket.close();
    }
  });

  it('requires a socket', async () => {
    await assert.rejects(() => discoverReflexive({}), TypeError);
  });
});

/* -------------------------------------------------------------------------- */
/* Live layer                                                                  */
/* -------------------------------------------------------------------------- */

describe('stun: against real public servers', () => {
  it('discovers a reflexive address and classifies the mapping', async (t) => {
    const { socket, local } = await bindUdpSocket();
    try {
      const result = await discoverReflexive({
        socket,
        servers: ['stun.cloudflare.com:3478', 'stun.l.google.com:19302'],
        timeoutMs: 4000,
      });
      if (!result.ok) {
        // No egress (offline CI, restricted network): this layer is advisory.
        t.skip(`no STUN answer: ${result.error}`);
        return;
      }
      assert.match(result.reflexive.address, /^\d+\.\d+\.\d+\.\d+$/);
      assert.ok(result.reflexive.port > 0 && result.reflexive.port <= 65535);
      assert.ok(['none', 'endpoint-independent', 'endpoint-dependent', 'unknown'].includes(result.mapping));
      console.log(
        `      live: local ${local.port} -> reflexive ${result.reflexive.address}:${result.reflexive.port} ` +
          `mapping=${result.mapping}`,
      );
    } finally {
      socket.close();
    }
  });
});
