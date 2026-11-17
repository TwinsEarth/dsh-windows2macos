/**
 * The cached runtime verdict (G5) and the state file it lives in.
 *
 * ## Why a cache, and why it is labelled
 *
 * A full runtime verdict spawns the installed Harness once and decodes every session log plus one legal append.
 * That is the gate (`evidence: 'installed-harness'`), but it is measured in minutes and it needs an installation.
 * The panel must not block on it, and an operator opening the page should not have to wait for it to learn what the
 * last verdict was. So the verdict is a **record**: written when a runtime verify finishes, read back by the cache
 * route and by the embedded status, and marked `stale` once it is older than a day.
 *
 * A record is data, never an inference: `buildRuntimeVerdictRecord` copies the counts and the reason codes out of a
 * real `verifyRepo({runtime:true})` result. Nothing here decides whether a session is valid.
 *
 * ## Where it is persisted
 *
 * `<DSH_HOME>/xclient/w2m-backup/state.json` -- the `xclient/` tree is this package's own state area (the same
 * convention `dsh-fix` uses for its mount marker; DSH's `storages/` is client-owned and must not be written by a
 * plugin that is not the client). The write is atomic and best effort: losing the record must never fail the
 * verify that produced it, so the caller gets a `persisted: false` and a `persist_error`, not an exception.
 *
 * ## `backupRuntimeVerify`
 *
 * `'off'` (default) | `'nightly'`. `nightly` means "after the scheduled backup (including a missed-slot catch-up),
 * run the runtime verify once and store the record". It never gates the backup: the backup result is returned
 * first, the verdict runs after it, and a failure is logged as a warning with the record still persisted. A
 * manual one-shot is the CLI's `run --runtime-verify` and the panel's "run now" button (`?runtime=1`).
 */

import fs from 'node:fs';
import path from 'node:path';

import { writeJsonAtomic } from './atomic.mjs';

/** The evidence label a cached runtime verdict always carries. */
export const RUNTIME_VERDICT_EVIDENCE = 'installed-harness';

/** How old a cached verdict may be before it is reported as stale. */
export const DEFAULT_RUNTIME_VERDICT_STALE_MS = 24 * 60 * 60 * 1000;

/** The engine/schedule option's accepted values; anything else is a configuration error. */
export const RUNTIME_VERDICT_MODES = Object.freeze(['off', 'nightly']);

/** File name inside the plugin state directory. */
export const BACKUP_STATE_FILE_NAME = 'state.json';

/** Named refusal when a manual runtime verdict is asked to run while one is already running. */
export const RUNTIME_VERDICT_BUSY = 'BACKUP_VERIFY_BUSY';

/**
 * The plugin state directory inside a DSH home: `<dshHome>/xclient/w2m-backup/`.
 *
 * @param {string} dshHome
 * @returns {string}
 */
export function backupStateDir(dshHome) {
  return path.join(dshHome, 'xclient', 'w2m-backup');
}

/**
 * Absolute path of the persisted plugin state (`state.json`).
 *
 * @param {string} dshHome
 * @returns {string}
 */
export function backupStateFile(dshHome) {
  return path.join(backupStateDir(dshHome), BACKUP_STATE_FILE_NAME);
}

/**
 * Read the persisted plugin state.
 *
 * Never throws: a missing file is a normal first run, and an unreadable/corrupt file is reported instead of
 * crashing the route that only wanted to show a cached verdict.
 *
 * @param {string} dshHome
 * @returns {{ok: boolean, file: string, state: object, error: string|null}}
 */
export function readBackupState(dshHome) {
  const file = backupStateFile(dshHome);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = error?.code;
    return {
      ok: false,
      file,
      state: {},
      error: code === 'ENOENT' ? null : `could not read ${file}: ${code ?? (error instanceof Error ? error.message : String(error))}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, file, state: {}, error: `${file} is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, file, state: {}, error: `${file} is not a JSON object` };
  }
  return { ok: true, file, state: parsed, error: null };
}

/**
 * Merge a patch into the persisted plugin state and write it atomically.
 *
 * Best effort by design: the caller has a real result to report and a state-file failure is a diagnostic, not an
 * outcome. Returns `{ok, file, error}` so the caller can log the reason without a `try/catch` at every call site.
 *
 * @param {string} dshHome
 * @param {object} patch
 * @returns {{ok: boolean, file: string, error: string|null}}
 */
