/**
 * The peer-to-peer data plane's cryptography: a device keypair, a two-message handshake and the
 * transport keys that come out of it. Stage 1 of `docs/P2P-CRYPTO.md`, which is the contract this
 * file implements and the document that has to be updated if this file changes.
 *
 * WHY THIS IS A SEPARATE MODULE
 *
 * `p2p.mjs` owns punching and the reliable channel; it deliberately knows nothing about identity.
 * Everything here is about *identity and keys*, and keeping it apart is what lets the handshake be
 * tested without a socket and the channel be tested without a keypair. Nothing in this file opens a
 * socket, and only {@link DeviceKey} touches the disk.
 *
 * WHAT IS HERE, IN THE DOCUMENT'S OWN TERMS (§4)
 *
 *   * **Identity** —an X25519 keypair generated the first time a machine pairs, stored as
 *     `device.key` beside `device.json`. See {@link DeviceKey} for what "mode 0600" honestly means
 *     on Windows.
 *   * **Handshake** —two messages modelled on Noise IK: `HELLO` (e_i, mac) and `HELLO_ACK`
 *     (e_r, mac'). The session key is the triple DH `ECDH(e_i,e_r) —ECDH(s_i,e_r) —ECDH(e_i,s_r)`,
 *     which gives mutual authentication and forward secrecy; `k0 = ECDH(s_i,s_r)` is what proves
 *     possession of the static key before any of that is trusted.
 *   * **Transport** —ChaCha20-Poly1305 per frame, nonce = four zero bytes followed by a 64-bit
 *     little-endian counter, a 64-message sliding replay window, and rekey after 2^20 messages or
 *     120 seconds with the previous epoch key retained briefly.
 *
 * TWO PLACES THIS FILE DEPARTS FROM §4, BOTH REPORTED
 *
 *   1. **`mac1`/`mac2` are not implemented.** They are keyed BLAKE2s, which `node:crypto` does not
 *      expose (OpenSSL has it; the binding does not). They mitigate *CPU-exhaustion denial of
 *      service* —they let a responder drop forged handshake messages before doing any asymmetric
 *      operation —and they contribute nothing to confidentiality or authenticity. Stage 1 accepts
 *      that exposure and says so in {@link HANDSHAKE_MAC_FIELDS_OMITTED} rather than shipping a
 *      half-built lookalike.
 *   2. **The handshake MACs are bound to the session id and the handshake version**, which §4's
 *      sketch does not show. Without that binding, every input to §4's `mac` is identical for every
 *      punch between the same pair of machines, so a `HELLO` captured from one punch would verify
 *      in the next one. The binding is strictly stronger than what §4 writes and adds no field it
 *      names; {@link sessionBinding} records it.
 *
 * Everything is big-endian in the handshake messages, matching `p2p.mjs`'s framing.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  getHashes,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/* -------------------------------------------------------------------------- */
/* Names that travel on the wire, or into a report                             */
/* -------------------------------------------------------------------------- */

/** The key file's name, beside `device.json`. §4 names it exactly. */
export const DEVICE_KEY_FILE = 'device.key';

/** Contract-mandated permission bits for {@link DEVICE_KEY_FILE}. See {@link DeviceKey}. */
export const DEVICE_KEY_MODE = 0o600;

/** Schema marker of the key file's contents, so a future format is detectable rather than misread. */
export const DEVICE_KEY_FORMAT = 'w2m-device-key/1';

/** The key algorithm, spelled the way `node:crypto` spells it. */
export const DEVICE_KEY_ALGO = 'x25519';

/** Bytes in an X25519 public key, or in any derived key. */
export const KEY_BYTES = 32;

/** Handshake version, carried in every handshake body. */
export const CRYPTO_VERSION = 1;

/** First byte of every handshake/encrypted *body*: what tells it from a plain punch or a plain frame. */
export const FRAME_MAGIC = 0xa5;

/** Bytes of a ChaCha20-Poly1305 authentication tag. */
export const TAG_BYTES = 16;

/** Bytes of `p2p.mjs`'s frame header: kind u8 + session u32. Authenticated, never encrypted. */
export const FRAME_HEADER_BYTES = 5;

/** Bytes at the head of an encrypted frame's body: magic + epoch + 64-bit counter. */
export const CIPHER_HEADER_BYTES = 1 + 1 + 8;

/** Bytes of the AEAD-produced MAC: 32 bytes of ciphertext plus the 16-byte tag. */
export const MAC_BYTES = KEY_BYTES + TAG_BYTES;

/** Bytes of a handshake body up to and including the machine-id length byte. */
export const HANDSHAKE_PREFIX_BYTES = 1 + 1 + 4 + KEY_BYTES + 1;

/** Smallest possible handshake body: the prefix, no machine id, and the MAC. */
export const HANDSHAKE_MIN_BYTES = HANDSHAKE_PREFIX_BYTES + MAC_BYTES;

/** Longest machine id a handshake carries, so a hostile one cannot make the responder hash a novel. */
export const MAX_HANDSHAKE_MACHINE_ID = 128;

/**
 * Bytes an encrypted frame adds, in total.
 *
 * Constrained by `MAX_FRAGMENT_PAYLOAD`, and the arithmetic is worth stating because it is the one
 * place a "few bytes more" silently stops being true: a DATA frame is 5 header + 12 fields + 1160
 * payload = 1177 bytes, and this overhead makes it 1208 —8 bytes over the 1200-byte budget the
 * fragment size was chosen for, and 72 under a 1280-byte IPv6 minimum MTU either way. The tightened
 * budget is asserted in `test/p2p-crypto.test.mjs` against `MAX_FRAGMENT_PAYLOAD` itself rather than
 * assumed here.
 */
export const CIPHER_OVERHEAD_BYTES = CIPHER_HEADER_BYTES + TAG_BYTES;

/** `k = HKDF(...)` of §4: the triple DH, expanded into four purpose-bound sub-keys. */
export const SESSION_KEY_LABEL = 'w2m-p2p-crypto v1 session';

/** `k0 = HKDF(ECDH(s_i,s_r))` of §4: proves possession of the static key. */
export const STATIC_KEY_LABEL = 'w2m-p2p-crypto v1 static';

/**
 * Domain separator of a `REFUSE`'s optional MAC — a *different* label from every handshake MAC, and a
 * different *input*: `ECDH(e_i, s_r)` rather than `ECDH(s_i, s_r)` (see the note above `REFUSE`).
 *
 * Without the label, a refusal MAC and `mac'` of §4 would both be `sealMac(·, …)` over 32-byte hashes
 * a hostile peer could try to make collide. One extra hash input makes the two families disjoint.
 */
export const REFUSE_MAC_LABEL = 'w2m-p2p-crypto v1 refuse';

/** The literal string §4's `hash(prologue ——` starts with. */
export const PROLOGUE = 'w2m-p2p-crypto v1 prologue';

/** Sub-key labels. Distinct per purpose, mixed in through HKDF's `info`. */
export const INITIATOR_MAC_LABEL = 'w2m-p2p-crypto v1 mac-initiator';
export const RESPONDER_MAC_LABEL = 'w2m-p2p-crypto v1 mac-responder';
export const INITIATOR_TO_RESPONDER_LABEL = 'w2m-p2p-crypto v1 i2r';
export const RESPONDER_TO_INITIATOR_LABEL = 'w2m-p2p-crypto v1 r2i';

/** Rekey thresholds, from §4: 2^20 messages or 120 seconds, whichever comes first. */
export const REKEY_AFTER_MESSAGES = 1 << 20;
export const REKEY_AFTER_MS = 120_000;

/**
 * How long a superseded epoch key is kept.
 *
 * This is §4's "the old key is retained briefly so frames in flight are not lost", and it is not a
 * nicety: after a rekey the peer may have frames on the wire that were encrypted under the previous
 * key, and a receiver that dropped the key the instant it derived the next one would lose them
 * silently. 15 seconds is orders of magnitude above any plausible flight time on a path whose RTO is
 * 300 ms, and short enough that a long-lived session holds two epochs, never a growing set.
 */
export const EPOCH_RETENTION_MS = 15_000;

/**
 * How far ahead of what this end has already derived a single frame may push the ratchet.
 *
 * The epoch rides in the clear in every frame, so it is attacker-chosen input: without this bound one
 * forged frame could ask for two billion HKDF steps. It is measured **from the highest epoch already
 * derived**, not as an absolute ceiling — a session that sends steadily advances its own epoch, and its
 * own defence must not become the thing that stops it (see {@link CryptoSession#epochKeysFor}).
 */
export const MAX_EPOCH_LOOKAHEAD = 8;

/**
 * `mac1`/`mac2`, as a value rather than a comment somebody can miss (see this file's header).
 *
 * Exported so a reader of `w2m_status`, a test, or a stage-2 implementation sees the omission as a
 * decision with a stated consequence: these fields mitigate CPU-exhaustion denial of service on the
 * handshake path, and their absence does **not** weaken confidentiality or authenticity.
 */
export const HANDSHAKE_MAC_FIELDS_OMITTED = Object.freeze({
  fields: ['mac1', 'mac2'],
  reason: 'keyed BLAKE2s is not exposed by node:crypto',
  consequence:
    'no CPU-exhaustion DoS mitigation on the handshake path; confidentiality and authenticity are unaffected',
});

/**
 * The named refusal reasons. Every one of these is *reported*; none is a silent drop.
 *
 * These strings are the contract's "refuse with a distinct reason code" (§4) and they are what the
 * agent writes into the ledger, so they are stable identifiers rather than prose.
 */
