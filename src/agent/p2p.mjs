/**
 * P2P transport for W2M: UDP hole punching plus a reliable, ordered channel on top.
 *
 * The relay exists because two machines behind NAT cannot dial each other. This
 * module is the alternative: both sides send to the other's *reflexive* address at
 * the same time, which opens both mappings, and the task envelope and its result
 * then travel directly instead of through the relay.
 *
 * What is actually guaranteed, and what is not:
 *
 *   * **Reliable, and message boundaries are preserved.** Fragments are individually
 *     acknowledged and retransmitted; a message is delivered only once every fragment
 *     has arrived. This is a from-scratch protocol, so the guarantees are exactly the
 *     ones implemented -- there is no TCP underneath to fall back on. Messages sent
 *     **one at a time** arrive in send order; concurrent `send()` calls may complete
 *     in either order, which is why the W2M integration awaits each send.
 *   * **Not a general transport.** One session, one peer, no congestion control
 *     beyond a fixed window. That is the right size for "deliver one task offer and
 *     return one result"; it is not a file-transfer protocol.
 *   * **Punching is not guaranteed to succeed.** A symmetric NAT gives a different
 *     mapped port per destination, so the address the peer was told about is not the
 *     address the peer's packets will come from. `punch()` reports failure with the
 *     attempts it made, and the caller falls back to the relay -- explicitly, never
 *     silently.
 *   * **Both ends may send, and one of them usually should not have to.** A peer behind
 *     a CGNAT can send all it likes and still never be heard: its own outbound HELLO opens
 *     its mapping, but the *other* end's filter stays shut until something of its own has
 *     gone the other way. That is why `punch()` and `accept()` are not alternatives: an
 *     executor that normally only accepts can also dial the dispatcher with the session the
 *     offer published (see {@link punchSession}), and the two outbound packets together open
 *     a path that neither alone could. Both ends use the address the *other's* packet came
 *     from -- the observed `rinfo` -- rather than the address that was announced, which is
 *     the one property that makes a symmetric NAT survivable at all.
 *
 * Framing (all integers big-endian):
 *
 *   u8   kind
 *   u32  session           identifies this punch; rejects strays from an old one
 *   ...  kind-specific body
 *
 *   HELLO    1  — "I am here, are you?" repeated to every candidate while punching
 *   HELLO_ACK 2 — "I am here too", which is what confirms the path is bidirectional
 *   DATA     3  — u32 messageId, u32 fragmentIndex, u32 fragmentTotal, payload
 *   ACK      4  — u32 messageId, u32 fragmentIndex (selective, per fragment)
 *   DONE     5  — u32 messageId (receiver has every fragment)
 *   PING     6  — keeps the mapping open between messages
 *   PONG     7  — the answer to PING, and never a PING
 *   BYE      8  — the peer is closing
 */

import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';

/** Frame kinds. Exported so tests and callers can name them instead of using magic numbers. */
export const KIND = {
  HELLO: 1,
  HELLO_ACK: 2,
  DATA: 3,
  ACK: 4,
  DONE: 5,
  PING: 6,
  PONG: 7,
  BYE: 8,
};

/** Protocol version, so a future framing change is detectable rather than corrupting. */
export const P2P_VERSION = 1;

/**
 * Payload bytes per fragment.
 *
 * 1160 keeps a frame under 1200 bytes including the 13-byte header, which passes a
 * 1280-byte IPv6 minimum MTU and the 1500-byte Ethernet MTU with room for a tunnel
 * (WireGuard adds 60). A larger fragment is faster right up until it is silently
 * dropped by a path that will not fragment.
 */
export const MAX_FRAGMENT_PAYLOAD = 1160;

/** Fragments in flight before waiting for acknowledgements. */
export const DEFAULT_WINDOW = 32;

/** First retransmit delay, and the ceiling it doubles up to. */
export const DEFAULT_RTO_MS = 300;
export const MAX_RTO_MS = 3000;

