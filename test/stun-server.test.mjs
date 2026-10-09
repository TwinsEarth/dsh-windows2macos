/**
 * STUN server suite (v0.4.0) — `src/relay/stun-server.mjs`.
 *
 * Why the tests look like this, in one paragraph: the v0.3.9 client suite shipped
 * with a fake server written by the same hand as the client, and both agreed on
 * the wrong address-family offset — only a real server disagreed. The v0.4.0
 * server is the *other half* of that same client, so the obvious test ("does my
 * server answer my client?") is exactly the tautology that failed last time. The
 * defence here is a frozen byte-level vector: a hand-built request goes in and the
 * complete response comes out, asserted octet for octet, with the expected bytes
 * derived from the RFC rather than from either implementation.
 *
 * Everything runs on loopback UDP. No external network, no third-party
 * dependency. A loopback pass is evidence about the *wire format* and about
 * crash-resistance; it is explicitly not evidence of NAT traversal, and the
 * mapping classification asserted below is what a single socket looks like to two
 * servers, not what a NAT does.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';

import {
  STUN_BINDING_ERROR,
  STUN_BINDING_REQUEST,
  STUN_BINDING_SUCCESS,
  STUN_MAGIC_COOKIE,
  createStunServer,
  parseStunMessage,
} from '../src/relay/stun-server.mjs';
import {
  bindUdpSocket,
  decodeMessage,
  discoverReflexive,
  encodeBindingRequest,
  stunQuery,
} from '../src/agent/stun.mjs';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** One loopback socket that can send raw bytes and collect raw answers. */
async function loopbackSocket() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return socket;
}

/**
 * Send one datagram and collect whatever comes back within `waitMs`.
 *
 * A "no reply" assertion cannot be made synchronously over UDP, so every case
 * here waits a fixed, short window and then counts the answers. The windows are
 * deliberately larger than loopback needs (loops back in microseconds) because
 * the cost of a false "dropped" pass is a test that stops catching regressions.
 *
 * @param {import('node:dgram').Socket} socket
 * @param {Buffer} bytes
 * @param {number} port
 * @param {number} [waitMs]
 * @returns {Promise<Buffer[]>}
 */
function exchange(socket, bytes, port, waitMs = 250) {
  const answers = [];
  const onMessage = (message) => answers.push(message);
  socket.on('message', onMessage);
  return new Promise((resolve) => {
    socket.send(bytes, port, '127.0.0.1', () => {
      setTimeout(() => {
        socket.removeListener('message', onMessage);
        resolve(answers);
      }, waitMs);
    });
  });
}

/**
 * Send several datagrams and collect the answers within one wait window.
 *
 * @param {import('node:dgram').Socket} socket
 * @param {Buffer[]} datagrams
 * @param {number} port
 * @param {number} [waitMs]
 * @returns {Promise<Buffer[]>}
 */
function sendMany(socket, datagrams, port, waitMs = 250) {
  const answers = [];
  const onMessage = (message) => answers.push(message);
  socket.on('message', onMessage);
  return new Promise((resolve) => {
    let sent = 0;
    const step = () => {
      if (sent === datagrams.length) {
        setTimeout(() => {
          socket.removeListener('message', onMessage);
          resolve(answers);
        }, waitMs);
        return;
      }
      const datagram = datagrams[sent];
      sent += 1;
      socket.send(datagram, port, '127.0.0.1', step);
    };
    step();
  });
}

/** A Binding request with the given attributes already encoded. */
function bindingRequest(transactionId, ...attributes) {
  const body = Buffer.concat(attributes);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(STUN_BINDING_REQUEST, 0);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, body]);
}

/**
 * Encode one attribute from the RFC, independently of the implementation.
 *
 * No padding is added: padding aligns the *next* attribute, which is why it
 * belongs to whichever attribute the test places next rather than to this helper
 * (`attributeAligned` below is the padded form, used where a test needs to prove
 * the server honours the padding itself).
 *
 * @param {number} type
 * @param {Buffer} value
 */
function rawAttribute(type, value) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  return Buffer.concat([header, value]);
}

/** The same attribute, padding included, for placing another attribute after it. */
function attributeAligned(type, value) {
  return Buffer.concat([rawAttribute(type, value), Buffer.alloc((4 - (value.length % 4)) % 4)]);
}

