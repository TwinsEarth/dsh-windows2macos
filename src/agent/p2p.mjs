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
 *
 * Encryption (v0.6.0, `docs/P2P-CRYPTO.md` stage 1) rides *inside* those kinds rather than adding
 * new ones, which is what keeps a v0.5.x peer able to talk to this build:
 *
 *   * A `HELLO`/`HELLO_ACK` whose body begins with `crypto.mjs`'s frame magic is a handshake message;
 *     one with an empty body is the plain punch a v0.5.x peer sends. A v0.5.x peer answers a
 *     handshake `HELLO` with its own plain `HELLO_ACK` (it never reads the body), and this build
 *     answers a v0.5.x `HELLO` with a plain `HELLO_ACK` when it holds no key for that machine.
 *   * A frame whose body begins with that same magic is encrypted: the 5-byte header stays in the
 *     clear and is authenticated as associated data, and the body carries a 10-byte cipher header
 *     (magic, epoch, 64-bit counter), the ciphertext and a 16-byte tag.
 *
 * So the two shapes are told apart by one byte and neither end has to be told which kind of peer it
 * is meeting. What is **not** negotiable is falling back mid-session: a peer that fails the handshake
 * is refused by name and never silently downgraded, because a downgrade an attacker can trigger is
 * not encryption.
 */

import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';

import {
  CRYPTO_REASON,
  REFUSE,
  decodeHello,
  decodeRefuse,
  encodeRefuse,
  REFUSE_REASON,
  respondHandshake,
  startHandshake,
  verifyRefuseMac,
} from './crypto.mjs';

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
 * 1160 keeps a *plaintext* DATA frame under 1200 bytes: 5 header + 12 fields + 1160 = 1177. An
 * encrypted frame adds `crypto.mjs`'s 26 bytes (10 cipher header + 16 tag) and lands at 1203 — 3
 * bytes over that soft budget and still 77 under a 1280-byte IPv6 minimum MTU, which is the number
 * that actually decides whether a path can carry it. The tighter budget is a deliberate acceptance
 * rather than an oversight, and it is asserted against this constant in `test/p2p-crypto.test.mjs`
 * so a future increase is a decision rather than an accident. A larger fragment is faster right up
 * until it is silently dropped by a path that will not fragment.
 */
export const MAX_FRAGMENT_PAYLOAD = 1160;

/** Fragments in flight before waiting for acknowledgements. */
export const DEFAULT_WINDOW = 32;

/** First retransmit delay, and the ceiling it doubles up to. */
export const DEFAULT_RTO_MS = 300;
export const MAX_RTO_MS = 3000;

/**
 * RFC 6298 RTT estimator. The old channel used a constant 300 ms RTO, which is
 * wrong on both a LAN (too slow) and a lossy WAN (too fast). This keeps SRTT and
 * RTTVAR and clamps the result; callers still apply per-attempt exponential
 * backoff on top.
 */
export class RttEstimator {
  constructor({ initialRtoMs = DEFAULT_RTO_MS, minRtoMs = 100, maxRtoMs = MAX_RTO_MS } = {}) {
    this.srtt = null;
    this.rttvar = null;
    this.minRtoMs = minRtoMs;
    this.maxRtoMs = maxRtoMs;
    this.rtoMs = Math.min(maxRtoMs, Math.max(minRtoMs, initialRtoMs));
  }

  sample(rttMs) {
    if (!Number.isFinite(rttMs) || rttMs < 0) return this.rtoMs;
    if (this.srtt === null) {
      this.srtt = rttMs;
      this.rttvar = rttMs / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - rttMs);
      this.srtt = 0.875 * this.srtt + 0.125 * rttMs;
    }
    this.rtoMs = Math.min(this.maxRtoMs, Math.max(this.minRtoMs, this.srtt + 4 * this.rttvar));
    return this.rtoMs;
  }

  reset() {
    this.srtt = null;
    this.rttvar = null;
    this.rtoMs = Math.min(this.maxRtoMs, Math.max(this.minRtoMs, DEFAULT_RTO_MS));
  }
}


/** Retransmits per fragment before the message is declared undeliverable. */
export const DEFAULT_MAX_ATTEMPTS = 8;

/** Largest message accepted, so a hostile length cannot make us allocate without bound. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/**
 * How many completed message ids one channel remembers, for duplicate suppression.
 *
 * `1024` bounds the completed-message memory at 1024 small records (message id -> completion
 * time) however many messages pass through the channel: a later completion evicts the oldest
 * record. `0` disables the memory entirely, so every duplicate is re-assembled — the escape
 * hatch for a caller that prefers zero bookkeeping to exactly-once delivery, documented rather
 * than hidden.
 */
export const DEFAULT_RECENT_MESSAGE_LIMIT = 1024;

/**
 * How long a completed message id stays remembered, and (same value) how long an incomplete
 * reassembly may sit with no new fragment before it is abandoned.
 *
 * Two constraints set the default. It must be comfortably longer than the sender's worst-case
 * retransmission budget for the *default* tuning (`DEFAULT_MAX_ATTEMPTS` × `MAX_RTO_MS` = 24 s
 * at most), so the receiver cannot sweep an assembly the sender is still trying to complete —
 * a caller that raises `tuning.maxAttempts` should raise the TTL with it. And it must be short
 * enough that a hostile or crash-looping peer cannot pin memory with abandoned assemblies.
 * 60 s satisfies both with margin.
 */
export const DEFAULT_RECENT_MESSAGE_TTL_MS = 60_000;

const HEADER_BYTES = 5;

/** Bounds for the stale-reassembly sweep interval derived from the TTL. */
const SWEEP_INTERVAL_MIN_MS = 10;
const SWEEP_INTERVAL_MAX_MS = 5000;

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
 * The result of trying to encrypt a punch, in one shape both `punch()` and `accept()` return.
 *
 * `status` is deliberately three-valued rather than a boolean:
 *
 *   * `encrypted` — a handshake completed and every frame on this channel is sealed.
 *   * `plaintext` — no handshake was possible (no key for the peer, or the peer sent none), and the
 *     reason says which. This is the v0.5.x compatibility path, and it is recorded, never hidden.
 *   * `refused`  — a handshake was attempted and did not complete. `reason` is a
 *     `crypto.mjs` reason code. **No plaintext channel is handed back on this path**: §4's "never
 *     silently downgrading to plaintext" is enforced where the channel is created rather than left to
 *     a caller to remember.
 *
 * That last sentence used to be written as "there is no plaintext channel in this case", which is a
 * stronger claim than the code makes and was falsified by the v0.5.9 review: a `REFUSE(NO_PEER_KEY)`
 * that arrives from nowhere still *chose* the `plaintext` outcome (the branch below the refusal check),
 * so a punch ended as `ok: true` with a plaintext channel instead of `refused`. Which is why the
 * refusal is now guarded where it is read — see {@link REFUSE_GUARD} — and why `plaintext` carries
 * `refusal_authenticated` when a refusal is what chose it: the honest wording is "a *failed* handshake
 * never falls back into the clear", not "no datagram can make this a plaintext punch".
 *
 * @param {'encrypted'|'plaintext'|'refused'} status
 * @param {string|null} reason
 * @param {{session: object, isInitiator: boolean}|null} [established]
 * @returns {{status:string, reason:string|null, session:object|null, isInitiator:boolean}}
 */
function cryptoOutcome(status, reason, established = null) {
  return {
    status,
    reason,
    session: established === null ? null : established.session,
    isInitiator: established === null ? false : established.isInitiator === true,
  };
}

/**
 * The channel's view of a crypto outcome. `null` means plaintext, which is what every existing
 * caller of `P2PChannel` gets.
 *
 * @param {object|null} outcome
 * @param {object} [tuning]
 * @returns {{session:object, isInitiator:boolean, tuning:object}|null}
 */
function channelCrypto(outcome, tuning = {}) {
  if (outcome === null || outcome.status !== 'encrypted' || outcome.session === null) return null;
  return { session: outcome.session, isInitiator: outcome.isInitiator === true, tuning };
}

