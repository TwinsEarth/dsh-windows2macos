/**
 * STUN (RFC 5389) — reflexive address discovery for the W2M P2P transport.
 *
 * Why this exists: the relay is a star. Every task offer and every result crosses
 * it, which is what makes the design work through NAT without opening a port —
 * and also what makes the relay a bandwidth bottleneck and a single point of
 * failure. A direct path needs each side to learn the *public* address the other
 * can reach it on, and that is the one thing a host cannot work out alone.
 *
 * Scope and honesty:
 *
 *   * **IPv4 only.** The deployment material targets an IPv4 relay; IPv6 needs its
 *     own socket family and is deliberately not half-implemented here.
 *   * **No third-party dependency.** The project's rule is `node:` builtins only,
 *     so this is a from-scratch implementation of the two messages actually
 *     needed: Binding Request and Binding Success Response. No authentication
 *     attributes (MESSAGE-INTEGRITY) — a public STUN server needs none, and
 *     implementing them badly would be worse than not offering them.
 *   * **It reports evidence, not a verdict.** NAT type is inferred from whether
 *     several servers agree on the mapped port, which distinguishes
 *     endpoint-independent mapping (hole punching works) from endpoint-dependent
 *     mapping (it usually does not). That inference is stated with the
 *     observations behind it, because "symmetric NAT" is a conclusion a caller
 *     must be able to check.
 */

import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';

/** RFC 5389 §6: the fixed magic cookie that makes STUN demultiplexable. */
export const STUN_MAGIC_COOKIE = 0x2112a442;

export const STUN_BINDING_REQUEST = 0x0001;
export const STUN_BINDING_SUCCESS = 0x0101;

const ATTR_MAPPED_ADDRESS = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_ERROR_CODE = 0x0009;

/**
 * Public STUN servers used by default.
 *
 * Two different operators on purpose: the NAT mapping can only be classified by
 * comparing what *different* destinations see, and two hostnames that resolve to
 * the same anycast address would defeat that.
 */
export const DEFAULT_STUN_SERVERS = [
  'stun.cloudflare.com:3478',
  'stun.l.google.com:19302',
  'stun.nextcloud.com:443',
];

/** Default per-query timeout. Public STUN answers in tens of milliseconds; 2 s is generous. */
export const DEFAULT_STUN_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------------------------

/**
 * Build a Binding Request.
 *
 * @param {Buffer} [transactionId] 12 bytes; generated when omitted.
 * @returns {{bytes: Buffer, transactionId: Buffer}}
 */
export function encodeBindingRequest(transactionId = randomBytes(12)) {
  if (!Buffer.isBuffer(transactionId) || transactionId.length !== 12) {
    throw new TypeError('STUN transaction id must be a 12-byte Buffer');
  }
  const header = Buffer.alloc(20);
  header.writeUInt16BE(STUN_BINDING_REQUEST, 0);
  header.writeUInt16BE(0, 2); // no attributes
  header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return { bytes: header, transactionId };
}

/**
 * Parse the attributes of one STUN message.
 *
 * @param {Buffer} buf
 * @returns {{type:number, transactionId:Buffer, attributes:Array<{type:number, value:Buffer}>,
 *            mappedAddress:{address:string,port:number,family:number}|null,
 *            errorCode:{code:number,reason:string}|null}|null}
 *   `null` when the buffer is not a STUN message at all.
 */
export function decodeMessage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) return null;
  if (buf.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return null;
  // RFC 5389 §6: the two most significant bits must be zero.
  if ((buf[0] & 0xc0) !== 0) return null;

  const type = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  const transactionId = buf.subarray(8, 20);
  const end = Math.min(20 + length, buf.length);

  const attributes = [];
  let offset = 20;
  while (offset + 4 <= end) {
    const attrType = buf.readUInt16BE(offset);
    const attrLen = buf.readUInt16BE(offset + 2);
    const value = buf.subarray(offset + 4, Math.min(offset + 4 + attrLen, end));
    attributes.push({ type: attrType, value });
    // Attributes are padded to a 4-byte boundary.
    offset += 4 + attrLen + ((4 - (attrLen % 4)) % 4);
  }

  let mappedAddress = null;
  let errorCode = null;
  for (const attr of attributes) {
    if (attr.type === ATTR_XOR_MAPPED_ADDRESS) {
      mappedAddress = decodeAddress(attr.value, transactionId, true);
    } else if (attr.type === ATTR_MAPPED_ADDRESS && mappedAddress === null) {
      // Only a fallback: the XOR form is the one RFC 5389 defines, the plain form is
      // RFC 3489 legacy that some servers still send.
      mappedAddress = decodeAddress(attr.value, transactionId, false);
    } else if (attr.type === ATTR_ERROR_CODE && attr.value.length >= 4) {
      errorCode = {
        code: (attr.value[2] & 0x07) * 100 + attr.value[3],
        reason: attr.value.subarray(4).toString('utf8'),
      };
    }
  }

  return { type, transactionId, attributes, mappedAddress, errorCode };
}

