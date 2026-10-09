/**
 * STUN (RFC 5389) Binding responder — the server half of `src/agent/stun.mjs`.
 *
 * Why this exists: every machine that wants a direct path has to learn the
 * *public* address a peer can reach it on, and a host cannot work that out alone.
 * A reflexive address is also the input to the NAT-mapping classification the hole
 * punch depends on: comparing what two *different* destinations report is the only
 * way to tell endpoint-independent mapping (a punch works) from endpoint-dependent
 * mapping (it usually does not). Running our own responder on the shared server is
 * what makes that comparison available on a deployment that has no second public
 * STUN server, and it keeps the answer on infrastructure the project controls.
 *
 * Scope and honesty:
 *
 *   * **IPv4 first, IPv6 tolerated.** The socket is `udp4` because the deployment
 *     material is IPv4 (see `src/agent/stun.mjs`). An IPv6 datagram can never
 *     arrive on it, but the address encoder writes both families from the RFC
 *     rather than assuming, so a `udp6` socket later needs no encoder change.
 *   * **No authentication.** No MESSAGE-INTEGRITY and no credentials: a Binding
 *     request carries no secret worth protecting, and a half-implemented
 *     authentication scheme would be worse than none. That also means this server
 *     must not be treated as a reflexion amplifier for arbitrary targets: it only
 *     ever answers the source address a request came from, which is what makes it
 *     a STUN server rather than a packet reflector.
 *   * **Robustness is the feature.** The single failure that matters here is a
 *     malformed datagram escaping the socket handler: an unhandled exception in a
 *     `'message'` listener takes the whole relay host down, so a request that
 *     cannot be read is counted and dropped, never thrown from.
 *   * **Not a full ICE/NAT-behaviour server.** No CHANGE-REQUEST / RESPONSE-ORIGIN
 *     / OTHER-ADDRESS (RFC 5780), so this server cannot itself classify filtering
 *     behaviour. Only the mapping observation is served, and that is stated.
 */

import dgram from 'node:dgram';

/** RFC 5389 §6: the fixed magic cookie that makes STUN demultiplexable. */
export const STUN_MAGIC_COOKIE = 0x2112a442;

export const STUN_BINDING_REQUEST = 0x0001;
export const STUN_BINDING_SUCCESS = 0x0101;
export const STUN_BINDING_ERROR = 0x0111;

export const ATTR_MAPPED_ADDRESS = 0x0001;
export const ATTR_ERROR_CODE = 0x0009;
export const ATTR_UNKNOWN_ATTRIBUTES = 0x000a;
export const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
export const ATTR_USERNAME = 0x0006;
export const ATTR_SOFTWARE = 0x8022;

/** 400 Bad Request, the only error this responder produces (see §15.6 for the layout). */
const ERROR_CODE_BAD_REQUEST = 400;
const ERROR_REASON_BAD_REQUEST = 'Bad Request';

/** Default SOFTWARE string; overridable per instance. */
export const DEFAULT_SOFTWARE = 'w2m-stun/1';

/**
 * Comprehension-required attributes (0x0000–0x7FFF) this responder understands.
 *
 * Anything else in that range is, by RFC 5389 §7.3.1, a message the server must
 * refuse rather than answer while ignoring a field the client said it needs.
 * The list is deliberately the *modern* set: RESPONSE-ADDRESS and CHANGE-REQUEST
 * are RFC 3489 legacy and are unknown here, so a classic client asking for them
 * gets a 400 instead of a silent answer to a question it did not ask.
 */
const KNOWN_COMPREHENSION_REQUIRED = new Set([ATTR_MAPPED_ADDRESS, ATTR_USERNAME, ATTR_XOR_MAPPED_ADDRESS]);

/**
 * Parser and dispatcher outcomes, mapped onto the `stats().dropped` counter that
 * means the same thing. A code missing from this table is still counted in
 * `stats().errors` — the breakdown is a convenience, the total is the contract.
 */