export const CRYPTO_REASON = Object.freeze({
  /** This machine has no keypair, or none for that peer, so no handshake is attempted. */
  NO_KEY: 'P2P_CRYPTO_NO_KEY',
  /** A handshake named a machine whose static key we do not hold. */
  UNKNOWN_PEER: 'P2P_CRYPTO_UNKNOWN_PEER',
  /** The peer is known, and the MAC over its static key did not verify. */
  BAD_MAC: 'P2P_CRYPTO_BAD_MAC',
  /** The same initiator ephemeral arrived twice: a replayed HELLO. */
  REPLAY: 'P2P_CRYPTO_REPLAY',
  /** A data frame's authentication tag did not verify. Dropped, never processed. */
  AUTH_FAILED: 'P2P_CRYPTO_AUTH_FAILED',
  /** An authenticated frame whose counter was already inside the replay window. */
  REPLAYED_FRAME: 'P2P_CRYPTO_REPLAYED_FRAME',
  /** An authenticated frame from an epoch whose key has been dropped. */
  STALE_EPOCH: 'P2P_CRYPTO_STALE_EPOCH',
  /** A frame claimed an epoch we will not derive. */
  EPOCH_TOO_FAR: 'P2P_CRYPTO_EPOCH_TOO_FAR',
  /** The peer answered the handshake with an explicit refusal. */
  REFUSED_BY_PEER: 'P2P_CRYPTO_REFUSED_BY_PEER',
  /** The handshake did not complete inside its window. */
  HANDSHAKE_TIMEOUT: 'P2P_CRYPTO_HANDSHAKE_TIMEOUT',
  /** The peer speaks a handshake version this build does not. */
  VERSION_MISMATCH: 'P2P_CRYPTO_VERSION_MISMATCH',
  /** A handshake message whose shape is unusable. */
  MALFORMED: 'P2P_CRYPTO_MALFORMED',
  /** The peer never learned a key (an older build), so a direct channel with it is plaintext. */
  PLAINTEXT_PEER: 'P2P_CRYPTO_PLAINTEXT_PEER',
  /**
   * The relay is not serving peer keys, so no handshake can be armed by anyone (v0.6.2).
   *
   * Distinct from {@link PLAINTEXT_PEER} on purpose, and the distinction is the whole reason this code
   * exists. A relay older than v0.6.0 has never heard of `static_key`: it accepts an announcement,
   * silently drops the field, and serves an entry without it. Every peer then looks exactly like a
   * machine that has no key — which is how a stale *relay* came to be reported for hours as "the peer
   * is an older build", pointing the investigation at the one component that was up to date.
   *
   * Detected from this node's own announcement: we POST a key, so the entry the relay echoes back says
   * whether it kept it. No relay cooperation and no version negotiation required, which is what makes
   * it work against the relay that is actually deployed.
   */
  RELAY_NO_KEYS: 'P2P_CRYPTO_RELAY_NO_KEYS',
  /**
   * A `REFUSE` datagram was **dropped**, not honoured: it named a session this punch did not agree.
   *
   * The four `REFUSE_*` codes below name an *ignored datagram* rather than a failed punch, which is
   * deliberate and is the whole of the v0.6.0 hardening: an unauthenticated refusal that cannot be
   * tied to this punch must not be able to change its outcome, and it must not be able to fail it
   * either — an attacker who could turn "the peer never answered" into "the peer refused" would have
   * been handed a denial of service in exchange for closing a downgrade.
   */
  REFUSE_SESSION_MISMATCH: 'P2P_CRYPTO_REFUSE_SESSION_MISMATCH',
  /** A `REFUSE` datagram was dropped: it came from an address this punch never dialled. */
  REFUSE_UNPUNCHED_SOURCE: 'P2P_CRYPTO_REFUSE_UNPUNCHED_SOURCE',
  /** A `REFUSE` datagram was dropped: it carried a `k0` MAC that did not verify. */
  REFUSE_BAD_MAC: 'P2P_CRYPTO_REFUSE_BAD_MAC',
  /**
   * A downgrade-inducing `REFUSE` was dropped: it did not come from the peer that answered the punch.
   *
   * `NO_KEY`/`NO_PEER_KEY` say "I cannot take part, use the plaintext channel" — the one refusal that
   * changes the outcome into something weaker than a failure. Requiring it to come from the address
   * that actually answered the punch is what stops a datagram from a third address from choosing a
   * plaintext channel on the peer's behalf.
   */
  REFUSE_UNCORROBORATED: 'P2P_CRYPTO_REFUSE_UNCORROBORATED',
});

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

/** @param {Buffer} buffer @returns {string} standard base64: the one spelling this project uses. */
export function encodeKey(buffer) {
  return Buffer.from(buffer).toString('base64');
}

/**
 * Decode a 32-byte key from its base64 spelling, strictly.
 *
 * Strict because the alternative is a key that *almost* decodes: a trailing space, a URL-safe `-`, a
 * truncated string. `Buffer.from(x, 'base64')` ignores characters it does not recognise, so without
 * this check a mangled key would decode to something and fail much further away, as a MAC mismatch
 * that looks exactly like an attack.
 *
 * @param {unknown} value
 * @returns {Buffer|null} The key, or null when the value is not exactly a 32-byte base64 key.
 */
export function decodeKey(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== KEY_BYTES) return null;
  // A re-encode comparison catches padding or trailing characters the decoder ignored.
  if (decoded.toString('base64') !== value) return null;
  return decoded;
}

/** @param {unknown} value @returns {boolean} Whether `value` is a usable base64 X25519 public key. */
export function isPublicKey(value) {
  return decodeKey(value) !== null;
}

/** @param {Buffer} raw 32 bytes. @returns {import('node:crypto').KeyObject} */
export function publicKeyFromRaw(raw) {
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * @param {Buffer} raw 32-byte little-endian private scalar.
 * @returns {import('node:crypto').KeyObject}
 */
export function privateKeyFromRaw(raw) {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** @param {import('node:crypto').KeyObject} publicKey @returns {Buffer} The raw 32 bytes. */
export function rawPublicOf(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' }).subarray(-KEY_BYTES);
}

/** @param {import('node:crypto').KeyObject} privateKey @returns {Buffer} The raw 32-byte scalar. */
export function rawPrivateOf(privateKey) {
  return privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-KEY_BYTES);
}

/**
 * One machine's static X25519 keypair: its identity on the direct path.
 *
 * WHERE IT LIVES, AND WHAT "0600" HONESTLY MEANS
 *
 * The private key is written beside `device.json` (the state directory) with mode `0o600` on the
 * file and `0o700` on the directory, exactly as `identity.mjs` does for the device token. **On
 * Windows those bits do nothing.** NTFS carries no POSIX modes: `chmodSync` there is best-effort and
 * cannot fail the write, and the file's real protection is the ACL it inherits from the per-user
 * profile directory plus the absence of any "Everyone" grant —the platform's default profile
 * protection, not something this code establishes. A machine where another local user can read the
 * profile directory can read this key. Saying that here is the point; the alternative is a comment
 * claiming a guarantee the platform does not provide.
 *
 * The file is JSON rather than 32 raw bytes so its format is self-describing and a future change is
 * detectable rather than misparsed, and it is written atomically (temp file in the same directory,
 * then rename) so a crash mid-write cannot leave a half-written key. Only the private scalar is
 * stored: the public half is derived, which is what makes a hand-edited file unable to publish a
 * public key that does not match its private key.
 */
export class DeviceKey {
  /**
   * @param {object} options
   * @param {import('node:crypto').KeyObject} options.privateKey
   * @param {string|null} [options.machineId] Metadata for diagnostics; never an input to a derivation.
   * @param {string|null} [options.path] Where it came from, or null for a generated one.
   */
  constructor({ privateKey, machineId = null, path = null }) {
    this.privateKey = privateKey;
    this.publicKey = derivePublicKey(privateKey);
    /** @type {string|null} */
    this.machineId = typeof machineId === 'string' && machineId !== '' ? machineId : null;
    /** @type {string|null} */
    this.path = path;
  }

  /** This machine's static public key, base64. The value that goes into an offer. */
  get publicKeyBase64() {
    return encodeKey(rawPublicOf(this.publicKey));
  }

  /** The private scalar, base64. Only ever written to the key file. */
  get privateKeyBase64() {
    return encodeKey(rawPrivateOf(this.privateKey));
  }

  /** @param {DeviceKey|string} other The other end's static public key, or a `DeviceKey`. */
  equals(other) {
    const value = other instanceof DeviceKey ? other.publicKeyBase64 : other;
    return value === this.publicKeyBase64;
  }

  /**
   * Load the keypair from `device.key` beside `device.json`, generating it on first use.
   *
   * @param {object} options
   * @param {string} [options.dir] Directory that holds (or will hold) `device.key`.
   * @param {string} [options.file] Explicit file path; wins over `dir`.
   * @param {string|null} [options.machineId] Recorded in the file's metadata.
   * @returns {{key: DeviceKey, path: string, created: boolean}}
   * @throws {Error} `DEVICE_KEY_CORRUPT` / `DEVICE_KEY_UNREADABLE` when the file exists but cannot be
   *   trusted. Deliberately a hard error, for the same reason `identity.mjs` refuses to mint a new
   *   `machine_id`: silently generating a replacement key would make every peer that knows the old
   *   one refuse this machine, and "my peers stopped talking to me" would have no visible cause.
   */
  static load(options = {}) {
    const path = options.file
      ? isAbsolute(options.file)
        ? options.file
        : resolve(options.file)
      : join(requireDir(options.dir), DEVICE_KEY_FILE);

    let text = null;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const failure = new Error(`could not read ${path}: ${error?.code ?? 'UNKNOWN'}`);
        failure.code = 'DEVICE_KEY_UNREADABLE';
        throw failure;
      }
    }

    if (text !== null) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        const failure = new Error(`${path} is not valid JSON; refusing to mint a replacement key`);
        failure.code = 'DEVICE_KEY_CORRUPT';
        throw failure;
      }
      if (parsed?.format !== DEVICE_KEY_FORMAT || parsed?.algo !== DEVICE_KEY_ALGO) {
        const failure = new Error(`${path} is not a ${DEVICE_KEY_FORMAT} ${DEVICE_KEY_ALGO} key`);
        failure.code = 'DEVICE_KEY_CORRUPT';
        throw failure;
      }
      const raw = decodeKey(parsed.private_key);
      if (raw === null) {
        const failure = new Error(`${path} has no usable private_key; refusing to mint a replacement`);
        failure.code = 'DEVICE_KEY_CORRUPT';
        throw failure;
      }
      const key = new DeviceKey({
        privateKey: privateKeyFromRaw(raw),
        machineId: parsed.machine_id ?? options.machineId ?? null,
        path,
      });
      return { key, path, created: false };
    }

    const key = new DeviceKey({
      privateKey: generateKeyPairSync(DEVICE_KEY_ALGO).privateKey,
      machineId: options.machineId ?? null,
      path,
    });
    key.save();
    return { key, path, created: true };
  }

  /**
   * Build a keypair from an existing private scalar, without touching the disk.
   *
   * The test seam, and the shape a caller uses when the key arrived from somewhere other than a
   * file. `null` disables the direct path's cryptography entirely, which is how a test —or a
   * machine that has deliberately opted out —produces the "older peer" case.
   *
   * @param {Buffer|string} raw 32 raw bytes, or their base64 spelling.
   * @param {string|null} [machineId]
   * @returns {DeviceKey}
   */
  static fromPrivate(raw, machineId = null) {
    const bytes = Buffer.isBuffer(raw) ? raw : decodeKey(raw);
    if (bytes === null || bytes.length !== KEY_BYTES) {
      throw new TypeError('DeviceKey.fromPrivate: the private key must be 32 bytes');
    }
    return new DeviceKey({ privateKey: privateKeyFromRaw(bytes), machineId });
  }

  /** Generate a fresh keypair in memory. See {@link DeviceKey.load} for the on-disk path. */
  static generate(machineId = null) {
    return new DeviceKey({ privateKey: generateKeyPairSync(DEVICE_KEY_ALGO).privateKey, machineId });
  }

  /** Write the keypair to {@link DeviceKey#path}, atomically, with the modes this platform honours. */
  save() {
    if (this.path === null) throw new Error('DeviceKey.save: this key has no path');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const body = {
      format: DEVICE_KEY_FORMAT,
      algo: DEVICE_KEY_ALGO,
      machine_id: this.machineId,
      private_key: this.privateKeyBase64,
    };
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: DEVICE_KEY_MODE });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, DEVICE_KEY_MODE);
    } catch {
      // Windows/NTFS carries no POSIX bits. See this class's comment: the key file's protection
      // there is the profile directory's inherited ACL, not this call.
    }
    return this.path;
  }

  /**
   * The raw ECDH output for one peer public key.
   *
   * @param {Buffer|string} peerPublicKey 32 raw bytes or their base64 spelling.
   * @returns {Buffer}
   */
  sharedSecret(peerPublicKey) {
    const raw = Buffer.isBuffer(peerPublicKey) ? peerPublicKey : decodeKey(peerPublicKey);
    if (raw === null || raw.length !== KEY_BYTES) {
      throw new TypeError('DeviceKey.sharedSecret: the peer public key must be 32 bytes');
    }
    return diffieHellman({ privateKey: this.privateKey, publicKey: publicKeyFromRaw(raw) });
  }
}

