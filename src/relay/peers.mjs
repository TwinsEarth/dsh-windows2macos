/**
 * Peer candidate registry — the signalling half of the P2P transport.
 *
 * Hole punching needs each side to know the other's reflexive address, and neither
 * can learn it alone. The relay is already the one place every paired machine
 * talks to, so it is the natural rendezvous: a machine announces the addresses it
 * believes it is reachable at, and a peer reads them back.
 *
 * Design decisions worth stating:
 *
 *   * **Ephemeral, and deliberately not persisted.** A candidate is a NAT mapping,
 *     and a NAT mapping is gone the moment the process that created it stops sending.
 *     Writing these to `devices.json` would survive a restart and then hand out
 *     addresses that cannot work -- a stale candidate is worse than no candidate,
 *     because it turns "nobody has announced yet" into a punch that fails for a
 *     reason the operator cannot see.
 *   * **A machine may only announce for itself.** The route uses the authenticated
 *     device's `machine_id` and ignores any `machine_id` in the body. Otherwise any
 *     paired machine could redirect a peer's punch at a third party.
 *   * **Bounded.** Candidate count, address shape and TTL are all validated, because
 *     this is the one place where a peer supplies an address another peer will send
 *     UDP datagrams to.
 *   * **The static public key is a *distribution* channel, not an authority (v0.6.0).** A machine
 *     announces its own X25519 public key with its candidates, and a peer reads it back — which is
 *     what removes the `[Peer]` block nobody wants to fill in by hand. What the relay can and cannot
 *     do here is worth stating plainly: it can substitute a key, because a peer learns the key from
 *     the relay's answer (or from the dispatcher's offer, which the relay also carries verbatim). It
 *     cannot *use* a substituted key, because a handshake needs the matching private half, so a
 *     substituted key produces a refusal rather than a silent interception. §8 of
 *     `docs/P2P-CRYPTO.md` names the cheap improvement — a key-change notice — and leaves it for
 *     stage 2; until then a changed key is visible as `P2P_CRYPTO_BAD_MAC` rather than as silence.
 */

/** Most candidates a single machine may announce. Enough for several interfaces, not for a scan. */
export const MAX_CANDIDATES = 16;

/** Default lifetime of an announcement. NAT mappings are kept alive by traffic; this is the backstop. */
export const DEFAULT_TTL_MS = 60_000;

/** Upper bound a caller may request, so an announcement cannot be pinned indefinitely. */
export const MAX_TTL_MS = 10 * 60_000;

/**
 * Bytes in an X25519 public key (v0.6.0).
 *
 * The key itself is base64, so this is what the validator decodes to. Kept as a literal rather than
 * imported from `src/agent/crypto.mjs` for the same reason `P2P_MODES` is duplicated in
 * `state.mjs`: the relay is a standalone process that must not depend on an agent module, and the
 * value is a wire fact two independently deployed ends have to agree on.
 */
export const STATIC_KEY_BYTES = 32;

/**
 * Is `value` a usable static public key?
 *
 * Strict about the encoding, because a key that "almost" decodes is the input to a MAC that fails for
 * a reason indistinguishable from an attack. `Buffer.from(x, 'base64')` ignores characters it does
 * not recognise, so the decode is only trusted after re-encoding it and getting the same string back.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStaticKey(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === STATIC_KEY_BYTES && decoded.toString('base64') === value;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * @param {unknown} value
 * @returns {boolean} Whether `value` is a syntactically valid dotted-quad IPv4.
 */
export function isIpv4(value) {
  if (typeof value !== 'string') return false;
  const match = IPV4.exec(value);
  if (!match) return false;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return false;
    // Leading zeros are accepted by some parsers and not others; refuse them rather
    // than let two ends disagree about which address a string means.
    if (match[i].length > 1 && match[i].startsWith('0')) return false;
  }
  return true;
}

export class PeerRegistry {
  /**
   * @param {object} [options]
   * @param {() => number} [options.nowMs]
   * @param {number} [options.defaultTtlMs]
   */
  constructor(options = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    /** @type {Map<string, {machine_id:string, candidates:Array<{address:string,port:number}>,
     *                      nat:{mapping:string|null}, announced_at_ms:number, expires_at_ms:number}>} */
    this.entries = new Map();
  }

