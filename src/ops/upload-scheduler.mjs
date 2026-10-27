// internal telemetry module (undocumented)
import { createHash } from 'node:crypto';

/** Hot data exists for 72 h; persistence of history needs at least three writable relays. */
export const MIN_RELAYS_TO_STORE = 3;

/** Operator decision: when the real online count cannot be fetched from a relay, use 2,026 machines. */
export const DEFAULT_FLEET_SIZE = 2026;

/** Normalize a fleet-size observation; anything missing/invalid/non-positive becomes the 2,026 default. */
export function fleetSizeOrDefault(observed) {
  const size = Number(observed);
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : DEFAULT_FLEET_SIZE;
}
export const HOUR_MS = 60 * 60 * 1000;
export const MAX_HOT_MS = 72 * HOUR_MS;

/**
 * Fleet-size tiers: the larger the fleet, the wider the random upload window and the longer the reconnect jitter, so
 * the relay sees an even trickle instead of a synchronized wave.
 */
export const UPLOAD_TIERS = Object.freeze([
  { above: 100_000, windowMs: 23 * HOUR_MS, reconnectMinMs: 5 * 60_000, reconnectMaxMs: 555 * 60_000, label: '>100k' },
  { above: 10_000, windowMs: 12 * HOUR_MS, reconnectMinMs: 5 * 60_000, reconnectMaxMs: 50 * 60_000, label: '>10k' },
  { above: 1_000, windowMs: 2 * HOUR_MS, reconnectMinMs: 3 * 60_000, reconnectMaxMs: 10 * 60_000, label: '>1k' },
  { above: -1, windowMs: HOUR_MS, reconnectMinMs: 60_000, reconnectMaxMs: 5 * 60_000, label: 'default' },
]);

/** Pick the tier for a fleet size. */
export function tierForFleetSize(fleetSize = 0) {
  const size = Number.isFinite(fleetSize) && fleetSize > 0 ? fleetSize : 0;
  return UPLOAD_TIERS.find((tier) => size > tier.above) ?? UPLOAD_TIERS[UPLOAD_TIERS.length - 1];
}

const digest = (text) => createHash('sha256').update(text).digest();

/** Uniform-ish [0, bound) from a hash; bound must be a positive safe integer. */
function hashInt(text, bound) {
  const value = digest(text).readUIntBE(0, 6); // 48 bits of entropy
  return value % bound;
}

/**
 * The upload instant for one machine inside one hour.
 * @param {{machineId: string, nowMs?: number, hourOffsetMs?: number}} input
 * @returns {number} epoch ms, strictly inside (hourStart, hourStart + 1h]
 */
export function uploadAtForHour(input) {
  return uploadAtForWindow(input);
}

/**
 * The upload instant inside the current tier window. Deterministic for a machine within one window (safe retries),
 * rotated each window, uniform across the fleet.
 * @param {{machineId: string, nowMs?: number, fleetSize?: number}} input
 */
export function uploadAtForWindow(input) {
  const nowMs = input.nowMs ?? Date.now();
  const tier = tierForFleetSize(input.fleetSize);
  const windowIndex = Math.floor(nowMs / tier.windowMs);
  const offset = hashInt('w2m-ops-upload-v2|' + input.machineId + '|' + windowIndex, tier.windowMs - 1_000);
  return windowIndex * tier.windowMs + 1_000 + offset;
}

/**
 * Next upload instant at or after `nowMs` (rolls into the next hour when this hour's slot is already past).
 * @param {{machineId: string, nowMs?: number}} input
 * @returns {number}
 */
export function nextUploadAt(input) {
  const nowMs = input.nowMs ?? Date.now();
  const tier = tierForFleetSize(input.fleetSize);
  const current = uploadAtForWindow({ ...input, nowMs });
  if (current > nowMs) return current;
  return uploadAtForWindow({ ...input, nowMs: nowMs + tier.windowMs });
}

/**
 * Delay before the first upload after (re)connect: 1–5 minutes, deterministic per session.
 * @param {{machineId: string, sessionSalt: string}} input
 * @returns {number} ms in [60_000, 300_000]
 */
export function startupDelayMs(input) {
  const tier = tierForFleetSize(input.fleetSize);
  const span = tier.reconnectMaxMs - tier.reconnectMinMs;
  return tier.reconnectMinMs + hashInt('w2m-ops-startup-v2|' + input.machineId + '|' + input.sessionSalt, span + 1);
}

/** Whether a sample may be persisted to relays (hot always, history only with N >= 3 writable relays). */
export function mayPersist({ writableRelays, isHistory = true }) {
  if (!Number.isInteger(writableRelays) || writableRelays < 0) throw new RangeError('writableRelays must be an integer');
  return isHistory ? writableRelays >= MIN_RELAYS_TO_STORE : writableRelays >= 1;
}

/** Hot retention: a sample older than 72 h is no longer hot. */
export function isHot(ageMs) {
  return ageMs <= MAX_HOT_MS;
}

/**
 * Fleet spread statistics for 1-minute buckets, used by the tests (and by a deployment check) to prove the scheduler
 * is not a thundering herd.
 * @param {string[]} machineIds
 * @param {number} [nowMs]
 */
export function spreadStats(machineIds, nowMs = Date.now(), fleetSize = 0) {
  const tier = tierForFleetSize(fleetSize);
  const buckets = new Map();
  const offsets = [];
  for (const machineId of machineIds) {
    const at = uploadAtForWindow({ machineId, nowMs, fleetSize });
    const offset = at - Math.floor(nowMs / tier.windowMs) * tier.windowMs;
    offsets.push(offset);
    const bucket = Math.floor(offset / 60_000);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  const counts = [...buckets.values()];
  const max = counts.reduce((a, b) => Math.max(a, b), 0);
  const min = counts.reduce((a, b) => Math.min(a, b), Infinity);
  const unique = new Set(offsets).size;
  return { machines: machineIds.length, bucketsUsed: buckets.size, max, min, uniqueOffsets: unique };
}
