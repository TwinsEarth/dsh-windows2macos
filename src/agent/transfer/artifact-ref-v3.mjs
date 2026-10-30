/**
 * Optional ArtifactRef v3 (feature-flagged; v2 remains the default on the wire).
 *
 * v3 adds an explicit hash algorithm, a Merkle root and a SHA-256 root so a
 * reader can cross-check the two aggregations. BLAKE3 is not bundled and Node
 * has no native implementation: when it is unavailable, creation falls back to
 * SHA-256 and records that decision instead of pretending BLAKE3 was used.
 */
import { createHash } from 'node:crypto';

export const REF_V3_VERSION = 3;

export const REF_V3_CODE = Object.freeze({
  OK: 'REF_V3_OK',
  BAD_SHAPE: 'REF_V3_BAD_SHAPE',
  UNSUPPORTED_ALG: 'REF_V3_UNSUPPORTED_ALG',
  BLAKE3_UNAVAILABLE: 'XFER_BLAKE3_UNAVAILABLE',
  INCONSISTENT: 'REF_V3_INCONSISTENT',
});

const sha256 = (buffer) => createHash('sha256').update(buffer).digest();
const hex64 = (value) => {
  if (typeof value !== 'string') return null;
  const raw = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
};
const isHex64 = (value) => hex64(value) !== null;

/**
 * Merkle root over chunk digests: leaves are the existing 32-byte chunk hashes;
 * internal nodes are SHA-256(0x01 || left || right); the final root is
 * SHA-256(0x02 || root). An odd node is promoted, never duplicated.
 */
export function merkleRootSha256(chunkHashesHex) {
  if (!Array.isArray(chunkHashesHex) || chunkHashesHex.length === 0) return null;
  let level = chunkHashesHex.map((hex) => {
    if (!isHex64(hex)) throw new TypeError('chunk hash must be 64 lowercase hex characters');
    return Buffer.from(hex, 'hex');
  });
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) { next.push(level[i]); continue; }
      next.push(sha256(Buffer.concat([Buffer.from([0x01]), level[i], level[i + 1]])));
    }
    level = next;
  }
  return sha256(Buffer.concat([Buffer.from([0x02]), level[0]])).toString('hex');
}

/**
 * @param {{rootCid: string, sha256Root: string, merkleRoot: string, hashAlg?: string,
 *          chunkBytes: number, chunkCount: number, size: number, originPeer?: string|null,
 *          blake3Available?: boolean}} input
 * @returns {{ok: true, ref: object} | {ok: false, code: string, detail?: string}}
 */
export function createRefV3(input) {
  const requestedAlg = input?.hashAlg === 'blake3' ? 'blake3' : 'sha256';
  const effectiveAlg = requestedAlg === 'blake3' && input?.blake3Available !== true ? 'sha256' : requestedAlg;
  const ref = {
    version: REF_V3_VERSION,
    rootCid: hex64(input?.rootCid) ?? input?.rootCid,
    sha256Root: hex64(input?.sha256Root) ?? input?.sha256Root,
    merkleRoot: input?.merkleRoot,
    hashAlg: effectiveAlg,
    ...(effectiveAlg !== requestedAlg ? { fallbackFrom: requestedAlg } : {}),
    chunkBytes: input?.chunkBytes,
    chunkCount: input?.chunkCount,
    size: input?.size,
    originPeer: typeof input?.originPeer === 'string' ? input.originPeer : null,
  };
  return verifyRefV3(ref, { blake3Available: input?.blake3Available === true });
}

/**
 * Validate v3 shape and invariants. A BLAKE3 v3 ref cannot be verified on a
 * runtime without BLAKE3: that is named, not silently downgraded.
 */
export function verifyRefV3(ref, { blake3Available = false } = {}) {
  if (ref === null || typeof ref !== 'object') return { ok: false, code: REF_V3_CODE.BAD_SHAPE, detail: 'ref must be an object' };
  if (ref.version !== REF_V3_VERSION) return { ok: false, code: REF_V3_CODE.BAD_SHAPE, detail: 'version must be 3' };
  if (!isHex64(ref.rootCid) || !isHex64(ref.sha256Root) || !isHex64(ref.merkleRoot)) {
    return { ok: false, code: REF_V3_CODE.BAD_SHAPE, detail: 'rootCid, sha256Root and merkleRoot must be 64-hex' };
  }
  if (ref.hashAlg !== 'sha256' && ref.hashAlg !== 'blake3') return { ok: false, code: REF_V3_CODE.UNSUPPORTED_ALG, detail: String(ref.hashAlg) };
  if (ref.hashAlg === 'blake3' && blake3Available !== true) return { ok: false, code: REF_V3_CODE.BLAKE3_UNAVAILABLE };
  for (const name of ['chunkBytes', 'chunkCount', 'size']) {
    if (!Number.isInteger(ref[name]) || ref[name] < (name === 'size' ? 0 : 1)) return { ok: false, code: REF_V3_CODE.BAD_SHAPE, detail: name };
  }
  if (ref.chunkCount !== Math.ceil(ref.size / ref.chunkBytes)) return { ok: false, code: REF_V3_CODE.INCONSISTENT, detail: 'chunkCount != ceil(size/chunkBytes)' };
  if (ref.hashAlg === 'sha256' && hex64(ref.rootCid) !== hex64(ref.sha256Root)) return { ok: false, code: REF_V3_CODE.INCONSISTENT, detail: 'sha256 rootCid must equal sha256Root' };
  return { ok: true, code: REF_V3_CODE.OK, ref, effectiveAlg: ref.hashAlg };
}
