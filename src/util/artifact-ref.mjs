/**
 * ArtifactRef v1 (S4): the control-plane reference to an artifact that lives in a USER sink.
 *
 * Invariants:
 *   · `object_id` is random (32 hex), never derived from the content;
 *   · the control plane carries no plaintext hash — only `cipher.sha256` and `plain.bytes`;
 *   · a ref is metadata-only (≤ 4 KiB) and its fields are a closed set;
 *   · with a fleet key, `hmac` binds every field (HMAC-SHA-256 over canonical JSON).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

export const ARTIFACT_REF_VERSION = 1;
export const MAX_REF_BYTES = 4096;
export const ARTIFACT_KINDS = Object.freeze(['stdout', 'stderr', 'patch', 'commit', 'reduce-input']);
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

const stable = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
};

const digest = (value) => createHash('sha256').update(stable(value), 'utf8').digest('hex');

function hmacOf(ref, hmacKey) {
  return createHmac('sha256', hmacKey).update(stable(ref), 'utf8').digest('base64url');
}

/**
 * @param {{objectId?: string, planSha256?: string|null, approvalSha256?: string|null, taskId: string,
 *          stepId?: string|null, machineId: string, kind: string, sinkKind?: 'dir'|'lan-git'|'ssh',
 *          relPath: string, cipherSha256: string, cipherBytes: number, plainBytes: number,
 *          enc?: object, zip?: object, hmacKey?: string}} input
 */
export function createArtifactRef(input) {
  const objectId = typeof input?.objectId === 'string' && input.objectId !== '' ? input.objectId : randomBytes(16).toString('hex');
  if (!HEX32.test(objectId)) return { ok: false, code: 'ARTIFACT_OBJECT_ID_INVALID' };
  if (typeof input?.taskId !== 'string' || input.taskId === '') return { ok: false, code: 'ARTIFACT_TASK_REQUIRED' };
  if (typeof input?.machineId !== 'string' || input.machineId === '') return { ok: false, code: 'ARTIFACT_MACHINE_REQUIRED' };
  if (!ARTIFACT_KINDS.includes(input?.kind)) return { ok: false, code: 'ARTIFACT_KIND_INVALID' };
  if (typeof input?.relPath !== 'string' || input.relPath === '' || input.relPath.includes('..')) return { ok: false, code: 'ARTIFACT_PATH_INVALID' };
  if (!HEX64.test(String(input?.cipherSha256 ?? ''))) return { ok: false, code: 'ARTIFACT_CIPHER_SHA_INVALID' };
  if (!Number.isInteger(input?.cipherBytes) || input.cipherBytes < 0) return { ok: false, code: 'ARTIFACT_CIPHER_BYTES_INVALID' };
  if (!Number.isInteger(input?.plainBytes) || input.plainBytes < 0) return { ok: false, code: 'ARTIFACT_PLAIN_BYTES_INVALID' };
  const ref = {
    v: ARTIFACT_REF_VERSION,
    object_id: objectId,
    plan_sha256: HEX64.test(String(input?.planSha256 ?? '')) ? input.planSha256 : null,
    approval_sha256: HEX64.test(String(input?.approvalSha256 ?? '')) ? input.approvalSha256 : null,
    task_id: input.taskId,
    step_id: typeof input?.stepId === 'string' && input.stepId !== '' ? input.stepId : null,
    machine_id: input.machineId,
    kind: input.kind,
    sink: { kind: input?.sinkKind ?? 'dir', rel_path: input.relPath },
    cipher: { sha256: input.cipherSha256, bytes: input.cipherBytes },
    plain: { bytes: input.plainBytes },
    enc: input?.enc ?? null,
    zip: input?.zip ?? null,
    created_at: new Date().toISOString(),
  };
  if (Buffer.byteLength(JSON.stringify(ref), 'utf8') > MAX_REF_BYTES) return { ok: false, code: 'ARTIFACT_REF_TOO_LARGE' };
  if (typeof input?.hmacKey === 'string' && input.hmacKey !== '') ref.hmac = hmacOf(ref, input.hmacKey);
  return { ok: true, ref };
}

/** Verify shape, size, the absence of a plaintext hash, and the HMAC when a key is supplied. */
export function verifyArtifactRef(ref, options = {}) {
  if (ref === null || typeof ref !== 'object') return { ok: false, code: 'ARTIFACT_REF_INVALID' };
  if (ref.v !== ARTIFACT_REF_VERSION) return { ok: false, code: 'ARTIFACT_VERSION_UNSUPPORTED' };
  if (Buffer.byteLength(JSON.stringify(ref), 'utf8') > MAX_REF_BYTES) return { ok: false, code: 'ARTIFACT_REF_TOO_LARGE' };
  if (!HEX32.test(String(ref.object_id ?? ''))) return { ok: false, code: 'ARTIFACT_OBJECT_ID_INVALID' };
  if (!HEX64.test(String(ref?.cipher?.sha256 ?? ''))) return { ok: false, code: 'ARTIFACT_CIPHER_SHA_INVALID' };
  if (typeof ref?.sink?.rel_path !== 'string' || ref.sink.rel_path.includes('..')) return { ok: false, code: 'ARTIFACT_PATH_INVALID' };
  if (ref?.plain !== undefined && ref.plain !== null && typeof ref.plain === 'object' && 'sha256' in ref.plain) {
    return { ok: false, code: 'ARTIFACT_PLAINTEXT_HASH_FORBIDDEN' };
  }
  for (const key of ['plain_sha256', 'sha256_plain', 'content_sha256']) {
    if (key in ref) return { ok: false, code: 'ARTIFACT_PLAINTEXT_HASH_FORBIDDEN' };
  }
  if (typeof options.hmacKey === 'string' && options.hmacKey !== '') {
    if (typeof ref.hmac !== 'string') return { ok: false, code: 'ARTIFACT_HMAC_MISSING' };
    const { hmac: _ignored, ...body } = ref;
    const expected = hmacOf(body, options.hmacKey);
    if (expected !== ref.hmac) return { ok: false, code: 'ARTIFACT_HMAC_INVALID' };
  }
  return { ok: true, digest: digest(ref) };
}
