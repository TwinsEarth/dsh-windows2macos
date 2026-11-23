/**
 * WebSocket control plane for the WebRTC transport.
 *
 * Both ends connect *outbound* to a standalone signaling server. That direction matters: a host
 * behind NAT can reach the signal server without an inbound port, and the server only relays SDP
 * and ICE candidates, never application bytes. Once the DataChannel is open, the signal server can
 * disappear without dropping the data plane.
 *
 * The server is deliberately dumb: rooms hold at most two roles (`host`/`client`), and a `signal`
 * message is forwarded only to the other member of the same room. It does not inspect SDP, choose
 * candidates, or hold a session. That keeps the trust boundary small and lets the same server be
 * run beside the relay or independently.
 *
 * Node 22 exposes a global `WebSocket`; Node 20 does not in every build. A missing implementation is
 * a named refusal (`WEBRTC_SIGNAL_UNAVAILABLE`), not a silent downgrade to another transport.
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

import { MAX_SIGNAL_BYTES, WEBRTC_PROTOCOL, parseBoundedJson, stringifyBounded } from './protocol.mjs';

/** Named signaling failures. */
export const SIGNAL_CODE = Object.freeze({
  UNAVAILABLE: 'WEBRTC_SIGNAL_UNAVAILABLE',
  BAD_URL: 'WEBRTC_SIGNAL_BAD_URL',
  CONNECT_TIMEOUT: 'WEBRTC_SIGNAL_CONNECT_TIMEOUT',
  JOIN_TIMEOUT: 'WEBRTC_SIGNAL_JOIN_TIMEOUT',
  CLOSED: 'WEBRTC_SIGNAL_CLOSED',
  SEND_FAILED: 'WEBRTC_SIGNAL_SEND_FAILED',
  BAD_MESSAGE: 'WEBRTC_SIGNAL_BAD_MESSAGE',
  PEER_TIMEOUT: 'WEBRTC_SIGNAL_PEER_TIMEOUT',
  SERVER_ERROR: 'WEBRTC_SIGNAL_SERVER_ERROR',
});

/** Roles a room accepts. A room is exactly one host and one client. */
export const SIGNAL_ROLE = Object.freeze({
  HOST: 'host',
  CLIENT: 'client',
});

/**
 * Build a signaling URL, adding only the parameters the caller did not already put in the URL.
 * The token goes in the query string because WebSocket browser clients cannot set arbitrary
 * headers; diagnostics never include it.
 *
 * @param {string} url
 * @param {{room: string, role: string, peerId: string, token?: string, protocol?: string}} options
 * @returns {{ok: true, url: string} | {ok: false, code: string, detail: string}}
 */
export function buildSignalingUrl(url, { room, role, peerId, token = '', protocol = WEBRTC_PROTOCOL } = {}) {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, code: SIGNAL_CODE.BAD_URL, detail: 'signalUrl is empty' };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return {
      ok: false,
      code: SIGNAL_CODE.BAD_URL,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return {
      ok: false,
      code: SIGNAL_CODE.BAD_URL,
      detail: `signalUrl must be ws: or wss:, got ${parsed.protocol}`,
    };
  }
  if (typeof room !== 'string' || room.trim() === '') {
    return { ok: false, code: SIGNAL_CODE.BAD_URL, detail: 'room is empty' };
  }
  if (role !== SIGNAL_ROLE.HOST && role !== SIGNAL_ROLE.CLIENT) {
    return {
      ok: false,
      code: SIGNAL_CODE.BAD_URL,
      detail: `role must be host or client, got ${String(role)}`,
    };
  }
  if (typeof peerId !== 'string' || peerId.trim() === '') {
    return { ok: false, code: SIGNAL_CODE.BAD_URL, detail: 'peerId is empty' };
  }
  if (!parsed.searchParams.has('room')) parsed.searchParams.set('room', room);
  if (!parsed.searchParams.has('role')) parsed.searchParams.set('role', role);
  if (!parsed.searchParams.has('peer')) parsed.searchParams.set('peer', peerId);
  if (!parsed.searchParams.has('protocol')) parsed.searchParams.set('protocol', protocol);
  if (token !== '' && !parsed.searchParams.has('token')) parsed.searchParams.set('token', token);
  return { ok: true, url: parsed.toString() };
}

/**
 * Strip credentials from a URL for diagnostics.
 *
 * @param {string} url
 * @returns {string}
 */
export function redactSignalingUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '<redacted>');
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate one signaling message. The server repeats these checks; the client repeats them because
 * a compromised or buggy server must not be able to inject an oversized `signal` into a tool.
 *
 * @param {unknown} value
 * @returns {{ok: true, value: Record<string, any>} | {ok: false, code: string, detail: string}}
 */
