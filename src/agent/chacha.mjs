/**
 * ChaCha20-Poly1305 (RFC 8439) in plain JS — the fallback for runtimes whose OpenSSL/BoringSSL
 * has no `chacha20-poly1305` (notably the DSH Electron host). Wire bytes are identical to the
 * native AEAD, so peers cannot tell which implementation produced them.
 */
import { timingSafeEqual } from 'node:crypto';

const P = (1n << 130n) - 5n;
const MASK128 = (1n << 128n) - 1n;
const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
const le32 = (buf, off) => buf.readUInt32LE(off);
const CONSTANTS = Buffer.from('expand 32-byte k', 'ascii');

function quarterRound(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
}

function chachaBlock(key, nonce, counter) {
  const state = new Uint32Array(16);
  for (let i = 0; i < 4; i += 1) state[i] = le32(CONSTANTS, i * 4);
  for (let i = 0; i < 8; i += 1) state[4 + i] = le32(key, i * 4);
  state[12] = counter >>> 0;
  for (let i = 0; i < 3; i += 1) state[13 + i] = le32(nonce, i * 4);
  const working = state.slice();
  for (let i = 0; i < 10; i += 1) {
    quarterRound(working, 0, 4, 8, 12); quarterRound(working, 1, 5, 9, 13);
    quarterRound(working, 2, 6, 10, 14); quarterRound(working, 3, 7, 11, 15);
    quarterRound(working, 0, 5, 10, 15); quarterRound(working, 1, 6, 11, 12);
    quarterRound(working, 2, 7, 8, 13); quarterRound(working, 3, 4, 9, 14);
  }
  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i += 1) out.writeUInt32LE((working[i] + state[i]) >>> 0, i * 4);
  return out;
}

function keystreamXor(key, nonce, input, startCounter) {
  const out = Buffer.alloc(input.length);
  let counter = startCounter;
  for (let offset = 0; offset < input.length; offset += 64, counter += 1) {
    const block = chachaBlock(key, nonce, counter);
    const end = Math.min(offset + 64, input.length);
    for (let i = offset; i < end; i += 1) out[i] = input[i] ^ block[i - offset];
  }
  return out;
}

function poly1305(message, key) {
  const rBytes = Buffer.from(key.subarray(0, 16));
  rBytes[3] &= 15; rBytes[7] &= 15; rBytes[11] &= 15; rBytes[15] &= 15;
  rBytes[4] &= 252; rBytes[8] &= 252; rBytes[12] &= 252;
  const r = BigInt('0x' + Buffer.from(rBytes).reverse().toString('hex'));
  const s = BigInt('0x' + Buffer.from(key.subarray(16, 32)).reverse().toString('hex'));
  let acc = 0n;
  for (let offset = 0; offset < message.length; offset += 16) {
    const chunk = message.subarray(offset, Math.min(offset + 16, message.length));
    let n = BigInt('0x' + Buffer.from(chunk).reverse().toString('hex'));
    n += 1n << BigInt(8 * chunk.length);
    acc = ((acc + n) * r) % P;
  }
  acc = (acc + s) & MASK128;
  const out = Buffer.alloc(16);
  let value = acc;
  for (let i = 0; i < 16; i += 1) { out[i] = Number(value & 0xffn); value >>= 8n; }
  return out;
}

const pad16 = (length) => (length % 16 === 0 ? Buffer.alloc(0) : Buffer.alloc(16 - (length % 16)));
const le64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };

function macData(aad, ciphertext) {
  return Buffer.concat([aad, pad16(aad.length), ciphertext, pad16(ciphertext.length), le64(aad.length), le64(ciphertext.length)]);
}

/** @returns {Buffer} ciphertext followed by the 16-byte tag. */
export function jsSeal(key, nonce, plaintext, aad = Buffer.alloc(0)) {
  const polyKey = chachaBlock(key, nonce, 0).subarray(0, 32);
  const ciphertext = keystreamXor(key, nonce, plaintext, 1);
  return Buffer.concat([ciphertext, poly1305(macData(aad, ciphertext), polyKey)]);
}

/** @returns {Buffer|null} plaintext, or null when the tag does not verify. */
export function jsOpen(key, nonce, sealed, aad = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(sealed) || sealed.length < 16) return null;
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  const polyKey = chachaBlock(key, nonce, 0).subarray(0, 32);
  const expected = poly1305(macData(aad, ciphertext), polyKey);
  if (!timingSafeEqual(tag, expected)) return null;
  return keystreamXor(key, nonce, ciphertext, 1);
}