const DROP_BUCKET = Object.freeze({
  TOO_SHORT: 'short',
  BAD_FIRST_BITS: 'first_bits',
  BAD_MAGIC_COOKIE: 'magic_cookie',
  LENGTH_MISMATCH: 'length',
  TRUNCATED_ATTRIBUTE: 'truncated_attribute',
  unsupported_transport: 'unsupported_transport',
});

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

/**
 * RFC 3339 with milliseconds stripped — the same shape the relay reports
 * (`rfc3339` in `state.mjs`), so a log line and a status line read alike.
 *
 * @param {number} ms
 * @returns {string}
 */
function rfc3339(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------------------------
// Wire format — encoders
//
// Written from the RFC and kept in the relay half of the tree on purpose: the
// client in `src/agent/` must stay able to disagree with this file, otherwise
// the byte-level test stops being evidence and becomes a tautology.
// ---------------------------------------------------------------------------------------------

/**
 * Encode a 4-byte attribute header.
 *
 * @param {number} type
 * @param {number} length
 * @returns {Buffer}
 */
function encodeAttributeHeader(type, length) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(length, 2);
  return header;
}

/**
 * Bytes of padding that must follow an attribute value of `length` bytes.
 *
 * RFC 5389 §15: attributes are padded to a 4-byte boundary, and the padding is
 * part of the message. It is trivial to leave out — the result still parses
 * correctly under any reader that makes the same assumption, which is exactly how
 * it survives a self-written test.
 *
 * @param {number} length
 * @returns {number}
 */
function paddingFor(length) {
  return (4 - (length % 4)) % 4;
}

/**
 * Encode MAPPED-ADDRESS / XOR-MAPPED-ADDRESS.
 *
 * Layout (RFC 5389 §15.1/§15.2): one reserved byte, then Family, then the port,
 * then the address. The reserved byte coming *first* is what makes "read
 * `value[0]` as the family" the classic silent bug — see the note in
 * `src/agent/stun.mjs`, where a fake server agreed with the wrong offset and only
 * a real one disagreed.
 *
 * @param {string} address Dotted-quad IPv4 or colon-separated IPv6.
 * @param {number} port
 * @param {Buffer} transactionId 12 bytes; the XOR mask beyond the cookie.
 * @param {boolean} xor
 * @returns {Buffer|null} `null` when the address cannot be encoded.
 */
function encodeAddressValue(address, port, transactionId, xor) {
  const family = address.includes(':') ? 0x02 : 0x01;
  const raw = family === 0x01 ? parseIpv4(address) : parseIpv6(address);
  if (raw === null) return null;

  const value = Buffer.alloc(family === 0x01 ? 8 : 20);
  value.writeUInt8(0x00, 0); // reserved, MUST be zero
  value.writeUInt8(family, 1);
  // RFC 5389 §15.2: XOR the port with the top 16 bits of the cookie. (XOR is
  // symmetric, so the same expression decodes — the client's decoder relies on
  // exactly that, see `decodeAddress` in `src/agent/stun.mjs`.)
  value.writeUInt16BE((xor ? port ^ (STUN_MAGIC_COOKIE >>> 16) : port) & 0xffff, 2);
  // The v6 mask is the cookie followed by the transaction id (RFC 5389 §15.2).
  const mask = xor ? Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), transactionId]) : null;
  for (let i = 0; i < raw.length; i += 1) {
    const byte = mask ? raw[i] ^ mask[i] : raw[i];
    value.writeUInt8(byte & 0xff, 4 + i);
  }
  return value;
}

/**
 * Parse a dotted-quad IPv4 address.
 *
 * @param {string} address
 * @returns {number[]|null} Four octets, or `null` when it is not an IPv4 literal.
 */
function parseIpv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * Parse a textual IPv6 address into 16 bytes, `::` compression and a trailing
 * IPv4-mapped quad (`::ffff:127.0.0.1`) included.
 *
 * @param {string} address
 * @returns {number[]|null} Sixteen bytes, or `null` when it is not an IPv6 literal.
 */