/**
 * What a `REFUSE` datagram must satisfy before it may change a punch's outcome — as a value, so the
 * contract cannot drift away from the code the way a comment can.
 *
 * `crypto.mjs` sends `REFUSE` with no proof in the one case where it has none to give: it is answering
 * a handshake it cannot verify, because it holds no key for that machine. That is honest, and it is
 * also a lever: any datagram of 13 bytes that reaches the dialling socket can claim to be that peer
 * refusing, and the naive reading of it turns "the handshake did not complete" (a named failure, the
 * relay fallback) into "the peer cannot take part" (a **plaintext channel**, and a ledger that says
 * the peer was the one who could not). MEDIUM-4 of the v0.5.9 review reproduced exactly that with a
 * third socket on loopback.
 *
 * So the refusal is honoured only when all of these hold, and the fourth narrows the one that
 * matters most:
 *
 *   1. **It names the session this punch agreed** — the frame header *and* the refusal body. A
 *      refusal for a punch we are not making cannot be about us.
 *   2. **It comes from an address this punch punched**: one of the candidates we sent `HELLO` to, or
 *      the address that has already answered. A refusal from a third address is not this peer's.
 *   3. **A seal never buys a downgrade it cannot prove.** A refusal that would choose a plaintext
 *      channel (`NO_KEY`, `NO_PEER_KEY`) is honoured when its `k_ref` seal verifies, or — for a peer too
 *      old to seal one — when it carries no seal at all *and* comes from the endpoint that answered the
 *      punch (condition 4). A **sealed** downgrade whose MAC does not verify is dropped: an honest peer
 *      either seals correctly or sends no MAC at all, so that datagram was assembled by somebody else.
 *   4. **An unsealed downgrade must be corroborated** by the same peer having acknowledged the punch.
 *      That branch does not fail the punch, it *downgrades* it, so it is the one place where a claim
 *      that cannot be checked has to come from the endpoint that actually answered. A *sealed*
 *      downgrade needs no corroboration: it is the peer.
 *
 * Every other (**terminal**) refusal is honoured from a dialled address whether or not it is sealed, and
 * `crypto.refusal_authenticated` says which it was: `true` (a seal that verified — proof), `null` (no
 * seal: the form an older build sends), `false` (a seal that did not verify). Dropping a terminal
 * refusal over a bad seal would buy nothing — an attacker forging one simply omits the seal — and would
 * cost the honest case its name: a peer whose record of *our* key is stale computes a `k_ref` we cannot
 * reproduce, and "your proof did not verify" is exactly what it is telling us.
 *
 * A datagram that fails 1, 2 or 3 is **dropped**, and the drop is recorded on the result in
 * `crypto.ignored_refusals` with a `reason_code` from `CRYPTO_REASON`. Dropped rather than reported as
 * a failure on purpose: if a forged refusal could fail the punch, injecting one would be a cheaper
 * denial of service than suppressing the real answer, and the honest peer would be failed for it.
 *
 * RESIDUAL, stated because the documents above quote it: an attacker who can put a datagram on the
 * wire *from the punched peer's address and port* (spoofing the source, so on-path or on the same
 * host as the punch) can still satisfy 1, 2 and 4 with an **unsealed** `NO_PEER_KEY` — the one form a
 * peer running an older build sends, and therefore the one form that cannot be required to carry a
 * seal. That attacker can force the recorded plaintext outcome; if the real peer answers first, an
 * injected terminal refusal can also force the relay fallback. What no longer works is a datagram
 * from anywhere else, one that names another session, a sealed downgrade that does not verify, or a
 * forced downgrade against a peer new enough to seal one — for those, `k_ref` cannot be forged by
 * anyone who does not hold the peer's static private key.
 */
export const REFUSE_GUARD = Object.freeze({
  requires: [
    'names the session this punch agreed (frame header and body)',
    'comes from an address this punch dialled, or from the peer that answered it',
    'a plaintext-choosing refusal is sealed with a k_ref MAC that verifies, or carries no seal at all',
    'an unsealed plaintext-choosing refusal (NO_KEY, NO_PEER_KEY) comes from the address that answered the punch',
  ],
  on_failure: 'the datagram is dropped and recorded in crypto.ignored_refusals; the punch outcome is unchanged',
  terminal_refusals:
    'honoured from a dialled address sealed or not; crypto.refusal_authenticated records true (seal verified), '
    + 'null (no seal) or false (a seal that did not verify), so a claim is never mistaken for proof',
  residual:
    'an attacker who can inject an unsealed refusal from the punched peer\'s own address and port can still '
    + 'force the recorded plaintext outcome, or the relay fallback with a terminal refusal; a sealed downgrade '
    + 'cannot be forged without the peer\'s static private key',
});

/**
 * A refusal frame, if this datagram is one. Extracted because three branches ask the same question.
 *
 * `key` is `k_ref` — the key this end derives from the handshake ephemeral (see `crypto.mjs`) — when a
 * handshake is in flight. It decides one thing only: whether the refusal's optional seal can be
 * checked. `authenticated` is deliberately three-valued — `true` (a seal was present and verified),
 * `false` (a seal was present and did *not* verify), `null` (no seal at all, which is what a peer too
 * old to seal one sends and which proves nothing).
 *
 * @param {{kind:number, session:number, body:Buffer}} parsed
 * @param {Buffer|null} [key] `k_ref` for this exchange, or null when no handshake is in flight.
 * @returns {{code:number, reason:string, session:number, machineId:string|null,
 *   authenticated:boolean|null}|null} The named reason, or null when this is not a refusal.
 */
function cryptoRefusalOf(parsed, key = null) {
  if (parsed.kind !== KIND.HELLO_ACK && parsed.kind !== KIND.HELLO) return null;
  const refuse = decodeRefuse(parsed.body);
  if (refuse === null) return null;
  let authenticated = null;
  if (refuse.mac !== null) authenticated = key === null ? false : verifyRefuseMac(key, parsed.body) === true;
  return {
    code: refuse.code,
    reason: REFUSE_REASON[refuse.code] ?? CRYPTO_REASON.REFUSED_BY_PEER,
    session: refuse.session,
    machineId: refuse.machineId,
    authenticated,
  };
}

/**
 * Why a refusal datagram was **ignored**, in the house `{reason_code, detail}` shape.
 *
 * Every one of these four is a refusal we declined to act on rather than a refusal that decided the
 * punch, which is why they are collected on the result (`crypto.ignored_refusals`) instead of being
 * raised as a failure: a datagram an attacker can forge must not be able to fail a punch either.
 * `detail` says what *would* have changed it, because "why did my punch still time out?" is the
 * question each of these exists to answer.
 *
 * @param {string} reasonCode One of `CRYPTO_REASON`'s four `REFUSE_*` codes.
 * @param {string} detail
 * @param {object} context
 * @param {{kind:number, session:number, body:Buffer}} context.parsed
 * @param {{address:string, port:number}} context.rinfo
 * @param {number} context.agreed The session this punch agreed.
 * @returns {{reason_code:string, detail:string, session:number, from:string, datagram_bytes:number}}
 */
function ignoredRefusal(reasonCode, detail, { parsed, rinfo, agreed }) {
  return {
    reason_code: reasonCode,
    detail,
    session: (parsed.session >>> 0),
    agreed_session: (agreed >>> 0),
    from: `${rinfo.address}:${rinfo.port}`,
    datagram_bytes: parsed.body.length + 5,
  };
}

/** Same remote endpoint? `null` on either side is "not the same". */
function sameEndpoint(a, b) {
  return a !== null && b !== null && a.address === b.address && a.port === b.port;
}

/**
 * Complete a handshake whose answer arrived *as a `HELLO`*: the simultaneous-punch case.
 *
 * When both ends dial at the same moment each one's `HELLO` reaches the other, and a `HELLO` carries
 * a fresh ephemeral exactly as an answer does. Rather than open a second session — two sessions for
 * one punch is the defect `punchSession` exists to prevent — this feeds that message through the
 * ordinary `finish()` verification, where the MAC decides whether it really is the peer.
 *
 * @param {{finish: Function}} handshake
 * @param {Buffer} body The received handshake body.
 * @returns {object|null} The established session, or null when it did not verify.
 */
function finishFromInitiatorMessage(handshake, body) {
  const finished = handshake.finish(body);
  return finished.ok ? { session: finished.session, isInitiator: true } : null;
}