export function validateSignalMessage(value) {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return {
      ok: false,
      code: SIGNAL_CODE.BAD_MESSAGE,
      detail: 'message must be an object with a string type',
    };
  }
  switch (value.type) {
    case 'joined':
      return { ok: true, value };
    case 'peer-joined':
    case 'peer-left':
      return { ok: true, value };
    case 'pong':
      return { ok: true, value };
    case 'error':
      return { ok: true, value };
    case 'signal': {
      if (typeof value.from !== 'string' || value.from === '') {
        return { ok: false, code: SIGNAL_CODE.BAD_MESSAGE, detail: 'signal.from is required' };
      }
      if (value.kind !== 'offer' && value.kind !== 'answer' && value.kind !== 'candidate') {
        return {
          ok: false,
          code: SIGNAL_CODE.BAD_MESSAGE,
          detail: `signal.kind ${String(value.kind)} is invalid`,
        };
      }
      if (!isRecord(value.payload)) {
        return { ok: false, code: SIGNAL_CODE.BAD_MESSAGE, detail: 'signal.payload must be an object' };
      }
      return { ok: true, value };
    }
    default:
      return { ok: false, code: SIGNAL_CODE.BAD_MESSAGE, detail: `unknown message type ${value.type}` };
  }
}

/**
 * A one-room signaling client.
 */