function parseIpv6(address) {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const split = (part) => (part === '' ? [] : part.split(':'));
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  const groups = [...head, ...tail];
  if (halves.length === 1) {
    if (groups.length !== 8) return null; // a bare address must be exactly 8 groups
  } else {
    // '::' stands for at least one zero group, so the explicit groups must leave room for it.
    if (groups.length >= 8) return null;
    // A dotted quad is the final 32 bits, so it counts as two groups.
    const omitted = groups.length - (dottedQuadAt(groups, groups.length - 1) ? 1 : 0);
    groups.splice(head.length, 0, ...Array(8 - omitted).fill('0'));
  }
  if (groups.length !== 8) return null;

  const bytes = [];
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const isLast = i === groups.length - 1;
    if (dottedQuadAt(groups, i)) {
      const octets = parseIpv4(group);
      if (octets === null) return null;
      bytes.push(...octets);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
    if (isLast && bytes.length !== 16) return null;
  }
  return bytes.length === 16 ? bytes : null;
}

/**
 * Whether the group at `index` is a trailing dotted quad rather than a hex group.
 *
 * @param {string[]} groups
 * @param {number} index
 * @returns {boolean}
 */
function dottedQuadAt(groups, index) {
  return index === groups.length - 1 && typeof groups[index] === 'string' && groups[index].includes('.');
}

/**
 * Encode an ERROR-CODE attribute (RFC 5389 §15.6).
 *
 * The code is split across two bytes: three reserved bits, then the class in the
 * low three bits of byte 2 and the number in byte 3. Writing `code` as a uint16
 * is the mistake this layout invites, and it produces [0, 0, 1, 144] for 400 —
 * a number no client on the other side will recognise.
 *
 * @param {number} code
 * @param {string} reason
 * @returns {Buffer}
 */
function encodeErrorCodeValue(code, reason) {
  const text = Buffer.from(reason, 'utf8');
  const value = Buffer.alloc(4 + text.length);
  value.writeUInt16BE(0, 0); // reserved, MUST be zero
  value.writeUInt8(0x07 & Math.floor(code / 100), 2);
  value.writeUInt8(code % 100, 3);
  text.copy(value, 4);
  return value;
}

/**
 * Encode UNKNOWN-ATTRIBUTES (RFC 5389 §15.9): the attribute *types* the client
 * required and we do not implement.
 *
 * Sent alongside the 400 because "Bad Request" alone leaves a client guessing
 * which field caused it — the whole complaint RFC 5389 §7.3.1 makes about
 * answering a request that carried an unread mandatory attribute.
 *
 * @param {number[]} types
 * @returns {Buffer}
 */
function encodeUnknownAttributesValue(types) {
  const value = Buffer.alloc(types.length * 2);
  types.forEach((type, i) => value.writeUInt16BE(type, i * 2));
  return value;
}

// ---------------------------------------------------------------------------------------------
// Wire format — parser
// ---------------------------------------------------------------------------------------------

/**
 * Read one STUN message.
 *
 * Every read is length-checked *before* it happens: the point of this function is
 * that a hostile or truncated datagram produces a value, never an exception, so
 * the socket handler above it cannot be crashed by input.
 *
 * @param {Buffer} buf
 * @returns {{ok:true, type:number, transactionId:Buffer, attributes:Array<{type:number, value:Buffer}>}
 *          |{ok:false, code:'TOO_SHORT'|'BAD_FIRST_BITS'|'BAD_MAGIC_COOKIE'|'LENGTH_MISMATCH'|'TRUNCATED_ATTRIBUTE'}}
 */