/** Retransmits per fragment before the message is declared undeliverable. */
export const DEFAULT_MAX_ATTEMPTS = 8;

/** Largest message accepted, so a hostile length cannot make us allocate without bound. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

const HEADER_BYTES = 5;

/** @param {number} kind @param {number} session @param {Buffer} [body] */
function frame(kind, session, body = Buffer.alloc(0)) {
  const out = Buffer.alloc(HEADER_BYTES + body.length);
  out.writeUInt8(kind, 0);
  out.writeUInt32BE(session >>> 0, 1);
  body.copy(out, HEADER_BYTES);
  return out;
}

/** @param {Buffer} datagram */
function parseFrame(datagram) {
  if (datagram.length < HEADER_BYTES) return null;
  const kind = datagram.readUInt8(0);
  const session = datagram.readUInt32BE(1);
  return { kind, session, body: datagram.subarray(HEADER_BYTES) };
}

// ---------------------------------------------------------------------------------------------
// Punching
// ---------------------------------------------------------------------------------------------

/**
 * Derive a session id both peers can compute without another round trip.
 *
 * This exists because the session id is what makes a punch *one* punch: frames
 * carrying a different id belong to a different attempt and must be ignored. Two
 * peers that each invented their own id would each reject the other's HELLO, and
 * the punch would time out while both sides insist they were sending.
 *
 * Callers pass inputs both sides already share -- the task id and the two machine
 * ids sorted -- so no extra signalling is needed and the result is deterministic.
 *
 * @param {...(string|number)} parts
 * @returns {number} A non-zero 32-bit session id.
 */
export function deriveSession(...parts) {
  const hash = createHash('sha256').update(parts.map(String).join('\u0000')).digest();
  const value = hash.readUInt32BE(0);
  return value === 0 ? 1 : value;
}

/**
 * Derivation labels, named once so `deriveSession` is never called with a hand-typed
 * string on one side and a different one on the other.
 *
 * The label is part of the hash: two peers that disagreed about it would compute
 * different session ids for the same punch, discard each other's HELLO, and report a
 * timeout that looks exactly like a NAT problem. That is the most expensive possible
 * misdiagnosis, which is why the strings live next to `deriveSession` rather than at
 * the two call sites.
 */
export const PUNCH_SESSION_LABEL = 'w2m-p2p-punch';
export const REVERSE_DIAL_SESSION_LABEL = 'w2m-p2p-reverse';

/** Longest accepted punch id, so a hostile offer cannot make either end hash a novel. */
export const MAX_PUNCH_ID_LENGTH = 64;

/**
 * Is `value` a usable punch id?
 *
 * A punch id is what a dispatcher publishes through the relay so the executor can join the
 * *same* session; it is deliberately not the session itself. One dispatcher leases one task
 * to several machines at once, and a single shared session id would make the second machine's
 * HELLO look like a re-acknowledgement of the first machine's live channel -- two peers on one
 * session, and a result delivered to the wrong address. The published id is therefore an
 * *input* to {@link punchSession}, which mixes in the machine id and yields a session that is
 * unique per (dispatch, task, machine) while still being computable by both ends without a
 * second round trip.
 *
 * Both shapes a JSON hop can carry are accepted: a hex string (what {@link mintPunchId}
 * produces) and a positive integer (what a caller that treats the id as a number would write).
 * Numbers are bounded to 32 bits so `deriveSession`'s string form of them is stable.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPunchId(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 && value <= 0xffffffff;
  return typeof value === 'string' && value !== '' && value.length <= MAX_PUNCH_ID_LENGTH;
}

/**
 * Mint a punch id for one dispatch.
 *
 * Random rather than derived: the session id ends up as the only thing that identifies a
 * channel's frames (`P2PChannel.onDatagram` discards anything carrying another session), so
 * a value an off-path observer could predict would be a value an off-path observer could
 * inject with. Eight random bytes is the cheapest size that makes guessing hopeless.
 *
 * @returns {string} 16 lower-case hex characters.
 */