/**
 * Decode MAPPED-ADDRESS / XOR-MAPPED-ADDRESS.
 *
 * @param {Buffer} value
 * @param {Buffer} transactionId
 * @param {boolean} xor
 * @returns {{address:string, port:number, family:number}|null}
 */
function decodeAddress(value, transactionId, xor) {
  if (value.length < 4) return null;
  // RFC 5389 §15.2 / §15.1: the first byte is reserved (x) and the SECOND byte is
  // Family. Reading value[0] as the family is the obvious mistake, and it fails
  // silently -- every address decodes to `null`, which is indistinguishable from a
  // server that sent no address at all. Caught by querying a real STUN server after
  // a self-written fake server had happily agreed with the wrong offset.
  const family = value[1];
  let port = value.readUInt16BE(2);
  let address;
  if (family === 0x01) {
    if (value.length < 8) return null;
    const raw = Buffer.from(value.subarray(4, 8));
    if (xor) {
      const mask = Buffer.alloc(4);
      mask.writeUInt32BE(STUN_MAGIC_COOKIE, 0);
      for (let i = 0; i < 4; i += 1) raw[i] ^= mask[i];
    }
    address = `${raw[0]}.${raw[1]}.${raw[2]}.${raw[3]}`;
  } else if (family === 0x02) {
    if (value.length < 20) return null;
    const raw = Buffer.from(value.subarray(4, 20));
    if (xor) {
      const mask = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), transactionId]);
      for (let i = 0; i < 16; i += 1) raw[i] ^= mask[i];
    }
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(raw.readUInt16BE(i).toString(16));
    address = groups.join(':');
  } else {
    return null;
  }

  if (xor) port ^= STUN_MAGIC_COOKIE >>> 16;
  return { address, port, family };
}

// ---------------------------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------------------------

/**
 * Bind a UDP socket on an ephemeral port.
 *
 * The socket is returned *unclosed on purpose*: its source port is what STUN
 * reports, and the whole point of querying STUN first is that the mapping stays
 * open for the hole punch that follows. Closing it would discard the mapping the
 * NAT just created.
 *
 * @param {{address?:string, port?:number}} [options]
 * @returns {Promise<{socket:import('node:dgram').Socket, local:{address:string,port:number}}>}
 */
export function bindUdpSocket(options = {}) {
  const address = options.address ?? '0.0.0.0';
  const port = options.port ?? 0;
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const onError = (error) => {
      socket.removeListener('listening', onListening);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      reject(error);
    };
    const onListening = () => {
      socket.removeListener('error', onError);
      const bound = socket.address();
      resolve({ socket, local: { address: bound.address, port: bound.port } });
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(port, address);
  });
}

/** `"host:port"` → `{host, port}`. Rejects anything that is not exactly that. */
export function parseServer(spec) {
  const text = String(spec).trim();
  const idx = text.lastIndexOf(':');
  if (idx <= 0) throw new TypeError(`STUN server must be "host:port", got ${JSON.stringify(spec)}`);
  const host = text.slice(0, idx);
  const port = Number(text.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new TypeError(`STUN server port out of range in ${JSON.stringify(spec)}`);
  }
  return { host, port, spec: text };
}

/**
 * Send one Binding Request and wait for the matching response.
 *
 * @param {import('node:dgram').Socket} socket
 * @param {string} server `"host:port"`
 * @param {{timeoutMs?:number, transactionId?:Buffer}} [options]
 * @returns {Promise<{ok:boolean, server:string, reflexive:{address:string,port:number}|null,
 *                    rttMs:number|null, error:string|null}>}
 */
export function stunQuery(socket, server, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STUN_TIMEOUT_MS;
  const { host, port, spec } = parseServer(server);
  const { bytes, transactionId } = encodeBindingRequest(options.transactionId);

  return new Promise((resolve) => {
    let settled = false;
    const startedAt = process.hrtime.bigint();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('message', onMessage);
      resolve(result);
    };

    const onMessage = (message) => {
      const decoded = decodeMessage(message);
      if (!decoded) return; // not STUN; some other service answered on that port
      if (!decoded.transactionId.equals(transactionId)) return; // not our transaction
      if (decoded.type !== STUN_BINDING_SUCCESS) {
        finish({
          ok: false,
          server: spec,
          reflexive: null,
          rttMs: null,
          error: decoded.errorCode
            ? `STUN_ERROR_${decoded.errorCode.code}: ${decoded.errorCode.reason}`
            : `STUN_UNEXPECTED_TYPE_0x${decoded.type.toString(16)}`,
        });
        return;
      }
      if (!decoded.mappedAddress) {
        finish({ ok: false, server: spec, reflexive: null, rttMs: null, error: 'STUN_NO_MAPPED_ADDRESS' });
        return;
      }
      const rttMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      finish({
        ok: true,
        server: spec,
        reflexive: { address: decoded.mappedAddress.address, port: decoded.mappedAddress.port },
        rttMs: Math.round(rttMs * 100) / 100,
        error: null,
      });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, server: spec, reflexive: null, rttMs: null, error: 'STUN_TIMEOUT' });
    }, timeoutMs);

    socket.on('message', onMessage);
    socket.send(bytes, port, host, (error) => {
      if (error) {
        finish({ ok: false, server: spec, reflexive: null, rttMs: null, error: `STUN_SEND_${error.code ?? 'FAILED'}` });
      }
    });
  });
}

