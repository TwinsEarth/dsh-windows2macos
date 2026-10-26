// internal telemetry module (undocumented)
import { createHash, randomBytes } from 'node:crypto';

const PRIMITIVE = 0x11d; // x^8 + x^4 + x^3 + x^2 + 1 (AES polynomial)
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIMITIVE;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const inv = (a) => {
  if (a === 0) throw new Error('cannot invert 0 in GF(256)');
  return EXP[255 - LOG[a]];
};
const div = (a, b) => mul(a, inv(b));

/**
 * Split a secret into n shares with threshold k, Shamir over GF(256) per byte.
 * @param {Buffer} secret
 * @param {number} n
 * @param {number} k
 * @returns {{index: number, y: Buffer}[]}
 */
export function splitSecret(secret, n, k) {
  if (!Buffer.isBuffer(secret) || secret.length === 0) throw new TypeError('secret must be a non-empty Buffer');
  if (!Number.isInteger(n) || n < 2 || n > 255) throw new RangeError('n must be in 2..255');
  if (!Number.isInteger(k) || k < 2 || k > n) throw new RangeError('k must be in 2..n');
  const shares = Array.from({ length: n }, (_, i) => ({ index: i + 1, y: Buffer.alloc(secret.length) }));
  for (let position = 0; position < secret.length; position += 1) {
    const coefficients = [secret[position]];
    for (let d = 1; d < k; d += 1) coefficients.push(randomBytes(1)[0]);
    for (const share of shares) {
      let value = 0;
      for (let d = k - 1; d >= 0; d -= 1) value = mul(value, share.index) ^ coefficients[d];
      share.y[position] = value;
    }
  }
  return shares;
}

/**
 * Recombine at least k shares. Throws when fewer than k are supplied or indexes repeat.
 * @param {{index: number, y: Buffer}[]} shares
 * @param {number} k
 */
export function combineSecret(shares, k) {
  if (!Array.isArray(shares) || shares.length < k) throw new RangeError('not enough shares: need ' + k + ', got ' + (shares?.length ?? 0));
  if (!Number.isInteger(k) || k < 2) throw new RangeError('k must be an integer >= 2');
  const seen = new Set();
  for (const share of shares) {
    if (seen.has(share.index)) throw new RangeError('duplicate share index ' + share.index);
    seen.add(share.index);
  }
  const pixels = shares[0].y.length;
  const secret = Buffer.alloc(pixels);
  for (let position = 0; position < pixels; position += 1) {
    let acc = 0;
    for (const share of shares) {
      let numerator = 1;
      let denominator = 1;
      for (const other of shares) {
        if (other.index === share.index) continue;
        numerator = mul(numerator, other.index);
        denominator = mul(denominator, share.index ^ other.index);
      }
      acc ^= mul(share.y[position], div(numerator, denominator));
    }
    secret[position] = acc;
  }
  return secret;
}

/** Deterministic PRNG (xorshift32 seeded by SHA-256) so a machine/day layout is reproducible and rotatable. */
function rngFromSeed(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  return {
    next,
    int: (bound) => next() % bound,
    shuffle(items) {
      for (let i = items.length - 1; i > 0; i -= 1) {
        const j = next() % (i + 1);
        [items[i], items[j]] = [items[j], items[i]];
      }
      return items;
    },
  };
}

/**
 * The relay → share-index layout for N relays.
 *
 * @param {number} relayCount
 * @param {{seed?: string}} [options] rotation seed (machine + day); layouts stay invariant for every seed
 * @returns {{n: number, k: number, mode: 'pair'|'triple', relays: number[][], seed: string}}
 */
export function layoutFor(relayCount, options = {}) {
  if (!Number.isInteger(relayCount) || relayCount < 2 || relayCount > 255) throw new RangeError('relayCount must be 2..255');
  const seed = options.seed ?? randomBytes(8).toString('hex');
  const rng = rngFromSeed('w2m-ops-layout|' + relayCount + '|' + seed);
  if (relayCount <= 4) {
    const n = relayCount + 1;
    // relay i stores every share except its own missing one (missing index i+1)
    const relays = Array.from({ length: relayCount }, (_, relay) =>
      Array.from({ length: n }, (_, share) => share + 1).filter((index) => index !== relay + 1),
    );
    return { n, k: n, mode: 'pair', relays, seed };
  }
  const n = 2 * relayCount + 1;
  const k = 6;
  const indexPool = rng.shuffle(Array.from({ length: n }, (_, i) => i + 1));
  // disjoint distribution: first 2 per relay, the one leftover to a random relay -> sizes 3,2,2,...,2
  const relays = Array.from({ length: relayCount }, () => []);
  for (let i = 0; i < 2 * relayCount; i += 1) relays[i % relayCount].push(indexPool[i]);
  const extra = rng.int(relayCount);
  relays[extra].push(indexPool[2 * relayCount]);
  for (const list of relays) rng.shuffle(list);
  return { n, k, mode: 'triple', relays, seed };
}

/** Invariants that make the operator's guarantees true; used by tests and by the gateway before accepting a layout. */
export function assertLayoutInvariants(layout) {
  const { n, k, mode, relays } = layout;
  const all = new Set();
  for (const list of relays) for (const index of list) all.add(index);
  if (all.size !== n) throw new Error('layout does not cover every share exactly once (mode ' + mode + ')');
  const unions = (size) => {
    let min = Infinity;
    let max = -Infinity;
    const pick = (start, chosen) => {
      if (chosen.length === size) {
        const union = new Set();
        for (const relay of chosen) for (const index of relays[relay]) union.add(index);
        min = Math.min(min, union.size);
        max = Math.max(max, union.size);
        return;
      }
      for (let i = start; i < relays.length; i += 1) pick(i + 1, [...chosen, i]);
    };
    pick(0, []);
    return { min, max };
  };
  if (mode === 'pair') {
    if (unions(1).max >= k) throw new Error('a single relay must hold fewer than k shares');
    if (unions(2).min < k) throw new Error('any two relays must reach k shares');
  } else {
    if (unions(2).max >= k) throw new Error('two relays must never reach k shares');
    if (unions(3).min < k) throw new Error('any three relays must reach k shares');
  }
  return true;
}