export function mintPunchId() {
  return randomBytes(8).toString('hex');
}

/**
 * The session a dispatcher punches with, derived from the punch id it published.
 *
 * Deterministic on purpose, and identical on both ends: the dispatcher knows the punch id, the
 * task id and the peer's machine id from the lease; the executor knows the first two from the
 * offer and the third because it is its own id. No extra round trip, and the executor's HELLO
 * carries the very session the dispatcher's in-flight punch is filtering for -- which is what
 * makes the two halves one punch instead of two punches that time out against each other.
 *
 * @param {object} options
 * @param {unknown} options.punch The published punch id; see {@link isPunchId}.
 * @param {unknown} options.taskId
 * @param {unknown} options.machineId The *executor's* machine id, not the dispatcher's.
 * @returns {number|null} `null` when the inputs cannot produce one, so a caller can fall back
 *   to its own id instead of punching at a session the far end is not using.
 */
export function punchSession({ punch, taskId, machineId } = {}) {
  if (!isPunchId(punch)) return null;
  if (typeof taskId !== 'string' || taskId === '') return null;
  if (typeof machineId !== 'string' || machineId === '') return null;
  return deriveSession(PUNCH_SESSION_LABEL, punch, taskId, machineId);
}

/**
 * The session an executor uses when the offer named where to dial but no session to join.
 *
 * This is the compatibility path: a dispatcher that publishes its candidates without a punch
 * id (or an older one that publishes nothing at all, where the caller never gets here). The
 * executor picks the id, and the dispatcher's `accept()` adopts whatever the HELLO carries --
 * that asymmetry is exactly what `allowSessionAdoption` exists for, and it is why a dial can
 * still be attempted against a peer that never named a session.
 *
 * @param {object} options
 * @param {unknown} options.originMachineId The dispatcher's machine id, from the offer.
 * @param {unknown} options.taskId
 * @param {unknown} options.machineId The executor's own machine id.
 * @returns {number|null}
 */
export function reverseDialSession({ originMachineId, taskId, machineId } = {}) {
  if (typeof originMachineId !== 'string' || originMachineId === '') return null;
  if (typeof taskId !== 'string' || taskId === '') return null;
  if (typeof machineId !== 'string' || machineId === '') return null;
  return deriveSession(REVERSE_DIAL_SESSION_LABEL, originMachineId, taskId, machineId);
}

/**
 * Try to open a bidirectional path to one of `remote`'s candidate addresses.
 *
 * Both peers run this at the same time. Each sends HELLO to every candidate; the
 * first peer to get through causes the other's NAT to accept, because the other's
 * outbound HELLO already opened its own mapping in that direction.
 *
 * @param {object} options
 * @param {import('node:dgram').Socket} options.socket  Already bound, and the same socket STUN used.
 * @param {Array<{address:string, port:number}>} options.remote
 * @param {number} [options.session] Agreed id, usually from {@link deriveSession}.
 * @param {boolean} [options.allowSessionAdoption] Adopt the initiator's session id
 *        instead of requiring one. Only valid for a peer that expects to be the
 *        responder; two peers that both adopt end up on different ids.
 * @param {number} [options.timeoutMs]
 * @param {number} [options.intervalMs]
 * @returns {Promise<{ok:boolean, peer:{address:string,port:number}|null, session:number,
 *                    attempts:number, rttMs:number|null, error:string|null}>}
 */
