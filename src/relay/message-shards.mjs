/**
 * Chat history, encrypted and split across the fleet's own machines.
 *
 * ## The three rules that keep "distributed storage" from becoming "lost data"
 *
 * 1. **Rebuildable.** Any single message must be recoverable from the shards that exist, and the metadata says where they
 *    are: \`{machine_id, part, total, sha256}\` per shard. A reader never has to guess who holds what.
 * 2. **Offline tolerated.** Each part is assigned to **two distinct** machines. One machine being down is the normal
 *    case, not the failure case, and a single copy would make it a data-loss case.
 * 3. **Integrity.** Every shard carries sha256 of its own bytes. A shard that does not match is corrupt and is named;
 *    it is never silently decrypted into garbage. Missing shards are named too -- "some data is gone" without saying
 *    which part is gone is not a report, it is a shrug.
 *
 * ## Encryption
 *
 * AES-256-GCM with a key derived from the fleet key (the same secret that already authorises joining, so no new
 * long-lived secret appears). The IV is generated per day-batch and travels in the header; the auth tag is verified before
 * any plaintext is returned, so a wrong key or a tampered ciphertext fails loudly.
 *
 * ## What this file does NOT do
 *
 * It does not decide where the machines are or how bytes reach them. It produces the shards and reassembles them; the
 * relay owns transport. Keeping the split here is what makes it testable without a fleet.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Default slice size for one shard: small enough to distribute, large enough not to explode the shard count. */
export const DEFAULT_SHARD_BYTES = 256 * 1024;
/** Two copies, per rule 2. */
export const DEFAULT_REPLICAS = 2;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const dayKey = (atMs) => new Date(atMs).toISOString().slice(0, 10);

/** Derive the encryption key from the fleet key. Same secret, different purpose, separated label. */
export function deriveShardKey(fleetKey) {
  if (typeof fleetKey !== 'string' || fleetKey === '') throw new TypeError('fleetKey must be a non-empty string');
  return createHash('sha256').update('w2m-chat-shards-v1').update('\u0000').update(fleetKey).digest();
}

/**
 * Split one day's messages into encrypted shards and assign each part to replica machines.
 *
 * @param {{messages: object[], fleetKey: string, machines: string[], shardBytes?: number, replicas?: number,
 *          at_ms?: number}} input
 * @returns {{ok: true, day: string, shards: object[], header: object} | {ok: false, code: string}}
 */
export function buildShards({ messages, fleetKey, machines, shardBytes = DEFAULT_SHARD_BYTES, replicas = DEFAULT_REPLICAS, at_ms }) {
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, code: 'NOTHING_TO_SHARD' };
  if (!Array.isArray(machines) || machines.length === 0) return { ok: false, code: 'NO_MACHINES' };
  if (replicas > machines.length) return { ok: false, code: 'NOT_ENOUGH_MACHINES', detail: { machines: machines.length, replicas } };
  const key = deriveShardKey(fleetKey);
  const at = Number.isFinite(at_ms) ? at_ms : messages[0].at_ms ?? Date.now();
  const day = dayKey(at);
  const plaintext = Buffer.from(JSON.stringify(messages), 'utf8');

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const sealed = Buffer.concat([ciphertext, tag]);

  const total = Math.max(1, Math.ceil(sealed.length / shardBytes));
  const shards = [];
  for (let part = 0; part < total; part += 1) {
    const body = sealed.subarray(part * shardBytes, (part + 1) * shardBytes);
    const digest = sha256(body);
    // Rule 2: distinct machines per part, rotating so the copies are not all on the same pair.
    const holders = [];
    for (let r = 0; r < replicas; r += 1) holders.push(machines[(part + r) % machines.length]);
    for (const machineId of holders) {
      shards.push({
        day, part, total, machine_id: machineId, sha256: digest,
        bytes: body.length, body: body.toString('base64'),
      });
    }
  }
  return { ok: true, day, shards, header: { iv: iv.toString('base64'), algorithm: 'aes-256-gcm', total, day } };
}

/**
 * Reassemble the day's messages from whatever shards are available.
 *
 * Every failure is named: a missing part, a corrupt part, and a failed authentication are three different operational
 * facts and a caller that cannot tell them apart cannot decide whether to retry another replica.
 *
 * @param {{shards: object[], header: object, fleetKey: string}} input
 * @returns {{ok: true, messages: object[]} | {ok: false, code: string, detail?: object}}
 */
export function assembleShards({ shards, header, fleetKey }) {
  if (!Array.isArray(shards) || shards.length === 0) return { ok: false, code: 'NO_SHARDS' };
  if (header === null || typeof header !== 'object') return { ok: false, code: 'NO_HEADER' };
  const total = header.total;
  const byPart = new Map();
  for (const shard of shards) {
    if (sha256(Buffer.from(shard.body, 'base64')) !== shard.sha256) {
      return { ok: false, code: 'SHARD_CORRUPT', detail: { part: shard.part, machine_id: shard.machine_id } };
    }
    if (!byPart.has(shard.part)) byPart.set(shard.part, shard);
  }
  const missing = [];
  for (let part = 0; part < total; part += 1) if (!byPart.has(part)) missing.push(part);
  if (missing.length > 0) return { ok: false, code: 'MISSING_SHARDS', detail: { missing } };

  const ordered = [];
  for (let part = 0; part < total; part += 1) ordered.push(Buffer.from(byPart.get(part).body, 'base64'));
  const sealed = Buffer.concat(ordered);
  const tag = sealed.subarray(sealed.length - 16);
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveShardKey(fleetKey), Buffer.from(header.iv, 'base64'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { ok: true, messages: JSON.parse(plaintext.toString('utf8')) };
  } catch {
    // Wrong key or tampered ciphertext: never return partial plaintext.
    return { ok: false, code: 'AUTH_FAILED' };
  }
}

/** Which shards does a reader hold for one machine? Transport uses this; it does not read the bodies. */
export function shardsForMachine(shards, machineId) {
  return shards.filter((shard) => shard.machine_id === machineId).map(({ body, ...meta }) => meta);
}