/**
 * Try to open a bidirectional path to one of `remote`'s candidate addresses.
 *
 * Both peers run this at the same time. Each sends HELLO to every candidate; the
 * first peer to get through causes the other's NAT to accept, because the other's
 * outbound HELLO already opened its own mapping in that direction.
 *
 * v0.6.0 folds the handshake of `docs/P2P-CRYPTO.md` §4 into that same exchange rather than adding a
 * round trip: once the path answers, a one-message `HELLO` carrying `e_i` and a MAC over the static
 * keys goes out, the peer's `HELLO_ACK` carries `e_r`, and the session key comes out of the triple
 * DH. Three outcomes, and only the first hands back an encrypted channel:
 *
 *   * Both ends hold each other's key: the handshake completes and every frame is sealed.
 *   * This end holds no key for the peer (a v0.5.x peer, or one that never announced): a plain
 *     `HELLO` is sent and the channel is plaintext with `P2P_CRYPTO_NO_KEY` as the reason.
 *   * This end holds a key and the handshake fails: the punch reports `ok: false` with the peer's
 *     named reason, and no plaintext channel is handed back for that peer — but see
 *     {@link REFUSE_GUARD}: "the peer's named reason" is only acted on when the datagram carrying it
 *     can plausibly be the peer's, because `REFUSE` is unauthenticated by design. The caller falls
 *     back to the relay — §4's fallback clause — and the ledger records `p2p.encrypted: false` plus
 *     the reason.
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
 * @param {object} [options.crypto] `{deviceKey, peerKey, peerMachineId}` to attempt a handshake.
 *   Omitted, or with any field missing, means plaintext exactly as v0.5.x behaved.
 * @param {object} [options.cryptoTuning] Rekey thresholds and retention, for a test that cannot send
 *   2^20 messages.
 * @returns {Promise<{ok:boolean, peer:{address:string,port:number}|null, session:number,
 *                    attempts:number, rttMs:number|null, error:string|null,
 *                    crypto:{status:string, reason:string|null, session:object|null, isInitiator:boolean,
 *                            refusal_authenticated?:boolean|null, ignored_refusals?:object[]}}>}
 *   `crypto.ignored_refusals` is present only when at least one `REFUSE` datagram was dropped by
 *   {@link REFUSE_GUARD}; each entry is `{reason_code, detail, session, agreed_session, from,
 *   datagram_bytes}` (`datagram_bytes` is null for the one drop decided at outcome time, when the
 *   datagram is no longer at hand). `crypto.refusal_authenticated` is present only when a refusal
 *   decided the outcome: `true` for a seal that verified, `null` for the unsealed form an older build
 *   sends, `false` for a seal that did not verify.
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
    return {
      ok: false,
      peer: null,
      session: explicitSession ?? 0,
      attempts: 0,
      rttMs: null,
      error: 'P2P_NO_CANDIDATES',
      crypto: cryptoOutcome('plaintext', CRYPTO_REASON.PLAINTEXT_PEER),
    };
  }

  const ownSession = explicitSession ?? randomBytes(4).readUInt32BE(0);
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  const startedAt = process.hrtime.bigint();

  const hello = frame(KIND.HELLO, ownSession);
  /** The handshake, armed only when a key for the peer is actually in hand. */
  const request = options.crypto ?? null;
  const handshake =
    request?.deviceKey && request?.peerKey && typeof request?.peerMachineId === 'string'
      ? startHandshake({
        deviceKey: request.deviceKey,
        peerMachineId: request.peerMachineId,
        peerPublicKey: request.peerKey,
        session: ownSession,
      })
      : null;
  /**
   * `k_ref` for the peer being dialled, when a handshake is in flight: what a refusal MAC is checked
   * with. It comes from the handshake's own ephemeral (`ECDH(e_i, s_r)`), so it exists for every peer
   * whose `HELLO` reached us — including one that holds no key for us, which is the case that sends
   * the refusal MEDIUM-4 was about.
   */
  const refusalKey = handshake === null ? null : handshake.refusalMacKey;
  /**
   * Why there is no handshake, when there is none. `null` means one is in flight.
   *
   * v0.6.2: `request === null` is *this end's* decision, not a fact about the peer. `P2PNode.dial`
   * sends no crypto request in three situations and every one of them is local — this machine has no
   * device key, it holds no key for that peer, or it is dialling itself (a machine keeps no key for
   * itself, so its own `respondHandshake` would refuse it with `P2P_CRYPTO_UNKNOWN_PEER`).
   *
   * It used to report `PLAINTEXT_PEER` here, documented as "the peer never learned a key (an older
   * build)". Measured consequence: a dispatcher with an empty peer-key store reported every direct
   * channel as the peer being out of date, when both ends were the same build on the same host — an
   * encryption downgrade recorded as normal compatibility. `dial()`'s own comment has always claimed
   * the reason would be `NO_KEY`; this is that behaviour, and it is what the objective asks for: a
   * punch that did not encrypt says whether the cause was ours or theirs.
   *
   * `PLAINTEXT_PEER` keeps its real meaning and its real sites: a handshake *was* armed and the peer
   * answered in the clear, which is the only case where the peer is genuinely the reason.
   */
  const noCryptoReason = handshake !== null ? null : (options.cryptoBlockedReason ?? CRYPTO_REASON.NO_KEY);
  /** Whether this punch is trying to encrypt at all. */
  const wantCrypto = handshake !== null;

  return new Promise((resolve) => {
    let attempts = 0;
    let timer = null;
    let settled = false;
    let agreed = ownSession;
    /** The path is open: a plain HELLO_ACK arrived, or a HELLO did when we are the responder. */
    let punchedPeer = null;
    let punchedRtt = null;
    let punchAttempts = 0;
    /** Set when the handshake has definitively failed, so the punch says why instead of timing out. */
    let refused = null;
    /** Whether the refusal that set `refused` was `k0`-verified. See {@link REFUSE_GUARD}. */
    let refusedAuthenticated = null;
    /**
     * Set when the peer has told us it can only do plaintext (`REFUSE.NO_KEY`).
     *
     * Separate from `refused` on purpose, and the distinction is the whole of §4's fallback clause: a
     * refusal means "do not talk to me in the clear", a plaintext-only answer means "I cannot talk to
     * you any other way, and here is why". The first is a failure, the second is a recorded outcome.
     *
     * Carries the source it arrived from and whether it was authenticated, because a plaintext channel
     * is only handed back when the *same* endpoint that answered the punch is the one that asked for
     * it — see {@link REFUSE_GUARD} condition 4.
     */
    let plainOnly = null;
    /** Every `REFUSE` datagram dropped by {@link REFUSE_GUARD}, in `{reason_code, detail}` form. */
    const ignoredRefusals = [];
    /** One drop per un-corroborated plaintext refusal, however many times the outcome is asked for. */
    let plainOnlyDropRecorded = false;

    /** Is this datagram from an address this punch actually punched, or from the peer that answered it? */
    const isPunchedSource = (rinfo) =>
      sameEndpoint(punchedPeer, rinfo) ||
      remote.some((candidate) => candidate.address === rinfo.address && candidate.port === rinfo.port);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('message', onMessage);
      // The drops are attached here rather than threaded through every outcome, and only when there
      // were any: a punch nobody interfered with returns exactly the object it always did.
      resolve(
        ignoredRefusals.length === 0
          ? result
          : { ...result, crypto: { ...result.crypto, ignored_refusals: ignoredRefusals } },
      );
    };

    /** The path is open: report it with whatever the handshake managed to do. */
    const finishPunched = (outcome) => {
      finish({
        ok: true,
        peer: punchedPeer,
        session: agreed,
        attempts: punchAttempts,
        rttMs: punchedRtt,
        error: null,
        crypto: outcome,
      });
    };

    const notePeer = (rinfo) => {
      punchedPeer = { address: rinfo.address, port: rinfo.port };
      punchedRtt = Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 100) / 100;
      punchAttempts = attempts;
    };

    const onMessage = (datagram, rinfo) => {
      const parsed = parseFrame(datagram);
      if (!parsed) return;

      if (parsed.kind === KIND.HELLO) {
        const incoming = decodeHello(parsed.body);
        if (incoming !== null) {
          // A handshake HELLO. It answered the punch *and* asked for a session in one datagram.
          if (explicitSession !== undefined && parsed.session !== explicitSession) return;
          agreed = parsed.session;
          notePeer(rinfo);
          if (handshake !== null && incoming.machineId === request.peerMachineId) {
            const established = finishFromInitiatorMessage(handshake, parsed.body);
            if (established !== null) {
              finishPunched(cryptoOutcome('encrypted', null, established));
              return;
            }
            refused = CRYPTO_REASON.BAD_MAC;
            return;
          }
          // A handshake HELLO from a machine we have no key for. Answering it with a plain HELLO_ACK
          // is the one honest thing available: we cannot verify its MAC and it cannot verify ours.
          socket.send(frame(KIND.HELLO_ACK, agreed), rinfo.port, rinfo.address, () => {});
          if (!wantCrypto) finishPunched(cryptoOutcome('plaintext', noCryptoReason));
          return;
        }
        if (explicitSession !== undefined && parsed.session !== explicitSession) return;
        // Adopt the initiator's id when we have none of our own, and echo it back so
        // the initiator sees its own id and accepts the answer.
        agreed = parsed.session;
        socket.send(frame(KIND.HELLO_ACK, agreed), rinfo.port, rinfo.address, () => {});
        notePeer(rinfo);
        if (!wantCrypto) finishPunched(cryptoOutcome('plaintext', noCryptoReason));
        return;
      }

      if (parsed.kind === KIND.HELLO_ACK) {
        const refusal = cryptoRefusalOf(parsed, refusalKey);
        if (refusal !== null) {
          // ---- REFUSE_GUARD, conditions 1 and 2: this refusal has to be about *this* punch, from an
          // address this punch actually dialled. Both checks come before anything else reads the
          // datagram, and both are recorded rather than raised: see REFUSE_GUARD's `on_failure`.
          if (parsed.session !== agreed || refusal.session !== agreed) {
            ignoredRefusals.push(ignoredRefusal(
              CRYPTO_REASON.REFUSE_SESSION_MISMATCH,
              `the refusal named session ${refusal.session} in a frame for session ${parsed.session}; a refusal `
                + `that names the agreed session ${agreed} is honoured`,
              { parsed, rinfo, agreed },
            ));
            return;
          }
          if (!isPunchedSource(rinfo)) {
            ignoredRefusals.push(ignoredRefusal(
              CRYPTO_REASON.REFUSE_UNPUNCHED_SOURCE,
              `it arrived from ${rinfo.address}:${rinfo.port}, which is neither one of the ${remote.length} `
                + 'address(es) this punch dialled nor the peer that answered it; a refusal from one of those is '
                + 'honoured',
              { parsed, rinfo, agreed },
            ));
            return;
          }
          // ---- condition 3, first half: a MAC that was present and *wrong* buys nothing.
          //
          // It cannot be proof, and — for the one refusal that would choose a plaintext channel — it
          // must not even be a claim: `NO_KEY`/`NO_PEER_KEY` are the refusals a *legitimate* peer seals
          // with `k_ref` (it holds our `e_i` and its own `s_r`), so a sealed one that does not verify is
          // not a peer whose records disagree with ours; it is a datagram somebody assembled. Dropping
          // it costs an honest peer nothing, because an honest peer that cannot derive `k_ref` sends no
          // MAC at all, which is the claim path below.
          const wantsPlaintext = refusal.code === REFUSE.NO_KEY || refusal.code === REFUSE.NO_PEER_KEY;
          if (wantsPlaintext && refusal.authenticated === false) {
            ignoredRefusals.push(ignoredRefusal(
              CRYPTO_REASON.REFUSE_BAD_MAC,
              'it asked for a plaintext channel and carried a refusal MAC that did not verify; a refusal sealed '
                + 'with the key derived from the handshake ephemeral is honoured, and an older peer that sends no '
                + 'MAC at all is honoured from the address that answered the punch',
              { parsed, rinfo, agreed },
            ));
            return;
          }
          if (wantsPlaintext) {
            // The peer has a keypair of its own and none *for us*, and it said so instead of answering
            // in a way we would have to guess about. That is the plaintext-only case, not a failure:
            // §4's fallback clause is explicitly about not losing a machine to a security upgrade, and
            // this is the peer naming the upgrade it could not take part in. The plain acknowledgement
            // follows from the same responder, so the punch settles on that.
            //
            // This is also the one refusal that *chooses a plaintext channel* rather than failing the
            // punch, so it is the one held to REFUSE_GUARD's fourth condition, and that condition can
            // only be checked at outcome time: the refusal and the plain acknowledgement are two
            // datagrams, either may arrive first, and only once both have is there something to
            // corroborate. A refusal sealed with `k_ref` needs no corroboration — it is the peer.
            plainOnly = {
              reason: CRYPTO_REASON.NO_KEY,
              source: { address: rinfo.address, port: rinfo.port },
              authenticated: refusal.authenticated,
            };
            return;
          }
          // Any other refusal is final — `BAD_MAC` means the peer is known and its proof did not
          // verify, which is a stale key or an impersonation attempt, and neither is a reason to fall
          // back into the clear. Named, and never downgraded: this is the path where a channel is
          // deliberately not handed back at all. A failed MAC does not disqualify it, because it can
          // only ever fail a punch that was already failing, and an honest peer with a stale record of
          // *our* key is exactly the peer that sends one; `refusal_authenticated` says which it was.
          refused = refusal.reason;
          refusedAuthenticated = refusal.authenticated;
          finish({
            ok: false,
            peer: punchedPeer,
            session: agreed,
            attempts: punchAttempts,
            rttMs: punchedRtt,
            error: `${refusal.reason}: the peer refused the handshake`,
            crypto: {
              ...cryptoOutcome('refused', refusal.reason),
              refusal_authenticated: refusal.authenticated,
            },
          });
          return;
        }
        if (parsed.session !== agreed) return;
        notePeer(rinfo);
        const ack = decodeHello(parsed.body);
        if (ack === null) {
          // A plain HELLO_ACK: a v0.5.x peer, or a peer re-acknowledging a session it already holds a
          // channel for. Nothing to authenticate against, so the channel is plaintext by construction
          // and says so — but only once the handshake has had its chance to answer.
          //
          // `deferPlain` is not a grace period for its own sake. A responder answers the *first*
          // datagram of a punch, and a punch sends the plain HELLO (for the mapping, and for a v0.5.x
          // peer) before the handshake one; a responder that has not yet seen the handshake therefore
          // answers plainly, and settling on that answer would turn "your key did not verify" into a
          // silent plaintext channel — the exact outcome §4 forbids. Deferring costs one interval and
          // only happens on the punch where there was something to wait for.
          if (!wantCrypto) {
            finishPunched(plaintextOutcome() ?? cryptoOutcome('plaintext', noCryptoReason));
          } else deferPlain();
          return;
        }
        if (handshake === null) {
          finishPunched(cryptoOutcome('plaintext', CRYPTO_REASON.PLAINTEXT_PEER));
          return;
        }
        const finished = handshake.finish(parsed.body);
        if (finished.ok) {
          finishPunched(cryptoOutcome('encrypted', null, { session: finished.session, isInitiator: true }));
          return;
        }
        // The answer carried an unverifiable MAC. Recorded, and *not* retried: a peer whose mac does
        // not verify will not verify it on the third attempt either, and the deadline below turns this
        // into a named refusal rather than a punch timeout.
        refused = finished.reason;
        tick();
        return;
      }
    };

    /**
     * The plaintext outcome to settle on, or null when only a handshake will do.
     *
     * `plainOnly` is set when the *peer itself* said it could not take part (`REFUSE.NO_KEY`). That is
     * the one case where a plaintext channel is the documented outcome rather than a downgrade: the
     * peer told us which upgrade it could not make, and §4's fallback clause exists so that it does not
     * lose the machine. A peer we hold a key for and never hear a handshake from is a different fact —
     * `P2P_CRYPTO_HANDSHAKE_TIMEOUT` — and it falls back to the relay, which is what the contract says
     * a failed handshake does.
     *
     * It is also where REFUSE_GUARD's fourth condition is enforced, and it has to be *here* rather than
     * at the datagram: the refusal and the plain acknowledgement are two datagrams from the same
     * responder, either may arrive first, and only once both have is there something to corroborate.
     * A refusal that no acknowledgement from the same endpoint ever backs is not honoured — and, like
     * every other drop, it does not fail the punch; the punch keeps waiting and then reports the
     * timeout it honestly has.
     *
     * A refusal that *is* sealed with `k_ref` skips that condition entirely: it proves the sender holds
     * the static key we dialled, which is more than an acknowledgement from the same address could.
     */
    const plaintextOutcome = () => {
      if (plainOnly === null) return null;
      const corroborated = plainOnly.authenticated === true || sameEndpoint(punchedPeer, plainOnly.source);
      if (!corroborated) {
        if (!plainOnlyDropRecorded) {
          plainOnlyDropRecorded = true;
          ignoredRefusals.push({
            reason_code: CRYPTO_REASON.REFUSE_UNCORROBORATED,
            detail:
              `it asked for a plaintext channel from ${plainOnly.source.address}:${plainOnly.source.port}, and the `
              + 'peer that answered this punch is '
              + (punchedPeer === null ? 'nobody yet' : `${punchedPeer.address}:${punchedPeer.port}`)
              + '; the same refusal from the address that answered the punch is honoured',
            session: agreed >>> 0,
            agreed_session: agreed >>> 0,
            from: `${plainOnly.source.address}:${plainOnly.source.port}`,
            datagram_bytes: null,
          });
        }
        return null;
      }
      return {
        ...cryptoOutcome('plaintext', plainOnly.reason),
        refusal_authenticated: plainOnly.authenticated,
      };
    };
    /** Keep the handshake alive after a plain answer, rather than settling into the clear. */
    const deferPlain = () => {
      tick();
    };

    const tick = () => {
      if (settled) return;
      if (Date.now() >= deadline) {
        if (punchedPeer !== null && wantCrypto && refused === null) {
          const plaintext = plaintextOutcome();
          if (plaintext !== null) {
            finishPunched(plaintext);
            return;
          }
          // The path opened and the handshake did not finish: a named failure rather than a punch
          // timeout, because "the peer is unreachable" and "the peer would not authenticate" need
          // different responses from an operator — and because a silent plaintext channel here would be
          // a downgrade that a mismatched key could trigger.
          finish({
            ok: false,
            peer: punchedPeer,
            session: agreed,
            attempts: punchAttempts,
            rttMs: punchedRtt,
            error: `${CRYPTO_REASON.HANDSHAKE_TIMEOUT}: no HELLO_ACK within ${timeoutMs}ms`,
            crypto: cryptoOutcome('refused', CRYPTO_REASON.HANDSHAKE_TIMEOUT),
          });
          return;
        }
        if (refused !== null) {
          // The handshake failed and said why — from the peer's own refusal frame, or from a MAC that
          // did not verify. Reported at once and named, never downgraded to a plaintext channel: a
          // downgrade that a mismatched key can trigger is not encryption.
          //
          // `refusal_authenticated` travels with it because "the peer refused and proved it holds its
          // static key" and "somebody told us the peer refused" are different facts, and the ledger is
          // where that difference has to survive.
          finish({
            ok: false,
            peer: punchedPeer,
            session: agreed,
            attempts: punchAttempts,
            rttMs: punchedRtt,
            error: `${refused}: the handshake did not complete`,
            crypto: { ...cryptoOutcome('refused', refused), refusal_authenticated: refusedAuthenticated },
          });
          return;
        }
        if (punchedPeer !== null) {
          finishPunched(cryptoOutcome('plaintext', noCryptoReason));
          return;
        }
        finish({
          ok: false,
          peer: null,
          session: agreed,
          attempts,
          rttMs: null,
          error: `P2P_PUNCH_TIMEOUT: no answer from ${remote.length} candidate(s) in ${timeoutMs}ms`,
          crypto: cryptoOutcome('plaintext', noCryptoReason),
        });
        return;
      }
      attempts += 1;
      if (punchedPeer !== null && wantCrypto && refused === null) {
        // The path is open and the handshake is not: keep offering it to the address that answered,
        // on a short interval. Repeating the same bytes is what makes this safe — the peer re-sends
        // the identical `HELLO_ACK` for a repeat rather than treating it as a replay
        // (`crypto.mjs`'s `NonceCache`), so a lost answer costs one interval and never a session.
        socket.send(frame(KIND.HELLO, ownSession, handshake.body), punchedPeer.port, punchedPeer.address, () => {});
      } else if (refused === null) {
        // Still punching. **The handshake HELLO goes first**, and the order is load-bearing rather
        // than cosmetic: a responder answers the first datagram it sees, and a responder that holds no
        // key of its own would answer a plain HELLO with a plain acknowledgement — after which the
        // punch has an answer and the handshake arrives too late to be the one that decided. Sending
        // the handshake first means the *first* answer is the handshake's, and the plain HELLO that
        // follows is the mapping keep-alive (and the only thing a v0.5.x peer understands).
        for (const candidate of remote) {
          if (wantCrypto) {
            socket.send(frame(KIND.HELLO, ownSession, handshake.body), candidate.port, candidate.address, () => {});
          }
          socket.send(hello, candidate.port, candidate.address, () => {});
        }
      }
      timer = setTimeout(tick, punchedPeer === null ? intervalMs : Math.min(intervalMs, 100));
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
 *
 * v0.6.0: when `options.crypto` is given every frame on the channel is sealed with
 * ChaCha20-Poly1305 (`docs/P2P-CRYPTO.md` §4). The encryption lives in `sendFrame` and
 * `onDatagram` and nowhere else, so the reliable-channel logic above it — fragments, acknowledgements,
 * retransmission, assembly — is byte-for-byte the code it always was. Three properties are worth
 * stating because they are decisions rather than consequences:
 *
 *   * **Every kind is encrypted, not just DATA.** ACK, DONE, PING, PONG and BYE too. Encrypting only
 *     the payload would leave a plaintext BYE that an off-path attacker could forge to tear a session
 *     down, and would leak the message ids and fragment counts of everything else.
 *   * **A frame that does not authenticate is dropped, never processed** — and the reason is recorded
 *     in `crypto.failures`/`crypto.last_failure`, so "the peer is not who it said" is visible instead
 *     of looking like packet loss.
 *   * **The old epoch stays decryptable for a bounded window** (`crypto.mjs`), which is what keeps a
 *     rekey from losing a frame that was already in flight.
 *
 * Receiver-side duplicate suppression (the P2 F2 follow-up) is separate from all of that and changes
 * no wire format: a fragment carrying a message id this channel has already delivered is acknowledged
 * — the sender may still be waiting on a lost ACK — and then dropped without touching the in-flight
 * `incoming` map. `incoming` entries that stop making progress are swept after a TTL, so a fragmented
 * message whose tail never arrives cannot occupy memory forever. Both the memory and the TTL are
 * bounded and configurable (`recentMessageLimit`, `recentMessageTtlMs`), and both are receive-side
 * only: ACK/DONE/BYE semantics and the framing are exactly what they were.
 */
export class P2PChannel extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('node:dgram').Socket} options.socket
   * @param {{address:string, port:number}} options.peer
   * @param {number} options.session
   * @param {object} [options.tuning]
   * @param {{session: object, isInitiator: boolean, tuning?: object}|null} [options.crypto]
   *   An established session from `punch()`/`accept()`. Omitted means plaintext.
   * @param {number} [options.recentMessageLimit=1024] How many completed message ids to remember
   *   for duplicate suppression. `0` disables the memory. See {@link DEFAULT_RECENT_MESSAGE_LIMIT}.
   * @param {number} [options.recentMessageTtlMs=60000] How long a completed message id is remembered
   *   and how long an incomplete reassembly may go without a new fragment before it is swept. See
   *   {@link DEFAULT_RECENT_MESSAGE_TTL_MS}.
   */
  constructor(options) {
    super();
    this.socket = options.socket;
    this.peer = options.peer;
    this.session = options.session;
    this.tuning = {
      window: options.tuning?.window ?? DEFAULT_WINDOW,
      maxWindow: options.tuning?.maxWindow ?? 256,
      rtoMs: options.tuning?.rtoMs ?? DEFAULT_RTO_MS,
      maxAttempts: options.tuning?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    };
    /**
     * How many recently completed message ids the channel remembers, and for how long.
     *
     * Bounded, independent options rather than fields of `tuning`: `tuning` is the send-side
     * retransmission contract the two ends should agree about, while these are pure receiver state
     * — a peer cannot observe them, and changing them cannot change the wire format.
     *
     * @type {number}
     */
    this.recentMessageLimit = options.recentMessageLimit ?? DEFAULT_RECENT_MESSAGE_LIMIT;
    /** @type {number} */
    this.recentMessageTtlMs = options.recentMessageTtlMs ?? DEFAULT_RECENT_MESSAGE_TTL_MS;
    if (!Number.isInteger(this.recentMessageLimit) || this.recentMessageLimit < 0) {
      throw new TypeError(
        `recentMessageLimit must be a non-negative integer, got ${JSON.stringify(this.recentMessageLimit)}`,
      );
    }
    if (!Number.isFinite(this.recentMessageTtlMs) || this.recentMessageTtlMs <= 0) {
      throw new TypeError(
        `recentMessageTtlMs must be a positive finite number, got ${JSON.stringify(this.recentMessageTtlMs)}`,
      );
    }
    /** Adaptive send window: starts at the tuning value, grows on completed messages. */
    this.window = this.tuning.window;
    /** RTT/RTO measured from ACK arrival, instead of the fixed 300 ms default. */
    this.rtt = new RttEstimator({ initialRtoMs: this.tuning.rtoMs, maxRtoMs: MAX_RTO_MS });

    const crypto = options.crypto ?? null;
    /** @type {CryptoSession|null} */
    this.cryptoSession = crypto === null ? null : crypto.session;
    /** @type {boolean} Which direction this channel's send counter and key belong to. */
    this.cryptoInitiator = crypto !== null && crypto.isInitiator === true;
    /**
     * What this channel's encryption actually is, for the ledger and for `w2m_status`.
     *
     * `encrypted` is a statement about *this* channel, not about the configuration: a plaintext
     * channel is one where no handshake completed, and `reason` always says why.
     *
     * @type {{encrypted:boolean, reason:string|null, epoch:number, sent:number, received:number,
     *   dropped:number, last_failure:string|null, replays_refused:number}}
     */
    this.encryption = {
      encrypted: this.cryptoSession !== null,
      reason: this.cryptoSession === null ? CRYPTO_REASON.PLAINTEXT_PEER : null,
      epoch: 0,
      sent: 0,
      received: 0,
      dropped: 0,
      replays_refused: 0,
      last_failure: null,
    };

    /**
     * messageId -> `{fragments: Buffer[], received: Set<number>, total: number, lastSeenAtMs: number}`.
     *
     * `lastSeenAtMs` advances only when a fragment that was *not* already stored arrives, i.e. when
     * the assembly actually made progress; a peer that keeps re-sending one fragment cannot keep a
     * stalled assembly alive past the TTL.
     */
    this.incoming = new Map();
    /** messageId -> {fragments: Buffer[], acked: Set<number>, resolve, reject, attempts: Map} */
    this.outgoing = new Map();
    /**
     * Message ids already delivered on this channel, oldest completion first.
     *
     * A fragment for a remembered id is a duplicate: it is acknowledged (the sender may still be
     * waiting on a lost ACK) and dropped, never assembled again. Bounded by `recentMessageLimit` with
     * the oldest record evicted first, and each record expires `recentMessageTtlMs` after completion.
     *
     * @type {Map<number, {at:number, deduped:boolean}>}
     */
    this.completed = new Map();
    /**
     * Receiver-side duplicate-suppression counters. Receive-only: nothing here changes what goes on
     * the wire, so a peer that does not have this build is unaffected.
     *
     *   * `duplicateFragmentsDropped` — DATA fragments for an already-completed message id that were
     *     acknowledged and discarded instead of assembled and delivered again.
     *   * `messagesDeduped` — completed messages that had at least one such fragment (counted once per
     *     completion record, so it is "messages saved from re-delivery", not "duplicates seen").
     *   * `staleAssembliesSwept` — partial reassemblies abandoned by the stale-assembly TTL sweep.
     *
     * @type {{duplicateFragmentsDropped:number, messagesDeduped:number, staleAssembliesSwept:number}}
     */
    this.stats = { duplicateFragmentsDropped: 0, messagesDeduped: 0, staleAssembliesSwept: 0 };
    /** Clock time the next opportunistic sweep is allowed; batching keeps a busy `onData` cheap. */
    this.nextSweepAtMs = 0;
    /** Sweep cadence derived from the TTL: often enough to be prompt, rare enough to be free. */
    this.sweepIntervalMs = Math.max(
      SWEEP_INTERVAL_MIN_MS,
      Math.min(SWEEP_INTERVAL_MAX_MS, Math.floor(this.recentMessageTtlMs / 2)),
    );
    /**
     * Low-frequency stale-reassembly timer.
     *
     * It exists because the entries that need sweeping are exactly the ones that produce no further
     * activity: an assembly abandoned by a peer that vanished would otherwise sit in `incoming`
     * forever. `unref()` so a quiet receiver does not hold the process open, and `close()` clears it,
     * so a channel that ended leaves no timer behind.
     */
    this.sweepTimer = setInterval(() => this.sweepStaleAssemblies(), this.sweepIntervalMs);
    this.sweepTimer.unref?.();
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

    let body = parsed.body;
    if (this.cryptoSession !== null) {
      // A handshake message on an encrypted session is not data: it is an attacker (or a confused
      // peer) trying to slip a plaintext frame past the seal. Refused by name.
      if (decodeHello(body) !== null || decodeRefuse(body) !== null) {
        this.noteCryptoFailure(CRYPTO_REASON.AUTH_FAILED);
        return;
      }
      const opened = this.cryptoSession.decrypt(this.cryptoInitiator, datagram);
      if (!opened.ok) {
        this.noteCryptoFailure(opened.reason);
        return;
      }
      body = opened.plaintext;
      this.encryption.received = this.cryptoSession.stats.received;
      this.encryption.epoch = this.cryptoSession.sendEpoch;
      this.encryption.replays_refused = this.cryptoSession.stats.replay_refusals;
    }

    if (parsed.kind === KIND.DATA) this.onData(body);
    else if (parsed.kind === KIND.ACK) this.onAck(body);
    // A PING must be answered with PONG, never with PING. Echoing the same kind back
    // makes two peers bounce it between them forever, and the loop looks like healthy
    // traffic while it saturates the mapping it was meant to keep alive.
    else if (parsed.kind === KIND.PING) this.sendFrame(KIND.PONG, Buffer.alloc(0));
    else if (parsed.kind === KIND.PONG) this.lastPongAtMs = Date.now();
    else if (parsed.kind === KIND.BYE) this.close('peer-closed');
  }

  /**
   * Record a frame that did not authenticate, and emit `'crypto'` so a caller can log it.
   *
   * A dropped frame is not an error in the channel's sense — the channel is fine, the *frame* was
   * not — so it deliberately does not go through `'error'` (which `P2PNode` reports as a transport
   * failure). It is not silent either: the counters are in `channel.encryption` and the event names
   * the reason.
   *
   * @param {string} reason
   */
  noteCryptoFailure(reason) {
    this.encryption.dropped += 1;
    this.encryption.last_failure = reason;
    this.emit('crypto', { reason, dropped: this.encryption.dropped });
  }

  /**
   * Seal this channel with a session that completed *after* the channel was created (v0.6.0).
   *
   * The one caller is `P2PNode.applyCryptoUpgrade`, and the case it serves is the simultaneous punch:
   * the punch resolves first and builds a plaintext channel, then the handshake HELLO for the same
   * session arrives and completes. Replacing the channel instead would tear down a live, claimed
   * channel that listeners are already attached to; attaching keys changes only what the next frame is
   * sealed with, and every frame sent before this point was plaintext at both ends.
   *
   * Refuses once this channel is already encrypted: a second session would mean two key sets for one
   * session, and the safe answer there is to keep the one that is working.
   *
   * @param {object} session A `CryptoSession` from `crypto.mjs`.
   * @param {boolean} isInitiator Which direction this end's keys belong to.
   * @returns {boolean} Whether the channel is encrypted as a result.
   */
  attachCrypto(session, isInitiator) {
    if (this.closed) return false;
    if (this.cryptoSession !== null) return true;
    if (session === null || typeof session !== 'object') return false;
    this.cryptoSession = session;
    this.cryptoInitiator = isInitiator === true;
    this.encryption.encrypted = true;
    this.encryption.reason = null;
    return true;
  }

  /** @param {Buffer} body */
  onData(body) {
    if (body.length < 12) return;
    const messageId = body.readUInt32BE(0);
    const index = body.readUInt32BE(4);
    const total = body.readUInt32BE(8);
    if (total === 0 || total > 100000 || index >= total) return;
    const payload = body.subarray(12);
    const now = Date.now();
    if (now >= this.nextSweepAtMs) this.sweepStaleAssemblies(now);

    // A fragment carrying a message id this channel has already delivered is a duplicate, and not
    // of the in-flight kind: `incoming` was deleted when the message was assembled, so without this
    // check the fragment is treated as the first fragment of a brand-new message and the payload is
    // delivered a second time (a duplicate of the *final* fragment additionally leaves a permanently
    // incomplete entry behind). Drop it before it can touch `incoming`, but still acknowledge it:
    // the duplicate may be a retransmission whose ACK was lost, and staying silent would make the
    // sender spend its whole attempt budget and fail a send that actually succeeded.
    if (this.isRecentlyCompleted(messageId, now)) {
      const record = this.completed.get(messageId);
      this.stats.duplicateFragmentsDropped += 1;
      if (record !== undefined && record.deduped !== true) {
        record.deduped = true;
        this.stats.messagesDeduped += 1;
      }
      this.ackFragment(messageId, index);
      return;
    }

    let entry = this.incoming.get(messageId);
    if (entry !== undefined && now - entry.lastSeenAtMs > this.recentMessageTtlMs) {
      // The TTL is enforced at lookup time as well as by the periodic sweep: an assembly that has
      // gone quiet for longer than the TTL is stale even if the timer has not reached it yet, so a
      // late fragment starts a fresh assembly instead of resurrecting the expired one.
      this.incoming.delete(messageId);
      this.stats.staleAssembliesSwept += 1;
      entry = undefined;
    }
    if (!entry) {
      entry = { fragments: new Array(total).fill(null), received: new Set(), total, lastSeenAtMs: now };
      this.incoming.set(messageId, entry);
    }
    if (!entry.received.has(index)) {
      entry.fragments[index] = Buffer.from(payload);
      entry.received.add(index);
      // Progress, not mere traffic: a duplicate does not keep a stalled assembly alive (see the
      // `incoming` doc comment).
      entry.lastSeenAtMs = now;
    }

    // Acknowledge every fragment, including in-flight duplicates: a duplicate means our ACK
    // was lost, and re-acking is cheaper than a retransmit storm.
    this.ackFragment(messageId, index);

    if (entry.received.size === entry.total) {
      this.incoming.delete(messageId);
      // Remember the completion before emitting, so a listener that synchronously provokes another
      // datagram (or a duplicate that is already queued) cannot re-assemble the message.
      this.rememberCompleted(messageId, now);
      const assembled = Buffer.concat(entry.fragments, entry.fragments.reduce((n, f) => n + f.length, 0));
      const doneBody = Buffer.alloc(4);
      doneBody.writeUInt32BE(messageId, 0);
      this.sendFrame(KIND.DONE, doneBody);
      this.emit('message', assembled);
    }
  }

  /**
   * Send the ACK for one fragment.
   *
   * Every valid DATA fragment is acknowledged, including in-flight duplicates and fragments of a
   * message that already completed: an ACK is a statement that the fragment arrived, and withholding
   * it is exactly what turns a lost ACK into a retransmission storm ending in a false
   * `P2P_FRAGMENT_UNACKED`. Extracted so the duplicate-suppression branch and the assembly path
   * cannot drift apart.
   *
   * @param {number} messageId
   * @param {number} index
   */
  ackFragment(messageId, index) {
    const ackBody = Buffer.alloc(8);
    ackBody.writeUInt32BE(messageId, 0);
    ackBody.writeUInt32BE(index, 4);
    this.sendFrame(KIND.ACK, ackBody);
  }

  /**
   * Has this channel already delivered `messageId`, recently enough to suppress a duplicate?
   *
   * The TTL is applied at lookup time as well as in the sweep, so an expired record is never
   * reported as completed even when the sweep has not run yet.
   *
   * @param {number} messageId
   * @param {number} now
   * @returns {boolean}
   */
  isRecentlyCompleted(messageId, now) {
    const record = this.completed.get(messageId);
    if (record === undefined) return false;
    if (now - record.at > this.recentMessageTtlMs) {
      this.completed.delete(messageId);
      return false;
    }
    return true;
  }

  /**
   * Remember a completed message id, evicting the oldest completion when the bound is reached.
   *
   * `recentMessageLimit === 0` means "remember nothing": duplicates are re-assembled instead of
   * suppressed, and the memory stays empty. Every other value keeps the map at or below that size.
   *
   * @param {number} messageId
   * @param {number} now
   */
  rememberCompleted(messageId, now) {
    if (this.recentMessageLimit === 0) return;
    // Delete before set so a re-completed id becomes the newest record rather than keeping its old
    // position; with monotonic message ids this is defensive, not load-bearing.
    this.completed.delete(messageId);
    this.completed.set(messageId, { at: now, deduped: false });
    while (this.completed.size > this.recentMessageLimit) {
      this.completed.delete(this.completed.keys().next().value);
    }
  }

  /**
   * Drop what has expired: completed ids older than the TTL, and reassemblies that stopped making
   * progress more than a TTL ago.
   *
   * Called from the low-frequency timer and opportunistically from `onData` (at most once per
   * `sweepIntervalMs`, never more than one clock read per datagram because `now` is passed in).
   * Synchronous and exception-free by construction: an interval callback must not throw.
   *
   * The completed map is iterated in completion order and the scan stops at the first record that is
   * still live; expired records are always at the front, so the cost is proportional to what is
   * actually removed. The incoming map is scanned whole and entries are only ever removed, never
   * resurrected: a late fragment after a sweep starts a *fresh* assembly, and only if the message id
   * is not in `completed`. The same expiry is applied on lookup in `onData`, so the TTL boundary does
   * not depend on the timer's phase.
   *
   * @param {number} [now]
   */
  sweepStaleAssemblies(now = Date.now()) {
    this.nextSweepAtMs = now + this.sweepIntervalMs;
    for (const [messageId, record] of this.completed) {
      if (now - record.at <= this.recentMessageTtlMs) break;
      this.completed.delete(messageId);
    }
    for (const [messageId, entry] of this.incoming) {
      if (now - entry.lastSeenAtMs <= this.recentMessageTtlMs) continue;
      this.incoming.delete(messageId);
      this.stats.staleAssembliesSwept += 1;
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
    entry.inFlight.delete(index);
    // Karn: a fragment that was retransmitted has an ambiguous RTT, so only the
    // first transmission is sampled.
    if (entry.sentAt.has(index) && !entry.retransmitted.has(index)) {
      this.rtt.sample(Date.now() - entry.sentAt.get(index));
      entry.sentAt.delete(index);
    }
    if (entry.acked.size === entry.fragments.length) {
      this.outgoing.delete(messageId);
      clearTimeout(entry.timer);
      // A completed message is the only honest RTT-free signal that the path holds more
      // than the previous window: grow conservatively, and halve on a retransmit timeout.
      this.window = Math.min(this.tuning.maxWindow, this.window + Math.max(1, Math.floor(this.window / 8)));
      entry.resolve();
      return;
    }
    // ACK-driven progress: the next window leaves as soon as a slot frees, instead of
    // waiting for the RTO timer (the 0.12 MiB/s ceiling).
    if (entry.pump !== null) entry.pump();
  }

  /**
   * Send one frame, sealed when the channel has a session.
   *
   * The encryption is here and in `onDatagram`, nowhere else, which is what keeps the reliable
   * channel's logic unchanged by this work: an ACK, a retransmit and a BYE are all just frames.
   *
   * @param {number} kind
   * @param {Buffer} body
   */
  sendFrame(kind, body) {
    if (this.closed) return;
    const plain = frame(kind, this.session, body);
    const datagram = this.cryptoSession === null ? plain : this.cryptoSession.encrypt(this.cryptoInitiator, plain);
    if (this.cryptoSession !== null) {
      this.encryption.sent = this.cryptoSession.stats.sent;
      this.encryption.epoch = this.cryptoSession.sendEpoch;
    }
    this.socket.send(datagram, this.peer.port, this.peer.address, () => {});
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
        inFlight: new Set(),
        sentAt: new Map(),
        retransmitted: new Set(),
        pump: null,
        resolve,
        reject,
        attempts: new Map(),
      };
      this.outgoing.set(messageId, entry);

      const pump = () => {
        if (this.closed) return;
        // Send only what the current window has room for. inFlight is the honest
        // count of fragments the peer has not acknowledged yet; re-sending those
        // is the timer's job, not pump's.
        let budget = Math.max(1, this.window - entry.inFlight.size);
        for (let i = 0; i < fragments.length && budget > 0; i += 1) {
          if (entry.acked.has(i) || entry.inFlight.has(i)) continue;
          const attempt = (entry.attempts.get(i) ?? 0) + 1;
          entry.attempts.set(i, attempt);
          if (attempt > this.tuning.maxAttempts) {
            this.outgoing.delete(messageId);
            clearTimeout(entry.timer);
            this.window = Math.max(8, Math.floor(this.window / 2));
            reject(
              new Error(
                `P2P_FRAGMENT_UNACKED: fragment ${i}/${fragments.length} of message ${messageId} ` +
                  `after ${this.tuning.maxAttempts} attempts`,
              ),
            );
            return;
          }
          entry.inFlight.add(i);
          if (!entry.sentAt.has(i)) entry.sentAt.set(i, Date.now());
          budget -= 1;
          const body = Buffer.alloc(12 + fragments[i].length);
          body.writeUInt32BE(messageId, 0);
          body.writeUInt32BE(i, 4);
          body.writeUInt32BE(fragments.length, 8);
          fragments[i].copy(body, 12);
          this.sendFrame(KIND.DATA, body);
        }

        if (entry.inFlight.size === 0) return;
        const worst = Math.max(...[...entry.inFlight].map((i) => entry.attempts.get(i) ?? 1));
        const delay = Math.min(this.rtt.rtoMs * 2 ** (worst - 1), MAX_RTO_MS);
        // One timer per message, not one per channel: a shared field means a second
        // concurrent send silently cancels the first one's retransmission schedule.
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          if (!this.outgoing.has(messageId)) return;
          // Retransmit the fragments that are still unacknowledged, then schedule again.
          for (const i of entry.inFlight) {
            entry.retransmitted.add(i);
            const attempt = (entry.attempts.get(i) ?? 0) + 1;
            entry.attempts.set(i, attempt);
            if (attempt > this.tuning.maxAttempts) {
              this.outgoing.delete(messageId);
              this.window = Math.max(8, Math.floor(this.window / 2));
              reject(
                new Error(
                  `P2P_FRAGMENT_UNACKED: fragment ${i}/${fragments.length} of message ${messageId} ` +
                    `after ${this.tuning.maxAttempts} attempts`,
                ),
              );
              return;
            }
            const body = Buffer.alloc(12 + fragments[i].length);
            body.writeUInt32BE(messageId, 0);
            body.writeUInt32BE(i, 4);
            body.writeUInt32BE(fragments.length, 8);
            fragments[i].copy(body, 12);
            this.sendFrame(KIND.DATA, body);
          }
          pump();
        }, delay);
        entry.timer.unref?.();
      };
      entry.pump = pump;

      pump();
    });
  }

  /**
   * Stop the channel. The socket is NOT closed: the caller owns it.
   *
   * @param {string} [reason] Reported on the `'close'` event and in the rejection of every pending
   *   send.
   * @param {{silent?: boolean}} [options] `silent: true` drops this channel **without telling the
   *   peer**, which is what discarding a *duplicate local view* of a live session requires. A punch
   *   can produce two channel objects for one session (both ends dialled, and the accept loop answered
   *   while the punch was still in flight); keeping the observed-address one and closing the other is
   *   right, but a BYE there would tell the peer a session that is very much alive was over, and would
   *   tear down the channel the survivor is about to use.
   */
  close(reason = 'closed', options = {}) {
    if (this.closed) return;
    // The BYE goes out BEFORE `closed` is set, and that ordering is the whole fix. `sendFrame`
    // refuses to send once the channel is closed -- a guard that is right for retransmissions and was
    // silently wrong for the goodbye: with `closed` set first, the BYE below could never leave, so the
    // peer was never told the path was over and kept writing into a channel nothing was listening on.
    // Measured, on the path this release is about: a dispatcher's `pushOffer` closes the channel it
    // pushed the offer over, and without the BYE the executor's side still looked live for the whole
    // task, so its result was sent into that dead channel and only fell back to the relay after eight
    // unacknowledged fragments (`P2P_FRAGMENT_UNACKED`) -- the "result came back relay" half of the
    // failure, with no reverse dial attempted because a channel appeared to exist.
    if (reason !== 'peer-closed' && options.silent !== true) {
      try {
        this.sendFrame(KIND.BYE, Buffer.alloc(0));
      } catch {
        /* the path is already gone */
      }
    }
    this.closed = true;
    // The stale-assembly timer is receiver state, not transport state: it must die with the channel
    // or a closed channel would leave a repeating (if unref()ed) callback behind. The counter is
    // set to `null` rather than left holding a cleared handle so "was the timer cleared?" is
    // observable instead of inferred.
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.socket.removeListener('message', this.onDatagram);
    for (const entry of this.outgoing.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`P2P_CHANNEL_CLOSED: ${reason}`));
    }
    this.outgoing.clear();
    this.incoming.clear();
    this.completed.clear();
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
 * v0.6.0 adds the responder's half of the handshake. A `HELLO` whose body is a handshake message is
 * verified against the initiator's static key, answered with a `HELLO_ACK` carrying `e_r`, and turned
 * into a session; one whose body is empty is the v0.5.x punch and is answered exactly as before. When
 * a handshake arrives for a machine we hold no key for, the answer is an unauthenticated named
 * `REFUSE` — we cannot verify anything it says and we will not guess — and the punch itself is still
 * acknowledged so a plaintext channel can be formed. A handshake that arrives with a key we *do* hold
 * and fails its MAC gets a `REFUSE` naming that, and no channel at all.
 *
 * @param {object} options
 * @param {import('node:dgram').Socket} options.socket Already bound; the same socket the
 *        punch was aimed at, and the same one a channel will use.
 * @param {number} [options.timeoutMs] How long to wait before giving up.
 * @param {Set<number>|Map<number, unknown>} [options.claimed] Sessions that already have
 *        a live channel. Read, never written.
 * @param {boolean} [options.unrefWait] Do not let the wait itself hold the process open. Off by
 *        default: an awaited operation is normally exactly the thing that should keep a process
 *        alive. On for a node that was asked to be unreferenced (`P2PNode.unref()`), where this
 *        timer would otherwise be the last referenced handle and the process could never exit.
 * @param {number} [options.intervalMs] Floor between re-acknowledgements of the same
 *        claimed session within one call, so a peer that sprays HELLOs cannot make the
 *        responder answer every single one. The default matches `punch()`'s send
 *        interval, so a retransmission is always answered; `0` disables the floor.
 * @param {object} [options.crypto] `{deviceKey, peerKeys, seen}` to answer handshakes. Without it
 *        this function is exactly v0.5.x: every `HELLO` is answered plainly.
 * @param {object} [options.cryptoTuning] Rekey thresholds and retention; see `crypto.mjs`.
 * @returns {Promise<{ok:boolean, channel:P2PChannel|null, peer:{address:string,port:number}|null,
 *                    session:number, rttMs:number|null, error:string|null, machineId:string|null,
 *                    crypto:{status:string, reason:string|null, session:object|null, isInitiator:boolean,
 *                            refusal_authenticated?:boolean}}>}
 *   `machineId` is the handshake's *verified* claim about who dialled, or null for a plain punch
 *   (which carries no identity at all — see `P2PNode`'s note on why it refuses to guess one).
 *   `crypto.refusal_authenticated` is present only on a refused outcome, and is the *sender's* view of
 *   {@link REFUSE_GUARD}'s third condition: whether the refusal this end sent carried a `k_ref` seal.
 */
export async function accept(options) {
  const { socket } = options;
  if (!socket) throw new TypeError('accept: a bound UDP socket is required');

  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 250;
  const claimed = options.claimed ?? null;
  const crypto = options.crypto ?? null;
  const unrefWait = options.unrefWait === true;

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
        machineId: null,
        crypto: cryptoOutcome('plaintext', CRYPTO_REASON.PLAINTEXT_PEER),
      });
    }, timeoutMs);

    // See `options.unrefWait`: a node that was asked not to hold the process open must not hold it
    // open through the accept loop's own timeout, which is the handle that is pending almost all of
    // the time in a node that is simply waiting for a punch.
    if (unrefWait) timer.unref?.();

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
        machineId: null,
        crypto: cryptoOutcome('plaintext', CRYPTO_REASON.PLAINTEXT_PEER),
      });
    };

    const onMessage = (datagram, rinfo) => {
      const parsed = parseFrame(datagram);
      // Only a HELLO is this function's business. DATA/ACK/PING/PONG belong to whichever
      // channels are already listening; a second consumer of them would be a second
      // delivery, which is the bug the `claimed` set exists to prevent.
      if (!parsed || parsed.kind !== KIND.HELLO) return;
      const session = parsed.session;
      const handshakeMessage = decodeHello(parsed.body);

      if (claimed !== null && claimed.has(session)) {
        const now = Date.now();
        const last = reackedAt.get(session) ?? Number.NEGATIVE_INFINITY;
        // The interval floor applies to a *plain* re-acknowledgement only, which is what it was written
        // for: a peer retransmitting its punch HELLO must not draw an answer to every datagram. A
        // handshake message is different — it is the initiator asking for a session, it arrives once
        // per attempt, and suppressing its answer because a plain HELLO for the same session landed
        // milliseconds earlier is a *stall*, not a saving: the initiator waits out its whole timeout,
        // and what it reports is a timeout instead of the key it could not verify.
        const isHandshake = handshakeMessage !== null && crypto !== null;
        if (isHandshake || now - last >= intervalMs) {
          reackedAt.set(session, now);
          // A plain re-acknowledgement answers with an EMPTY body, and that empty body *is* the answer:
          // sending nothing because it "has no content" was the bug that made a repeated HELLO look
          // like an unreachable peer.
          let reply = Buffer.alloc(0);
          let upgraded = null;
          if (isHandshake) {
            const answer = answerHandshake({ crypto, body: parsed.body });
            // `refuse` as well as `body`: a handshake that failed for a *claimed* session still gets a
            // named answer, because the alternative is the initiator waiting out its whole timeout and
            // reporting `P2P_CRYPTO_HANDSHAKE_TIMEOUT` when the truth is `P2P_CRYPTO_BAD_MAC`. An
            // earlier version sent only `body`, so every refusal on this path was silent — the one
            // outcome §4 says must never be silent.
            reply = answer.body ?? answer.refuse ?? Buffer.alloc(0);
            if (answer.ok && answer.established !== null) upgraded = answer;
          }
          socket.send(frame(KIND.HELLO_ACK, session, reply), rinfo.port, rinfo.address, () => {});
          // The other half of the simultaneous punch, and the reason `upgrade` exists. A channel for
          // `session` is already live here — `dial()` opened it, or an earlier `accept()` did — and the
          // peer has now asked for a handshake on that same session. The handshake is *completed*
          // above, so the peer gets its answer, but the live channel is still plaintext; returning it
          // as-is would leave the two ends disagreeing about whether the session is encrypted, so
          // every frame would fail its tag and the task would fall back to the relay for a reason
          // nothing recorded. The established session is handed back for the *caller* to attach to the
          // channel it already owns: `accept()` does not own channels and will not reach into one.
          if (upgraded !== null) {
            finish({
              ok: false,
              channel: null,
              peer: { address: rinfo.address, port: rinfo.port },
              session,
              rttMs: null,
              error: 'P2P_CRYPTO_UPGRADE: the handshake completed for a session that was already claimed',
              machineId: upgraded.machineId ?? null,
              crypto: cryptoOutcome('encrypted', null, upgraded.established),
              upgrade: {
                session,
                session_crypto: upgraded.established.session,
                isInitiator: upgraded.established.isInitiator === true,
                machineId: upgraded.machineId ?? null,
              },
            });
            return;
          }
        }
        return;
      }

      /** A refusal to send *instead of* an acknowledgement: no channel exists in that case. */
      let outcome = cryptoOutcome('plaintext', CRYPTO_REASON.PLAINTEXT_PEER);
      let ackBody = Buffer.alloc(0);
      let machineId = null;
      /** Set when the handshake cannot be verified, so the peer is told why in a named refusal. */
      let refusal = null;
      /**
       * The exact refusal bytes the crypto layer produced, when it produced any.
       *
       * They are forwarded rather than rebuilt, because rebuilding them here silently threw away the
       * responder's machine id and — since v0.6.0 — the `k0` MAC that makes `BAD_MAC` a statement only
       * the holder of `s_r` can make. The initiator treats a MAC'd refusal as proof and a bare one as a
       * claim (`REFUSE_GUARD`), so losing the MAC here would quietly downgrade every terminal refusal
       * back to "somebody said so".
       */
      let refusalBytes = null;
      /** Whether the refusal this end sent carried a `k_ref` seal. False when it has no key material. */
      let refusalSealed = false;

      if (handshakeMessage !== null) {
        if (crypto === null) {
          // No key material on this machine at all. The punch is still answered — refusing *that*
          // would turn "this build has no keys" into "this machine is unreachable", which is exactly
          // the fleet-losing outcome §4 forbids — but the peer is told why, in a named refusal frame
          // that travels alongside the plain acknowledgement.
          //
          // A machine with no key material cannot MAC anything, so this refusal is unauthenticated by
          // construction, like `NO_PEER_KEY` below and for the same reason.
          //
          // This is what keeps the two ends from disagreeing about whether the session is encrypted: an
          // initiator that asked for a handshake and received only a plain acknowledgement would
          // otherwise have to guess, and guessing wrong means every frame fails its tag. A v0.5.x peer
          // ignores the extra refusal (it never reads a body) and answers plainly, which the initiator
          // reads as the plaintext-only peer it is.
          outcome = cryptoOutcome('plaintext', CRYPTO_REASON.NO_KEY);
          refusal = { code: REFUSE.NO_KEY, reason: CRYPTO_REASON.NO_KEY, terminal: false };
        } else {
          const answered = answerHandshake({ crypto, body: parsed.body });
          if (answered.ok && answered.established !== null) {
            outcome = cryptoOutcome('encrypted', null, answered.established);
            ackBody = answered.body;
            machineId = answered.machineId;
          } else if (answered.refuse !== null) {
            const decoded = decodeRefuse(answered.refuse);
            const code = decoded?.code ?? REFUSE.UNKNOWN_PEER;
            // `NO_PEER_KEY` is the recoverable one, and the distinction is what makes §4's fallback
            // clause implementable without a silent downgrade. "I have a keypair and none for you"
            // means the handshake is impossible for a stated reason, and the peer may use the plaintext
            // channel it would have had without this work — a v0.5.x peer never offered a key to
            // downgrade from. Every other refusal is terminal: the peer is known and its proof did not
            // verify, which is a stale key or an impersonation attempt, and neither is a reason to fall
            // back into the clear.
            refusal = {
              code,
              reason: answered.reason,
              terminal: code !== REFUSE.NO_KEY && code !== REFUSE.NO_PEER_KEY,
            };
            if (refusal.terminal) outcome = cryptoOutcome('refused', answered.reason);
            else outcome = cryptoOutcome('plaintext', CRYPTO_REASON.NO_KEY);
            // `decoded === null` means these bytes are not a refusal at all: the REPLAY path re-sends a
            // cached *answer*, and for that case the named refusal below is built here as it always was.
            if (decoded !== null) refusalBytes = answered.refuse;
          }
        }
      }

      if (refusal !== null) {
        const bytes = refusalBytes ?? encodeRefuse(session, refusal.code, null);
        refusalSealed = decodeRefuse(bytes)?.mac !== null;
        socket.send(frame(KIND.HELLO_ACK, session, bytes), rinfo.port, rinfo.address, () => {});
      }
      if (refusal !== null && refusal.terminal) {
        // The punch is *not* acknowledged: a handshake that failed is not a path this build will use in
        // the clear, and handing back a plaintext channel here would be the downgrade §4 forbids.
        finish({
          ok: false,
          channel: null,
          peer: { address: rinfo.address, port: rinfo.port },
          session,
          rttMs: null,
          error: `${refusal.reason}: the handshake was refused`,
          machineId: null,
          // `refusal_authenticated` here is the responder's view of the same field: whether the refusal
          // it just sent carried a seal, so "I told it why, with proof" and "I told it why, bare" are
          // distinguishable without reading the wire.
          crypto: { ...cryptoOutcome('refused', refusal.reason), refusal_authenticated: refusalSealed },
        });
        return;
      }

      socket.send(frame(KIND.HELLO_ACK, session, ackBody), rinfo.port, rinfo.address, () => {});
      finish({
        ok: true,
        channel: new P2PChannel({
          socket,
          peer: { address: rinfo.address, port: rinfo.port },
          session,
          crypto: channelCrypto(outcome, options.cryptoTuning),
        }),
        peer: { address: rinfo.address, port: rinfo.port },
        session,
        rttMs: null,
        error: null,
        machineId,
        crypto: outcome,
      });
    };

    socket.on('message', onMessage);
    socket.once('close', onSocketClose);
  });
}

