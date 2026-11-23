/**
 * The Noise boundary for the WebRTC transport.
 *
 * WebRTC already encrypts a DataChannel with DTLS, but DTLS authenticates an ephemeral certificate
 * to whoever completed the ICE handshake. It says nothing about which W2M machine is on the other
 * end, and it ends at the relay for a TURN path. The W2M fleet already has an audited
 * Noise_IK_25519_ChaChaPoly_SHA256 handshake and a rekeying `CryptoSession` in `crypto.mjs`; this
 * module puts that *inside* the DataChannel, so every RPC/event byte has the same end-to-end
 * identity and confidentiality guarantee regardless of the ICE path (host, srflx or relay).
 *
 * Reuse is deliberate: a second handshake would be a second place for a transcript bug, replay
 * window bug or epoch bug. The only WebRTC-specific piece is the 5-byte frame header, which
 * `protocol.mjs` shares with `p2p.mjs` precisely so `CryptoSession` can authenticate it as AAD.
 *
 * ## State machine
 *
 *   initiator: start() -> HELLO -> wait HELLO_ACK -> secure
 *   responder: wait HELLO -> respondHandshake -> HELLO_ACK -> secure
 *
 * `HELLO`/`HELLO_ACK` are the only plaintext frames. They are Noise handshake bodies: the static-key
 * proof and the transcript MAC are inside them, so an observer cannot forge either one. A refusal
 * travels as a BYE with a named code, never as plaintext application data.
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

import {
  CRYPTO_REASON,
  DeviceKey,
  NonceCache,
  PeerKeyStore,
  respondHandshake,
  startHandshake,
} from '../crypto.mjs';
import {
  FRAME_KIND,
  WEBRTC_CODE,
  decodeFrame,
  encodeFrame,
  encodeJsonFrame,
  WebRtcProtocolError,
} from './protocol.mjs';

/** Handshake states, exposed in diagnostics. */
export const SECURE_STATE = Object.freeze({
  IDLE: 'idle',
  HELLO_SENT: 'hello-sent',
  SECURE: 'secure',
  CLOSED: 'closed',
  FAILED: 'failed',
});

/** How long a handshake may take before the channel is failed. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

/** Rekey/material limits already live in `crypto.mjs`; this module adds no second policy. */

/**
 * @param {unknown} value
 * @returns {value is Buffer}
 */
function isBuffer(value) {
  return Buffer.isBuffer(value);
}

/**
 * One Noise-secured WebRTC DataChannel.
 *
 * The owner supplies:
 *  - `sendRaw(frame)` — write one complete frame to the DataChannel;
 *  - `onFrame({kind, body})` — authenticated plaintext body for DATA/CHUNK/PING/PONG;
 *  - `onSecure(info)` — handshake completed;
 *  - `onError({code, detail})` — named failure;
 *  - `onClose(reason)` — the channel ended.
 *
 * `sendRaw` may return `{ok:false, code}`; `send()` propagates that instead of claiming delivery.
 */