export function parseStunMessage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) return { ok: false, code: 'TOO_SHORT' };
  // RFC 5389 §6: the two most significant bits of every STUN message are zero.
  // A datagram where they are set is not STUN (it is how the multiplexed
  // protocols sharing port 3478 are told apart), so it is dropped.
  if ((buf[0] & 0xc0) !== 0) return { ok: false, code: 'BAD_FIRST_BITS' };
  if (buf.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return { ok: false, code: 'BAD_MAGIC_COOKIE' };

  const type = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  // The message length excludes the 20-byte header and everything in a STUN
  // message is a multiple of 4 bytes (attributes are padded), so an odd length
  // or one that does not match the datagram is malformed by construction.
  if (length % 4 !== 0 || 20 + length !== buf.length) return { ok: false, code: 'LENGTH_MISMATCH' };

  const attributes = [];
  let offset = 20;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return { ok: false, code: 'TRUNCATED_ATTRIBUTE' };
    const attrType = buf.readUInt16BE(offset);
    const attrLength = buf.readUInt16BE(offset + 2);
    const padded = attrLength + ((4 - (attrLength % 4)) % 4);
    // The padding is part of the message: an attribute whose pad byte is missing
    // is a truncated datagram, not an attribute that ends early.
    if (offset + 4 + padded > buf.length) return { ok: false, code: 'TRUNCATED_ATTRIBUTE' };
    attributes.push({ type: attrType, value: buf.subarray(offset + 4, offset + 4 + attrLength) });
    offset += 4 + padded;
  }

  return { ok: true, type, transactionId: buf.subarray(8, 20), attributes };
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

/**
 * Create a STUN Binding responder.
 *
 * The factory owns exactly one `udp4` socket. Nothing is bound until `start()`,
 * `stop()` is idempotent, and `start()` after `stop()` is supported: a server
 * that leaks its socket on a restart is a server that cannot be reconfigured
 * without dropping the process.
 *
 * @param {object} [options]
 * @param {string} [options.host] Bind address. Default `'0.0.0.0'` — a STUN server
 *   bound to loopback answers nobody, which is the opposite of its job.
 * @param {number} [options.port] Default 3478, the IANA STUN port. `0` asks the OS
 *   for a free port (used by tests and by anyone behind a port-forward).
 * @param {string} [options.software] Value of the SOFTWARE attribute and of `stats().software`.
 * @param {() => number} [options.nowMs] Clock injection, for tests.
 * @returns {{start:()=>Promise<{ok:boolean,host:string|null,port:number|null,error:string|null}>,
 *            stop:()=>Promise<void>, address:()=>({address:string,port:number}|null),
 *            stats:()=>object, parseCount:()=>number}}
 */