export function writeBackupState(dshHome, patch) {
  const file = backupStateFile(dshHome);
  try {
    const current = readBackupState(dshHome).state;
    const next = { ...current, ...(patch !== null && typeof patch === 'object' ? patch : {}), format: 'w2m-session-backup/plugin-state', version: 1 };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, next);
    return { ok: true, file, error: null };
  } catch (error) {
    return { ok: false, file, error: error instanceof Error ? error.message : String(error) };
  }
}

/** One ISO timestamp from a Date, an epoch millisecond number, or now. */
function isoStamp(value, fallbackMs) {
  const ms = value instanceof Date ? value.getTime() : (Number.isFinite(Number(value)) ? Number(value) : fallbackMs);
  return new Date(ms).toISOString();
}

/** The reason codes of a verify result, deduplicated and bounded (a report must not grow without limit). */
function reasonCodesOf(verifyResult) {
  const problems = Array.isArray(verifyResult?.problems) ? verifyResult.problems : [];
  const codes = [];
  for (const problem of problems) {
    const code = typeof problem?.code === 'string' ? problem.code : null;
    if (code !== null && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

/**
 * Turn one real `verifyRepo({runtime:true})` result into the cached record.
 *
 * The record's shape is fixed: `{started_at, finished_at, ok, checked, failed, snapshots, reason_codes,
 * evidence}`. `checked`/`failed` come from `runtime_verified`; `snapshots` is how many snapshots the whole verify
 * walked (the context the runtime counts were produced in), not a runtime count. `evidence` is always
 * `'installed-harness'`: a record that could not get a runtime verdict is not a runtime verdict, so `ok` is false
 * and a reason code names why.
 *
 * @param {{
 *   verifyResult: object, startedAt?: Date|number, finishedAt?: Date|number,
 *   trigger?: string, runtimeAvailable?: boolean,
 * }} input
 * @returns {object}
 */
export function buildRuntimeVerdictRecord(input) {
  const verifyResult = input?.verifyResult ?? null;
  const nowMs = Date.now();
  const startedAt = isoStamp(input?.startedAt, nowMs);
  const finishedAt = isoStamp(input?.finishedAt, nowMs);
  const runtime = verifyResult?.runtime_verified ?? {};
  const checked = Number.isSafeInteger(runtime.checked) ? runtime.checked : 0;
  const failed = Number.isSafeInteger(runtime.failed) ? runtime.failed : 0;
  const snapshots = Number.isSafeInteger(verifyResult?.counts?.snapshots) ? verifyResult.counts.snapshots : 0;
  const runtimeAvailable = input?.runtimeAvailable ?? (verifyResult?.ok !== undefined && verifyResult?.reason_code !== 'BACKUP_RUNTIME_UNAVAILABLE');
  const reasonCodes = reasonCodesOf(verifyResult);
  if (runtimeAvailable !== true && !reasonCodes.includes('BACKUP_RUNTIME_UNAVAILABLE')) {
    reasonCodes.unshift('BACKUP_RUNTIME_UNAVAILABLE');
  }
  return {
    started_at: startedAt,
    finished_at: finishedAt,
    ok: verifyResult?.ok === true,
    checked,
    failed,
    snapshots,
    reason_codes: reasonCodes,
    evidence: RUNTIME_VERDICT_EVIDENCE,
    trigger: typeof input?.trigger === 'string' && input.trigger !== '' ? input.trigger : 'manual',
    duration_ms: Number.isSafeInteger(verifyResult?.duration_ms) ? verifyResult.duration_ms : null,
    runtime_available: runtimeAvailable === true,
  };
}

/**
 * Is a cached record stale?
 *
 * @param {object|null} record
 * @param {{nowMs?: number, staleAfterMs?: number}} [input]
 * @returns {{stale: boolean, age_ms: number|null, stale_after_ms: number}}
 */
export function runtimeVerdictStaleness(record, input = {}) {
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const staleAfterMs = Number.isSafeInteger(input.staleAfterMs) && input.staleAfterMs >= 0
    ? input.staleAfterMs
    : DEFAULT_RUNTIME_VERDICT_STALE_MS;
  const finishedMs = typeof record?.finished_at === 'string' ? Date.parse(record.finished_at) : Number.NaN;
  if (!Number.isFinite(finishedMs)) return { stale: true, age_ms: null, stale_after_ms: staleAfterMs };
  const ageMs = Math.max(0, nowMs - finishedMs);
  return { stale: ageMs > staleAfterMs, age_ms: ageMs, stale_after_ms: staleAfterMs };
}

/**
 * The cached-verdict store: one in-flight run at a time, a persisted record, and a read path that never spawns.
 *
 * @param {{
 *   dshHome: string, verify: () => object, now?: () => number,
 *   staleAfterMs?: number, persist?: boolean,
 * }} input
 * @returns {{
 *   stateFile: string,
 *   cached: () => {ok: boolean, cached: true, record: object|null, stale: boolean, age_ms: number|null,
 *     stale_after_ms: number, state_file: string},
 *   run: (options?: {trigger?: string}) => Promise<object>,
 *   record: () => object|null,
 *   describe: () => object,
 * }}
 */
export function createRuntimeVerdictStore(input = {}) {
  const dshHome = path.resolve(String(input.dshHome ?? ''));
  const verify = input.verify;
  if (typeof verify !== 'function') throw new TypeError('createRuntimeVerdictStore requires a verify function');
  const now = typeof input.now === 'function' ? input.now : Date.now;
  const staleAfterMs = Number.isSafeInteger(input.staleAfterMs) && input.staleAfterMs >= 0
    ? input.staleAfterMs
    : DEFAULT_RUNTIME_VERDICT_STALE_MS;
  const persist = input.persist !== false;
  const stateFile = backupStateFile(dshHome);
  let record = null;
  let inFlight = null;
  let runs = 0;
  let failures = 0;

  // The cached record is loaded once at construction: the panel and the embedded status read this object, and
  // the route that writes it updates the same object, so a read never has to touch the disk.
  try {
    const loaded = readBackupState(dshHome).state;
    if (loaded?.last_runtime_verify !== null && typeof loaded?.last_runtime_verify === 'object') {
      record = loaded.last_runtime_verify;
    }
  } catch {
    // A corrupt state file is a diagnostic; the store still works (it just starts uncached).
    record = null;
  }

  const cached = () => {
    const staleness = runtimeVerdictStaleness(record, { nowMs: now(), staleAfterMs });
    return {
      ok: true,
      cached: true,
      record,
      stale: staleness.stale,
      age_ms: staleness.age_ms,
      stale_after_ms: staleness.stale_after_ms,
      state_file: stateFile,
    };
  };

  const run = (options = {}) => {
    if (inFlight !== null) return inFlight;
    const startedAt = now();
    inFlight = (async () => {
      let verifyResult;
      let thrown = null;
      try {
        verifyResult = await verify();
      } catch (error) {
        thrown = error;
        verifyResult = {
          ok: false,
          reason_code: error?.code ?? 'BACKUP_FAILED',
          detail: error instanceof Error ? error.message : String(error),
          counts: { snapshots: 0 },
          runtime_verified: { checked: 0, failed: 0 },
          problems: [{ code: 'BACKUP_RUNTIME_UNAVAILABLE', detail: error instanceof Error ? error.message : String(error) }],
        };
      }
      const finishedAt = now();
      const next = buildRuntimeVerdictRecord({
        verifyResult,
        startedAt,
        finishedAt,
        trigger: options.trigger,
        runtimeAvailable: thrown === null,
      });
      record = next;
      runs += 1;
      if (next.ok !== true) failures += 1;
      let persisted = { ok: false, file: stateFile, error: null };
      if (persist) {
        persisted = writeBackupState(dshHome, {
          last_runtime_verify: next,
          last_runtime_verify_run: {
            at: next.finished_at,
            trigger: next.trigger,
            ok: next.ok,
            duration_ms: next.duration_ms,
          },
        });
      }
      return {
        ok: next.ok,
        ran: true,
        record: next,
        // The full verify result, for the route that asked for a synchronous verdict: the route's contract is the
        // verify report, and the record is the cached projection of it. In-process only; never persisted.
        verify_result: verifyResult,
        persisted: persisted.ok,
        persist_error: persisted.error,
      };
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    stateFile,
    cached,
    run,
    record: () => record,
    describe: () => ({
      state_file: stateFile,
      cached: record !== null,
      last_runtime_verify: record,
      runs,
      failures,
      in_flight: inFlight !== null,
    }),
  };
}
