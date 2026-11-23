/**
 * A dependency-free WebSocket signaling server for `webrtc-v1`.
 *
 * ## Why this exists in the repository
 *
 * The W2M fleet already runs a relay, and a WebRTC transport needs a signaling exchange that is
 * independent of the relay's HTTP/SSE task plane. Rather than require an external service, this
 * module implements the minimal RFC 6455 server the protocol needs: one text frame in, one text
 * frame out, no extensions, no compression, no binary payloads. It is intentionally not a general
 * WebSocket library — a smaller surface is the point.
 *
 * ## What it does not do
 *
 * It does not inspect SDP, choose ICE candidates, terminate DTLS, or see application data. A room
 * holds at most one `host` and one `client`; messages are forwarded verbatim to the other member.
 * The signal server can therefore sit on a public address without becoming a data-plane trust
 * boundary. Authentication is optional (`token`); when set, it is checked before the upgrade with
 * a constant-time compare.
 *
 * ## Limits
 *
 * Text messages are capped (`maxMessageBytes`, 64 KiB by default), rooms are capped, and a
 * connection that sends an oversized or malformed frame is closed with a named code. Ping/pong
 * heartbeats drop dead sockets so a room does not keep a half-open peer forever.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { MAX_SIGNAL_BYTES, WEBRTC_PROTOCOL, parseBoundedJson } from './protocol.mjs';

/** WebSocket opcodes used by the server. */
const OPCODE = Object.freeze({ TEXT: 0x1, CLOSE: 0x8, PING: 0x9, PONG: 0xa });

/** RFC 6455 handshake GUID. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Close codes from RFC 6455 §7.4.1. */
const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED: 1003,
  TOO_BIG: 1009,
  INTERNAL: 1011,
});

/** Named server refusals returned in an `error` message before a close. */
export const SIGNAL_SERVER_CODE = Object.freeze({
  UNAUTHORIZED: 'SIGNAL_UNAUTHORIZED',
  ROOM_FULL: 'SIGNAL_ROOM_FULL',
  BAD_JOIN: 'SIGNAL_BAD_JOIN',
  BAD_MESSAGE: 'SIGNAL_BAD_MESSAGE',
  NOT_JOINED: 'SIGNAL_NOT_JOINED',
  TOO_BIG: 'SIGNAL_TOO_BIG',
  PROTOCOL: 'SIGNAL_PROTOCOL_ERROR',
});

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Constant-time token comparison that does not leak length by timing.
 * @param {string} supplied
 * @param {string} expected
 * @returns {boolean}
 */
function tokenMatches(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  const a = createHash('sha256').update(supplied, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Encode one unmasked server frame.
 * @param {number} opcode
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function encodeServerFrame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Parse one masked client frame from a buffer. Returns `{frame, rest}` or a protocol error.
 * Fragmentation is refused: signaling messages are tiny and a continuation state machine is surface
 * area with no benefit here.
 *
 * @param {Buffer} buffer
 * @param {number} maxBytes
 * @returns {{ok: true, frame: {opcode: number, payload: Buffer}, rest: Buffer} |
 *   {ok: false, code: string, closeCode: number, detail: string}}
 */
function readClientFrame(buffer, maxBytes) {
  if (buffer.length < 2) return { ok: false, code: 'SHORT', closeCode: 0, detail: 'need two bytes' };
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (!fin) {
    return {
      ok: false,
      code: SIGNAL_SERVER_CODE.PROTOCOL,
      closeCode: CLOSE.PROTOCOL_ERROR,
      detail: 'fragmentation is not supported',
    };
  }
  if (!masked) {
    return {
      ok: false,
      code: SIGNAL_SERVER_CODE.PROTOCOL,
      closeCode: CLOSE.PROTOCOL_ERROR,
      detail: 'client frames must be masked',
    };
  }
  if (length === 126) {
    if (buffer.length < 4) return { ok: false, code: 'SHORT', closeCode: 0, detail: 'need extended length' };
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return { ok: false, code: 'SHORT', closeCode: 0, detail: 'need 64-bit length' };
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(maxBytes)) {
      return {
        ok: false,
        code: SIGNAL_SERVER_CODE.TOO_BIG,
        closeCode: CLOSE.TOO_BIG,
        detail: `payload ${big} > ${maxBytes}`,
      };
    }
    length = Number(big);
    offset = 10;
  }
  if (length > maxBytes) {
    return {
      ok: false,
      code: SIGNAL_SERVER_CODE.TOO_BIG,
      closeCode: CLOSE.TOO_BIG,
      detail: `payload ${length} > ${maxBytes}`,
    };
  }
  if (buffer.length < offset + 4 + length) {
    return { ok: false, code: 'SHORT', closeCode: 0, detail: 'need mask and payload' };
  }
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    payload[index] = buffer[offset + index] ^ mask[index % 4];
  }
  return { ok: true, frame: { opcode, payload }, rest: buffer.subarray(offset + length) };
}

