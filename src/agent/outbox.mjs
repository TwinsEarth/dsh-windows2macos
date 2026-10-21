/**
 * Result outbox (M6, v1.3.10-beta.21 slice).
 *
 * A machine can finish a task while the network is down. The result must not live only in memory: it goes to disk first, is
 * re-delivered on reconnect, and is removed only after the relay acknowledged it. The relay deduplicates by
 * (task_id, attempt), so a re-delivery is safe even when the acknowledgement itself was lost.
 *
 * Files are written atomically (temp + rename), so a crash leaves either the old state or the complete new one. Retries use
 * exponential backoff persisted with the entry, which is what makes "close the laptop for an hour" a resume rather than a
 * restart.
 *
 * Limits: at most 200 entries / 16 MiB. Past that the OLDEST entries are dropped and the caller sees outbox_full:true, because
 * a full disk is a worse failure than a lost notification about old work.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OUTBOX_LIMITS = Object.freeze({ maxItems: 200, maxBytes: 16 * 1024 * 1024, maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 60_000 });

const resultIdOf = (taskId, attempt) => taskId + ':' + String(attempt);

export function createResultOutbox({ dir, now = () => Date.now(), limits = OUTBOX_LIMITS }) {
  if (typeof dir !== 'string' || dir === '') throw new Error('outbox dir is required');
  const deadDir = join(dir, 'dead');
  mkdirSync(dir, { recursive: true });
  mkdirSync(deadDir, { recursive: true });

  const fileOf = (resultId) => join(dir, resultId.replace(/[^A-Za-z0-9._-]/g, '_') + '.json');

  const serialize = (item) => {
    const envelopeJson = JSON.stringify(item.envelope ?? null);
    return { ...item, payload_sha256: createHash('sha256').update(envelopeJson).digest('hex') };
  };

  const writeAtomic = (item) => {
    const target = fileOf(item.result_id);
    const temp = target + '.tmp';
    writeFileSync(temp, JSON.stringify(item) + '\n', 'utf8');
    renameSync(temp, target);
    return target;
  };

  /** Read every entry on disk; a corrupt file is quarantined instead of breaking the agent on start. */
  const load = () => {
    const items = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, name);
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof parsed?.result_id !== 'string' || typeof parsed?.task_id !== 'string') throw new Error('not an outbox entry');
        items.push(parsed);
      } catch {
        try { renameSync(path, join(deadDir, name + '.corrupt')); } catch { /* best effort */ }
      }
    }
    items.sort((a, b) => (a.created_at_ms ?? 0) - (b.created_at_ms ?? 0) || a.result_id.localeCompare(b.result_id));
    return items;
  };

  const sizeOf = (items) => items.reduce((sum, item) => sum + statSize(item), 0);
  const statSize = (item) => Buffer.byteLength(JSON.stringify(item), 'utf8');

  /** Drop the oldest entries until the new one fits. Returns how many went. */
  const makeRoom = (items, incoming) => {
    let dropped = 0;
    while (items.length > 0 && (items.length >= limits.maxItems || sizeOf(items) + statSize(incoming) > limits.maxBytes)) {
      const oldest = items.shift();
      try { rmSync(fileOf(oldest.result_id), { force: true }); } catch { /* already gone */ }
      dropped += 1;
    }
    return dropped;
  };

  return {
    /** Persist a result; the same (task_id, attempt) is one entry, so a retried handler does not duplicate it. */
    enqueue({ taskId, attempt, dedupeKey = '', envelope }) {
      if (typeof taskId !== 'string' || taskId === '') throw new Error('task_id is required');
      if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer');
      const resultId = resultIdOf(taskId, attempt);
      const existing = fileOf(resultId);
      if (existsSync(existing)) {
        const item = JSON.parse(readFileSync(existing, 'utf8'));
        return { ok: true, duplicate: true, item };
      }
      const at = now();
      const item = serialize({
        result_id: resultId,
        task_id: taskId,
        attempt,
        dedupe_key: typeof dedupeKey === 'string' ? dedupeKey : '',
        envelope: envelope ?? null,
        attempts: 0,
        next_retry_ms: at,
        created_at_ms: at,
        created_at: new Date(at).toISOString(),
      });
      if (statSize(item) > limits.maxBytes) return { ok: false, code: 'OUTBOX_FULL', detail: 'the result alone exceeds the outbox byte limit', bytes: statSize(item) };
      const items = load();
      const dropped = makeRoom(items, item);
      writeAtomic(item);
      return { ok: true, item, outbox_full: dropped > 0, dropped };
    },
    /** Entries whose backoff expired; a caller drains these and calls ack or fail for each. */
    pending() {
      const at = now();
      return load().filter((item) => (item.next_retry_ms ?? 0) <= at);
    },
    ack({ resultId }) {
      const path = fileOf(resultId);
      if (!existsSync(path)) return { ok: false, code: 'OUTBOX_NOT_FOUND', result_id: resultId };
      rmSync(path, { force: true });
      return { ok: true };
    },
    /** Count a failed delivery. Backoff doubles per attempt; past maxAttempts the entry moves to dead/ and is reported exhausted. */
    fail({ resultId, error = null }) {
      const path = fileOf(resultId);
      if (!existsSync(path)) return { ok: false, code: 'OUTBOX_NOT_FOUND', result_id: resultId };
      const item = JSON.parse(readFileSync(path, 'utf8'));
      item.attempts = (item.attempts ?? 0) + 1;
      item.last_error = error === null ? null : String(error).slice(0, 500);
      if (item.attempts >= limits.maxAttempts) {
        try { renameSync(path, join(deadDir, 'exhausted-' + item.result_id.replace(/[^A-Za-z0-9._-]/g, '_') + '.json')); } catch { rmSync(path, { force: true }); }
        return { ok: true, exhausted: true, attempts: item.attempts };
      }
      const delay = Math.min(limits.baseDelayMs * 2 ** (item.attempts - 1), limits.maxDelayMs);
      item.next_retry_ms = now() + delay;
      writeAtomic(item);
      return { ok: true, exhausted: false, attempts: item.attempts, retry_in_ms: delay };
    },
    stats() {
      const items = load();
      return { depth: items.length, bytes: sizeOf(items), limits: { maxItems: limits.maxItems, maxBytes: limits.maxBytes } };
    },
    list() { return load(); },
  };
}
