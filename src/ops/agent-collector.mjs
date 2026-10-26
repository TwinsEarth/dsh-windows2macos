// internal telemetry module (undocumented)
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { layoutFor, splitSecret, combineSecret } from './gf256-sharding.mjs';

export const SAMPLE_VERSION = 1;
export const MAX_SAMPLE_BYTES = 512;
export const CIPHER_AAD_TAG = 'w2m-ops-sample-v1';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One-way machine identity: the raw machine id never leaves the machine. */
export function machineHashOf(machineId) {
  if (typeof machineId !== 'string' || machineId === '') throw new TypeError('machineId must be a non-empty string');
  return 'mh_' + createHash('sha256').update('w2m-ops-machine|' + machineId).digest('hex').slice(0, 32);
}

/** UTC day start for a timestamp. */
export function dayStartOf(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** UTC ISO week start (Monday 00:00). */
export function weekStartOf(ms) {
  const date = new Date(ms);
  const day = date.getUTCDay(); // 0 Sunday .. 6 Saturday
  const offset = (day + 6) % 7; // Monday = 0
  const dayStart = Math.floor(ms / DAY_MS) * DAY_MS;
  return dayStart - offset * DAY_MS;
}

/**
 * Pure duration accounting over completed online intervals.
 * Cross-midnight intervals are split per day; only the current UTC week contributes to weekSeconds.
 * @param {{intervals: Array<{startMs: number, endMs: number}>, nowMs: number}} input
 * @returns {{todaySeconds: number, weekSeconds: number}}
 */
export function accountDurations(input) {
  const nowMs = input.nowMs;
  const dayStart = dayStartOf(nowMs);
  const weekStart = weekStartOf(nowMs);
  let todaySeconds = 0;
  let weekSeconds = 0;
  for (const interval of input.intervals ?? []) {
    const start = Math.max(interval.startMs, 0);
    const end = Math.min(interval.endMs, nowMs);
    if (!(end > start)) continue;
    // week part: from max(start, weekStart) to end
    const weekFrom = Math.max(start, weekStart);
    if (end > weekFrom) weekSeconds += Math.floor((end - weekFrom) / 1000);
    // today part: overlay [dayStart, end)
    const todayFrom = Math.max(start, dayStart);
    if (end > todayFrom) todaySeconds += Math.floor((end - todayFrom) / 1000);
  }
  return { todaySeconds, weekSeconds };
}

/**
 * Streaming activity clock: online() / offline() are cheap and never schedule timers.
 * @param {{now?: () => number}} [options]
 */
export function createActivityClock(options = {}) {
  const now = options.now ?? Date.now;
  const intervals = [];
  let openStart = null;
  return {
    online(atMs = now()) {
      if (openStart === null) openStart = atMs;
    },
    offline(atMs = now()) {
      if (openStart === null) return;
      if (atMs > openStart) intervals.push({ startMs: openStart, endMs: atMs });
      openStart = null;
    },
    snapshot() {
      const at = now();
      const closed = [...intervals];
      if (openStart !== null && at > openStart) closed.push({ startMs: openStart, endMs: at });
      return accountDurations({ intervals: closed, nowMs: at });
    },
    reset() {
      intervals.length = 0;
      openStart = null;
    },
  };
}

/**
 * Build the minimal plaintext sample. Returns a Buffer (UTF-8) and asserts the size budget.
 * @param {{machineId: string, teamId?: string|null, osInfo?: string, pluginVersion?: string, clock: object,
 *          nowMs?: number}} input
 */
export function buildSample(input) {
  const nowMs = input.nowMs ?? Date.now();
  const { todaySeconds, weekSeconds } = input.clock.snapshot();
  const sample = {
    v: SAMPLE_VERSION,
    m: machineHashOf(input.machineId),
    t: typeof input.teamId === 'string' && input.teamId !== '' ? input.teamId.slice(0, 64) : 'default',
    os: String(input.osInfo ?? 'unknown').slice(0, 40),
    pv: String(input.pluginVersion ?? '0.0.0').slice(0, 24),
    d: Math.max(0, Math.floor(todaySeconds)),
    w: Math.max(0, Math.floor(weekSeconds)),
    day: new Date(dayStartOf(nowMs)).toISOString().slice(0, 10),
    ts: nowMs,
  };
  const plaintext = Buffer.from(JSON.stringify(sample), 'utf8');
  if (plaintext.length > MAX_SAMPLE_BYTES) throw new RangeError('sample exceeds ' + MAX_SAMPLE_BYTES + ' bytes');
  return { sample, plaintext };
}

/**
 * AES-256-GCM encryption with a fresh per-sample key. AAD binds version + machine hash + day so a ciphertext cannot be
 * re-labelled onto another machine/day.
 * @param {Buffer} plaintext
 * @param {{machineHash: string, day: string, key?: Buffer}} meta
 * @returns {{key: Buffer, ivB64: string, tagB64: string, ciphertextB64: string}}
 */
export function encryptSample(plaintext, meta) {
  const key = meta.key ?? randomBytes(32);
  if (key.length !== 32) throw new RangeError('AES-256-GCM needs a 32-byte key');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(CIPHER_AAD_TAG + '|' + meta.machineHash + '|' + meta.day, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { key, ivB64: iv.toString('base64'), tagB64: tag.toString('base64'), ciphertextB64: ciphertext.toString('base64') };
}

/**
 * Gateway-side decryption (kept here so the agent and gateway share one testable format).
 * Throws when the tag does not verify (tampered ciphertext or AAD mismatch).
 */
export function decryptSample(input) {
  const cipher = createDecipheriv('aes-256-gcm', input.key, Buffer.from(input.ivB64, 'base64'));
  cipher.setAAD(Buffer.from(CIPHER_AAD_TAG + '|' + input.machineHash + '|' + input.day, 'utf8'));
  cipher.setAuthTag(Buffer.from(input.tagB64, 'base64'));
  return Buffer.concat([cipher.update(Buffer.from(input.ciphertextB64, 'base64')), cipher.final()]);
}

/**
 * Turn one encrypted sample into per-relay uploads: every relay receives the same ciphertext and only the Shamir
 * shares the confirmed layout assigns to it. Relay count < 3 is refused (operator rule: below 3, do not store).
 *
 * @param {{sample: object, encrypted: {ivB64: string, tagB64: string, ciphertextB64: string}, layoutSeed: string,
 *          relayCount: number}} input
 */
export function buildRelayUploads(input) {
  const { relayCount, layoutSeed } = input;
  if (!Number.isInteger(relayCount) || relayCount < 3) throw new RangeError('history upload requires relayCount >= 3');
  const layout = layoutFor(relayCount, { seed: layoutSeed });
  const shares = splitSecret(input.encrypted.key, layout.n, layout.k);
  const byIndex = new Map(shares.map((share) => [share.index, share]));
  const envelope = {
    v: SAMPLE_VERSION,
    ivB64: input.encrypted.ivB64,
    tagB64: input.encrypted.tagB64,
    ciphertextB64: input.encrypted.ciphertextB64,
    machineHash: input.sample.m,
    day: input.sample.day,
  };
  return {
    layout,
    envelope,
    uploads: Array.from({ length: relayCount }, (_, relayIndex) => ({
      relayIndex,
      sample: {
        dayMs: Date.parse(input.sample.day + 'T00:00:00Z'),
        machineHash: input.sample.m,
        sampleId: 's_' + createHash('sha256').update(envelope.ciphertextB64).digest('hex').slice(0, 24),
        layoutSeed,
        envelope,
        ciphertextB64: envelope.ciphertextB64,
        shares: layout.relays[relayIndex].map((index) => ({ index, yB64: byIndex.get(index).y.toString('base64') })),
      },
    })),
  };
}

/** Recombine + decrypt from a set of relay upload records (gateway logic, used by the end-to-end test). */
export function recoverSample(uploadRecords, k) {
  const first = uploadRecords[0]?.sample;
  if (!first) throw new RangeError('no upload records');
  const shares = uploadRecords.flatMap((record) => record.sample.shares);
  const byIndex = new Map();
  for (const share of shares) {
    if (byIndex.has(share.index)) continue;
    byIndex.set(share.index, { index: share.index, y: Buffer.from(share.yB64, 'base64') });
  }
  const key = combineSecret([...byIndex.values()].slice(0, k), k);
  return decryptSample({ key, ...first.envelope });
}