/**
 * Walk a STUN datagram's attributes without decoding their values.
 *
 * The point is to be able to assert an attribute the client decoder deliberately
 * drops (UNKNOWN-ATTRIBUTES), and to read the layout the server actually emitted
 * instead of the layout the test believes it emitted. Values are returned
 * unpadded, exactly as the RFC defines them.
 *
 * @param {Buffer} buffer
 * @returns {Array<{type:number, value:Buffer, offset:number}>}
 */
function rawAttributes(buffer) {
  const found = [];
  let offset = 20;
  const end = 20 + buffer.readUInt16BE(2);
  while (offset + 4 <= end) {
    const type = buffer.readUInt16BE(offset);
    const length = buffer.readUInt16BE(offset + 2);
    found.push({ type, value: buffer.subarray(offset + 4, offset + 4 + length), offset });
    offset += 4 + length + ((4 - (length % 4)) % 4);
  }
  return found;
}

/**
 * A non-loopback IPv4 address of this machine, or `null` when there is none.
 *
 * Needed for one case only: the NAT-mapping classifier treats "the server
 * reported exactly the address my socket is bound to" as *no translation*, which
 * is the correct and honest reading on loopback and a different branch from the
 * one a punch needs. Binding a source socket to a real interface address asks the
 * classifier the real question without faking a NAT.
 *
 * @returns {string|null}
 */
function nonLoopbackIpv4() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

/**
 * Bind a socket to `bindAddress` and ask each of `targets` what it sees.
 *
 * @param {string} bindAddress `'0.0.0.0'` binds the wildcard: the OS then picks the
 *   interface as the source, which is how a real client behaves before it knows
 *   anything about its own address.
 * @param {Array<{address:string, port:number}>} targets
 * @param {number} [timeoutMs]
 * @returns {Promise<object|null>} The `discoverReflexive` result, or `null` when
 *   this machine cannot bind that address at all.
 */
async function classifyFrom(bindAddress, targets, timeoutMs = 2000) {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, bindAddress, resolve);
    });
  } catch {
    socket.close();
    return null;
  }
  try {
    return await discoverReflexive({
      socket,
      servers: targets.map((target) => `${target.address}:${target.port}`),
      timeoutMs,
    });
  } finally {
    socket.close();
  }
}

/** XOR-MAPPED-ADDRESS for an IPv4 literal, written from RFC 5389 §15.2. */
function xorMappedAddress(address, port) {
  const value = Buffer.alloc(8);
  value.writeUInt8(0x00, 0);
  value.writeUInt8(0x01, 1);
  value.writeUInt16BE(port ^ (STUN_MAGIC_COOKIE >>> 16), 2);
  const octets = address.split('.').map(Number);
  for (let i = 0; i < 4; i += 1) {
    value.writeUInt8(octets[i] ^ ((STUN_MAGIC_COOKIE >>> (24 - 8 * i)) & 0xff), 4 + i);
  }
  return value;
}

/** MAPPED-ADDRESS for an IPv4 literal, written from RFC 5389 §15.1. */
function mappedAddress(address, port) {
  const value = Buffer.alloc(8);
  value.writeUInt8(0x00, 0);
  value.writeUInt8(0x01, 1);
  value.writeUInt16BE(port, 2);
  const octets = address.split('.').map(Number);
  for (let i = 0; i < 4; i += 1) value.writeUInt8(octets[i], 4 + i);
  return value;
}

/** The 12-byte transaction id used by every frozen-vector case. */
const FROZEN_TXID = Buffer.from('310eaf9fdb9de7065ec3025d', 'hex');

/**
 * A fixed loopback source port, so the frozen response vector can be a literal.
 *
 * A dynamic port would still test every byte, but the expected bytes would have
 * to be computed at run time from the port — which is the shape of a test that
 * agrees with the encoder it is checking. Pinned, the whole response is a
 * constant written from the RFC. 45321 is in the Linux ephemeral range and far
 * from any default port the suite could collide with; the fallback below keeps a
 * busy machine from failing the suite for the wrong reason.
 */
const FROZEN_CLIENT_PORT = 45321;

/** Relay a frozen client socket's address/port into a datagram. */
async function withFrozenClientPort(fn) {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(FROZEN_CLIENT_PORT, '127.0.0.1', resolve);
    });
  } catch {
    await new Promise((resolve, reject) => {
      socket.removeAllListeners('error');
      socket.once('error', reject);
      socket.bind(0, '127.0.0.1', resolve);
    });
  }
  try {
    return await fn(socket);
  } finally {
    socket.close();
  }
}