/** @param {unknown} dir @returns {string} */
function requireDir(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new TypeError('DeviceKey: a state directory (or an explicit file) is required to locate device.key');
  }
  return isAbsolute(dir) ? dir : resolve(dir);
}

/**
 * The public half of a private key.
 *
 * Node can do this directly for a KeyObject, and the fallback is the RFC 7748 base-point
 * multiplication in plain JavaScript below. The fallback exists because a *private scalar* —the
 * shape the key file stores and a test may hand over —is not a KeyObject until
 * {@link privateKeyFromRaw} has built one, and `createPublicKey` on a PKCS#8 X25519 blob is exactly
 * the call that the raw-scalar route cannot make. Both paths are used, and both are exercised.
 *
 * @param {import('node:crypto').KeyObject} privateKey
 * @returns {import('node:crypto').KeyObject}
 */
function derivePublicKey(privateKey) {
  try {
    return createPublicKey(privateKey);
  } catch {
    return publicKeyFromRaw(x25519BasePoint(rawPrivateOf(privateKey)));
  }
}

/* -- X25519 base-point multiplication, in plain JavaScript ------------------ */
/*
 * RFC 7748 §5, and it is here rather than in a dependency because the project has none. Constant-time
 * discipline is not attempted and the reason is stated rather than implied: this runs at most once
 * per key, on this machine's *own* key, with no attacker-chosen input and no secret-dependent branch
 * a remote party can time. A protocol implementation that multiplied attacker-supplied points with a
 * long-lived secret would need the constant-time form; this is not that.
 */

/** @param {bigint} value @param {bigint} modulus @returns {bigint} Non-negative remainder. */
function mod(value, modulus) {
  const result = value % modulus;
  return result < 0n ? result + modulus : result;
}

/** @param {bigint} base @param {bigint} exponent @param {bigint} modulus @returns {bigint} */
function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = mod(base, modulus);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b, modulus);
    b = mod(b * b, modulus);
    e >>= 1n;
  }
  return result;
}

/**
 * The u-coordinate of `scalar · B`, little-endian in and out.
 *
 * @param {Buffer} scalarBytes 32-byte little-endian private scalar.
 * @returns {Buffer} 32 bytes.
 */
export function x25519BasePoint(scalarBytes) {
  const P = (1n << 255n) - 19n;
  const A24 = 121665n;

  let scalar = 0n;
  for (let i = scalarBytes.length - 1; i >= 0; i -= 1) scalar = (scalar << 8n) | BigInt(scalarBytes[i]);
  // Clamp, per RFC 7748: clear the three low bits, clear the top bit, set the second-highest bit.
  scalar &= (1n << 255n) - 1n;
  scalar &= ~7n;
  scalar &= ~(1n << 254n);
  scalar |= 1n << 254n;

  const x1 = 9n;
  let x2 = 1n;
  let z2 = 0n;
  let x3 = 9n;
  let z3 = 1n;
  let swap = 0n;

  for (let t = 254; t >= 0; t -= 1) {
    const bit = (scalar >> BigInt(t)) & 1n;
    swap ^= bit;
    if (swap === 1n) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = bit;

    const a = mod(x2 + z2, P);
    const aa = mod(a * a, P);
    const b = mod(x2 - z2, P);
    const bb = mod(b * b, P);
    const e = mod(aa - bb, P);
    const c = mod(x3 + z3, P);
    const d = mod(x3 - z3, P);
    const da = mod(d * a, P);
    const cb = mod(c * b, P);
    const t1 = mod(da + cb, P);
    const t2 = mod(da - cb, P);
    x3 = mod(t1 * t1, P);
    z3 = mod(x1 * mod(t2 * t2, P), P);
    x2 = mod(aa * bb, P);
    z2 = mod(e * mod(aa + mod(A24 * e, P), P), P);
  }

  if (swap === 1n) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }

  const value = mod(x2 * modPow(z2, P - 2n, P), P);
  const out = Buffer.alloc(KEY_BYTES);
  let rest = value;
  for (let i = 0; i < KEY_BYTES; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/**
 * A peer's static key, learned from an offer or from the relay, with its provenance.
 *
 * Provenance is the answer to "why did this channel not encrypt?": a key from the relay and a key
 * from the dispatcher's own offer are equally usable, but a *missing* one can only be diagnosed if
 * the reader can see that nothing ever supplied it.
 */
export class PeerKeyStore {
  constructor() {
    /** @type {Map<string, {key: string, source: string, at: number}>} */
    this.keys = new Map();
  }

  /**
   * @param {string} machineId
   * @param {unknown} key
   * @param {string} [source]
   * @param {number} [now]
   * @returns {boolean} Whether the key was usable and stored.
   */
  set(machineId, key, source = 'unknown', now = Date.now()) {
    if (typeof machineId !== 'string' || machineId === '') return false;
    if (!isPublicKey(key)) return false;
    this.keys.set(machineId, { key, source, at: now });
    return true;
  }

  /** @param {string} machineId @returns {string|null} */
  get(machineId) {
    const entry = this.keys.get(machineId);
    return entry === undefined ? null : entry.key;
  }

  /** @param {string} machineId @returns {{key: string, source: string, at: number}|null} */
  entry(machineId) {
    const found = this.keys.get(machineId);
    return found === undefined ? null : { ...found };
  }

  /** @param {string} machineId @returns {boolean} */
  has(machineId) {
    return this.keys.has(machineId);
  }

  /**
   * Merge a `static_keys` map as it arrives on an offer.
   *
   * A malformed entry is *skipped*, never fatal: one broken key from a dispatcher must not cost the
   * whole fleet its ability to punch. The returned count is what the caller reports.
   *
   * @param {unknown} map
   * @param {string} [source]
   * @returns {number} How many keys were accepted.
   */
  merge(map, source = 'offer') {
    if (map === null || typeof map !== 'object' || Array.isArray(map)) return 0;
    let accepted = 0;
    for (const [machineId, key] of Object.entries(map)) {
      if (this.set(machineId, key, source)) accepted += 1;
    }
    return accepted;
  }

  /** @returns {number} */
  get size() {
    return this.keys.size;
  }
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * HKDF-SHA256, §4's `HKDF(...)`.
 *
 * @param {Buffer} ikm
 * @param {string} label Bound into `info`, so two derivations over the same input key material can
 *   never produce the same output.
 * @param {number} [length]
 * @returns {Buffer}
 */
export function derive(ikm, label, length = KEY_BYTES) {
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(label, 'utf8'), length));
}

/**
 * How BLAKE2s-256 is reached on this runtime, discovered once and remembered.
 *
 * ## Why a probe exists for a call that simply works
 *
 * `P2P_PUNCH_FAILED: Digest method not supported` was reproduced twice in production and, measured directly,
 * **neither MacMini nor this Windows host lacks `blake2s256`** — so the algorithm is *not* the cause. What
 * made that take so long to establish is the shape of the failure: OpenSSL's message names no algorithm, no
 * caller and no host, so the only way to rule a candidate out was to probe each machine by hand.
 *
 * This wrapper does not change behaviour. It changes what a failure *says*: the algorithm that was requested,
 * whether the runtime advertises it, and the fact that it cannot be substituted. That is the difference
 * between a message a reader can act on and one that costs a round trip per hypothesis.
 */
let blake2sSupport = null;

/**
 * Whether this runtime can compute BLAKE2s-256, and how it was reached.
 *
 * @returns {{ok: boolean, advertised: boolean, detail: string}}
 */
export function blake2s256Support() {
  if (blake2sSupport !== null) return blake2sSupport;
  let advertised = false;
  try {
    advertised = typeof getHashes === 'function' && getHashes().includes('blake2s256');
  } catch {
    advertised = false;
  }
  try {
    const probe = createHash('blake2s256');
    probe.update('');
    const bytes = probe.digest().length;
    blake2sSupport = {
      ok: bytes === 32,
      advertised,
      detail: bytes === 32
        ? `BLAKE2s-256 available (${advertised ? 'advertised by getHashes' : 'works though not advertised'})`
        : `BLAKE2s-256 produced ${bytes} bytes rather than 32`,
    };
  } catch (e) {
    blake2sSupport = {
      ok: false,
      advertised,
      detail: `BLAKE2s-256 unavailable on this runtime: ${e?.message ?? String(e)}. It is a WIRE PROTOCOL primitive -- the handshake hash, the prologue hash and the session binding -- so it cannot be replaced with SHA-256 without breaking interoperability with every peer. This machine cannot take part in a handshake until the runtime supports it.`,
    };
  }
  return blake2sSupport;
}

/**
 * BLAKE2s-256, §3's handshake hash.
 *
 * Throws a message naming the algorithm and the consequence when the runtime cannot provide it, instead of
 * letting OpenSSL's `Digest method not supported` escape — which names neither, and which is why a real
 * production failure took several rounds to attribute.
 *
 * @param {...(Buffer|string)} parts
 * @returns {Buffer} 32 bytes.
 */