export async function punch(options) {
  const { socket } = options;
  if (!socket) throw new TypeError('punch: a bound UDP socket is required');

  const explicitSession = options.session;
  if (explicitSession === undefined && options.allowSessionAdoption !== true) {
    // Refusing here rather than generating one is deliberate. If both peers generate
    // their own, each discards the other's HELLO and the punch fails with a timeout
    // that looks like a NAT problem -- the most expensive possible misdiagnosis.
    throw new TypeError(
      'punch: `session` is required (see deriveSession), or pass allowSessionAdoption: true ' +
        'to accept the initiator\'s id when this peer is the responder',
    );
  }

  const remote = (options.remote ?? []).filter(
    (c) => c && typeof c.address === 'string' && Number.isInteger(c.port) && c.port > 0,
  );
  if (remote.length === 0) {
    return { ok: false, peer: null, session: explicitSession ?? 0, attempts: 0, rttMs: null, error: 'P2P_NO_CANDIDATES' };
  }

  const ownSession = explicitSession ?? randomBytes(4).readUInt32BE(0);
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  const startedAt = process.hrtime.bigint();

  const hello = frame(KIND.HELLO, ownSession);

  return new Promise((resolve) => {
    let attempts = 0;
    let timer = null;
    let settled = false;
    let agreed = ownSession;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('message', onMessage);
      resolve(result);
    };

    const onMessage = (datagram, rinfo) => {
      const parsed = parseFrame(datagram);
      if (!parsed) return;

      if (parsed.kind === KIND.HELLO) {
        if (explicitSession !== undefined && parsed.session !== explicitSession) return;
        // Adopt the initiator's id when we have none of our own, and echo it back so
        // the initiator sees its own id and accepts the answer.
        agreed = parsed.session;
        socket.send(frame(KIND.HELLO_ACK, agreed), rinfo.port, rinfo.address, () => {});
        const rttMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        finish({
          ok: true,
          peer: { address: rinfo.address, port: rinfo.port },
          session: agreed,
          attempts,
          rttMs: Math.round(rttMs * 100) / 100,
          error: null,
        });
        return;
      }

      if (parsed.kind === KIND.HELLO_ACK) {
        if (parsed.session !== agreed) return;
        const rttMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        finish({
          ok: true,
          peer: { address: rinfo.address, port: rinfo.port },
          session: agreed,
          attempts,
          rttMs: Math.round(rttMs * 100) / 100,
          error: null,
        });
      }
    };

    const tick = () => {
      if (settled) return;
      if (Date.now() >= deadline) {
        finish({
          ok: false,
          peer: null,
          session: agreed,
          attempts,
          rttMs: null,
          error: `P2P_PUNCH_TIMEOUT: no answer from ${remote.length} candidate(s) in ${timeoutMs}ms`,
        });
        return;
      }
      attempts += 1;
      for (const candidate of remote) {
        socket.send(hello, candidate.port, candidate.address, () => {});
      }
      timer = setTimeout(tick, intervalMs);
    };

    socket.on('message', onMessage);
    tick();
  });
}

// ---------------------------------------------------------------------------------------------
// Reliable channel
// ---------------------------------------------------------------------------------------------

/**
 * A reliable, ordered message channel over a punched UDP path.
 *
 * Emits `message` (Buffer) for each delivered message, `close`, and `error`.
 */