  /**
   * Record (or replace) a machine's candidates.
   *
   * @param {string} machineId Authenticated device id. Never taken from the body.
   * @param {object} body
   * @returns {{machine_id:string, candidates:Array<object>, expires_at:string, ttl_ms:number}}
   */
  announce(machineId, body = {}) {
    if (typeof machineId !== 'string' || machineId === '') {
      throw new TypeError('announce: machineId is required');
    }
    const raw = Array.isArray(body.candidates) ? body.candidates : [];
    if (raw.length === 0) {
      throw Object.assign(new Error('candidates must be a non-empty array'), { code: 'BAD_CANDIDATES' });
    }
    if (raw.length > MAX_CANDIDATES) {
      throw Object.assign(
        new Error(`too many candidates: ${raw.length} > ${MAX_CANDIDATES}`),
        { code: 'TOO_MANY_CANDIDATES' },
      );
    }

    const candidates = [];
    const seen = new Set();
    for (const candidate of raw) {
      const address = candidate?.address;
      const port = candidate?.port;
      if (!isIpv4(address)) {
        throw Object.assign(new Error(`candidate address is not IPv4: ${JSON.stringify(address)}`), {
          code: 'BAD_CANDIDATE_ADDRESS',
        });
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw Object.assign(new Error(`candidate port out of range: ${JSON.stringify(port)}`), {
          code: 'BAD_CANDIDATE_PORT',
        });
      }
      const key = `${address}:${port}`;
      if (seen.has(key)) continue; // a duplicate is not an error, just noise
      seen.add(key);
      candidates.push({ address, port });
    }

    const requestedTtl = Number.isInteger(body.ttl_ms) ? body.ttl_ms : this.defaultTtlMs;
    const ttlMs = Math.max(1000, Math.min(requestedTtl, MAX_TTL_MS));
    const now = this.nowMs();

    // v0.6.0: the machine's static public key, when it sent one. Validated here because this is the
    // one place a peer supplies a value another peer will use to authenticate it — a malformed key
    // stored and served would make a handshake fail with a MAC error that looks exactly like an
    // attack. Absent (a v0.5.x machine, or one with no key) stays absent rather than becoming `null`:
    // "this machine has no key" and "this machine's key is unknown" must not be the same value.
    let staticKey = null;
    if (body.static_key !== undefined && body.static_key !== null) {
      if (!isStaticKey(body.static_key)) {
        throw Object.assign(new Error('static_key is not a 32-byte base64 X25519 public key'), {
          code: 'BAD_STATIC_KEY',
        });
      }
      staticKey = body.static_key;
    }

    const entry = {
      machine_id: machineId,
      candidates,
      nat: { mapping: typeof body.nat?.mapping === 'string' ? body.nat.mapping : null },
      static_key: staticKey,
      announced_at_ms: now,
      expires_at_ms: now + ttlMs,
    };
    this.entries.set(machineId, entry);

    return {
      machine_id: machineId,
      candidates,
      ...(staticKey === null ? {} : { static_key: staticKey }),
      expires_at: new Date(entry.expires_at_ms).toISOString(),
      ttl_ms: ttlMs,
    };
  }

  /**
   * Read a machine's candidates, or `null` when it never announced or the
   * announcement has expired. Expiry is checked on read as well as on sweep, so a
   * stale entry can never be served between sweeps.
   *
   * @param {string} machineId
   * @returns {object|null}
   */
  get(machineId) {
    const entry = this.entries.get(machineId);
    if (!entry) return null;
    if (this.nowMs() >= entry.expires_at_ms) {
      this.entries.delete(machineId);
      return null;
    }
    return {
      machine_id: entry.machine_id,
      candidates: entry.candidates.map((c) => ({ ...c })),
      nat: { ...entry.nat },
      ...(entry.static_key === null || entry.static_key === undefined
        ? {}
        : { static_key: entry.static_key }),
      announced_at: new Date(entry.announced_at_ms).toISOString(),
      expires_at: new Date(entry.expires_at_ms).toISOString(),
    };
  }

  /** Drop expired entries. @returns {number} how many were dropped */
  sweep() {
    const now = this.nowMs();
    let dropped = 0;
    for (const [machineId, entry] of this.entries) {
      if (now >= entry.expires_at_ms) {
        this.entries.delete(machineId);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Live announcements, for `/healthz` and diagnostics. */
  stats() {
    this.sweep();
    return { peers_announced: this.entries.size };
  }

  clear() {
    this.entries.clear();
  }
}

export default PeerRegistry;