export function handshakeHash(...parts) {
  let hash;
  try {
    hash = createHash('blake2s256');
  } catch (e) {
    const support = blake2s256Support();
    const error = new Error(`handshakeHash requires BLAKE2s-256: ${support.detail}`);
    error.code = 'CRYPTO_BLAKE2S256_UNAVAILABLE';
    error.cause = e;
    throw error;
  }
  for (const part of parts) hash.update(part);
  const out = hash.digest();
  if (out.length !== 32) {
    const error = new Error(`handshakeHash expected a 32-byte digest and produced ${out.length}; peers would compute a different handshake hash`);
    error.code = 'CRYPTO_BLAKE2S256_WRONG_LENGTH';
    throw error;
  }
  return out;
}

/**
 * The prologue hash of §4: `hash(prologue —s_i.pub —s_r.pub)`.
 *
 * @param {string} initiatorPublic Base64.
 * @param {string} responderPublic Base64.
 * @returns {Buffer}
 */
export function prologueHash(initiatorPublic, responderPublic) {
  return handshakeHash(
    PROLOGUE,
    decodeKey(initiatorPublic) ?? Buffer.alloc(0),
    decodeKey(responderPublic) ?? Buffer.alloc(0),
  );
}

/**
 * The 5 bytes of session binding mixed into every handshake MAC.
 *
 * §4's `mac` is `AEAD(k0, nonce=0, hash(prologue —s_i.pub —s_r.pub))`, and every one of those
 * inputs is identical for every punch between the same pair of machines: a `HELLO` captured from one
 * punch would verify perfectly in the next. Binding the version and the session id closes that at the
 * source, at the cost of one more `hash.update`. Deliberately *not* a field on the wire —it is
 * recomputed by the receiver from the session it is already filtering on.
 *
 * @param {number} session
 * @returns {Buffer} 5 bytes.
 */
export function sessionBinding(session) {
  const out = Buffer.alloc(5);
  out.writeUInt8(CRYPTO_VERSION, 0);
  out.writeUInt32BE(session >>> 0, 1);
  return out;
}

/**
 * The four keys a completed handshake yields.
 *
 * §4 writes `k = HKDF(ECDH(e_i,e_r) —ECDH(s_i,e_r) —ECDH(e_i,s_r))` and uses that one value for
 * both the handshake's second MAC and the transport. One 128-byte expansion supplies four *distinct*
 * keys instead of reusing one key for four purposes, because key reuse is the failure mode that
 * passes every test and is found in a review years later. The `info` labels make the split explicit
 * rather than positional, so an implementation that reordered them would produce different keys
 * rather than silently swapped ones.
 *
 * @param {object} input
 * @param {Buffer} input.ephemeralShared `ECDH(e_i, e_r)`.
 * @param {Buffer} input.initiatorStaticShared `ECDH(s_i, e_r)`.
 * @param {Buffer} input.responderStaticShared `ECDH(e_i, s_r)`.
 * @returns {{macInitiator:Buffer, macResponder:Buffer, sendInitiator:Buffer, sendResponder:Buffer}}
 */
export function sessionKeys({ ephemeralShared, initiatorStaticShared, responderStaticShared }) {
  const triple = Buffer.concat([ephemeralShared, initiatorStaticShared, responderStaticShared]);
  const material = derive(triple, SESSION_KEY_LABEL, 4 * KEY_BYTES);
  return {
    macInitiator: material.subarray(0, KEY_BYTES),
    macResponder: material.subarray(KEY_BYTES, 2 * KEY_BYTES),
    sendInitiator: material.subarray(2 * KEY_BYTES, 3 * KEY_BYTES),
    sendResponder: material.subarray(3 * KEY_BYTES, 4 * KEY_BYTES),
  };
}

/**
 * `AEAD(key, nonce=0, message)` —the "MAC" of §4, which is really a sealed 32-byte hash.
 *
 * ChaCha20-Poly1305 in one shot: `key` is the key, the nonce is twelve zero bytes (as §4 writes it),
 * and the message is the hash. The return value is the ciphertext *and* the 16-byte tag, because the
 * ciphertext is what carries the hash across and the tag is what proves the key —there is no
 * separate plaintext hash on the wire.
 *
 * @param {Buffer} key 32 bytes.
 * @param {Buffer} message
 * @returns {Buffer} Ciphertext followed by the tag: 48 bytes for a 32-byte message.
 */