/**
 * Query several servers and classify the NAT behaviour from what they agree on.
 *
 * The classification that matters for hole punching is **mapping behaviour**:
 *
 *   * every server reports the same public port → endpoint-independent mapping
 *     ("cone"), which is what makes a punched hole reusable;
 *   * different ports per destination → endpoint-dependent mapping ("symmetric"),
 *     where the port a peer was told about is not the port the peer will see.
 *
 * It is deliberately *not* called a full NAT-type detection: filtering behaviour
 * (address/port-restricted cone) would need a second host to probe from, and
 * claiming to detect what was not probed is exactly the kind of unverified
 * certainty this project refuses elsewhere.
 *
 * @param {object} options
 * @param {import('node:dgram').Socket} options.socket
 * @param {string[]} [options.servers]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok:boolean, reflexive:{address:string,port:number}|null,
 *                    mapping:'none'|'endpoint-independent'|'endpoint-dependent'|'unknown',
 *                    local:{address:string,port:number}, servers:Array<object>, error:string|null}>}
 */
export async function discoverReflexive(options = {}) {
  const { socket } = options;
  if (!socket) throw new TypeError('discoverReflexive: a bound UDP socket is required');
  const servers = options.servers?.length ? options.servers : DEFAULT_STUN_SERVERS;
  const local = socket.address();

  // Sequential, not parallel: the mapping comparison is only meaningful if each
  // observation is attributable to one destination, and a burst of identical
  // requests from one socket to three servers invites a NAT to coalesce them.
  const results = [];
  for (const server of servers) {
    // A server we cannot even parse is a configuration error, not a probe result.
    try {
      parseServer(server);
    } catch (error) {
      results.push({ ok: false, server, reflexive: null, rttMs: null, error: error.message });
      continue;
    }
    results.push(await stunQuery(socket, server, { timeoutMs: options.timeoutMs }));
  }

  const answered = results.filter((r) => r.ok);
  if (answered.length === 0) {
    return {
      ok: false,
      reflexive: null,
      mapping: 'unknown',
      local: { address: local.address, port: local.port },
      servers: results,
      error: results.every((r) => r.error === 'STUN_TIMEOUT' || r.error?.startsWith('STUN_SEND_'))
        ? 'STUN_UNREACHABLE: no configured STUN server answered'
        : 'STUN_NO_ANSWER',
    };
  }

  const ports = new Set(answered.map((r) => r.reflexive.port));
  const addresses = new Set(answered.map((r) => r.reflexive.address));
  const first = answered[0].reflexive;

  let mapping;
  if (addresses.size === 1 && addresses.has(local.address) && ports.has(local.port)) {
    // The server saw the address the socket is already bound to: nothing is translating.
    // This one IS decidable from a single answer -- the server reported our own socket
    // address, which no translator would do. (Bound to 0.0.0.0 the local address is
    // "0.0.0.0", so this cannot fire by accident behind a NAT.)
    mapping = 'none';
  } else if (answered.length < 2) {
    // Ordering matters: `ports.size === 1` is trivially true for a single answer, so
    // checking it first makes every one-server probe look endpoint-independent. Saying
    // either mapping from one observation would be a guess, so we say neither.
    mapping = 'unknown';
  } else if (ports.size === 1) {
    mapping = 'endpoint-independent';
  } else {
    mapping = 'endpoint-dependent';
  }

  return {
    ok: true,
    reflexive: { address: first.address, port: first.port },
    mapping,
    local: { address: local.address, port: local.port },
    servers: results,
    error: null,
  };
}

/**
 * Whether a mapping behaviour can plausibly be punched.
 *
 * `unknown` returns `true` on purpose: one unreachable STUN server must not be
 * the reason a direct path is never even attempted. The punch itself is the test.
 *
 * @param {string} mapping
 * @returns {boolean}
 */
export function mappingSupportsPunching(mapping) {
  return mapping !== 'endpoint-dependent';
}