export class SignalingClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.url Full ws:// or wss:// URL, normally from `buildSignalingUrl`.
   * @param {string} options.room
   * @param {'host'|'client'} options.role
   * @param {string} options.peerId Stable id for this side within the room.
   * @param {Function} [options.WebSocketImpl]
   * @param {number} [options.connectTimeoutMs]
   * @param {number} [options.joinTimeoutMs]
   * @param {number} [options.heartbeatMs]
   * @param {() => number} [options.now]
   */
  constructor({
    url,
    room,
    role,
    peerId,
    WebSocketImpl = globalThis.WebSocket,
    connectTimeoutMs = 10_000,
    joinTimeoutMs = 10_000,
    heartbeatMs = 25_000,
    now = Date.now,
  }) {
    super();
    this.url = url;
    this.room = room;
    this.role = role;
    this.peerId = peerId;
    this.WebSocketImpl = WebSocketImpl;
    this.connectTimeoutMs = connectTimeoutMs;
    this.joinTimeoutMs = joinTimeoutMs;
    this.heartbeatMs = heartbeatMs;
    this.now = now;

    this.socket = null;
    this.state = 'idle';
    this.peer = null;
    this.joinedAt = null;
    this.closedReason = null;
    this.lastError = null;
    this.pendingConnect = null;
    this.pendingJoin = null;
    this.pendingPeer = null;
    this.heartbeatTimer = null;
    this.lastPongAt = null;
    this.stats = {
      messages_sent: 0,
      messages_received: 0,
      signals_sent: 0,
      signals_received: 0,
      bytes_sent: 0,
      bytes_received: 0,
    };
  }

  /**
   * Connect and join the room. Resolves when the server confirms the join, not merely when the
   * TCP/WebSocket handshake succeeds: a socket that opens onto a full room is not "connected".
   *
   * @returns {Promise<{ok: true, peer: string|null, room: string, role: string} | {ok: false, code: string, detail: string}>}
   */
  connect() {
    if (this.state === 'joined')
      return Promise.resolve({ ok: true, peer: this.peer, room: this.room, role: this.role });
    if (this.state === 'connecting' || this.state === 'joining') {
      return (
        this.pendingConnect ??
        Promise.resolve({
          ok: false,
          code: SIGNAL_CODE.CONNECT_TIMEOUT,
          detail: 'connect already in progress',
        })
      );
    }
    if (typeof this.WebSocketImpl !== 'function') {
      return Promise.resolve({
        ok: false,
        code: SIGNAL_CODE.UNAVAILABLE,
        detail: 'this Node build has no global WebSocket; use Node 22+ or inject a WebSocket implementation',
      });
    }
    this.state = 'connecting';
    this.closedReason = null;
    this.lastError = null;
    this.pendingConnect = new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingConnect = null;
        resolve(value);
      };
      const timer = setTimeout(() => {
        this.close('connect-timeout');
        finish({
          ok: false,
          code: SIGNAL_CODE.CONNECT_TIMEOUT,
          detail: `no WebSocket open within ${this.connectTimeoutMs} ms`,
        });
      }, this.connectTimeoutMs);
      timer.unref?.();
      let socket;
      try {
        socket = new this.WebSocketImpl(this.url);
      } catch (error) {
        this.state = 'closed';
        finish({
          ok: false,
          code: SIGNAL_CODE.BAD_URL,
          detail: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      this.socket = socket;
      const onOpen = () => {
        this.state = 'joining';
        this.#sendRaw({
          type: 'join',
          room: this.room,
          role: this.role,
          peer: this.peerId,
          protocol: WEBRTC_PROTOCOL,
        });
        const joinTimer = setTimeout(() => {
          finish({
            ok: false,
            code: SIGNAL_CODE.JOIN_TIMEOUT,
            detail: `no join confirmation within ${this.joinTimeoutMs} ms`,
          });
        }, this.joinTimeoutMs);
        joinTimer.unref?.();
        this.pendingJoin = {
          resolve: (message) => {
            clearTimeout(joinTimer);
            this.state = 'joined';
            this.joinedAt = this.now();
            this.peer = typeof message.peer === 'string' ? message.peer : null;
            this.#startHeartbeat();
            finish({ ok: true, peer: this.peer, room: this.room, role: this.role });
          },
          reject: (code, detail) => {
            clearTimeout(joinTimer);
            finish({ ok: false, code, detail });
          },
        };
      };
      const onMessage = (event) => this.#onMessage(event);
      const onError = () => {
        const detail = 'WebSocket error';
        this.#reportError({ code: SIGNAL_CODE.SEND_FAILED, detail });
        if (this.pendingConnect !== null) {
          finish({
            ok: false,
            code: SIGNAL_CODE.SEND_FAILED,
            detail: 'WebSocket error before the join completed',
          });
          try {
            socket.close();
          } catch {
            // already closing
          }
        }
      };
      const onClose = () => {
        const wasJoined = this.state === 'joined';
        this.state = 'closed';
        this.#clearHeartbeat();
        if (this.pendingConnect !== null) {
          finish({ ok: false, code: SIGNAL_CODE.CLOSED, detail: 'socket closed before join' });
        }
        if (this.pendingJoin !== null) {
          this.pendingJoin.reject(SIGNAL_CODE.CLOSED, 'socket closed before join');
          this.pendingJoin = null;
        }
        this.#rejectPeer(SIGNAL_CODE.CLOSED, 'socket closed while waiting for a peer');
        if (wasJoined) this.emit('close', this.closedReason ?? 'socket-closed');
      };
      if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('open', onOpen);
        socket.addEventListener('message', onMessage);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
      } else {
        socket.onopen = onOpen;
        socket.onmessage = onMessage;
        socket.onerror = onError;
        socket.onclose = onClose;
      }
    });
    return this.pendingConnect;
  }

  /**
   * Wait for the other role to join. A host typically calls this after connecting; a client may
   * connect second and find the host already there (`joined.peer` is non-null).
   *
   * @param {number} [timeoutMs]
   * @returns {Promise<{ok: true, peer: string} | {ok: false, code: string, detail: string}>}
   */
  waitForPeer(timeoutMs = 30_000) {
    if (this.peer !== null) return Promise.resolve({ ok: true, peer: this.peer });
    if (this.state !== 'joined') {
      return Promise.resolve({ ok: false, code: SIGNAL_CODE.CLOSED, detail: `not joined (${this.state})` });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPeer = null;
        resolve({ ok: false, code: SIGNAL_CODE.PEER_TIMEOUT, detail: `no peer within ${timeoutMs} ms` });
      }, timeoutMs);
      timer.unref?.();
      this.pendingPeer = {
        resolve: (value) => {
          clearTimeout(timer);
          this.pendingPeer = null;
          resolve(value);
        },
      };
    });
  }

  /**
   * Send one SDP or ICE payload to the other member.
   *
   * @param {'offer'|'answer'|'candidate'} kind
   * @param {object} payload
   * @returns {{ok: true, bytes: number} | {ok: false, code: string, detail: string}}
   */
  sendSignal(kind, payload, to = this.peer) {
    if (this.state !== 'joined')
      return { ok: false, code: SIGNAL_CODE.CLOSED, detail: `not joined (${this.state})` };
    if (kind !== 'offer' && kind !== 'answer' && kind !== 'candidate') {
      return { ok: false, code: SIGNAL_CODE.BAD_MESSAGE, detail: `invalid signal kind ${String(kind)}` };
    }
    const message = { type: 'signal', kind, payload, ...(to ? { to } : {}) };
    const result = this.#sendRaw(message);
    if (result.ok) this.stats.signals_sent += 1;
    return result;
  }

  /** Graceful close: send `leave`, then close the socket. */
  close(reason = 'client-close') {
    if (this.state === 'closed' && this.socket === null) return;
    this.closedReason = reason;
    this.#clearHeartbeat();
    if (this.socket !== null) {
      try {
        this.#sendRaw({ type: 'leave', reason });
      } catch {
        // best effort
      }
      try {
        this.socket.close(1000, reason);
      } catch {
        // already closing
      }
    }
    this.state = 'closed';
    this.socket = null;
    this.#rejectPeer(SIGNAL_CODE.CLOSED, reason);
  }

  /** @returns {object} */
  diagnostics() {
    return {
      state: this.state,
      room: this.room,
      role: this.role,
      peer_id: this.peerId,
      peer: this.peer,
      url: redactSignalingUrl(this.url),
      joined_at: this.joinedAt,
      last_pong_at: this.lastPongAt,
      reason: this.closedReason,
      last_error: this.lastError,
      stats: { ...this.stats },
    };
  }

  #sendRaw(message) {
    const socket = this.socket;
    if (socket === null || socket.readyState !== 1) {
      return {
        ok: false,
        code: SIGNAL_CODE.CLOSED,
        detail: `socket readyState ${socket?.readyState ?? 'null'}`,
      };
    }
    const bounded = stringifyBounded(message, MAX_SIGNAL_BYTES);
    if (bounded.ok !== true) return bounded;
    try {
      socket.send(bounded.text);
    } catch (error) {
      return {
        ok: false,
        code: SIGNAL_CODE.SEND_FAILED,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    this.stats.messages_sent += 1;
    this.stats.bytes_sent += bounded.bytes;
    return { ok: true, bytes: bounded.bytes };
  }

  async #onMessage(event) {
    let text = event?.data;
    if (typeof text !== 'string') {
      if (text instanceof ArrayBuffer) text = Buffer.from(text).toString('utf8');
      else if (typeof text?.text === 'function') text = await text.text();
      else return;
    }
    this.stats.messages_received += 1;
    const parsed = parseBoundedJson(text);
    if (parsed.ok !== true) {
      this.#reportError({ code: parsed.code ?? SIGNAL_CODE.BAD_MESSAGE, detail: parsed.detail });
      return;
    }
    const valid = validateSignalMessage(parsed.value);
    if (valid.ok !== true) {
      this.#reportError({ code: valid.code, detail: valid.detail });
      return;
    }
    const message = valid.value;
    if (message.type === 'joined') {
      this.pendingJoin?.resolve(message);
      this.pendingJoin = null;
      this.emit('joined', message);
      return;
    }
    if (message.type === 'peer-joined') {
      this.peer = typeof message.peer === 'string' ? message.peer : this.peer;
      if (this.pendingPeer !== null && this.peer !== null)
        this.pendingPeer.resolve({ ok: true, peer: this.peer });
      this.emit('peer-joined', message);
      return;
    }
    if (message.type === 'peer-left') {
      this.peer = null;
      this.#rejectPeer(SIGNAL_CODE.CLOSED, 'peer left');
      this.emit('peer-left', message);
      return;
    }
    if (message.type === 'pong') {
      this.lastPongAt = this.now();
      return;
    }
    if (message.type === 'error') {
      this.#reportError({
        code: message.code ?? SIGNAL_CODE.SERVER_ERROR,
        detail: message.message ?? 'server error',
      });
      return;
    }
    if (message.type === 'signal') {
      this.stats.signals_received += 1;
      if (typeof message.from === 'string') this.peer = message.from;
      this.emit('signal', message);
    }
  }

  #startHeartbeat() {
    this.#clearHeartbeat();
    if (this.heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      this.#sendRaw({ type: 'ping', at: this.now() });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  #clearHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  #rejectPeer(code, detail) {
    if (this.pendingPeer !== null) {
      this.pendingPeer.resolve({ ok: false, code, detail });
      this.pendingPeer = null;
    }
  }

  /**
   * Emit a named error without crashing a caller that attached no `error` listener. EventEmitter's
   * special `error` event throws when unhandled; a status tool or a test must be able to observe a
   * refused socket without a process-level exception.
   */
  #reportError(error) {
    this.lastError = error;
    if (this.listenerCount('error') > 0) this.emit('error', error);
    else this.emit('protocol-error', error);
  }
}

/**
 * A random peer id for a one-shot transport. Stable ids matter for room ownership, but a single
 * host/client pair only needs uniqueness inside one room.
 * @returns {string}
 */
export function randomPeerId() {
  return `peer-${randomBytes(6).toString('hex')}`;
}
