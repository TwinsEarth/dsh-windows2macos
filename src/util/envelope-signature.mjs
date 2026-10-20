/**
 * Envelope signatures: what a machine signed, and how a reader checks it.
 *
 * ## Why the payload is exactly four fields
 *
 * A signature over "the whole envelope" is impossible to verify reproducibly: the envelope carries hashes, timestamps and
 * transport facts that change between the signing machine and the reader. So the machine signs the four facts that identify
 * THE COMMAND: task id, argv hash (the envelope's command_hash), machine id, and when it signed. Everything else in the
 * envelope is covered indirectly through those, and a reader verifies exactly this tuple.
 *
 * ## Why verification returns a status rather than throwing
 *
 * "unsigned" is not an error -- a machine running an older build, or one configured without a device key, is a fact to report.
 * "bad_signature" is the interesting case: the data does not match the signature, which is exactly what tampering looks like.
 * A caller must see the difference, so both are values.
 */
import { createPublicKey, verify } from 'node:crypto';

/** The DER prefix for an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * The canonical bytes a machine signs. Sorted keys, no whitespace, so the same tuple always produces the same bytes.
 *
 * @param {{task_id: string, argv_hash: string, machine_id: string, ts: string}} input
 * @returns {string}
 */
export function canonicalSignedPayload({ task_id: taskId, argv_hash: argvHash, machine_id: machineId, ts }) {
  return JSON.stringify({
    argv_hash: String(argvHash ?? ''),
    machine_id: String(machineId ?? ''),
    task_id: String(taskId ?? ''),
    ts: String(ts ?? ''),
  });
}

/**
 * @param {string|null} publicKeyBase64
 * @returns {import('node:crypto').KeyObject|null}
 */
export function publicKeyFromBase64(publicKeyBase64) {
  if (typeof publicKeyBase64 !== 'string' || publicKeyBase64 === '') return null;
  try {
    const raw = Buffer.from(publicKeyBase64, 'base64');
    if (raw.length !== 32) return null;
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/**
 * @param {{signature?: object|null, task_id?: string, argv_hash?: string, machine_id?: string, ts?: string}} input
 * @returns {'signed'|'unsigned'|'bad_signature'|'unsupported_algorithm'}
 */
export function verifyEnvelopeSignature({ signature = null, task_id: taskId, argv_hash: argvHash, machine_id: machineId, ts } = {}) {
  if (signature === null || signature === undefined || typeof signature !== 'object') return 'unsigned';
  if (signature.alg !== 'ed25519') return 'unsupported_algorithm';
  if (typeof signature.value !== 'string' || signature.value === '') return 'bad_signature';
  const key = publicKeyFromBase64(signature.public_key);
  if (key === null) return 'bad_signature';
  const payload = canonicalSignedPayload({ task_id: taskId, argv_hash: argvHash, machine_id: machineId, ts: signature.ts ?? ts });
  try {
    const ok = verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signature.value, 'base64'));
    return ok ? 'signed' : 'bad_signature';
  } catch {
    return 'bad_signature';
  }
}