export function sealMac(key, message) {
  const cipher = createCipheriv('chacha20-poly1305', key, Buffer.alloc(12), { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(message), cipher.final()]);
  return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

/**
 * Open one of those MACs. Returns null on any failure and never throws.
 *
 * @param {Buffer} key
 * @param {Buffer} sealed Ciphertext followed by the tag.
 * @returns {Buffer|null} The authenticated message.
 */
export function openMac(key, sealed) {
  if (!Buffer.isBuffer(sealed) || sealed.length <= TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.alloc(12), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
}

/** @param {Buffer} a @param {Buffer} b @returns {boolean} Constant-time comparison. */
export function bytesEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* -------------------------------------------------------------------------- */
/* Handshake messages                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The two handshake bodies of §4, and the one refusal body, byte for byte.
 *
 * They ride **inside** the existing `p2p.mjs` frame kinds. A `HELLO`/`HELLO_ACK` whose body begins
 * with {@link FRAME_MAGIC} is a handshake message; a `HELLO`/`HELLO_ACK` whose body is empty is the
 * plain punch v0.5.x sends. That is what keeps the wire compatible in both directions without a
 * version bump: a v0.5.x peer answers a handshake `HELLO` with its own plain `HELLO_ACK` (it never
 * looks at the body), and this build answers a v0.5.x `HELLO` with a plain `HELLO_ACK` when it holds
 * no key for that machine. Neither end has to be told which kind of peer it is meeting.
 *
 *     HELLO      magic|version|session u32|e[32]|idLen u8|machineId|mac[48]
 *     HELLO_ACK  magic|version|session u32|e[32]|idLen u8|machineId|mac[48]
 *     REFUSE     magic|version|session u32|code u8|idLen u8|machineId[|mac 48]
 *
 * `mac` is 32 bytes of ciphertext plus 16 of tag (§4's AEAD-produced MAC).
 *
 * `REFUSE` **may** be unauthenticated, and that is not an oversight: it is sent precisely when we
 * cannot authenticate the peer (we hold no key for it), so it can carry no proof — and it is what
 * turns "the handshake did not complete" into a named reason on *both* ends instead of a timeout on
 * one of them. When the responder received a handshake `HELLO` it holds the initiator's ephemeral
 * `e_i`, and it *always* holds its own static private key `s_r`, so it can always derive
 * `k_ref = HKDF(ECDH(e_i, s_r), REFUSE_MAC_LABEL)` — a key the initiator derives just as easily from
 * `e_i`'s private half and `s_r`'s public key, and that nobody else can derive at all. The trailing 48
 * bytes of a refusal are then `sealMac(k_ref, hash(REFUSE_MAC_LABEL ‖ the refusal without its MAC))`.
 *
 * That is the asymmetry this file relies on, and it is worth stating plainly because the naive
 * version of it is wrong: `k0 = ECDH(s_i, s_r)` — the handshake MAC's key — is *not* usable here. A
 * responder that has no key for us (or a stale one) cannot compute it, and those are exactly the two
 * cases that send a refusal. `k_ref` needs neither end to hold the other's static key: the initiator
 * sends `e_i` in the clear, and the responder's `s_r` is public. What it proves is what a refusal
 * needs to prove — *this datagram came from the machine that holds `s_r`* — and it is therefore
 * available to `BAD_MAC` (our proof did not verify), `NO_PEER_KEY` (we hold no key for you) and
 * `UNKNOWN_PEER` alike.
 *
 * `VERSION` is the one refusal that stays bare, and deliberately: the peer that needs it speaks a
 * handshake version whose body layout this build cannot rely on, so a trailing field it does not know
 * about would be worse than useless.
 *
 * The unauthenticated form still exists and is still honoured by `p2p.mjs` — a peer running an older
 * build cannot produce `k_ref` and must not lose its plaintext channel for it. What `p2p.mjs` will not
 * do is let a datagram it cannot tie to the punch (see `REFUSE_GUARD` there) rewrite a ledger.
 */

/**
 * Refusal codes carried in a `REFUSE` body: one byte each, so a reason survives a round trip.
 *
 * `NO_PEER_KEY` and `BAD_MAC` are deliberately separate, and the separation is what makes §4's fallback
 * clause implementable without a silent downgrade:
 *
 *   * `NO_PEER_KEY` — we hold no key for that machine, so nothing it sent could have been verified
 *     either way. The peer learns that the handshake is impossible *for a stated reason* and may fall
 *     back to the plaintext channel it would have had without this work. That is the v0.5.x case, and
 *     it is not a downgrade: the peer never offered a key to downgrade from.
 *   * `BAD_MAC` — the peer *is* known and its MAC over its static key did not verify. That is either a
 *     stale key or an impersonation attempt, and the initiator treats it as terminal.
 *
 * The two known-peer codes (`BAD_MAC`, `REPLAY`) can be sealed with the ephemeral-static key of
 * {@link refusalMacKey}, and so can the two unknown-peer codes — `k_ref` needs no static key on file.
 * `VERSION` is the exception and stays bare. What `p2p.mjs` does with that asymmetry (`REFUSE_GUARD`
 * there) is the rule: a *plaintext-choosing* refusal (`NO_KEY`, `NO_PEER_KEY`) must either verify its
 * seal or arrive, unsealed, from the endpoint that acknowledged the punch; a terminal refusal is
 * honoured from a dialled address sealed or not, with `refusal_authenticated` recording whether the
 * seal was proof. Nothing dropped ever fails a punch.
 */
export const REFUSE = Object.freeze({
  UNKNOWN_PEER: 1,
  BAD_MAC: 2,
  REPLAY: 3,
  NO_KEY: 4,
  VERSION: 5,
  /** v0.6.0: "I have a keypair, and none for you." The one refusal a peer may fall back from. */
  NO_PEER_KEY: 6,
});

/** @type {Record<number, string>} */
export const REFUSE_REASON = Object.freeze({
  [REFUSE.UNKNOWN_PEER]: CRYPTO_REASON.UNKNOWN_PEER,
  [REFUSE.BAD_MAC]: CRYPTO_REASON.BAD_MAC,
  [REFUSE.REPLAY]: CRYPTO_REASON.REPLAY,
  [REFUSE.NO_KEY]: CRYPTO_REASON.NO_KEY,
  [REFUSE.VERSION]: CRYPTO_REASON.VERSION_MISMATCH,
  [REFUSE.NO_PEER_KEY]: CRYPTO_REASON.NO_KEY,
});

/**
 * Build a `HELLO` or `HELLO_ACK` body.
 *
 * @param {number} version
 * @param {number} session
 * @param {Buffer} ephemeralPublic 32 bytes.
 * @param {string|null} machineId
 * @param {Buffer} mac 48 bytes.
 * @returns {Buffer}
 */
export function encodeHello(version, session, ephemeralPublic, machineId, mac) {
  const id = machineId === null ? Buffer.alloc(0) : Buffer.from(machineId, 'utf8');
  if (id.length > MAX_HANDSHAKE_MACHINE_ID) throw new TypeError('encodeHello: the machine id is too long');
  const out = Buffer.alloc(HANDSHAKE_PREFIX_BYTES + id.length + MAC_BYTES);
  out.writeUInt8(FRAME_MAGIC, 0);
  out.writeUInt8(version, 1);
  out.writeUInt32BE(session >>> 0, 2);
  ephemeralPublic.copy(out, 6);
  out.writeUInt8(id.length, 38);
  id.copy(out, 39);
  mac.copy(out, 39 + id.length);
  return out;
}

/**
 * Parse a handshake body. Null for anything that is not one, so a caller can treat "a plain punch"
 * and "a malformed handshake" as the two different things they are.
 *
 * @param {Buffer} body
 * @returns {{version:number, session:number, ephemeral:string, machineId:string|null, mac:Buffer,
 *   bytes:Buffer, headerBytes:number}|null}
 */
export function decodeHello(body) {
  if (!Buffer.isBuffer(body) || body.length < HANDSHAKE_MIN_BYTES) return null;
  if (body.readUInt8(0) !== FRAME_MAGIC) return null;
  const version = body.readUInt8(1);
  const session = body.readUInt32BE(2);
  const ephemeral = body.subarray(6, 6 + KEY_BYTES);
  const idLength = body.readUInt8(38);
  if (idLength > MAX_HANDSHAKE_MACHINE_ID) return null;
  // The length is checked rather than tolerated: a body with trailing bytes is not a handshake any
  // build produces, and accepting one would let a peer append data the MAC does not cover.
  if (body.length !== HANDSHAKE_PREFIX_BYTES + idLength + MAC_BYTES) return null;
  const idEnd = 39 + idLength;
  let machineId = null;
  if (idLength > 0) {
    machineId = body.subarray(39, idEnd).toString('utf8');
    // A control byte in a machine id is not something any build produces, and letting one through
    // would put a delimiter into a log line.
    // eslint-disable-next-line no-control-regex -- rejecting control bytes is the point
    if (/[\u0000-\u001f\u007f]/.test(machineId)) return null;
  }
  const mac = body.subarray(idEnd, idEnd + MAC_BYTES);
  if (mac.length !== MAC_BYTES) return null;
  return {
    version,
    session,
    ephemeral: encodeKey(ephemeral),
    machineId,
    mac: Buffer.from(mac),
    bytes: Buffer.from(body),
    headerBytes: idEnd,
  };
}

/**
 * Build a `REFUSE` body, optionally with the trailing `k0` MAC of {@link sealRefuse}.
 *
 * @param {number} session
 * @param {number} code
 * @param {string|null} [machineId]
 * @param {Buffer|null} [mac] 48 bytes, or null for the unauthenticated form.
 * @returns {Buffer}
 */
export function encodeRefuse(session, code, machineId = null, mac = null) {
  const id = (machineId === null ? Buffer.alloc(0) : Buffer.from(machineId, 'utf8')).subarray(
    0,
    MAX_HANDSHAKE_MACHINE_ID,
  );
  const trailing = mac === null ? Buffer.alloc(0) : mac;
  if (trailing.length !== 0 && trailing.length !== MAC_BYTES) {
    throw new TypeError(`encodeRefuse: a refusal MAC must be ${MAC_BYTES} bytes`);
  }
  const out = Buffer.alloc(8 + id.length + trailing.length);
  out.writeUInt8(FRAME_MAGIC, 0);
  out.writeUInt8(CRYPTO_VERSION, 1);
  out.writeUInt32BE(session >>> 0, 2);
  out.writeUInt8(code, 6);
  out.writeUInt8(id.length, 7);
  id.copy(out, 8);
  trailing.copy(out, 8 + id.length);
  return out;
}

/**
 * Parse a `REFUSE` body — both the bare form and the `k0`-MAC'd one — or null.
 *
 * Strict about the length, in both forms, and that strictness is load-bearing rather than tidy: the
 * body being parsed here arrives as the body of a **`HELLO_ACK`**, and a handshake body is also
 * `magic|version|session|…` with a byte that can look like an id length. An earlier version accepted
 * exactly one length and validated nothing else, so a genuine `HELLO_ACK` could be read as a refusal
 * — `body[6]` (the first byte of the responder's ephemeral, which is random) became the refusal code
 * and `body[7]` the id length — roughly one handshake in 256 refusing itself. The machine-id check
 * below is what makes that collision impossible rather than unlikely: a handshake body's bytes from
 * offset 8 on are key material, and key material is not a printable machine id.
 *
 * @param {Buffer} body
 * @returns {{session:number, code:number, machineId:string|null, mac:Buffer|null, headerBytes:number,
 *   bytes:Buffer}|null}
 */
export function decodeRefuse(body) {
  if (!Buffer.isBuffer(body) || body.length < 8) return null;
  if (body.readUInt8(0) !== FRAME_MAGIC) return null;
  if (body.readUInt8(1) !== CRYPTO_VERSION) return null;
  const session = body.readUInt32BE(2);
  const code = body.readUInt8(6);
  const idLength = body.readUInt8(7);
  if (idLength > MAX_HANDSHAKE_MACHINE_ID) return null;
  const headerBytes = 8 + idLength;
  if (body.length !== headerBytes && body.length !== headerBytes + MAC_BYTES) return null;
  let machineId = null;
  if (idLength > 0) {
    machineId = body.subarray(8, headerBytes).toString('utf8');
    // Same rule, and the same reason, as `decodeHello`: no build produces a control byte in a machine
    // id, and one that arrives would put a delimiter into a log line.
    // eslint-disable-next-line no-control-regex -- rejecting control bytes is the point
    if (/[\u0000-\u001f\u007f]/.test(machineId)) return null;
  }
  const mac = body.length === headerBytes + MAC_BYTES
    ? Buffer.from(body.subarray(headerBytes, headerBytes + MAC_BYTES))
    : null;
  return { session, code, machineId, mac, headerBytes, bytes: Buffer.from(body) };
}

/**
 * The transcript a refusal MAC is taken over: the label, then the refusal exactly as it goes on the
 * wire *without* its MAC. Recomputed by the receiver from the bytes it holds, never sent separately.
 *
 * @param {Buffer} body The refusal body without the trailing MAC.
 * @returns {Buffer} 32 bytes.
 */
export function refuseTranscript(body) {
  return handshakeHash(REFUSE_MAC_LABEL, body);
}

/**
 * A refusal with proof attached, for every responder that received a parseable `HELLO`.
 *
 * @param {number} session
 * @param {number} code
 * @param {string|null} machineId
 * @param {Buffer} macKey `k_ref`, from {@link refusalMacKey}.
 * @returns {Buffer}
 */
export function sealRefuse(session, code, machineId, macKey) {
  const body = encodeRefuse(session, code, machineId);
  return encodeRefuse(session, code, machineId, sealMac(macKey, refuseTranscript(body)));
}

/**
 * The MAC key a refusal is sealed with: `k_ref = HKDF(ECDH(e_i, s_r), REFUSE_MAC_LABEL)`.
 *
 * Both ends derive it from material the *other* end published, and neither needs the other's static
 * public key to be on file: the initiator passes its own ephemeral private key and the responder's
 * static public key, the responder passes its own static private key and the initiator's ephemeral
 * public key from the `HELLO`. An attacker who has neither private key cannot derive it, which is
 * what makes a sealed refusal evidence rather than a claim.
 *
 * @param {object} input
 * @param {import('node:crypto').KeyObject} input.privateKey `e_i`'s private half (initiator) or `s_r`
 *   (responder).
 * @param {Buffer} input.peerPublicRaw 32 raw bytes of `s_r` (initiator) or `e_i` (responder).
 * @returns {Buffer} 32 bytes.
 */
export function refusalMacKey({ privateKey, peerPublicRaw }) {
  if (!Buffer.isBuffer(peerPublicRaw) || peerPublicRaw.length !== KEY_BYTES) {
    throw new TypeError(`refusalMacKey: the peer public key must be ${KEY_BYTES} raw bytes`);
  }
  return derive(diffieHellman({ privateKey, publicKey: publicKeyFromRaw(peerPublicRaw) }), REFUSE_MAC_LABEL);
}

/**
 * Verify the optional MAC on a received refusal.
 *
 * @param {Buffer|null} macKey `k_ref`, or null when this end has nothing to check with.
 * @param {Buffer} body The whole refusal body as received.
 * @returns {boolean|null} `null` when the body carries no MAC (or is not a refusal at all), otherwise
 *   whether it verifies. `false` is never "unknown" — it is a MAC that was present and wrong.
 */
export function verifyRefuseMac(macKey, body) {
  const decoded = decodeRefuse(body);
  if (decoded === null || decoded.mac === null) return null;
  if (macKey === null) return false;
  const expected = sealMac(macKey, refuseTranscript(body.subarray(0, decoded.headerBytes)));
  return bytesEqual(expected, decoded.mac);
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The 64-message sliding replay window of §4, in the shape WireGuard uses.
 *
 * "Highest counter seen" plus a 64-bit map of which of the 64 counters below it have arrived. A
 * frame below `highest - 64` is too old to place and is refused; a frame above `highest` slides the
 * window up and clears the bits it skipped; a frame inside the window is refused when its bit is
 * already set.
 *
 * Bit numbering, stated once because this is where an off-by-one hides: bit `width - 1` is the counter
 * `highest`, and a counter `d = highest - counter` behind it sits at bit `width - 1 - d`. The window
 * therefore spans `highest - (width - 1)` … `highest` — 64 counters in a 64-bit word, the old and the
 * new together — and the refusal test is `counter < highest - (width - 1)`, strictly below, because
 * the counter exactly `width - 1` behind is still represented and must be accepted once.
 *
 * The bits are indexed from the *top* while the counters run from the bottom, so an advance slides them
 * **right**. An earlier version slid them left, which moved every seen bit one position per frame and
 * eventually off the end: an in-order stream decrypted happily and a replay of frame 2 was accepted as
 * new — the exact failure this class exists to prevent, and invisible to any test that does not both
 * replay a frame *and* keep sending in order.
 */
export class ReplayWindow {
  /** @param {number} [size] Window width, in messages. */
  constructor(size = 64) {
    /** @type {number} */
    this.size = size;
    /** @type {bigint} Highest counter accepted, or -1n before the first frame. */
    this.highest = -1n;
    /**
     * One bit per counter in the window, bit `size - 1` being `highest`.
     *
     * A BigInt rather than an array of booleans so the slide is a shift, which is shorter and harder
     * to get subtly wrong.
     *
     * @type {bigint}
     */
    this.bits = 0n;
    /** @type {number} Counters refused as replays or as too old. */
    this.refused = 0;
  }

  /**
   * Record `counter` as seen.
   *
   * @param {bigint} counter
   * @returns {boolean} False when it is a replay, or so old it cannot be placed.
   */
  accept(counter) {
    const width = BigInt(this.size);
    const oldest = this.highest - (width - 1n);
    if (counter < oldest) {
      this.refused += 1;
      return false;
    }
    if (counter > this.highest) {
      // A counter above the window is new by definition — nothing above `highest` was ever recorded —
      // and the slide carries every bit that is still inside the window. Testing a bit here instead
      // was the bug that made an *in-order* frame look like a replay.
      const shift = counter - this.highest;
      this.bits = shift >= width ? 0n : this.bits >> shift;
      this.highest = counter;
    }
    const bit = 1n << (width - 1n - (this.highest - counter));
    if ((this.bits & bit) !== 0n) {
      this.refused += 1;
      return false;
    }
    this.bits |= bit;
    return true;
  }
}

/**
 * One peer pair's transport keys, epochs, counters and replay window.
 *
 * DIRECTION, NOT ROLE —and this is the design decision in this file that matters most
 *
 * The four keys are derived once, per handshake, and are *directional*: `sendInitiator` encrypts
 * initiator→responder and `sendResponder` the other way. A channel has to know which of the two is
 * its own send key, and that depends on which end it was. But the node **replaces** a channel with
 * the better of two simultaneous punches (`dial()` keeps the observed-address one; `adoptChannel`
 * replaces a duplicate), and that replacement can swap which end initiated on the surviving channel.
 * A session that had recorded "I am the initiator" would then encrypt with the wrong direction's key
 * and every frame would fail its tag —a failure indistinguishable from an attack. So the session
 * holds **both** directional keys, and each channel carries a one-line view of which direction it
 * is. Replacing the channel keeps the session.
 *
 * EPOCHS, AND WHY THE REKEY IS A RATCHET
 *
 * §4 says rekey after 2^20 messages or 120 seconds "by running the handshake again". Re-running it
 * inside the data path would cost a round trip and a state machine. Instead the session *ratchets*:
 * the epoch number travels in the clear in every frame (one byte, see {@link CIPHER_HEADER_BYTES})
 * and both ends derive epoch `n+1` from epoch `n` with HKDF. A rekey therefore costs no round trip
 * and no message; the receiver derives the next key the moment it sees a frame from the next epoch.
 * The previous epoch's key is retained for {@link EPOCH_RETENTION_MS} so a frame in flight across the
 * boundary is not lost —§7's eighth acceptance test.
 *
 * The 64-bit counter is deliberately **not** reset on rekey. The nonce is
 * `0x00000000 —counter64le` and the replay window is over that counter, so a monotonic counter is
 * what keeps both correct across an epoch boundary; resetting it would make two frames in one
 * session share a nonce, which is the one mistake a stream cipher never recovers from.
 */
export class CryptoSession {
  /**
   * @param {object} options
   * @param {number} options.session The punch session this handshake belongs to.
   * @param {string|null} [options.peerMachineId] The peer, when the handshake named one.
   * @param {Buffer} options.sendInitiator The initiator→responder key.
   * @param {Buffer} options.sendResponder The responder→initiator key.
   * @param {number} [options.nowMs]
   * @param {number} [options.rekeyMessages]
   * @param {number} [options.rekeyMs]
   * @param {number} [options.retentionMs]
   */
  constructor(options) {
    this.session = options.session >>> 0;
    /** @type {string|null} */
    this.peerMachineId = options.peerMachineId ?? null;
    this.sendInitiator = options.sendInitiator;
    this.sendResponder = options.sendResponder;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.rekeyMessages = options.rekeyMessages ?? REKEY_AFTER_MESSAGES;
    this.rekeyMs = options.rekeyMs ?? REKEY_AFTER_MS;
    this.retentionMs = options.retentionMs ?? EPOCH_RETENTION_MS;

    /** @type {number} The epoch this end encrypts under. */
    this.sendEpoch = 0;
    /** @type {bigint} Monotonic across epochs; never reset. */
    this.sendCounter = 0n;
    /** @type {bigint} Messages sent in the current epoch, for the rekey threshold. */
    this.epochMessages = 0n;
    /** @type {number} When the current epoch began, for the time threshold. */
    this.epochStartedAt = this.nowMs();
    /** @type {number} Highest epoch this end has derived keys for, in either direction. */
    this.highestEpoch = 0;
    /** @type {Map<number, {initiator: Buffer, responder: Buffer, expiresAt: number}>} */
    this.epochs = new Map();
    this.epochs.set(0, {
      initiator: this.sendInitiator,
      responder: this.sendResponder,
      expiresAt: Number.POSITIVE_INFINITY,
    });
    /** @type {ReplayWindow} */
    this.replay = new ReplayWindow(64);
    /** @type {boolean} */
    this.closed = false;
    /** @type {{rekeys:number, sent:number, received:number, dropped:number, replay_refusals:number}} */
    this.stats = { rekeys: 0, sent: 0, received: 0, dropped: 0, replay_refusals: 0 };
  }

  /**
   * The key pair for one epoch, ratcheted forward from epoch 0.
   *
   * One chain, two users: the epoch this end is *sending* under and the epoch the peer has moved to
   * are the same chain, which is what makes the ratchet work without a message.
   *
   * Two invariants, and both were learned from a failure that looked like an attack:
   *
   *   * **The chain is never cut.** A key is usable only if every key before it in the chain is still
   *     held, so {@link CryptoSession#retireBelow} purges a *prefix* and stops. An earlier version
   *     deleted epoch 0 a fixed time after the first rekey and could then no longer derive epoch 2 --
   *     `EPOCH_TOO_FAR` on a frame from an honest peer, with nothing in the reason to say that the
   *     receiver had thrown away its own chain.
   *   * **`highestEpoch` only ever rises.** Derivation is monotonic, so the loop continues from where
   *     it stopped rather than walking back over keys that are gone.
   *
   * @param {number} epoch
   * @returns {{initiator: Buffer, responder: Buffer}|null} Null for an epoch we will not derive.
   */
  epochKeysFor(epoch) {
    if (!Number.isInteger(epoch) || epoch < 0) return null;
    // The bound applies to how far *ahead of what this end has already derived* a request may reach,
    // and it is a denial-of-service bound: the epoch rides in the clear, so a forged frame could
    // otherwise ask for two billion HKDF steps. It must not cap this end's own send epoch — a session
    // that sends steadily rekeys on the message count and would otherwise stop being able to encrypt
    // after `MAX_EPOCH_LOOKAHEAD` epochs, which is a self-inflicted outage rather than a defence.
    if (epoch > this.highestEpoch + MAX_EPOCH_LOOKAHEAD) return null;
    if (epoch <= this.highestEpoch) return this.epochs.get(epoch) ?? null;
    for (let next = this.highestEpoch + 1; next <= epoch; next += 1) {
      const previous = this.epochs.get(next - 1);
      if (previous === undefined) return null;
      this.epochs.set(next, {
        initiator: derive(previous.initiator, `${SESSION_KEY_LABEL} epoch ${next}`),
        responder: derive(previous.responder, `${SESSION_KEY_LABEL} epoch ${next}`),
        expiresAt: Number.POSITIVE_INFINITY,
      });
    }
    this.highestEpoch = epoch;
    return this.epochs.get(epoch) ?? null;
  }

  /** The key this end encrypts with, given which end this channel is. */
  sendKey(isInitiator, epoch) {
    const keys = this.epochKeysFor(epoch);
    if (keys === null) return null;
    return isInitiator ? keys.initiator : keys.responder;
  }

  /** The key this end decrypts the peer's frames with: the other direction's. */
  receiveKey(isInitiator, epoch) {
    const keys = this.epochKeysFor(epoch);
    if (keys === null) return null;
    return isInitiator ? keys.responder : keys.initiator;
  }

  /**
   * Advance the send epoch when either threshold has passed.
   *
   * Checked on send rather than on a timer: a session that is idle for an hour and then sends one
   * frame does not need a rekey at all, and a timer would have performed thirty of them.
   *
   * @returns {boolean} Whether the epoch advanced.
   */
  maybeRekey() {
    const due =
      this.epochMessages >= BigInt(this.rekeyMessages) || this.nowMs() - this.epochStartedAt >= this.rekeyMs;
    if (!due) return false;
    this.sendEpoch += 1;
    this.epochMessages = 0n;
    this.epochStartedAt = this.nowMs();
    this.stats.rekeys += 1;
    // Make sure the epoch we are about to send under exists here, and start the retention clock on
    // the one we have stopped sending under. See `retireBelow` for why the run stays contiguous.
    this.epochKeysFor(this.sendEpoch);
    this.retireBelow(this.sendEpoch);
    return true;
  }

  /**
   * Give the superseded epochs a finite lifetime, and drop the ones whose time is up.
   *
   * This is §4's "the old key is retained briefly so frames in flight are not lost", and its shape is
   * forced by the ratchet rather than chosen:
   *
   *   * **The previous epoch is always kept.** A frame in flight across a rekey carries epoch `n - 1`
   *     while this end is at `n`, and it is exactly one behind because epochs advance one at a time.
   *   * **No gap is ever left below a retained epoch.** Every key is derived from the one before it,
   *     so deleting epoch 3 while keeping 4 would make epoch 5 underivable -- a permanent, silent
   *     outage for that session. Purging therefore removes the longest expired run at the *bottom* and
   *     stops at the first key that has to stay.
   *
   * @param {number} epoch The epoch this end now sends under.
   */
  retireBelow(epoch) {
    const now = this.nowMs();
    for (const [number, entry] of this.epochs) {
      if (number >= epoch) continue;
      if (entry.expiresAt === Number.POSITIVE_INFINITY) entry.expiresAt = now + this.retentionMs;
    }
    // Never below the previous epoch, and never below the newest epoch the peer has reached: a peer
    // that rekeyed ahead of us must still be able to derive its next key here.
    const floor = Math.max(epoch - 1, this.highestEpoch - 1, 0);
    for (let number = 0; number < floor; number += 1) {
      const entry = this.epochs.get(number);
      if (entry === undefined) break;
      if (Number.isFinite(entry.expiresAt) && entry.expiresAt <= now) this.epochs.delete(number);
    }
  }

  /**
   * Encrypt one complete frame.
   *
   * **The frame, header included, is the unit of encryption** —and that is a correction to how this
   * first looked. An earlier version took the frame apart and used `plaintext.subarray(0, 5)` as the
   * additional data while the caller handed the *ciphertext's* header to {@link CryptoSession#decrypt};
   * the two never matched, so every frame failed its tag and the failure was indistinguishable from an
   * attack. Taking and returning a whole frame makes the AAD one value that cannot drift: both methods
   * are handed the same bytes, and `test/p2p-crypto.test.mjs` pins that a frame encrypted here is
   * decrypted by a peer that only ever sees the frame.
   *
   * @param {boolean} isInitiator Whether this end initiated the handshake.
   * @param {Buffer} frame The complete frame —`p2p.mjs`'s header plus body.
   * @returns {Buffer} The frame with its body replaced: header —cipher header —ciphertext —tag.
   */
  encrypt(isInitiator, frame) {
    this.maybeRekey();
    const key = this.sendKey(isInitiator, this.sendEpoch);
    if (key === null) throw new Error('CryptoSession.encrypt: no send key for the current epoch');
    const counter = this.sendCounter;
    this.sendCounter += 1n;
    this.epochMessages += 1n;
    this.stats.sent += 1;

    const header = frame.subarray(0, FRAME_HEADER_BYTES);
    const cipherHeader = Buffer.alloc(CIPHER_HEADER_BYTES);
    cipherHeader.writeUInt8(FRAME_MAGIC, 0);
    cipherHeader.writeUInt8(this.sendEpoch & 0xff, 1);
    cipherHeader.writeBigUInt64LE(counter, 2);

    const cipher = createCipheriv('chacha20-poly1305', key, nonceFor(counter), { authTagLength: TAG_BYTES });
    // The frame's own header —kind and session —rides as additional authenticated data. That is
    // what stops an attacker retagging a DATA frame as a BYE, or moving a frame into another session:
    // the tag covers the fields the receiving channel routes on.
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(frame.subarray(FRAME_HEADER_BYTES)), cipher.final()]);
    return Buffer.concat([header, cipherHeader, ciphertext, cipher.getAuthTag()]);
  }

  /**
   * Decrypt one complete frame.
   *
   * Never throws, and never returns plaintext that did not authenticate. Every refusal is named, so a
   * caller records *why* a frame was dropped rather than only that something was.
   *
   * @param {boolean} isInitiator Whether this end initiated the handshake.
   * @param {Buffer} frame The complete received frame, header included.
   * @returns {{ok: true, frame: Buffer, plaintext: Buffer, epoch: number}|{ok: false, reason: string}}
   *   On success `plaintext` is the *body* that was encrypted and `frame` is the reconstructed frame.
   */
  decrypt(isInitiator, frame) {
    const fail = (reason) => {
      this.stats.dropped += 1;
      return { ok: false, reason };
    };
    if (!Buffer.isBuffer(frame) || frame.length < FRAME_HEADER_BYTES + CIPHER_HEADER_BYTES + TAG_BYTES) {
      return fail(CRYPTO_REASON.AUTH_FAILED);
    }
    const header = frame.subarray(0, FRAME_HEADER_BYTES);
    const body = frame.subarray(FRAME_HEADER_BYTES);
    if (body.readUInt8(0) !== FRAME_MAGIC) return fail(CRYPTO_REASON.AUTH_FAILED);
    const epoch = body.readUInt8(1);
    const counter = body.readBigUInt64LE(2);

    const known = this.epochs.get(epoch);
    if (known === undefined) {
      // A frame from an epoch we have not reached is the peer's rekey notice: derive up to it and
      // carry on. The ratchet is what makes that possible without a round trip, and *not* doing it
      // here was a permanent outage for every session that ever rekeyed -- the peer moved to epoch 1
      // and this end answered `EPOCH_TOO_FAR` forever.
      const derived = this.epochKeysFor(epoch);
      if (derived === null) {
        // "An epoch we cannot reach" and "an epoch whose key we dropped" are different facts: the
        // first is a frame from far in the future, the second one that arrived too late.
        return fail(epoch > this.highestEpoch ? CRYPTO_REASON.EPOCH_TOO_FAR : CRYPTO_REASON.STALE_EPOCH);
      }
    } else if (known.expiresAt <= this.nowMs()) {
      this.epochs.delete(epoch);
      return fail(CRYPTO_REASON.STALE_EPOCH);
    }
    const key = this.receiveKey(isInitiator, epoch);
    if (key === null) return fail(CRYPTO_REASON.EPOCH_TOO_FAR);

    let plaintext;
    try {
      const decipher = createDecipheriv('chacha20-poly1305', key, nonceFor(counter), { authTagLength: TAG_BYTES });
      decipher.setAAD(header);
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
      plaintext = Buffer.concat([
        decipher.update(body.subarray(CIPHER_HEADER_BYTES, body.length - TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      // Authentication failed. The frame is dropped and never processed, and the tag is *not* retried
      // against the other epochs: an attacker who could make us try keys until one verified would
      // have turned a 128-bit tag into a search.
      return fail(CRYPTO_REASON.AUTH_FAILED);
    }

    // The replay check comes *after* authentication, and that order is deliberate: checking first
    // would let an unauthenticated counter fill the window and lock out genuine frames.
    if (!this.replay.accept(counter)) {
      this.stats.replay_refusals += 1;
      return fail(CRYPTO_REASON.REPLAYED_FRAME);
    }

    // Adopt the peer's rekey without a round trip of our own: seeing a frame from epoch n+1 is the
    // notice that epoch n+1 exists, and the ratchet means it can be derived locally.
    this.epochKeysFor(epoch + 1);

    this.stats.received += 1;
    return { ok: true, plaintext, frame: Buffer.concat([header, plaintext]), epoch };
  }
}

/** The nonce of §4: four zero bytes, then the 64-bit little-endian counter. */
function nonceFor(counter) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(counter, 4);
  return nonce;
}

/* -------------------------------------------------------------------------- */
/* The handshake itself                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `hash(HELLO —e_r)` —the transcript `mac'` is taken over, built in exactly one place.
 *
 * §4 writes `mac' = AEAD(k0', nonce=0, hash(HELLO))`. What goes into that hash has to be identical on
 * both ends or the handshake fails with a MAC error that looks like an attack, so the *construction*
 * lives here and both callers pass raw bytes: the initiator's own `HELLO` (which it already holds)
 * and the responder's ephemeral public key as **32 raw bytes**, never as its base64 spelling. That
 * distinction is not cosmetic —an earlier draft hashed one form on one end and the other form on the
 * other, and the only symptom was `P2P_CRYPTO_BAD_MAC` on a handshake between two honest peers.
 *
 * @param {Buffer} helloBytes The complete `HELLO` body as sent.
 * @param {Buffer} responderEphemeralRaw 32 raw bytes of `e_r`.
 * @returns {Buffer} 32 bytes.
 */
export function ackTranscript(helloBytes, responderEphemeralRaw) {
  return handshakeHash(helloBytes, responderEphemeralRaw);
}

/**
 * The initiator's half of §4's handshake —one message out, one in.
 *
 * A function rather than a state machine, because the whole exchange is `hello()` then
 * `finish(ack)`; four states to express two steps would be ceremony. The ephemeral pair is generated
 * inside `hello()` and kept in the closure, so a caller that calls `hello()` again gets a *different*
 * `HELLO` —which is what keeps a retransmission distinguishable from a replay.
 *
 * @param {object} options
 * @param {DeviceKey} options.deviceKey This machine's static key.
 * @param {string} options.peerMachineId The machine being dialled.
 * @param {string} options.peerPublicKey Its static public key, from the offer or from the relay.
 * @param {number} options.session The punch session.
 * @returns {{body: Buffer, ephemeral: string, session: number, peerMachineId: string,
 *   refusalMacKey: Buffer, finish: Function}} `refusalMacKey` is `k_ref` of {@link refusalMacKey}: what
 *   this end checks a `REFUSE` against, and the reason a refusal can be evidence rather than a claim.
 */
export function startHandshake({ deviceKey, peerMachineId, peerPublicKey, session }) {
  const peerRaw = decodeKey(peerPublicKey);
  if (peerRaw === null) {
    throw new TypeError('startHandshake: the peer public key must be a 32-byte base64 key');
  }
  const ephemeral = generateKeyPairSync(DEVICE_KEY_ALGO);
  const ephemeralPublic = rawPublicOf(ephemeral.publicKey);

  // k0 proves possession of the static key before anything else is trusted: only a holder of s_i can
  // compute ECDH(s_i, s_r), and only a holder of s_r can check it.
  const k0 = derive(deviceKey.sharedSecret(peerRaw), STATIC_KEY_LABEL);
  const prologue = prologueHash(deviceKey.publicKeyBase64, peerPublicKey);
  const mac = sealMac(k0, handshakeHash(prologue, sessionBinding(session)));
  const body = encodeHello(CRYPTO_VERSION, session, ephemeralPublic, deviceKey.machineId, mac);

  let finished = false;
  return {
    body,
    ephemeral: encodeKey(ephemeralPublic),
    session,
    peerMachineId,
    // Derived once, here, from the ephemeral this handshake is about to send: `ECDH(e_i, s_r)`. The
    // responder derives the same value from that very `e_i` and its own static key, which is what lets
    // it answer a refusal with proof even when it holds no key for us at all.
    refusalMacKey: refusalMacKey({ privateKey: ephemeral.privateKey, peerPublicRaw: peerRaw }),
    /**
     * Verify `HELLO_ACK` and hand back the transport session.
     *
     * @param {Buffer|null} ackBody
     * @returns {{ok: true, session: CryptoSession, amInitiator: true}|{ok: false, reason: string}}
     */
    finish(ackBody) {
      if (finished) return { ok: false, reason: CRYPTO_REASON.MALFORMED };
      finished = true;
      const ack = decodeHello(ackBody ?? Buffer.alloc(0));
      if (ack === null) return { ok: false, reason: CRYPTO_REASON.MALFORMED };
      if (ack.version !== CRYPTO_VERSION) return { ok: false, reason: CRYPTO_REASON.VERSION_MISMATCH };
      if (ack.session !== (session >>> 0)) return { ok: false, reason: CRYPTO_REASON.MALFORMED };
      if (ack.machineId !== null && ack.machineId !== peerMachineId) {
        // The responder named somebody else: not a wrong key, a peer that is not the one the offer
        // introduced us to. Saying that is more useful than "bad mac".
        return { ok: false, reason: CRYPTO_REASON.UNKNOWN_PEER };
      }
      const peerEphemeral = decodeKey(ack.ephemeral);
      if (peerEphemeral === null) return { ok: false, reason: CRYPTO_REASON.MALFORMED };

      // mac' = AEAD(k0, nonce=0, hash(HELLO —e_r)): the same k0, over the transcript so far.
      const expected = sealMac(k0, ackTranscript(body, peerEphemeral));
      if (!bytesEqual(ack.mac, expected)) {
        // Either the peer does not hold s_r (so it is not who the offer said) or the transcript was
        // tampered with. One reason code, named, and no fallback to plaintext.
        return { ok: false, reason: CRYPTO_REASON.BAD_MAC };
      }

      const keys = sessionKeys({
        ephemeralShared: diffieHellman({
          privateKey: ephemeral.privateKey,
          publicKey: publicKeyFromRaw(peerEphemeral),
        }),
        initiatorStaticShared: deviceKey.sharedSecret(peerEphemeral),
        responderStaticShared: diffieHellman({
          privateKey: ephemeral.privateKey,
          publicKey: publicKeyFromRaw(peerRaw),
        }),
      });
      return {
        ok: true,
        session: new CryptoSession({
          session,
          peerMachineId,
          sendInitiator: keys.sendInitiator,
          sendResponder: keys.sendResponder,
        }),
        amInitiator: true,
      };
    },
  };
}

/**
 * The responder's half: verify a `HELLO`, answer it, and derive the same session keys.
 *
 * @param {object} options
 * @param {DeviceKey} options.deviceKey This machine's static key.
 * @param {Buffer} options.body The received handshake body.
 * @param {Map<string,string>|PeerKeyStore} options.peerKeys Machine id ?static public key.
 * @param {NonceCache|null} [options.seen] Replay tracking, owned by the caller because it has to
 *   outlive one handshake.
 * @returns {{ok:true, body:Buffer, session:number, machineId:string|null, crypto:CryptoSession,
 *   amInitiator:false}|{ok:false, reason:string, refuse:Buffer|null}}
 */
export function respondHandshake({ deviceKey, body, peerKeys, seen = null }) {
  const hello = decodeHello(body);
  if (hello === null) return { ok: false, reason: CRYPTO_REASON.MALFORMED, refuse: null };

  /** This peer's static public key as filed under its claimed machine id, or null. */
  const keyFor = (machineId) => {
    if (machineId === null) return null;
    return peerKeys instanceof PeerKeyStore
      ? peerKeys.get(machineId)
      : (peerKeys.get(machineId) ?? null);
  };

  /**
   * `k_ref` for this exchange, from the initiator's `e_i` and our own static key.
   *
   * Present whenever the `HELLO` parsed at all, which is every refusal below except `MALFORMED` (which
   * sends nothing). It is deliberately *not* `k0`: a responder with no key for the initiator — the
   * sender of `NO_PEER_KEY` — cannot compute `k0`, and a responder with a stale key for it (the sender
   * of `BAD_MAC`) would produce a `k0` the initiator cannot reproduce either. `k_ref` needs neither.
   */
  const initiatorEphemeralRaw = decodeKey(hello.ephemeral);
  const refusalKey = initiatorEphemeralRaw === null
    ? null
    : refusalMacKey({ privateKey: deviceKey.privateKey, peerPublicRaw: initiatorEphemeralRaw });
  /**
   * A refusal body: sealed when we can prove it, bare when we cannot.
   *
   * @param {number} code
   * @returns {Buffer}
   */
  const refuse = (code) => (refusalKey === null
    ? encodeRefuse(hello.session, code, deviceKey.machineId)
    : sealRefuse(hello.session, code, deviceKey.machineId, refusalKey));

  if (hello.version !== CRYPTO_VERSION) {
    // The version is decided before any key is looked at — a peer speaking a different handshake
    // version must be told *that*, not "unknown peer" — and this refusal stays bare on purpose: the
    // peer receiving it speaks a body layout this build cannot vouch for, so a trailing field it does
    // not know about would be worse than useless.
    return {
      ok: false,
      reason: CRYPTO_REASON.VERSION_MISMATCH,
      refuse: encodeRefuse(hello.session, REFUSE.VERSION, deviceKey.machineId),
    };
  }

  const initiatorKey = keyFor(hello.machineId);

  if (initiatorKey === null) {
    // Nothing this peer says can be verified, and we will not guess. The refusal is named — and it is
    // *sealed*, because `k_ref` is exactly the proof this case can carry: it says "this datagram came
    // from the machine that holds the static key you dialled", which is precisely what a peer with no
    // key on file for us can still prove. `p2p.mjs` turns that into the rule that a refusal which
    // would choose a plaintext channel needs either this proof or the corroboration of the same
    // endpoint having acknowledged the punch.
    //
    // It says `NO_PEER_KEY` rather than `UNKNOWN_PEER` because that is what the initiator needs to
    // know: a handshake is impossible here, so it may use the plaintext channel it would have had
    // before this work rather than waiting out a timeout.
    //
    // This branch has a second, ordinary caller: a handshake from *our own* machine id, which is what
    // a task the relay leased back to the dispatching machine produces. We hold no peer key for
    // ourselves, so it lands here, and the peer — us — falls back to the plaintext channel a
    // self-dial has always used. That is the right answer rather than an oversight: a self-connection
    // has no path to protect and must not fail, or a machine would lose the task it dispatched to
    // itself.
    return { ok: false, reason: CRYPTO_REASON.UNKNOWN_PEER, refuse: refuse(REFUSE.NO_PEER_KEY) };
  }
  const initiatorRaw = decodeKey(initiatorKey);
  if (initiatorRaw === null) {
    return { ok: false, reason: CRYPTO_REASON.UNKNOWN_PEER, refuse: refuse(REFUSE.UNKNOWN_PEER) };
  }

  const k0 = derive(deviceKey.sharedSecret(initiatorRaw), STATIC_KEY_LABEL);
  const expectedMac = sealMac(
    k0,
    handshakeHash(prologueHash(initiatorKey, deviceKey.publicKeyBase64), sessionBinding(hello.session)),
  );
  if (!bytesEqual(hello.mac, expectedMac)) {
    // The peer is known, and its mac is wrong: it does not hold the private key we have on file for
    // it. A distinct code from UNKNOWN_PEER because the responses differ —one means "refresh that
    // machine's key", the other means "somebody is guessing at names". Sealed with `k_ref` and not
    // `k0`, because when our record of *its* key is the stale one, `k0` is a value neither end can
    // agree on — and this is the refusal whose whole content is "our records disagree".
    return { ok: false, reason: CRYPTO_REASON.BAD_MAC, refuse: refuse(REFUSE.BAD_MAC) };
  }

  const nonceKey = `${hello.machineId}#${hello.session}#${hello.ephemeral}`;
  if (seen !== null && !seen.accept(nonceKey)) {
    // A replayed HELLO. What it *cannot* do is produce this session's key: the answer below carries a
    // fresh responder ephemeral, so the session key differs from the one the captured HELLO would
    // have produced, and the original initiator (which holds e_i's private half) completes a *second*
    // session rather than the attacker learning anything. The refusal is recorded, and the identical
    // answer is re-sent when there was one —so a retransmission whose ACK was lost still gets its
    // ACK, and no legitimate peer is failed for our own lost datagram.
    const cached = seen.replayBytes(nonceKey);
    return {
      ok: false,
      reason: CRYPTO_REASON.REPLAY,
      refuse: cached.length > 0 ? cached : null,
    };
  }

  const ephemeral = generateKeyPairSync(DEVICE_KEY_ALGO);
  const ephemeralPublic = rawPublicOf(ephemeral.publicKey);
  const ackBody = encodeHello(
    CRYPTO_VERSION,
    hello.session,
    ephemeralPublic,
    deviceKey.machineId,
    // mac' = AEAD(k0, nonce=0, hash(HELLO —e_r)), the transcript so far.
    sealMac(k0, ackTranscript(hello.bytes, ephemeralPublic)),
  );

  const keys = sessionKeys({
    ephemeralShared: diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: publicKeyFromRaw(decodeKey(hello.ephemeral) ?? Buffer.alloc(KEY_BYTES)),
    }),
    initiatorStaticShared: diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: publicKeyFromRaw(initiatorRaw),
    }),
    responderStaticShared: deviceKey.sharedSecret(decodeKey(hello.ephemeral) ?? Buffer.alloc(KEY_BYTES)),
  });

  if (seen !== null) seen.note(nonceKey, ackBody);

  return {
    ok: true,
    body: ackBody,
    session: hello.session,
    machineId: hello.machineId,
    amInitiator: false,
    crypto: new CryptoSession({
      session: hello.session,
      peerMachineId: hello.machineId,
      sendInitiator: keys.sendInitiator,
      sendResponder: keys.sendResponder,
    }),
  };
}