export class P2PChannel extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('node:dgram').Socket} options.socket
   * @param {{address:string, port:number}} options.peer
   * @param {number} options.session
   * @param {object} [options.tuning]
   */
  constructor(options) {
    super();
    this.socket = options.socket;
    this.peer = options.peer;
    this.session = options.session;
    this.tuning = {
      window: options.tuning?.window ?? DEFAULT_WINDOW,
      rtoMs: options.tuning?.rtoMs ?? DEFAULT_RTO_MS,
      maxAttempts: options.tuning?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    };

    /** messageId -> {fragments: Buffer[], received: Set<number>, total: number, timer} */
    this.incoming = new Map();
    /** messageId -> {fragments: Buffer[], acked: Set<number>, resolve, reject, attempts: Map} */
    this.outgoing = new Map();
    this.nextMessageId = 1;
    this.closed = false;

    this.onDatagram = this.onDatagram.bind(this);
    this.socket.on('message', this.onDatagram);
  }

  /** @param {Buffer} datagram */
  onDatagram(datagram) {
    const parsed = parseFrame(datagram);
    if (!parsed || parsed.session !== this.session) return;
    // A datagram from anywhere other than the punched peer is not part of this session.
    // (The check is on the address we already validated; UDP source addresses are
    // spoofable, which is why the session id is random and the payload is not trusted
    // for anything but the task it is correlated with.)

    if (parsed.kind === KIND.DATA) this.onData(parsed.body);
    else if (parsed.kind === KIND.ACK) this.onAck(parsed.body);
    // A PING must be answered with PONG, never with PING. Echoing the same kind back
    // makes two peers bounce it between them forever, and the loop looks like healthy
    // traffic while it saturates the mapping it was meant to keep alive.
    else if (parsed.kind === KIND.PING) this.sendFrame(KIND.PONG, Buffer.alloc(0));
    else if (parsed.kind === KIND.PONG) this.lastPongAtMs = Date.now();
    else if (parsed.kind === KIND.BYE) this.close('peer-closed');
  }

  /** @param {Buffer} body */
  onData(body) {
    if (body.length < 12) return;
    const messageId = body.readUInt32BE(0);
    const index = body.readUInt32BE(4);
    const total = body.readUInt32BE(8);
    if (total === 0 || total > 100000 || index >= total) return;
    const payload = body.subarray(12);

    let entry = this.incoming.get(messageId);
    if (!entry) {
      entry = { fragments: new Array(total).fill(null), received: new Set(), total };
      this.incoming.set(messageId, entry);
    }
    if (!entry.received.has(index)) {
      entry.fragments[index] = Buffer.from(payload);
      entry.received.add(index);
    }

    // Acknowledge every fragment, including duplicates: a duplicate means our ACK
    // was lost, and re-acking is cheaper than a retransmit storm.
    const ackBody = Buffer.alloc(8);
    ackBody.writeUInt32BE(messageId, 0);
    ackBody.writeUInt32BE(index, 4);
    this.sendFrame(KIND.ACK, ackBody);

    if (entry.received.size === entry.total) {
      this.incoming.delete(messageId);
      const assembled = Buffer.concat(entry.fragments, entry.fragments.reduce((n, f) => n + f.length, 0));
      const doneBody = Buffer.alloc(4);
      doneBody.writeUInt32BE(messageId, 0);
      this.sendFrame(KIND.DONE, doneBody);
      this.emit('message', assembled);
    }
  }

  /** @param {Buffer} body */
  onAck(body) {
    if (body.length < 8) return;
    const messageId = body.readUInt32BE(0);
    const index = body.readUInt32BE(4);
    const entry = this.outgoing.get(messageId);
    if (!entry) return;
    entry.acked.add(index);
    if (entry.acked.size === entry.fragments.length) {
      this.outgoing.delete(messageId);
      clearTimeout(entry.timer);
      entry.resolve();
    }
  }

  /** @param {number} kind @param {Buffer} body */
  sendFrame(kind, body) {
    if (this.closed) return;
    this.socket.send(frame(kind, this.session, body), this.peer.port, this.peer.address, () => {});
  }

  /**
   * Send one message reliably.
   *
   * Resolves when the peer has acknowledged every fragment. Rejects only after
   * `maxAttempts` retransmits of some fragment, with the fragment index in the
   * message -- "the peer went away" and "the path broke on one fragment" need
   * different responses from a caller.
   *
   * @param {Buffer|string} payload
   * @returns {Promise<void>}
   */
  send(payload) {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    if (buf.length > MAX_MESSAGE_BYTES) {
      return Promise.reject(new Error(`P2P_MESSAGE_TOO_LARGE: ${buf.length} > ${MAX_MESSAGE_BYTES}`));
    }
    if (this.closed) return Promise.reject(new Error('P2P_CHANNEL_CLOSED'));

    const messageId = this.nextMessageId;
    this.nextMessageId = (this.nextMessageId % 0xffffffff) + 1;

    const fragments = [];
    for (let offset = 0; offset < Math.max(buf.length, 1); offset += MAX_FRAGMENT_PAYLOAD) {
      fragments.push(buf.subarray(offset, Math.min(offset + MAX_FRAGMENT_PAYLOAD, buf.length)));
    }

    return new Promise((resolve, reject) => {
      const entry = {
        fragments,
        acked: new Set(),
        resolve,
        reject,
        attempts: new Map(),
      };
      this.outgoing.set(messageId, entry);

      const pump = () => {
        if (this.closed) return;
        const pending = [];
        for (let i = 0; i < fragments.length; i += 1) {
          if (entry.acked.has(i)) continue;
          pending.push(i);
          if (pending.length >= this.tuning.window) break;
        }
        if (pending.length === 0) return;

        for (const index of pending) {
          const attempt = (entry.attempts.get(index) ?? 0) + 1;
          entry.attempts.set(index, attempt);
          if (attempt > this.tuning.maxAttempts) {
            this.outgoing.delete(messageId);
            reject(
              new Error(
                `P2P_FRAGMENT_UNACKED: fragment ${index}/${fragments.length} of message ${messageId} ` +
                  `after ${this.tuning.maxAttempts} attempts`,
              ),
            );
            return;
          }
          const body = Buffer.alloc(12 + fragments[index].length);
          body.writeUInt32BE(messageId, 0);
          body.writeUInt32BE(index, 4);
          body.writeUInt32BE(fragments.length, 8);
          fragments[index].copy(body, 12);
          this.sendFrame(KIND.DATA, body);
        }

        const worst = Math.max(...pending.map((i) => entry.attempts.get(i) ?? 1));
        const delay = Math.min(this.tuning.rtoMs * 2 ** (worst - 1), MAX_RTO_MS);
        // One timer per message, not one per channel: a shared field means a second
        // concurrent send silently cancels the first one's retransmission schedule.
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          if (this.outgoing.has(messageId)) pump();
        }, delay);
        entry.timer.unref?.();
      };

      pump();
    });
  }

  /** Stop the channel. The socket is NOT closed: the caller owns it. */
  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.socket.removeListener('message', this.onDatagram);
    for (const entry of this.outgoing.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`P2P_CHANNEL_CLOSED: ${reason}`));
    }
    this.outgoing.clear();
    this.incoming.clear();
    if (reason !== 'peer-closed') {
      try {
        this.sendFrame(KIND.BYE, Buffer.alloc(0));
      } catch {
        /* the path is already gone */
      }
    }
    this.emit('close', reason);
  }
}

