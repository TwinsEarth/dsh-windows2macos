// internal telemetry module (undocumented)
import { encryptSample, buildRelayUploads } from './agent-collector.mjs';
import { nextUploadAt, startupDelayMs, mayPersist } from './upload-scheduler.mjs';

export const DEFAULT_RETRY = Object.freeze({ maxAttempts: 4, baseDelayMs: 2_000, maxDelayMs: 60_000 });

/**
 * @param {{
 *   relayCount: number,
 *   layoutSeed?: string,
 *   now?: () => number,
 *   postShard: (relayIndex: number, payload: object) => Promise<void> | void,
 *   sleep?: (ms: number) => Promise<void>,
 *   retry?: {maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number},
 *   onEvent?: (event: object) => void,
 * }} options
 */
export function createOpsUploader(options) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const retry = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
  const onEvent = options.onEvent ?? (() => {});
  const relayCount = options.relayCount;
  const layoutSeed = options.layoutSeed ?? 'auto';

  /** Build and push one sample to every relay. Returns per-relay outcomes; never throws on transport failure. */
  async function uploadSample(input) {
    const t = input.nowMs ?? now();
    if (!mayPersist({ writableRelays: relayCount, isHistory: true })) {
      return { skipped: true, reason: 'NEED_AT_LEAST_3_RELAYS', relayCount };
    }
    const encrypted = encryptSample(input.plaintext, { machineHash: input.sample.m, day: input.sample.day });
    const seed = layoutSeed === 'auto' ? input.sample.day + '|' + input.sample.m : layoutSeed;
    const built = buildRelayUploads({ sample: input.sample, encrypted, layoutSeed: seed, relayCount });
    const results = [];
    for (const upload of built.uploads) {
      let attempt = 0;
      let lastError = null;
      while (attempt < retry.maxAttempts) {
        attempt += 1;
        try {
          await options.postShard(upload.relayIndex, upload.sample);
          results.push({ relayIndex: upload.relayIndex, ok: true, attempts: attempt });
          break;
        } catch (error) {
          lastError = error;
          onEvent({ type: 'upload-retry', relayIndex: upload.relayIndex, attempt, message: String(error).slice(0, 120) });
          if (attempt >= retry.maxAttempts) {
            results.push({ relayIndex: upload.relayIndex, ok: false, attempts: attempt, error: String(lastError).slice(0, 120) });
            break;
          }
          const delay = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
          await sleep(delay);
        }
      }
    }
    const ok = results.filter((result) => result.ok).length;
    onEvent({ type: 'upload-done', at: t, ok, total: results.length, machineHash: input.sample.m });
    return { skipped: false, results, ok, total: results.length };
  }

  return {
    uploadSample,
    /** Next monthly-independent hourly slot for this machine (random per hour, stable for retries). */
    planHourly(machineId, atMs = now(), fleetSize = options.fleetSize ?? 0) {
      return nextUploadAt({ machineId, nowMs: atMs, fleetSize });
    },
    /** 1–5 minute random delay after (re)connect. */
    reconnectDelay(machineId, sessionSalt, fleetSize = options.fleetSize ?? 0) {
      return startupDelayMs({ machineId, sessionSalt, fleetSize });
    },
    minRelays: 3,
  };
}

/** Guard for the plugin mount: keep the schedule reference-free so unload cannot leave a timer behind. */
export function safeInterval(handler, ms, setIntervalFn = setInterval) {
  const timer = setIntervalFn(handler, ms);
  return () => clearInterval(timer);
}