export function createStunServer({
  host = '0.0.0.0',
  port = 3478,
  software = DEFAULT_SOFTWARE,
  nowMs,
  log = () => {},
} = {}) {
  const clock = typeof nowMs === 'function' ? nowMs : () => Date.now();
  const softwareName = typeof software === 'string' && software.trim() !== '' ? software : DEFAULT_SOFTWARE;
  const note = typeof log === 'function' ? log : () => {};

  /** @type {import('node:dgram').Socket|null} */
  let socket = null;
  let startedAtMs = null;
  let starting = null;
  let stopping = null;

  const counters = {
    requests: 0,
    responses: 0,
    errors: 0,
    /** Why datagrams were refused, as counters rather than prose — a debug log needs the shape. */
    dropped: {
      short: 0,
      first_bits: 0,
      magic_cookie: 0,
      length: 0,
      truncated_attribute: 0,
      unsupported_transport: 0,
    },
    by_type: {},
    last_request_at: null,
    last_error: null,
  };

  /**
   * Build the success response for one Binding request.
   *
   * Attribute order is fixed (XOR-MAPPED-ADDRESS, MAPPED-ADDRESS, SOFTWARE) so the
   * byte-level test in `test/stun-server.test.mjs` can assert an exact frozen
   * buffer: a response whose content is right but whose layout drifts is a
   * response no frozen vector can protect.
   *
   * @param {Buffer} transactionId
   * @param {{address:string, port:number}} peer
   * @returns {Buffer}
   */
  function buildSuccess(transactionId, peer) {
    const xor = encodeAddressValue(peer.address, peer.port, transactionId, true);
    const plain = encodeAddressValue(peer.address, peer.port, transactionId, false);
    // Without a MAPPED-ADDRESS there is nothing to report, and an empty success
    // response would be a lie dressed as an answer.
    if (xor === null && plain === null) return null;
    const parts = [];
    if (xor) parts.push(encodeAttributeHeader(ATTR_XOR_MAPPED_ADDRESS, xor.length), xor);
    if (plain) parts.push(encodeAttributeHeader(ATTR_MAPPED_ADDRESS, plain.length), plain);
    const sw = Buffer.from(softwareName, 'utf8');
    parts.push(encodeAttributeHeader(ATTR_SOFTWARE, sw.length), sw);

    const body = Buffer.concat(parts);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(STUN_BINDING_SUCCESS, 0);
    header.writeUInt16BE(body.length, 2);
    header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
    transactionId.copy(header, 8);
    return Buffer.concat([header, body]);
  }

  /**
   * Build the 400 response for a request carrying an unknown comprehension-required
   * attribute.
   *
   * @param {Buffer} transactionId
   * @param {number[]} unknownTypes
   * @returns {Buffer}
   */
  function buildBadRequest(transactionId, unknownTypes) {
    const error = encodeErrorCodeValue(ERROR_CODE_BAD_REQUEST, ERROR_REASON_BAD_REQUEST);
    // The padding is not decoration and not optional: RFC 5389 §15 requires every
    // attribute to start on a 4-byte boundary. `Bad Request` is 11 bytes, so the
    // value is 15 and the *next* attribute needs one byte of padding — omitting it
    // produces a response that still walks correctly under a same-assumption
    // decoder and is wrong on the wire. The Binding success path never showed the
    // bug because all three of its values are already multiples of 4.
    const parts = [
      encodeAttributeHeader(ATTR_ERROR_CODE, error.length),
      error,
      Buffer.alloc(paddingFor(error.length)),
    ];
    if (unknownTypes.length > 0) {
      const unknown = encodeUnknownAttributesValue(unknownTypes);
      parts.push(encodeAttributeHeader(ATTR_UNKNOWN_ATTRIBUTES, unknown.length), unknown);
    }
    const sw = Buffer.from(softwareName, 'utf8');
    parts.push(encodeAttributeHeader(ATTR_SOFTWARE, sw.length), sw);

    const body = Buffer.concat(parts);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(STUN_BINDING_ERROR, 0);
    header.writeUInt16BE(body.length, 2);
    header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
    transactionId.copy(header, 8);
    return Buffer.concat([header, body]);
  }

  /**
   * Decide what one datagram deserves.
   *
   * @param {Buffer} message
   * @param {{address:string, port:number}} peer
   * @returns {{disposition:string, reply:Buffer|null, type?:number, unknown?:number[]}}
   */
  function handleRequest(message, peer) {
    const parsed = parseStunMessage(message);
    if (!parsed.ok) return { disposition: parsed.code, reply: null };
    return { ...handleParsed(parsed, peer), type: parsed.type };
  }

  /**
   * Apply the RFC 5389 §7.3.1 checks to an already-parsed message.
   *
   * @param {{type:number, transactionId:Buffer, attributes:Array<{type:number, value:Buffer}>}} parsed
   * @param {{address:string, port:number}} peer
   * @returns {{disposition:string, reply:Buffer|null, unknown?:number[]}}
   */
  function handleParsed(parsed, peer) {
    const { type, transactionId, attributes } = parsed;
    // Only a request is answered. `type` packs class and method into interleaved
    // bits (RFC 5389 §6), so the class is extracted rather than compared: a
    // *response* arriving here is either a stray datagram from some other endpoint
    // or a reflection attempt aimed at a third party, and replying to a response
    // is how a loop starts.
    const messageClass = ((type >> 4) & 0x01) | ((type >> 7) & 0x02);
    if (messageClass !== 0x00) {
      return { disposition: 'not_a_request', reply: null };
    }
    if (type !== STUN_BINDING_REQUEST) {
      // An unknown *method* is an error in RFC 5389 §7.3.1 terms, but a method this
      // responder does not implement is not a Binding request; it is counted and
      // dropped rather than answered with a Binding error that would claim the
      // transaction was understood.
      return { disposition: `unhandled_method_0x${type.toString(16).padStart(4, '0')}`, reply: null };
    }

    const unknown = [];
    for (const attribute of attributes) {
      if (!KNOWN_COMPREHENSION_REQUIRED.has(attribute.type) && attribute.type < 0x8000)
        unknown.push(attribute.type);
    }
    if (unknown.length > 0) {
      // Counted per attribute type as well as per request: an operator watching a
      // new client fail needs to know *which* field it insisted on.
      for (const unknownType of unknown)
        counters.by_type[unknownType] = (counters.by_type[unknownType] ?? 0) + 1;
      const reply = buildBadRequest(transactionId, unknown);
      return { disposition: 'unknown_comprehension_required', unknown, reply };
    }

    // The port is taken from the datagram, never from an attribute: this is the
    // observation the client cannot make for itself, and the only place it can
    // come from is `rinfo`. `buildSuccess` returns `null` only when the source
    // address cannot be encoded as an address attribute at all, in which case the
    // honest answer is nothing rather than a success response with no address in
    // it — a client reads that as `STUN_NO_MAPPED_ADDRESS` instead of as a peer.
    const reply = buildSuccess(transactionId, peer);
    if (reply === null) return { disposition: 'unsupported_transport', reply: null };
    return { disposition: 'binding_success', reply };
  }

  /**
   * A post-bind socket error. Asynchronous (ICMP port-unreachable on some
   * platforms) and recorded, never rethrown: a dead socket must not take the
   * process with it.
   *
   * @param {NodeJS.ErrnoException} error
   */
  function onSocketError(error) {
    counters.errors += 1;
    counters.last_error = `SOCKET_ERROR: ${error.code ?? error.message}`;
  }

  /**
   * `dgram` message handler. Nothing in here may throw: an exception in a socket
   * listener is an uncaught exception, i.e. the relay host dies because someone
   * sent it a bad packet.
   */
  function onMessage(message, rinfo) {
    counters.requests += 1;
    counters.last_request_at = rfc3339(clock());

    let outcome;
    let peer = null;
    try {
      // `rinfo.address` can carry a scope id for a link-local v6 address; only the
      // address itself belongs in the attribute.
      peer = { address: String(rinfo.address).split('%')[0], port: rinfo.port };
      outcome = handleRequest(message, peer);
    } catch (error) {
      // Reached only by a bug, since the parser is total. Counted and swallowed
      // anyway: the alternative is a crash loop.
      counters.errors += 1;
      counters.last_error = `PARSE_FAILED: ${error?.message ?? String(error)}`;
      return;
    }
    if (peer === null) return;

    if (outcome.type !== undefined) {
      const key = `0x${outcome.type.toString(16).padStart(4, '0')}`;
      counters.by_type[key] = (counters.by_type[key] ?? 0) + 1;
    }

    // Observers are handed a frozen-shaped object rather than the raw datagram:
    // a caller that logs one line per request needs the *decision*, and the
    // request bytes may contain anything at all.
    try {
      note({
        event: 'stun-request',
        disposition: outcome.disposition,
        type: outcome.type === undefined ? null : `0x${outcome.type.toString(16).padStart(4, '0')}`,
        from: `${peer.address}:${peer.port}`,
        unknown: outcome.unknown ?? [],
      });
    } catch {
      // A broken observer is not allowed to break the responder.
    }

    if (outcome.reply === null) {
      counters.errors += 1;
      const bucket = counters.dropped[DROP_BUCKET[outcome.disposition]];
      if (bucket !== undefined) counters.dropped[DROP_BUCKET[outcome.disposition]] += 1;
      counters.last_error = outcome.disposition;
      return;
    }

    if (!socket) return;
    socket.send(outcome.reply, rinfo.port, rinfo.address, (error) => {
      if (error) {
        counters.errors += 1;
        counters.last_error = `SEND_FAILED: ${error.code ?? error.message}`;
        return;
      }
      counters.responses += 1;
    });
  }

  return {
    /**
     * Bind the socket.
     *
     * Never throws: a taken port is a returned `{ok:false, error}` naming
     * `EADDRINUSE`, because the caller is a CLI whose whole job at that moment is
     * to print one clear line and exit non-zero.
     *
     * @returns {Promise<{ok:boolean, host:string|null, port:number|null, error:string|null}>}
     */
    async start() {
      if (socket)
        return { ok: true, host: socket.address().address, port: socket.address().port, error: null };
      if (starting) return starting;
      starting = new Promise((resolve) => {
        const candidate = dgram.createSocket('udp4');
        const settle = (result) => {
          starting = null;
          resolve(result);
        };
        candidate.once('error', onBindError);
        candidate.once('listening', onListening);

        /** A bind failure leaves a socket that will never be usable. */
        function onBindError(error) {
          candidate.removeListener('listening', onListening);
          candidate.removeListener('error', onBindError);
          // Close it so the port is genuinely free for the retry the CLI tells the
          // user to make.
          try {
            candidate.close();
          } catch {
            /* never bound: close() throws EBADF on some platforms, nothing to do */
          }
          counters.last_error = `START_FAILED: ${error.code ?? error.message}`;
          settle({ ok: false, host: null, port: null, error: error.code ?? error.message });
        }

        function onListening() {
          candidate.removeListener('error', onBindError);
          candidate.removeListener('listening', onListening);
          candidate.on('error', onSocketError);
          candidate.on('message', onMessage);
          socket = candidate;
          startedAtMs = clock();
          settle({
            ok: true,
            host: candidate.address().address,
            port: candidate.address().port,
            error: null,
          });
        }

        candidate.bind(port, host);
      });
      return starting;
    },

    /**
     * Close the socket. Idempotent, and never throws: every exit path in the CLI
     * runs through here, including the one after a failed `start()`.
     *
     * @returns {Promise<void>}
     */
    async stop() {
      if (stopping) return stopping;
      const current = socket;
      socket = null;
      startedAtMs = null;
      if (!current) return undefined;
      stopping = new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          stopping = null;
          resolve();
        };
        try {
          current.removeAllListeners('message');
          // `close()` on a socket that was never bound throws, and its callback
          // never fires in that case, so both paths have to resolve.
          current.close(done);
        } catch {
          done();
        }
      });
      return stopping;
    },

    /** The bound address, or `null` while the server is not listening. */
    address() {
      if (!socket) return null;
      const bound = socket.address();
      return { address: bound.address, port: bound.port };
    },

    /**
     * A plain snapshot: counters, why requests were refused, and when the server
     * started. `responses` lags `requests` by the datagrams still in flight, which
     * is why the counters are reported as observations rather than as a ratio.
     *
     * @returns {{requests:number, responses:number, errors:number, started_at:string|null,
     *            software:string, dropped:object, by_type:object, last_request_at:string|null,
     *            last_error:string|null, running:boolean}}
     */
    stats() {
      return {
        requests: counters.requests,
        responses: counters.responses,
        errors: counters.errors,
        started_at: startedAtMs === null ? null : rfc3339(startedAtMs),
        software: softwareName,
        dropped: { ...counters.dropped },
        by_type: { ...counters.by_type },
        last_request_at: counters.last_request_at,
        last_error: counters.last_error,
        running: socket !== null,
      };
    },

    /**
     * How many datagrams have been parsed since the process started.
     *
     * Same number as `stats().requests`, exposed separately because `parseCount`
     * is the name the contract fixes and a caller may reasonably read it while
     * `stats()` is being rendered.
     *
     * @returns {number}
     */
    parseCount() {
      return counters.requests;
    },
  };
}

export default createStunServer;