/**
 * The responder's half of a punch: wait for a HELLO, answer it, hand back a channel.
 *
 * This is the mirror of {@link punch}, and it exists because the two ends of a punch do
 * genuinely different things. The initiator knows the session and every candidate and
 * has to keep sending; the responder knows nothing, waits, and learns both the session
 * and the address from the HELLO that reaches it. That asymmetry is what lets a peer be
 * dialled without any prior arrangement — and it is why adoption (`allowSessionAdoption`)
 * exists in `punch()`: a responder that invented its own id would discard the very
 * datagram it is waiting for.
 *
 * Two decisions worth stating:
 *
 *   * **A claimed session is re-acknowledged, never adopted.** When the HELLO's session
 *     already has a live channel, the answer is another HELLO_ACK and no second channel:
 *     the initiator retransmits HELLOs while punching, so a lost ACK has to be
 *     answerable again, but two channels on one session would each assemble and deliver
 *     every payload and the peer would see each message twice. The caller owns that
 *     `claimed` set, because a claim has to outlive one call to this function.
 *   * **`rttMs` is `null`.** The responder never sent anything before the HELLO arrived,
 *     so there is no round trip to measure. Reporting the time spent waiting as an RTT
 *     would be a fabricated number in a field named for a measurement.
 *
 * @param {object} options
 * @param {import('node:dgram').Socket} options.socket Already bound; the same socket the
 *        punch was aimed at, and the same one a channel will use.
 * @param {number} [options.timeoutMs] How long to wait before giving up.
 * @param {Set<number>|Map<number, unknown>} [options.claimed] Sessions that already have
 *        a live channel. Read, never written.
 * @param {number} [options.intervalMs] Floor between re-acknowledgements of the same
 *        claimed session within one call, so a peer that sprays HELLOs cannot make the
 *        responder answer every single one. The default matches `punch()`'s send
 *        interval, so a retransmission is always answered; `0` disables the floor.
 * @returns {Promise<{ok:boolean, channel:P2PChannel|null, peer:{address:string,port:number}|null,
 *                    session:number, rttMs:number|null, error:string|null}>}
 */