export class SecureChannel extends EventEmitter {
  /**
   * @param {object} options
   * @param {'initiator'|'responder'} options.role
   * @param {DeviceKey} options.deviceKey
   * @param {string} options.peerMachineId For the initiator, the machine being dialled.
   * @param {string} [options.peerPublicKey] Required for the initiator: the peer's pinned static key.
   * @param {Map<string,string>|PeerKeyStore} [options.peerKeys] Required for the responder.
   * @param {number} [options.session] 32-bit handshake session; random when omitted.
   * @param {number} [options.handshakeTimeoutMs]
   * @param {() => number} [options.now]
   * @param {(frame: Buffer) => {ok?: boolean, code?: string, detail?: string}|void|Promise<void>} options.sendRaw
   */
  constructor({
    role,
    deviceKey,
    peerMachineId,
    peerPublicKey = '',
    peerKeys = null,
    session = null,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    now = Date.now,
    sendRaw,
  }) {
    super();
    if (role !== 'initiator' && role !== 'responder') {
      throw new TypeError('SecureChannel: role must be "initiator" or "responder"');
    }
    if (!(deviceKey instanceof DeviceKey)) {
      throw new TypeError('SecureChannel: deviceKey must be a DeviceKey');
    }
    if (typeof peerMachineId !== 'string' || peerMachineId === '') {
      throw new TypeError('SecureChannel: peerMachineId is required');
    }
    if (typeof sendRaw !== 'function') {
      throw new TypeError('SecureChannel: sendRaw is required');
    }
    if (role === 'initiator' && (typeof peerPublicKey !== 'string' || peerPublicKey === '')) {
      throw new TypeError(
        'SecureChannel: the initiator needs the peer public key (pinned, never learned from SDP)',
      );
    }
    if (role === 'responder' && !(peerKeys instanceof Map) && !(peerKeys instanceof PeerKeyStore)) {
      throw new TypeError('SecureChannel: the responder needs a peerKeys Map or PeerKeyStore');
    }
    this.role = role;
    this.deviceKey = deviceKey;
    this.peerMachineId = peerMachineId;
    this.peerPublicKey = peerPublicKey;
    this.peerKeys = peerKeys;
    this.session =
      Number.isInteger(session) && session >= 0 && session <= 0xffffffff
        ? session
        : randomBytes(4).readUInt32BE(0);
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.now = now;
    this.sendRaw = sendRaw;
    this.seen = new NonceCache();

    this.state = SECURE_STATE.IDLE;
    this.amInitiator = role === 'initiator';
    this.crypto = null;
    this.pending = null;
    this.timer = null;
    this.closedReason = null;
    this.stats = {
      frames_sent: 0,
      frames_received: 0,
      bytes_sent: 0,
      bytes_received: 0,
      dropped: 0,
      handshakes: 0,
      pings: 0,
      pongs: 0,
      last_error: null,
    };
  }