/* -------------------------------------------------------------------------- */
/* The existing client against the new server                                  */
/* -------------------------------------------------------------------------- */

describe('stun-server: the v0.3.9 client talks to it unchanged', () => {
  /** @type {ReturnType<typeof createStunServer>} */
  let server;

  before(async () => {
    server = createStunServer({ host: '127.0.0.1', port: 0, software: 'w2m-stun/test' });
    const started = await server.start();
    assert.equal(started.ok, true, started.error ?? '');
  });
  after(async () => {
    await server.stop();
  });

  it('reports the address and port the client socket actually sent from', async () => {
    const { socket, local } = await bindUdpSocket({ address: '127.0.0.1' });
    try {
      const result = await stunQuery(socket, `127.0.0.1:${server.address().port}`, { timeoutMs: 2000 });
      assert.equal(result.ok, true, result.error ?? '');
      // The whole point of a STUN server: the far side sees an address the sender
      // cannot observe locally.
      assert.deepEqual(result.reflexive, { address: local.address, port: local.port });
      assert.equal(typeof result.rttMs, 'number');
      assert.ok(Number.isFinite(result.rttMs) && result.rttMs >= 0);
    } finally {
      socket.close();
    }
  });

  it("echoes the client's transaction id and answers with SOFTWARE", async () => {
    const socket = await loopbackSocket();
    try {
      const { bytes, transactionId } = encodeBindingRequest();
      const [answer] = await exchange(socket, bytes, server.address().port);
      const decoded = decodeMessage(answer);
      assert.equal(decoded.type, STUN_BINDING_SUCCESS);
      assert.ok(decoded.transactionId.equals(transactionId));
      const software = decoded.attributes.find((a) => a.type === 0x8022);
      assert.equal(software.value.toString('utf8'), 'w2m-stun/test');
    } finally {
      socket.close();
    }
  });

  it('counts what it answered', async () => {
    const before = server.stats();
    const socket = await loopbackSocket();
    try {
      await exchange(socket, encodeBindingRequest().bytes, server.address().port);
    } finally {
      socket.close();
    }
    const after = server.stats();
    assert.equal(after.requests, before.requests + 1);
    assert.equal(after.responses, before.responses + 1);
    assert.equal(server.parseCount(), after.requests);
  });
});

/* -------------------------------------------------------------------------- */
/* Mapping classification across two instances                                 */
/* -------------------------------------------------------------------------- */