export async function accept(options) {
  const { socket } = options;
  if (!socket) throw new TypeError('accept: a bound UDP socket is required');

  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 250;
  const claimed = options.claimed ?? null;

  return new Promise((resolve) => {
    let settled = false;
    /** session -> last re-ack timestamp, so the floor is per session, not per socket. */
    const reackedAt = new Map();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('message', onMessage);
      socket.removeListener('close', onSocketClose);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        channel: null,
        peer: null,
        session: 0,
        rttMs: null,
        error: `P2P_ACCEPT_TIMEOUT: no HELLO within ${timeoutMs}ms`,
      });
    }, timeoutMs);

    // A wait on a socket that goes away must end now, not at the end of the timeout:
    // this is what makes a node's `close()` a barrier instead of a five-second stall.
    const onSocketClose = () => {
      finish({
        ok: false,
        channel: null,
        peer: null,
        session: 0,
        rttMs: null,
        error: 'P2P_SOCKET_CLOSED: the socket went away while waiting for a HELLO',
      });
    };

    const onMessage = (datagram, rinfo) => {
      const parsed = parseFrame(datagram);
      // Only a HELLO is this function's business. DATA/ACK/PING/PONG belong to whichever
      // channels are already listening; a second consumer of them would be a second
      // delivery, which is the bug the `claimed` set exists to prevent.
      if (!parsed || parsed.kind !== KIND.HELLO) return;
      const session = parsed.session;

      if (claimed !== null && claimed.has(session)) {
        const now = Date.now();
        const last = reackedAt.get(session) ?? Number.NEGATIVE_INFINITY;
        if (now - last >= intervalMs) {
          reackedAt.set(session, now);
          socket.send(frame(KIND.HELLO_ACK, session), rinfo.port, rinfo.address, () => {});
        }
        return;
      }

      socket.send(frame(KIND.HELLO_ACK, session), rinfo.port, rinfo.address, () => {});
      finish({
        ok: true,
        channel: new P2PChannel({
          socket,
          peer: { address: rinfo.address, port: rinfo.port },
          session,
        }),
        peer: { address: rinfo.address, port: rinfo.port },
        session,
        rttMs: null,
        error: null,
      });
    };

    socket.on('message', onMessage);
    socket.once('close', onSocketClose);
  });
}

/**
 * Punch, then return a reliable channel on the opened path.
 *
 * @param {object} options Same as {@link punch}, plus `tuning` for the channel.
 * @returns {Promise<{ok:boolean, channel:P2PChannel|null, punch:object, error:string|null}>}
 */
export async function connect(options) {
  const result = await punch(options);
  if (!result.ok) return { ok: false, channel: null, punch: result, error: result.error };
  const channel = new P2PChannel({
    socket: options.socket,
    peer: result.peer,
    session: result.session,
    tuning: options.tuning,
  });
  return { ok: true, channel, punch: result, error: null };
}