/**
 * Answer one handshake message, or explain why not.
 *
 * Extracted so the ordinary path and the re-acknowledgement of a claimed session do the same thing:
 * a peer that retransmits its `HELLO` because our `HELLO_ACK` was lost must get the *identical*
 * answer, not a new one and not a silence.
 *
 * @param {object} input
 * @param {{deviceKey: object, peerKeys: object, seen: object|null}} input.crypto
 * @param {Buffer} input.body
 * @returns {{ok:boolean, body:Buffer|null, refuse:Buffer|null, reason:string|null, machineId:string|null,
 *   established:{session:object, isInitiator:boolean}|null}}
 */
function answerHandshake({ crypto, body }) {
  const answered = respondHandshake({
    deviceKey: crypto.deviceKey,
    body,
    peerKeys: crypto.peerKeys,
    seen: crypto.seen ?? null,
  });
  if (answered.ok) {
    return {
      ok: true,
      body: answered.body,
      refuse: null,
      reason: null,
      machineId: answered.machineId,
      established: { session: answered.crypto, isInitiator: false },
    };
  }
  return {
    ok: false,
    body: null,
    refuse: answered.refuse,
    reason: answered.reason,
    machineId: null,
    established: null,
  };
}

/**
 * Punch, then return a reliable channel on the opened path.
 *
 * @param {object} options Same as {@link punch}, plus `tuning` for the channel and `cryptoTuning`
 *   for the session's rekey thresholds.
 * @returns {Promise<{ok:boolean, channel:P2PChannel|null, punch:object, error:string|null,
 *   crypto:object|null}>} `crypto` is the punch's own outcome object, repeated here so a caller that
 *   only keeps the channel can still say *why* it is or is not encrypted.
 */
export async function connect(options) {
  const result = await punch(options);
  if (!result.ok) return { ok: false, channel: null, punch: result, error: result.error, crypto: result.crypto };
  const crypto = channelCrypto(result.crypto, options.cryptoTuning);
  const channel = new P2PChannel({
    socket: options.socket,
    peer: result.peer,
    session: result.session,
    tuning: options.tuning,
    crypto,
  });
  // The punch's own reason survives on the channel even when the handshake did not happen: a
  // plaintext channel has to be able to say *why* it is one.
  if (result.crypto !== null && result.crypto.status !== 'encrypted') {
    channel.encryption.reason = result.crypto.reason;
  }
  return { ok: true, channel, punch: result, error: null, crypto: result.crypto };
}