  /** Begin the handshake. The initiator sends HELLO; the responder waits. */
  start() {
    if (this.state !== SECURE_STATE.IDLE) {
      return { ok: false, code: 'WEBRTC_SECURE_ALREADY_STARTED', detail: this.state };
    }
    if (this.role === 'responder') {
      this.#armTimer();
      return { ok: true, state: this.state };
    }
    try {
      this.pending = startHandshake({
        deviceKey: this.deviceKey,
        peerMachineId: this.peerMachineId,
        peerPublicKey: this.peerPublicKey,
        session: this.session,
      });
    } catch (error) {
      return this.#fail(
        'WEBRTC_HANDSHAKE_START_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    }
    this.state = SECURE_STATE.HELLO_SENT;
    this.#armTimer();
    const hello = encodeFrame(FRAME_KIND.HELLO, this.session, this.pending.body);
    return this.#write(hello);
  }

  /**
   * Feed one complete frame received from the DataChannel.
   *
   * Never throws: a malformed or unauthenticated frame is dropped with a named error and the secure
   * channel either stays up (bad DATA) or fails (bad handshake).
   *
   * @param {Buffer} frame
   * @returns {{ok: boolean, code?: string, detail?: string}}
   */
  handle(frame) {
    if (this.state === SECURE_STATE.CLOSED || this.state === SECURE_STATE.FAILED) {
      return { ok: false, code: 'WEBRTC_SECURE_CLOSED', detail: this.closedReason ?? this.state };
    }
    let parsed;
    try {
      parsed = decodeFrame(frame);
    } catch (error) {
      return this.#drop(error instanceof WebRtcProtocolError ? error.code : WEBRTC_CODE.BAD_FRAME, error);
    }
    this.stats.frames_received += 1;
    this.stats.bytes_received += frame.length;

    if (parsed.kind === FRAME_KIND.HELLO) return this.#handleHello(parsed);
    if (parsed.kind === FRAME_KIND.HELLO_ACK) return this.#handleHelloAck(parsed);
    // A refusal to a plaintext HELLO arrives before either side has a CryptoSession. It is only a
    // named reason, never application data, so it is read here rather than dropped as "not secure".
    if (parsed.kind === FRAME_KIND.BYE && this.crypto === null) {
      let value = null;
      try {
        value = JSON.parse(parsed.body.toString('utf8'));
      } catch {
        value = null;
      }
      const reason = typeof value?.reason === 'string' ? value.reason : 'peer-bye';
      this.#fail(reason, 'peer refused the handshake');
      return { ok: false, code: reason, detail: 'peer refused the handshake' };
    }
    if (this.crypto === null) {
      return this.#drop(
        'WEBRTC_SECURE_NOT_READY',
        new Error('application frame arrived before the handshake'),
      );
    }
    if (parsed.session !== this.session) {
      return this.#drop(
        'WEBRTC_SECURE_SESSION_MISMATCH',
        new Error(`frame session ${parsed.session} != ${this.session}`),
      );
    }
    const opened = this.crypto.decrypt(this.amInitiator, frame);
    if (opened.ok !== true) {
      return this.#drop(opened.reason ?? CRYPTO_REASON.AUTH_FAILED, new Error('Noise authentication failed'));
    }
    const body = opened.plaintext;
    if (parsed.kind === FRAME_KIND.PING) {
      this.stats.pings += 1;
      const pong = encodeFrame(FRAME_KIND.PONG, this.session, body);
      const sealed = this.crypto.encrypt(this.amInitiator, pong);
      this.#write(sealed);
      this.emit('ping', body);
      return { ok: true };
    }
    if (parsed.kind === FRAME_KIND.PONG) {
      this.stats.pongs += 1;
      this.emit('pong', body);
      return { ok: true };
    }
    if (parsed.kind === FRAME_KIND.BYE) {
      let value = null;
      try {
        value = JSON.parse(body.toString('utf8'));
      } catch {
        value = null;
      }
      this.close(value?.reason ?? 'peer-bye', { sendBye: false });
      return { ok: true };
    }
    if (parsed.kind === FRAME_KIND.DATA || parsed.kind === FRAME_KIND.CHUNK) {
      this.emit('frame', { kind: parsed.kind, body });
      return { ok: true };
    }
    // ACK/DONE are reserved for a future request/response layer; authenticated but not interpreted.
    this.emit('frame', { kind: parsed.kind, body });
    return { ok: true };
  }

  /**
   * Seal and send one application payload. Returns the number of bytes written on the wire.
   *
   * @param {Buffer|string|object} payload
   * @returns {{ok: true, bytes: number} | {ok: false, code: string, detail: string}}
   */
  send(payload, { kind = FRAME_KIND.DATA } = {}) {
    if (this.state !== SECURE_STATE.SECURE || this.crypto === null) {
      return { ok: false, code: 'WEBRTC_SECURE_NOT_READY', detail: this.state };
    }
    let bytes;
    if (isBuffer(payload)) bytes = payload;
    else if (typeof payload === 'string') bytes = Buffer.from(payload, 'utf8');
    else {
      const text = JSON.stringify(payload);
      if (typeof text !== 'string') {
        return { ok: false, code: WEBRTC_CODE.BAD_JSON, detail: 'payload is not serializable' };
      }
      bytes = Buffer.from(text, 'utf8');
    }
    const frame = encodeFrame(kind, this.session, bytes);
    let sealed;
    try {
      sealed = this.crypto.encrypt(this.amInitiator, frame);
    } catch (error) {
      return this.#fail('WEBRTC_ENCRYPT_FAILED', error instanceof Error ? error.message : String(error));
    }
    return this.#write(sealed);
  }

  /**
   * Send an authenticated PING and wait for its PONG.
   *
   * @param {number} [timeoutMs]
   * @returns {Promise<{ok: true, rttMs: number} | {ok: false, code: string, detail: string}>}
   */
  probe(timeoutMs = 5_000) {
    if (this.state !== SECURE_STATE.SECURE || this.crypto === null) {
      return Promise.resolve({ ok: false, code: 'WEBRTC_SECURE_NOT_READY', detail: this.state });
    }
    const token = randomBytes(8).toString('hex');
    const started = this.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('pong', onPong);
        resolve({ ok: false, code: 'WEBRTC_PROBE_TIMEOUT', detail: `no PONG within ${timeoutMs} ms` });
      }, timeoutMs);
      timer.unref?.();
      const onPong = (body) => {
        let value = null;
        try {
          value = JSON.parse(body.toString('utf8'));
        } catch {
          value = null;
        }
        if (value?.token !== token) return;
        clearTimeout(timer);
        this.off('pong', onPong);
        resolve({ ok: true, rttMs: this.now() - started });
      };
      this.on('pong', onPong);
      const ping = encodeFrame(
        FRAME_KIND.PING,
        this.session,
        Buffer.from(JSON.stringify({ token, at: started })),
      );
      let sealed;
      try {
        sealed = this.crypto.encrypt(this.amInitiator, ping);
      } catch (error) {
        clearTimeout(timer);
        this.off('pong', onPong);
        resolve({
          ok: false,
          code: 'WEBRTC_ENCRYPT_FAILED',
          detail: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const written = this.#write(sealed);
      if (written !== null && typeof written === 'object' && typeof written.then === 'function') {
        written.then((value) => {
          if (value.ok !== true) {
            clearTimeout(timer);
            this.off('pong', onPong);
            resolve(value);
          }
        });
      } else if (written.ok !== true) {
        clearTimeout(timer);
        this.off('pong', onPong);
        resolve(written);
      }
    });
  }

  /**
   * Close the secure layer. Sends an authenticated BYE when the channel is still usable.
   *
   * @param {string} [reason]
   * @param {{sendBye?: boolean}} [options]
   */
  close(reason = 'closed', { sendBye = true } = {}) {
    if (this.state === SECURE_STATE.CLOSED || this.state === SECURE_STATE.FAILED) return;
    const wasSecure = this.state === SECURE_STATE.SECURE && this.crypto !== null;
    if (wasSecure && sendBye) {
      try {
        const bye = encodeFrame(FRAME_KIND.BYE, this.session, Buffer.from(JSON.stringify({ reason })));
        this.#write(this.crypto.encrypt(this.amInitiator, bye));
      } catch {
        // A failed BYE is a lost courtesy, not a reason to keep the channel open.
      }
    }
    this.state = SECURE_STATE.CLOSED;
    this.closedReason = reason;
    this.#clearTimer();
    this.emit('close', reason);
  }

  /** @returns {object} Diagnostics safe to return over a tool. */
  diagnostics() {
    return {
      role: this.role,
      state: this.state,
      session: this.session,
      peer_machine_id: this.peerMachineId,
      am_initiator: this.amInitiator,
      handshake_timeout_ms: this.handshakeTimeoutMs,
      stats: { ...this.stats },
      crypto: this.crypto?.stats ?? null,
      reason: this.closedReason,
    };
  }

  #handleHello(parsed) {
    if (this.role !== 'responder') {
      return this.#drop('WEBRTC_UNEXPECTED_HELLO', new Error('an initiator received HELLO'));
    }
    if (this.state !== SECURE_STATE.IDLE) {
      return this.#drop('WEBRTC_DUPLICATE_HELLO', new Error(`HELLO in state ${this.state}`));
    }
    const result = respondHandshake({
      deviceKey: this.deviceKey,
      body: parsed.body,
      peerKeys: this.peerKeys,
      seen: this.seen,
    });
    if (result.ok !== true) {
      // A refusal body, when present, is itself Noise-authenticated proof; send it as the BYE body
      // so the initiator can distinguish "wrong key" from "peer offline".
      const bye = encodeJsonFrame(FRAME_KIND.BYE, this.session, {
        reason: result.reason ?? CRYPTO_REASON.AUTH_FAILED,
        refusal: result.refuse ? result.refuse.toString('base64') : null,
      });
      this.#write(bye.frame);
      return this.#fail(result.reason ?? 'WEBRTC_HANDSHAKE_REFUSED', 'respondHandshake refused');
    }
    this.session = result.session;
    this.crypto = result.crypto;
    this.amInitiator = false;
    this.state = SECURE_STATE.SECURE;
    this.stats.handshakes += 1;
    this.#clearTimer();
    const ack = encodeFrame(FRAME_KIND.HELLO_ACK, this.session, result.body);
    const written = this.#write(ack);
    if (written !== null && typeof written === 'object' && typeof written.then === 'function') {
      written.then((value) => {
        if (value.ok !== true)
          this.#fail(value.code ?? 'WEBRTC_ACK_SEND_FAILED', value.detail ?? 'ACK send failed');
      });
    } else if (written.ok !== true) {
      return written;
    }
    this.emit('secure', {
      role: this.role,
      session: this.session,
      peerMachineId: result.machineId ?? this.peerMachineId,
    });
    return { ok: true };
  }

  #handleHelloAck(parsed) {
    if (this.role !== 'initiator' || this.pending === null) {
      return this.#drop(
        'WEBRTC_UNEXPECTED_HELLO_ACK',
        new Error('HELLO_ACK without a pending initiator handshake'),
      );
    }
    if (parsed.session !== this.session) {
      return this.#drop(
        'WEBRTC_SECURE_SESSION_MISMATCH',
        new Error(`HELLO_ACK session ${parsed.session} != ${this.session}`),
      );
    }
    const result = this.pending.finish(parsed.body);
    this.pending = null;
    if (result.ok !== true)
      return this.#fail(result.reason ?? 'WEBRTC_HANDSHAKE_FAILED', 'HELLO_ACK did not verify');
    this.crypto = result.session;
    this.amInitiator = true;
    this.state = SECURE_STATE.SECURE;
    this.stats.handshakes += 1;
    this.#clearTimer();
    this.emit('secure', { role: this.role, session: this.session, peerMachineId: this.peerMachineId });
    return { ok: true };
  }

  #write(frame) {
    let result;
    try {
      result = this.sendRaw(frame);
    } catch (error) {
      return this.#fail('WEBRTC_SEND_FAILED', error instanceof Error ? error.message : String(error));
    }
    const note = () => {
      this.stats.frames_sent += 1;
      this.stats.bytes_sent += frame.length;
      return { ok: true, bytes: frame.length };
    };
    // `sendRaw` may be asynchronous (a provider process write with backpressure). Returning the
    // promise lets `send()` tell the caller whether the bytes actually left this process; handshake
    // and keepalive paths intentionally fire-and-forget the same promise.
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      return Promise.resolve(result).then(
        (value) => {
          if (value && typeof value === 'object' && value.ok === false) {
            return {
              ok: false,
              code: value.code ?? 'WEBRTC_SEND_FAILED',
              detail: value.detail ?? 'sendRaw refused',
            };
          }
          return note();
        },
        (error) => this.#fail('WEBRTC_SEND_FAILED', error instanceof Error ? error.message : String(error)),
      );
    }
    if (result && typeof result === 'object' && result.ok === false) {
      return {
        ok: false,
        code: result.code ?? 'WEBRTC_SEND_FAILED',
        detail: result.detail ?? 'sendRaw refused',
      };
    }
    return note();
  }

  #drop(code, error) {
    this.stats.dropped += 1;
    this.stats.last_error = { code, detail: error instanceof Error ? error.message : String(error) };
    this.emit('error', this.stats.last_error);
    return { ok: false, code, detail: this.stats.last_error.detail };
  }

  #fail(code, detail) {
    if (this.state === SECURE_STATE.FAILED || this.state === SECURE_STATE.CLOSED) {
      return { ok: false, code, detail };
    }
    this.state = SECURE_STATE.FAILED;
    this.closedReason = `${code}: ${detail}`;
    this.#clearTimer();
    this.stats.last_error = { code, detail };
    this.emit('error', this.stats.last_error);
    this.emit('close', this.closedReason);
    return { ok: false, code, detail };
  }

  #armTimer() {
    this.#clearTimer();
    if (this.handshakeTimeoutMs <= 0) return;
    this.timer = setTimeout(() => {
      this.#fail('WEBRTC_HANDSHAKE_TIMEOUT', `no secure channel within ${this.handshakeTimeoutMs} ms`);
    }, this.handshakeTimeoutMs);
    this.timer.unref?.();
  }

  #clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Load a device key for the transport, or return a named refusal.
 *
 * @param {{file?: string, machineId?: string|null, deviceKey?: DeviceKey}} options
 * @returns {{ok: true, key: DeviceKey} | {ok: false, code: string, detail: string}}
 */
export function resolveDeviceKey({ file = '', machineId = null, deviceKey = null } = {}) {
  if (deviceKey instanceof DeviceKey) return { ok: true, key: deviceKey };
  try {
    const loaded = DeviceKey.load({ file: file || undefined, machineId });
    return { ok: true, key: loaded.key };
  } catch (error) {
    return {
      ok: false,
      code: 'WEBRTC_DEVICE_KEY_FAILED',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