/**
 * Replay tracking for handshake messages, owned by whoever runs the accept loop.
 *
 * A HELLO is identified by `(machine id, session, initiator ephemeral)`. Bounded twice over —by TTL
 * and by count —because a peer that can make the responder's memory grow by sending handshakes is
 * the same denial of service in a new costume. This is the one place where `mac1`'s absence is felt
 * (see {@link HANDSHAKE_MAC_FIELDS_OMITTED}); the bound is what stands in for it.
 */
export class NonceCache {
  /** @param {{ttlMs?: number, max?: number, nowMs?: () => number}} [options] */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.max = options.max ?? 512;
    this.nowMs = options.nowMs ?? (() => Date.now());
    /** @type {Map<string, {at: number, bytes: Buffer|null}>} */
    this.entries = new Map();
  }

  /**
   * Record `key`. False when it was already present and still fresh.
   *
   * @param {string} key
   * @returns {boolean}
   */
  accept(key) {
    this.sweep();
    if (this.entries.has(key)) return false;
    this.entries.set(key, { at: this.nowMs(), bytes: null });
    return true;
  }

  /**
   * Remember the answer that was sent for `key`.
   *
   * The timestamp is deliberately *not* refreshed: the entry's lifetime is measured from the first
   * sighting, so re-noting cannot keep a replay entry alive forever.
   *
   * @param {string} key
   * @param {Buffer} bytes
   */
  note(key, bytes) {
    const existing = this.entries.get(key);
    const at = existing === undefined ? this.nowMs() : existing.at;
    this.entries.set(key, { at, bytes: Buffer.from(bytes) });
  }

  /** @param {string} key @returns {Buffer} The answer already sent for `key`, or an empty buffer. */
  replayBytes(key) {
    const entry = this.entries.get(key);
    return entry?.bytes ?? Buffer.alloc(0);
  }

  sweep() {
    const now = this.nowMs();
    for (const [key, entry] of [...this.entries]) {
      if (now - entry.at > this.ttlMs) this.entries.delete(key);
    }
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  /** @returns {number} */
  get size() {
    return this.entries.size;
  }
}
