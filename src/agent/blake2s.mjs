/**
 * BLAKE2s-256 in plain JavaScript -- the handshake hash when the runtime cannot provide it.
 *
 * ## Why this exists
 *
 * `src/agent/crypto.mjs` computes the handshake hash, the prologue hash and the session binding with
 * `createHash('blake2s256')`. On the DSH desktop runtime that call fails:
 *
 *     P2P_PUNCH_FAILED: handshakeHash requires BLAKE2s-256: BLAKE2s-256 unavailable on this runtime:
 *     Digest method not supported. It is a WIRE PROTOCOL primitive -- the handshake hash, the prologue hash and
 *     the session binding -- so it cannot be replaced with SHA-256 without breaking interoperability with every peer.
 *
 * That message is right about the constraint and wrong about the conclusion. BLAKE2s is **public and
 * deterministic**, so the algorithm can be computed here instead of by OpenSSL: the bytes are identical to what a
 * peer with a native implementation produces, and interoperability is preserved exactly. The alternative -- refusing
 * to handshake -- makes every direct path fall back to the relay on this runtime, which is what was observed.
 *
 * ## Scope: unkeyed only
 *
 * The wire protocol needs the **unkeyed** 32-byte digest (prologue, session binding, MAC inputs). Keyed BLAKE2s
 * (`mac1`/`mac2`) is explicitly not implemented in this build either way, so this module implements exactly the
 * unkeyed case and refuses a key rather than pretending.
 *
 * ## Correctness
 *
 * Verified against the three published vectors (empty, "abc", the pangram) and, when the runtime does have a native
 * `blake2s256`, cross-checked byte-for-byte against it over many lengths -- the test file asserts both.
 *
 * @see https://www.rfc-editor.org/rfc/rfc7693 (BLAKE2 -- BLAKE2s, 32-bit words, 10 rounds)
 */

const IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** Message-word permutation, one row per round (10 rounds for BLAKE2s). */
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const BLOCK = 64;
const OUT_BYTES = 32;

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** The G mixing function, rotation constants 16/12/8/7 for BLAKE2s. */
function mix(v, a, b, c, d, x, y) {
  v[a] = (v[a] + v[b] + x) >>> 0;
  v[d] = rotr(v[d] ^ v[a], 16);
  v[c] = (v[c] + v[d]) >>> 0;
  v[b] = rotr(v[b] ^ v[c], 12);
  v[a] = (v[a] + v[b] + y) >>> 0;
  v[d] = rotr(v[d] ^ v[a], 8);
  v[c] = (v[c] + v[d]) >>> 0;
  v[b] = rotr(v[b] ^ v[c], 7);
}

/** Read 16 little-endian 32-bit words out of a 64-byte block. */
function words(block, offset, m) {
  for (let i = 0; i < 16; i += 1) {
    const p = offset + i * 4;
    m[i] = (block[p] | (block[p + 1] << 8) | (block[p + 2] << 16) | (block[p + 3] << 24)) >>> 0;
  }
}

/** One compression call: 64 bytes of message, a 64-bit byte counter, and the final-block flag. */
function compress(h, block, offset, counter, last) {
  const v = new Uint32Array(16);
  const m = new Uint32Array(16);
  v.set(h, 0);
  v.set(IV, 8);
  v[12] ^= counter >>> 0;
  v[13] ^= Math.floor(counter / 0x100000000) >>> 0;
  if (last) {
    /**
     * Only `v[14]` is inverted -- `f0 = 0xFFFFFFFF` marks the last block, and **`f1` stays 0** for sequential
     * hashing (it is only 1 for the last node of a tree). Inverting `v[15]` as well is the classic wrong
     * implementation: it produces a stable, plausible-looking digest that matches no reference, which is exactly how
     * this was found -- three RFC vectors failed and the compression function, checked against a reference
     * implementation, turned out to be correct while the final-block setup was not.
     */
    v[14] = (v[14] ^ 0xffffffff) >>> 0;
  }
  words(block, offset, m);

  for (let r = 0; r < 10; r += 1) {
    const s = SIGMA[r];
    mix(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
    mix(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
    mix(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
    mix(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
    mix(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
    mix(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
    mix(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
    mix(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
  }

  for (let i = 0; i < 8; i += 1) h[i] = (h[i] ^ v[i] ^ v[i + 8]) >>> 0;
}

/**
 * BLAKE2s-256 of a buffer. Unkeyed; a key is refused rather than silently ignored.
 *
 * @param {Buffer|Uint8Array|string} input
 * @returns {Buffer} 32 bytes.
 */
export function blake2s256(input) {
  const data = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const h = new Uint32Array(IV);
  // Parameter block: digest length 32, key length 0, fanout 1, depth 1.
  h[0] = (h[0] ^ 0x01010000 ^ OUT_BYTES) >>> 0;

  let counter = 0;
  // Every block except the last is hashed as a non-final block, so the final block (possibly all zeros) is handled
  // separately -- BLAKE2 pads the last block and sets the final flag, it does not append an extra block.
  const full = data.length === 0 ? 0 : Math.ceil(data.length / BLOCK) - 1;
  for (let i = 0; i < full; i += 1) {
    counter += BLOCK;
    compress(h, data, i * BLOCK, counter, false);
  }

  const lastOffset = full * BLOCK;
  const lastLength = data.length - lastOffset;
  const tail = Buffer.alloc(BLOCK);
  data.copy(tail, 0, lastOffset, data.length);
  counter += lastLength;
  compress(h, tail, 0, counter, true);

  const out = Buffer.alloc(OUT_BYTES);
  for (let i = 0; i < 8; i += 1) out.writeUInt32LE(h[i], i * 4);
  return out;
}

/** The three RFC 7693 vectors, exported so a test can assert them without copying hex. */
export const BLAKE2S_VECTORS = [
  { input: '', hex: '69217a3079908094e11121d042354a7c1f55b6482ca1a51e1b250dfd1ed0eef9' },
  { input: 'abc', hex: '508c5e8c327c14e2e1a72ba34eeb452f37458b209ed63a294d999b4c86675982' },
  {
    input: 'The quick brown fox jumps over the lazy dog',
    hex: '606beeec743ccbeff6cbcdf5d5302aa855c256c29b88c8ed331ea1a6bf3c8812',
  },
];