/**
 * Create and start a signaling server.
 *
 * @param {object} [options]
 * @param {string} [options.host] Default `127.0.0.1`; use `0.0.0.0` for a remote signal server.
 * @param {number} [options.port] 0 picks an ephemeral port (tests).
 * @param {string} [options.path] HTTP path for the WebSocket upgrade.
 * @param {string} [options.token] When non-empty, required as `?token=` on the upgrade.
 * @param {number} [options.maxRooms]
 * @param {number} [options.maxMessageBytes]
 * @param {number} [options.heartbeatMs]
 * @param {object} [options.logger]
 * @returns {Promise<{ok: true, server: object, url: string, port: number, close: Function, stats: Function} |
 *   {ok: false, code: string, detail: string}>}
 */
export async function createSignalingServer({
  host = '127.0.0.1',
  port = 0,
  path = '/w2m/webrtc',
  token = '',
  maxRooms = 1024,
  maxMessageBytes = MAX_SIGNAL_BYTES,
  heartbeatMs = 30_000,
  logger = null,
} = {}) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return { ok: false, code: 'SIGNAL_BAD_PATH', detail: 'path must start with /' };
  }
  if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 512 || maxMessageBytes > 4 * 1024 * 1024) {
    return { ok: false, code: 'SIGNAL_BAD_LIMIT', detail: 'maxMessageBytes must be 512..4MiB' };
  }
  /** @type {Map<string, Map<string, object>>} room -> role -> connection */
  const rooms = new Map();
  /** @type {Set<object>} */
  const connections = new Set();
  let closed = false;
  const startedAt = Date.now();
  const counters = { connections: 0, joins: 0, signals: 0, rejected: 0, max_rooms: 0 };

  const httpServer = createServer((request, response) => {
    if (request.url === '/health' || request.url?.startsWith('/health?')) {
      const body = JSON.stringify({
        ok: true,
        protocol: WEBRTC_PROTOCOL,
        rooms: rooms.size,
        peers: [...rooms.values()].reduce((total, room) => total + room.size, 0),
        uptime_ms: Date.now() - startedAt,
      });
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });

  /**
   * @param {object} connection
   * @param {string} code
   * @param {string} detail
   */
  const sendError = (connection, code, detail) => {
    connection.send({ type: 'error', code, message: detail });
  };

  /** @param {object} connection */
  const detach = (connection) => {
    if (connection.room === null) return;
    const room = rooms.get(connection.room);
    if (room === undefined) return;
    if (room.get(connection.role) === connection) room.delete(connection.role);
    const other = [...room.entries()].find(([, peer]) => peer !== connection);
    if (other !== undefined)
      other[1].send({ type: 'peer-left', peer: connection.peerId, role: connection.role });
    if (room.size === 0) rooms.delete(connection.room);
    connection.room = null;
    connection.role = null;
  };

  /** @param {object} connection */
  const cleanup = (connection) => {
    if (connection.cleaned) return;
    connection.cleaned = true;
    detach(connection);
    connections.delete(connection);
    if (connection.heartbeat !== null) clearInterval(connection.heartbeat);
    try {
      connection.socket.destroy();
    } catch {
      // already destroyed
    }
  };

  /**
   * @param {object} connection
   * @param {string} code
   * @param {string} detail
   */
  const closeWithError = (connection, code, detail) => {
    counters.rejected += 1;
    sendError(connection, code, detail);
    setTimeout(() => cleanup(connection), 25).unref?.();
  };

  /**
   * @param {object} connection
   * @param {Record<string, any>} message
   */
  const handleMessage = (connection, message) => {
    switch (message.type) {
      case 'join': {
        if (connection.room !== null) {
          sendError(connection, SIGNAL_SERVER_CODE.BAD_JOIN, 'already joined');
          return;
        }
        const roomName = message.room;
        const role = message.role;
        const peerId = message.peer;
        const protocol = message.protocol ?? WEBRTC_PROTOCOL;
        if (typeof roomName !== 'string' || roomName.length === 0 || roomName.length > 128) {
          closeWithError(connection, SIGNAL_SERVER_CODE.BAD_JOIN, 'room must be 1..128 chars');
          return;
        }
        if (role !== 'host' && role !== 'client') {
          closeWithError(connection, SIGNAL_SERVER_CODE.BAD_JOIN, 'role must be host or client');
          return;
        }
        if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 128) {
          closeWithError(connection, SIGNAL_SERVER_CODE.BAD_JOIN, 'peer must be 1..128 chars');
          return;
        }
        if (protocol !== WEBRTC_PROTOCOL) {
          closeWithError(connection, SIGNAL_SERVER_CODE.BAD_JOIN, `protocol must be ${WEBRTC_PROTOCOL}`);
          return;
        }
        let room = rooms.get(roomName);
        if (room === undefined) {
          if (rooms.size >= maxRooms) {
            closeWithError(connection, SIGNAL_SERVER_CODE.ROOM_FULL, `server room cap ${maxRooms} reached`);
            return;
          }
          room = new Map();
          rooms.set(roomName, room);
          counters.max_rooms = Math.max(counters.max_rooms, rooms.size);
        }
        const existing = room.get(role);
        if (existing !== undefined && !existing.cleaned) {
          closeWithError(
            connection,
            SIGNAL_SERVER_CODE.ROOM_FULL,
            `role ${role} is already held by ${existing.peerId}`,
          );
          return;
        }
        room.set(role, connection);
        connection.room = roomName;
        connection.role = role;
        connection.peerId = peerId;
        counters.joins += 1;
        const other = [...room.entries()].find(([otherRole]) => otherRole !== role);
        connection.send({
          type: 'joined',
          room: roomName,
          role,
          peer: other?.[1]?.peerId ?? null,
          protocol,
        });
        if (other !== undefined) {
          other[1].send({ type: 'peer-joined', peer: peerId, role });
        }
        return;
      }
      case 'signal': {
        if (connection.room === null) {
          sendError(connection, SIGNAL_SERVER_CODE.NOT_JOINED, 'join before signaling');
          return;
        }
        if (message.kind !== 'offer' && message.kind !== 'answer' && message.kind !== 'candidate') {
          sendError(
            connection,
            SIGNAL_SERVER_CODE.BAD_MESSAGE,
            'signal.kind must be offer, answer or candidate',
          );
          return;
        }
        if (!isRecord(message.payload)) {
          sendError(connection, SIGNAL_SERVER_CODE.BAD_MESSAGE, 'signal.payload must be an object');
          return;
        }
        const room = rooms.get(connection.room);
        const other =
          room === undefined ? undefined : [...room.entries()].find(([, peer]) => peer !== connection);
        if (other === undefined) {
          sendError(connection, SIGNAL_SERVER_CODE.NOT_JOINED, 'no peer in the room');
          return;
        }
        const target = other[1];
        if (typeof message.to === 'string' && message.to !== target.peerId) {
          sendError(connection, SIGNAL_SERVER_CODE.BAD_MESSAGE, 'signal.to does not name the room peer');
          return;
        }
        counters.signals += 1;
        target.send({
          type: 'signal',
          from: connection.peerId,
          role: connection.role,
          kind: message.kind,
          payload: message.payload,
        });
        return;
      }
      case 'ping':
        connection.send({ type: 'pong', at: Date.now() });
        return;
      case 'leave':
        cleanup(connection);
        return;
      default:
        sendError(connection, SIGNAL_SERVER_CODE.BAD_MESSAGE, `unknown message type ${String(message.type)}`);
    }
  };

  /**
   * @param {object} connection
   * @param {Buffer} chunk
   */
  const feed = (connection, chunk) => {
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    while (true) {
      if (connection.buffer.length > maxMessageBytes * 4) {
        closeWithError(connection, SIGNAL_SERVER_CODE.TOO_BIG, 'buffered frames exceed the cap');
        return;
      }
      const parsed = readClientFrame(connection.buffer, maxMessageBytes);
      if (parsed.ok !== true) {
        if (parsed.code === 'SHORT') return; // wait for more bytes
        closeWithError(connection, parsed.code, parsed.detail);
        if (parsed.closeCode !== 0) {
          try {
            connection.socket.write(
              encodeServerFrame(
                OPCODE.CLOSE,
                Buffer.concat([
                  Buffer.from([parsed.closeCode >> 8, parsed.closeCode & 0xff]),
                  Buffer.from(parsed.detail.slice(0, 120)),
                ]),
              ),
            );
          } catch {
            // socket may already be dead
          }
        }
        return;
      }
      connection.buffer = parsed.rest;
      const frame = parsed.frame;
      if (frame.opcode === OPCODE.CLOSE) {
        try {
          connection.socket.write(encodeServerFrame(OPCODE.CLOSE, frame.payload.subarray(0, 2)));
        } catch {
          // best effort
        }
        cleanup(connection);
        return;
      }
      if (frame.opcode === OPCODE.PING) {
        connection.socket.write(encodeServerFrame(OPCODE.PONG, frame.payload));
        continue;
      }
      if (frame.opcode === OPCODE.PONG) {
        connection.lastPongAt = Date.now();
        continue;
      }
      if (frame.opcode !== OPCODE.TEXT) {
        closeWithError(connection, SIGNAL_SERVER_CODE.PROTOCOL, 'only text frames are accepted');
        return;
      }
      const decoded = parseBoundedJson(frame.payload, { maxBytes: maxMessageBytes });
      if (decoded.ok !== true) {
        sendError(connection, SIGNAL_SERVER_CODE.BAD_MESSAGE, decoded.detail);
        continue;
      }
      const message = decoded.value;
      if (!isRecord(message) || typeof message.type !== 'string') {
        sendError(connection, SIGNAL_SERVER_CODE.BAD_MESSAGE, 'message must be an object with a string type');
        continue;
      }
      handleMessage(connection, message);
      if (connection.cleaned) return;
    }
  };

  httpServer.on('upgrade', (request, socket, head) => {
    if (closed) {
      socket.destroy();
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://signal.local');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (token !== '' && !tokenMatches(url.searchParams.get('token') ?? '', token)) {
      counters.rejected += 1;
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = request.headers['sec-websocket-key'];
    const version = request.headers['sec-websocket-version'];
    if (typeof key !== 'string' || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    /** @type {object} */
    const connection = {
      socket,
      buffer: Buffer.alloc(0),
      room: null,
      role: null,
      peerId: null,
      cleaned: false,
      lastPongAt: Date.now(),
      heartbeat: null,
      send(message) {
        if (connection.cleaned || socket.destroyed) return false;
        try {
          socket.write(encodeServerFrame(OPCODE.TEXT, Buffer.from(JSON.stringify(message), 'utf8')));
          return true;
        } catch {
          cleanup(connection);
          return false;
        }
      },
    };
    connections.add(connection);
    counters.connections += 1;
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => feed(connection, chunk));
    socket.on('error', () => cleanup(connection));
    socket.on('close', () => cleanup(connection));
    if (heartbeatMs > 0) {
      connection.heartbeat = setInterval(() => {
        if (connection.cleaned) return;
        if (Date.now() - connection.lastPongAt > heartbeatMs * 2) {
          closeWithError(connection, SIGNAL_SERVER_CODE.PROTOCOL, 'heartbeat timeout');
          return;
        }
        try {
          socket.write(encodeServerFrame(OPCODE.PING));
        } catch {
          cleanup(connection);
        }
      }, heartbeatMs);
      connection.heartbeat.unref?.();
    }
    if (head.length > 0) feed(connection, head);
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  const advertisedHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `ws://${advertisedHost}:${actualPort}${path}`;
  logger?.debug?.(`signaling server listening on ${url} (rooms=${rooms.size})`);

  return {
    ok: true,
    server: httpServer,
    url,
    port: actualPort,
    close: () =>
      new Promise((resolve) => {
        closed = true;
        for (const connection of connections) cleanup(connection);
        httpServer.close(() => resolve({ ok: true }));
      }),
    stats: () => ({
      protocol: WEBRTC_PROTOCOL,
      rooms: rooms.size,
      peers: [...rooms.values()].reduce((total, room) => total + room.size, 0),
      connections: connections.size,
      counters: { ...counters },
      uptime_ms: Date.now() - startedAt,
    }),
  };
}