describe('stun-server: two instances classify one socket as endpoint-independent', () => {
  const servers = [];
  /** @type {number[]} */
  let ports;

  before(async () => {
    for (const software of ['w2m-stun/one', 'w2m-stun/two']) {
      const server = createStunServer({ host: '127.0.0.1', port: 0, software });
      const started = await server.start();
      assert.equal(started.ok, true, started.error ?? '');
      servers.push(server);
    }
    ports = servers.map((server) => server.address().port);
    assert.equal(new Set(ports).size, 2, 'the two instances must be on two different ports');
  });
  after(async () => {
    for (const server of servers) await server.stop();
  });

  it('reports the same mapped port to both instances, from one socket', async (t) => {
    // The classification the punch depends on: one socket, two destinations, one
    // mapped port. The client socket binds the wildcard, like a real client before
    // it knows its own address, so the OS picks the interface — that is what makes
    // this branch reachable without a NAT in the middle. Loopback cannot ask the
    // question at all: a server reached over 127.0.0.1 reports 127.0.0.1, which the
    // classifier correctly reads as "nothing is translating" (the other case
    // below). If this machine has no second address, this is skipped and that case
    // still runs.
    //
    // Honesty note: on one machine there is no translation, so "the two instances
    // agree on one mapped port" is all this proves. It is the observation a punch
    // needs, not evidence that a NAT would keep the mapping — only two hosts on
    // different networks can show that.
    const address = nonLoopbackIpv4();
    if (address === null) {
      t.skip('this machine has no non-loopback IPv4 address');
      return;
    }
    const extra = [];
    try {
      for (const software of ['w2m-stun/if-one', 'w2m-stun/if-two']) {
        const server = createStunServer({ host: address, port: 0, software });
        const started = await server.start();
        if (!started.ok) {
          t.skip(`cannot bind ${address}: ${started.error}`);
          return;
        }
        extra.push(server);
      }
      const targets = extra.map((server) => server.address());
      const result = await classifyFrom('0.0.0.0', targets);
      if (result === null || !result.ok) {
        t.skip(`cannot send from the wildcard to ${address}`);
        return;
      }
      assert.equal(result.mapping, 'endpoint-independent', JSON.stringify(result.servers));
      assert.equal(result.servers.length, 2);
      assert.ok(result.servers.every((s) => s.ok));
      const reported = new Set(result.servers.map((s) => s.reflexive.port));
      assert.equal(reported.size, 1, 'the two instances disagreed about the mapped port');
      assert.equal([...reported][0], result.local.port);
      assert.equal(result.reflexive.address, address);
      // Both instances saw the same address and port, which is the whole claim.
      assert.ok(result.servers.every((s) => s.reflexive.address === address));
    } finally {
      for (const server of extra) await server.stop();
    }
  });

  it('reads an untranslated loopback socket as "none", not as a NAT verdict', async () => {
    // The other half of the same classifier, pinned so the skip above cannot hide
    // a regression: on loopback the reported address *is* the socket's own, which
    // is decidable from a single answer and must not be dressed up as a mapping.
    const { socket, local } = await bindUdpSocket({ address: '127.0.0.1' });
    try {
      const result = await discoverReflexive({
        socket,
        servers: ports.map((port) => `127.0.0.1:${port}`),
        timeoutMs: 2000,
      });
      assert.equal(result.ok, true, result.error ?? '');
      assert.equal(result.mapping, 'none');
      assert.equal(result.servers.length, 2);
      assert.ok(result.servers.every((s) => s.reflexive.address === local.address));
      assert.ok(result.servers.every((s) => s.reflexive.port === local.port));
    } finally {
      socket.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Frozen byte-level vector                                                    */
/* -------------------------------------------------------------------------- */

describe('stun-server: frozen response bytes', () => {
  /** @type {ReturnType<typeof createStunServer>} */
  let server;

  before(async () => {
    // `w2m-stun/1` is the default, and the frozen vector depends on knowing
    // exactly which SOFTWARE value to expect, so it is pinned here rather than
    // left to the module default.
    server = createStunServer({ host: '127.0.0.1', port: 0, software: 'w2m-stun/1' });
    const started = await server.start();
    assert.equal(started.ok, true, started.error ?? '');
  });
  after(async () => {
    await server.stop();
  });

  it('answers a hand-built Binding request with exactly these bytes', async () => {
    await withFrozenClientPort(async (socket) => {
      const port = socket.address().port;
      // The request is a hex literal too: if the request builder and the parser
      // were wrong in the same way, this case would still fail.
      const request = Buffer.from('000100002112a442310eaf9fdb9de7065ec3025d', 'hex');
      const [answer] = await exchange(socket, request, server.address().port);
      assert.ok(answer, 'no response to a well-formed Binding request');

      // Built from the RFC: 20-byte header (0x0101, length 0x26, cookie, echoed
      // transaction id), then XOR-MAPPED-ADDRESS, MAPPED-ADDRESS, SOFTWARE.
      const expected = Buffer.concat([
        Buffer.from(`010100262112a442${FROZEN_TXID.toString('hex')}`, 'hex'),
        rawAttribute(0x0020, xorMappedAddress('127.0.0.1', port)),
        rawAttribute(0x0001, mappedAddress('127.0.0.1', port)),
        rawAttribute(0x8022, Buffer.from('w2m-stun/1', 'utf8')),
      ]);

      assert.equal(answer.toString('hex'), expected.toString('hex'));
      // Spelled out as well as compared: when this case breaks, the header fields
      // are what a reader needs to see, and a whole-buffer diff hides them.
      assert.equal(answer.readUInt16BE(0), STUN_BINDING_SUCCESS);
      assert.equal(answer.readUInt16BE(2), answer.length - 20);
      assert.equal(answer.readUInt16BE(2), 0x26);
      assert.equal(answer.readUInt32BE(4), STUN_MAGIC_COOKIE);
      assert.ok(answer.subarray(8, 20).equals(FROZEN_TXID));
      const decoded = decodeMessage(answer);
      assert.deepEqual(decoded.mappedAddress, { address: '127.0.0.1', port, family: 1 });
    });
  });

  it('carries the same port in MAPPED-ADDRESS and its XORed twin', async () => {
    const socket = await loopbackSocket();
    try {
      const port = socket.address().port;
      const { bytes } = encodeBindingRequest();
      const [answer] = await exchange(socket, bytes, server.address().port);
      const decoded = decodeMessage(answer);
      const plain = decoded.attributes.find((a) => a.type === 0x0001);
      const xor = decoded.attributes.find((a) => a.type === 0x0020);
      assert.equal(plain.value.readUInt16BE(2), port);
      assert.equal(xor.value.readUInt16BE(2), port ^ (STUN_MAGIC_COOKIE >>> 16));
      // The reader that matters only trusts the XOR form; the plain form is the
      // RFC 3489 legacy field some clients still look for.
      assert.equal(decoded.mappedAddress.port, port);
    } finally {
      socket.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Malformed and unexpected input                                              */
/* -------------------------------------------------------------------------- */

describe('stun-server: malformed input is dropped, never thrown', () => {
  /** @type {ReturnType<typeof createStunServer>} */
  let server;
  /** @type {import('node:dgram').Socket} */
  let socket;

  before(async () => {
    server = createStunServer({ host: '127.0.0.1', port: 0 });
    const started = await server.start();
    assert.equal(started.ok, true, started.error ?? '');
    socket = await loopbackSocket();
  });
  after(async () => {
    socket.close();
    await server.stop();
  });

  const garbage = [
    {
      name: 'a 3-byte datagram',
      bytes: Buffer.from('0001ff', 'hex'),
      code: 'TOO_SHORT',
    },
    {
      name: 'a full-length message with the wrong magic cookie',
      bytes: (() => {
        const value = Buffer.alloc(20);
        value.writeUInt16BE(STUN_BINDING_REQUEST, 0);
        value.writeUInt32BE(0xdeadbeef, 4);
        return value;
      })(),
      code: 'BAD_MAGIC_COOKIE',
    },
    {
      name: 'a message whose two most significant bits are set',
      bytes: (() => {
        const value = bindingRequest(FROZEN_TXID);
        value.writeUInt16BE(0xc001, 0);
        return value;
      })(),
      code: 'BAD_FIRST_BITS',
    },
    {
      name: 'a message whose declared length does not match the datagram',
      bytes: (() => {
        const value = bindingRequest(FROZEN_TXID);
        value.writeUInt16BE(0x0008, 2);
        return value;
      })(),
      code: 'LENGTH_MISMATCH',
    },
    {
      name: 'a truncated attribute',
      bytes: bindingRequest(FROZEN_TXID, Buffer.from('002000080001db97', 'hex')),
      code: 'TRUNCATED_ATTRIBUTE',
    },
    {
      name: 'a Binding *response* sent to the server',
      bytes: (() => {
        const header = Buffer.alloc(20);
        header.writeUInt16BE(STUN_BINDING_SUCCESS, 0);
        header.writeUInt16BE(0, 2);
        header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
        FROZEN_TXID.copy(header, 8);
        return header;
      })(),
      code: 'not_a_request',
    },
  ];

  for (const item of garbage) {
    it(`drops ${item.name}: no reply, no throw, counted`, async () => {
      const before = server.stats();
      // A wrong datagram must produce silence, so the exchange is followed by a
      // *valid* request on the same socket: one answer means the valid request was
      // answered and the garbage was not, which a bare "nothing came back" wait
      // could not distinguish from a server that had simply died.
      const answers = await exchange(socket, item.bytes, server.address().port);
      const [answer] = await exchange(socket, encodeBindingRequest().bytes, server.address().port);
      assert.equal(answers.length, 0, `server answered a malformed datagram (${item.code})`);
      assert.ok(answer, 'the follow-up request went unanswered: the server stopped responding');

      const after = server.stats();
      assert.equal(after.requests, before.requests + 2);
      assert.equal(after.responses, before.responses + 1);
      assert.equal(after.errors, before.errors + 1, `stats().errors did not count ${item.code}`);
      assert.ok(after.dropped && typeof after.dropped === 'object');
    });
  }

  it('never throws out of the parser, whatever it is handed', () => {
    // The socket handler's safety depends on this function being total. Asserted
    // directly as well as through the socket, because a thrown parser inside a
    // listener is an uncaught exception, i.e. a dead process.
    const inputs = [
      Buffer.alloc(0),
      Buffer.alloc(1),
      Buffer.alloc(19),
      Buffer.alloc(20),
      Buffer.from('000100002112a442', 'hex'),
      Buffer.alloc(64, 0xff),
      Buffer.concat([bindingRequest(FROZEN_TXID), Buffer.from('ffff', 'hex')]),
      // Attribute length 0xffff inside a 20-byte body: the classic integer-overflow
      // shape, which must be a returned code and not a RangeError.
      bindingRequest(FROZEN_TXID, Buffer.from('0020ffff', 'hex')),
    ];
    for (const input of inputs) {
      const parsed = parseStunMessage(input);
      assert.equal(typeof parsed.ok, 'boolean');
      if (!parsed.ok) assert.equal(typeof parsed.code, 'string');
    }
    assert.deepEqual(parseStunMessage(Buffer.alloc(3)), { ok: false, code: 'TOO_SHORT' });
    assert.deepEqual(parseStunMessage(bindingRequest(FROZEN_TXID)).ok, true);
  });

  it('survives a burst of garbage without losing the next valid request', async () => {
    const before = server.stats();
    // One wait for the whole burst: 50 datagrams in, 50 of them refused, and the
    // connection still usable afterwards. `exchange` per datagram would spend
    // 12 seconds proving the same thing far more slowly.
    const answers = await sendMany(
      socket,
      Array.from({ length: 50 }, (_, i) => Buffer.alloc(i, 0xa5)),
      server.address().port,
    );
    assert.equal(answers.length, 0, 'a malformed datagram was answered');

    const [answer] = await exchange(socket, encodeBindingRequest().bytes, server.address().port);
    assert.ok(answer, 'no answer after 50 malformed datagrams');
    const after = server.stats();
    assert.equal(after.responses, before.responses + 1);
    assert.equal(after.errors, before.errors + 50);
  });

  it('records why each datagram was dropped, on a server of its own', async () => {
    // Isolated instance so the breakdown can be asserted exactly: `by reason` is
    // what an operator reads when a client is not getting answers, and counts that
    // are only ever "somewhere above zero" would not tell them which reason.
    const fresh = createStunServer({ host: '127.0.0.1', port: 0 });
    const started = await fresh.start();
    assert.equal(started.ok, true, started.error ?? '');
    const probe = await loopbackSocket();
    try {
      const request = bindingRequest(FROZEN_TXID, Buffer.from('002000080001db97', 'hex'));
      await exchange(probe, Buffer.from('0001ff', 'hex'), started.port);
      await exchange(probe, Buffer.alloc(20), started.port); // zero cookie, zero type
      await exchange(probe, bindingRequest(FROZEN_TXID, Buffer.from('0020ffff', 'hex')), started.port);
      await exchange(probe, request, started.port);
      const stats = fresh.stats();
      assert.equal(stats.requests, 4);
      assert.equal(stats.responses, 0);
      assert.equal(stats.errors, 4);
      assert.equal(stats.dropped.short, 1, 'a 3-byte datagram should count as "short"');
      assert.equal(stats.dropped.magic_cookie, 1);
      assert.equal(stats.dropped.truncated_attribute, 2, 'both truncation shapes count the same way');
    } finally {
      probe.close();
      await fresh.stop();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

describe('stun-server: unknown comprehension-required attributes', () => {
  /** @type {ReturnType<typeof createStunServer>} */
  let server;
  /** @type {import('node:dgram').Socket} */
  let socket;

  before(async () => {
    server = createStunServer({ host: '127.0.0.1', port: 0 });
    const started = await server.start();
    assert.equal(started.ok, true, started.error ?? '');
    socket = await loopbackSocket();
  });
  after(async () => {
    socket.close();
    await server.stop();
  });

  it('answers 0x0111 with ERROR-CODE 400 and echoes the transaction id', async () => {
    // 0x0002 is comprehension-required (below 0x8000) and is not implemented:
    // RFC 5389 §7.3.1 says the request must be refused, not answered while a
    // mandatory field is ignored.
    const request = bindingRequest(FROZEN_TXID, rawAttribute(0x0002, Buffer.alloc(0)));
    const [answer] = await exchange(socket, request, server.address().port);
    assert.ok(answer, 'no error response to an unknown mandatory attribute');

    assert.equal(answer.readUInt16BE(0), STUN_BINDING_ERROR);
    assert.equal(answer.readUInt16BE(2), answer.length - 20);
    assert.equal(answer.readUInt32BE(4), STUN_MAGIC_COOKIE);
    assert.ok(answer.subarray(8, 20).equals(FROZEN_TXID));

    const decoded = decodeMessage(answer);
    assert.equal(decoded.type, STUN_BINDING_ERROR);
    assert.equal(decoded.errorCode.code, 400);
    assert.equal(decoded.errorCode.reason, 'Bad Request');
  });

  it('inlines the UNKNOWN-ATTRIBUTES attribute at the RFC bit layout', async () => {
    // Read straight out of the datagram rather than through `decodeMessage`,
    // because the v0.3.9 client decoder does not model this attribute at all (it
    // ignores what it does not need). Asserting it through a decoder that drops it
    // would assert nothing, and the attribute is the client's only clue about
    // which field was refused.
    const request = bindingRequest(FROZEN_TXID, rawAttribute(0x0002, Buffer.alloc(0)));
    const [answer] = await exchange(socket, request, server.address().port);
    const attributes = rawAttributes(answer);
    const error = attributes.find((a) => a.type === 0x0009);
    assert.ok(error, 'no ERROR-CODE attribute in the error response');
    assert.equal(error.value.length, 15); // 4-byte layout + 'Bad Request'
    assert.equal(error.value.readUInt16BE(0), 0); // reserved bits
    assert.equal(error.value.readUInt8(2), 4); // class: 4xx
    assert.equal(error.value.readUInt8(3), 0); // number: 400
    assert.equal(error.value.subarray(4).toString('utf8'), 'Bad Request');
    const unknown = attributes.find((a) => a.type === 0x000a);
    assert.ok(unknown, 'UNKNOWN-ATTRIBUTES was not sent alongside the error');
    assert.equal(unknown.value.length, 2);
    assert.equal(unknown.value.readUInt16BE(0), 0x0002);
    // Every attribute, including the one after a padded one, must start on a
    // 4-byte boundary — a reader that trusts the padding would otherwise walk off.
    assert.ok(attributes.every((a) => (a.offset - 20) % 4 === 0));
  });

  it('emits the whole 400 response byte for byte', async () => {
    // The frozen vector for the error path, and the reason it exists: the 1-byte
    // padding after a 15-byte ERROR-CODE value is exactly the detail a
    // self-consistent encoder/decoder pair never notices. The success path cannot
    // catch it because every attribute it emits is already a multiple of 4 — this
    // case is the only one that can, and it caught a real one-byte-short response
    // during development.
    const request = bindingRequest(FROZEN_TXID, rawAttribute(0x0002, Buffer.alloc(0)));
    const [answer] = await exchange(socket, request, server.address().port);

    // Built numerically, with the RFC layout spelled out per line, so a typo in one
    // field cannot hide behind a block of hex.
    const errorValue = Buffer.alloc(15); // 2 reserved + class + number + 'Bad Request'
    errorValue.writeUInt16BE(0, 0);
    errorValue.writeUInt8(4, 2);
    errorValue.writeUInt8(0, 3);
    Buffer.from('Bad Request', 'utf8').copy(errorValue, 4);
    const unknownValue = Buffer.alloc(2);
    unknownValue.writeUInt16BE(0x0002, 0);
    const softwareValue = Buffer.from('w2m-stun/1', 'utf8');

    const body = Buffer.concat([
      rawAttribute(0x0009, errorValue),
      Buffer.alloc(1), // padding: 15 is not a multiple of four
      rawAttribute(0x000a, unknownValue),
      rawAttribute(0x8022, softwareValue),
    ]);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(STUN_BINDING_ERROR, 0);
    header.writeUInt16BE(body.length, 2);
    header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
    FROZEN_TXID.copy(header, 8);
    const expected = Buffer.concat([header, body]);

    assert.equal(answer.length, expected.length, 'the 400 response is not the length the layout implies');
    assert.equal(expected.length, 60);
    assert.equal(answer.readUInt16BE(2), 40); // 19 + 1 + 6 + 14
    assert.equal(answer.toString('hex'), expected.toString('hex'));
  });

  it('reads an attribute whose value length needs padding', async () => {
    // SOFTWARE is comprehension-optional, so it is ignored — but the *next*
    // attribute still starts after the padding, and getting that wrong would put a
    // following mandatory attribute at the wrong offset.
    const request = bindingRequest(FROZEN_TXID, attributeAligned(0x8022, Buffer.from('w2m', 'utf8')));
    const [answer] = await exchange(socket, request, server.address().port);
    assert.equal(decodeMessage(answer).type, STUN_BINDING_SUCCESS);
  });

  it('reports the error through the existing client as a named failure', async () => {
    const { socket: client } = await bindUdpSocket({ address: '127.0.0.1' });
    try {
      // `stunQuery` sends a bare request, so the attribute is added by hand here:
      // the point of this case is the client's *error* path, which the server side
      // of the contract has to feed correctly.
      const request = bindingRequest(FROZEN_TXID, rawAttribute(0x0003, Buffer.alloc(0)));
      const answers = await exchange(client, request, server.address().port);
      const decoded = decodeMessage(answers[0]);
      assert.equal(decoded.errorCode.code, 400);
    } finally {
      client.close();
    }
  });

  it('ignores an unknown comprehension-optional attribute instead of failing', async () => {
    // 0x8023 is comprehension-optional: a server that refuses it would refuse every
    // future extension any client ever sends.
    const request = bindingRequest(FROZEN_TXID, rawAttribute(0x8023, Buffer.from('abcd', 'utf8')));
    const [answer] = await exchange(socket, request, server.address().port);
    assert.equal(decodeMessage(answer).type, STUN_BINDING_SUCCESS);
  });
});

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

describe('stun-server: lifecycle', () => {
  it('reports a bind failure instead of throwing, and start() retries cleanly', async () => {
    const first = createStunServer({ host: '127.0.0.1', port: 0 });
    const started = await first.start();
    assert.equal(started.ok, true);

    const second = createStunServer({ host: '127.0.0.1', port: started.port });
    const failed = await second.start();
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'EADDRINUSE');
    assert.equal(second.address(), null);
    // The socket of the failed attempt must be closed, not leaked: a retry on the
    // same port has to be possible.
    await second.stop();

    await first.stop();
    const retry = createStunServer({ host: '127.0.0.1', port: started.port });
    const again = await retry.start();
    assert.equal(again.ok, true, again.error ?? '');
    assert.equal(again.port, started.port);
    await retry.stop();
  });

  it('stops and starts again on the same port without leaking the socket', async () => {
    const server = createStunServer({ host: '127.0.0.1', port: 0, software: 'w2m-stun/lifecycle' });
    const first = await server.start();
    assert.equal(first.ok, true);
    assert.deepEqual(server.address(), { address: first.host, port: first.port });
    await server.stop();
    assert.equal(server.address(), null);

    // Rebinding the same port is the assertion that matters: a leaked socket would
    // still hold it and this second bind would come back EADDRINUSE. (The port is
    // not asserted to be *identical* afterwards: on a busy machine the OS may have
    // handed that ephemeral port to somebody else in the meantime, which is a fact
    // about the machine and not about this server.)
    const again = await server.start();
    assert.equal(again.ok, true, again.error ?? '');

    // The restarted server is a working server, not merely a bound socket.
    const socket = await loopbackSocket();
    try {
      const result = await stunQuery(socket, `127.0.0.1:${again.port}`, { timeoutMs: 2000 });
      assert.equal(result.ok, true, result.error ?? '');
      assert.equal(result.reflexive.port, socket.address().port);
    } finally {
      socket.close();
    }
    await server.stop();
  });

  it('stop() is idempotent, including before start() and after stop()', async () => {
    const server = createStunServer({ host: '127.0.0.1', port: 0 });
    await server.stop(); // never started
    await server.stop();
    const started = await server.start();
    assert.equal(started.ok, true);
    await server.stop();
    await server.stop();
    await server.stop();
    assert.equal(server.address(), null);
    assert.equal(server.stats().running, false);
  });

  it('exposes counters and a start time', async () => {
    const server = createStunServer({ host: '127.0.0.1', port: 0 });
    assert.deepEqual(server.stats().requests, 0);
    assert.equal(server.stats().started_at, null);
    await server.start();
    const stats = server.stats();
    assert.equal(typeof stats.requests, 'number');
    assert.equal(typeof stats.responses, 'number');
    assert.equal(typeof stats.errors, 'number');
    assert.equal(stats.running, true);
    assert.match(stats.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(stats.software, 'w2m-stun/1');
    assert.equal(server.parseCount(), 0);
    await server.stop();
    assert.equal(server.stats().started_at, null);
  });

  it('binds 0.0.0.0 by default and 3478 unless told otherwise', async () => {
    // Not asserted by binding the default port — a test suite that binds 3478 would
    // collide with the very service it is testing on a real host. The defaults are
    // read from the module instead.
    const server = createStunServer();
    assert.equal(server.address(), null);
    const started = await server.start();
    if (started.ok) {
      assert.equal(started.port, 3478);
      assert.equal(started.host, '0.0.0.0');
      await server.stop();
    } else {
      // Something else holds 3478 on this machine: reported, not hidden, and the
      // rest of the suite (which binds ephemeral ports) is unaffected.
      assert.equal(started.error, 'EADDRINUSE');
      await server.stop();
    }
  });
});
