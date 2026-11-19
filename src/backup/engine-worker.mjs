/**
 * Worker entry for the backup engine: run `runBackup` (and optionally `verifyRepo`) on a worker thread.
 *
 * ## Why this file exists
 *
 * 3.5.2 ran the whole backup synchronously inside the Cordis host stack. v3.5.1 already bounded the engine's memory
 * (the memory guard, the streaming block store), but the scan/read/store/commit pass still occupied the host's event
 * loop for its whole duration: the panel and the DSH GUI stayed slow while a scheduled or panel-triggered backup was
 * running. S8 (docs/REFACTOR-P1-PLAN.md §1.5) moves the *execution location*, not the behaviour: the engine is
 * still `./engine.mjs`, the CLI still calls it inline, and `runBackup`/`verifyRepo` keep their exports and return
 * shapes. This module is the worker side of that move.
 *
 * ## The protocol (the plugin runner owns the other end)
 *
 *   `{type:'start', input, jobs:['run'|'verify'], verifyOptions}`  ->  `{type:'progress', stage, done, total}`*
 *                                                                  ->  `{type:'done', result}`
 *                                                                  ->  `{type:'error', code, detail}`
 *
 * One `start` message runs one job (or a run followed by a verify) and exactly one terminal message is posted.
 * `result` is the engine's own result object, unmodified: a refusal is a `{ok:false, reason_code, detail}` *result*,
 * not a transport error. The `error` message is reserved for "the worker could not produce a result at all" (a
 * throw), because a refusal is data the host must surface, not a crash.
 *
 * ## Progress is coarse on purpose
 *
 * The engine is one synchronous call by design (`runBackup` has no progress callback and S8 does not instrument it),
 * so the worker reports the checkpoints it can observe:
 *
 *   * `scan`  -- posted immediately before the engine's scan runs (the `input.scan` seam is wrapped for this);
 *   * `select`/`store` -- posted after the scan returns, when the engine moves on to selection and block storage;
 *   * `commit`/`rotate`/`mirror` -- completion checkpoints posted when the synchronous `runBackup` call returns
 *     `ok:true`; the engine is not instrumented, so these mean "the pass that contains this phase is finished",
 *     not "this exact phase is running now";
 *   * `verify` -- posted when the optional `verifyRepo` pass starts.
 *
 * A stage that does not apply (a dry run commits nothing, a repository with no mirror is never mirrored) is not
 * reported. `done`/`total` are best-effort counts; `0/0` means "not measurable at this checkpoint". The plugin-side
 * runner turns these messages into `<DSH_HOME>/xclient/w2m-backup/worker.json`; this file writes no files at all.
 *
 * ## Credentials
 *
 * `input` may carry a backup password/PIN (`password`, string or Buffer) when the host unlocked a sealed repository
 * with one. The worker process owns that value only for the duration of the job: every reference it created is
 * overwritten with `undefined` once the job is over, and the error `detail` is scrubbed of the exact secret string
 * before it is posted. Nothing here ever puts the password (or any credential) into a progress or result message --
 * the result objects the engine returns never contain it either.
 */

import { parentPort } from 'node:worker_threads';

import { runBackup } from './engine.mjs';
import { scanHome } from './scan.mjs';
import { verifyRepo } from './verify.mjs';

/** The jobs a `start` message may name. Anything else is dropped rather than guessed at. */
const JOBS = Object.freeze(['run', 'verify']);

/** The coarse progress stages this worker can report. The runner validates against the same vocabulary. */
export const WORKER_STAGES = Object.freeze(['starting', 'scan', 'select', 'store', 'commit', 'rotate', 'mirror', 'verify']);

/** The only terminal failure code the worker mints by itself; engine refusals stay results, not errors. */
export const WORKER_FAILED_CODE = 'BACKUP_WORKER_FAILED';

/** Set once the terminal message has been posted; later messages (including progress) are dropped. */
let settled = false;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Post one message, ignoring a closed/terminated port: the runner treats silence as a crash, not as data. */
function post(message) {
  if (parentPort === null) return false;
  try {
    parentPort.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function toCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function progress(stage, done = 0, total = 0) {
  if (settled === true) return;
  post({ type: 'progress', stage, done: toCount(done), total: toCount(total) });
}

/** `jobs` is optional and defaults to `['run']`; unknown/duplicate entries are dropped, never interpreted. */
function normalizeJobs(raw) {
  const wanted = Array.isArray(raw) ? raw : ['run'];
  const jobs = [];
  for (const job of wanted) {
    if (typeof job === 'string' && JOBS.includes(job) && !jobs.includes(job)) jobs.push(job);
  }
  return jobs.length > 0 ? jobs : ['run'];
}

/** The exact secret strings this job carries, for the error-detail scrub. */
function secretStrings(...holders) {
  const secrets = [];
  for (const holder of holders) {
    if (!isObject(holder)) continue;
    const password = holder.password;
    if (typeof password === 'string' && password !== '') secrets.push(password);
    else if (Buffer.isBuffer(password) && password.length > 0) secrets.push(password.toString('utf8'));
  }
  return secrets;
}

/** Remove the exact secret from a detail line. A short PIN is scrubbed too: message cosmetics lose to safety. */
function redact(detail, secrets) {
  let text = typeof detail === 'string' && detail.trim() !== '' ? detail : 'the backup worker failed';
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret !== '') text = text.split(secret).join('[redacted]');
  }
  return text;
}

/** Overwrite credential references the worker created/owns. Best-effort: a frozen object must not fail the job. */
function clearPasswords(...holders) {
  for (const holder of holders) {
    if (!isObject(holder)) continue;
    try {
      holder.password = undefined;
    } catch {
      // A non-writable input object is the caller's; there is nothing to clear and nothing to report.
    }
  }
}

/**
 * Post the completion checkpoints for a finished synchronous run.
 *
 * Only phases that actually happened are reported: a refusal/dry run never commits, and a repository without a
 * configured mirror has no mirror phase. `rotate` carries the number of rotated versions (0 is meaningful: the
 * rotation pass ran and had nothing to move).
 */
function postRunCheckpoints(result) {
  if (!isObject(result) || result.ok !== true || result.dry_run === true) return;
  progress('commit', 1, 1);
  progress('rotate', result.rotated, result.rotated);
  if (isObject(result.mirror)) progress('mirror', result.mirror.ok === true ? 1 : 0, 1);
}

/**
 * Run the engine with the scan seam wrapped so the worker can report `scan`/`select`/`store` while the synchronous
 * call is still in progress. The wrapper calls the caller's own `input.scan` when one was injected (the engine's
 * test seam), so the worker additively reports progress without replacing the scan implementation.
 */
function runWithProgress(input) {
  const engineScan = typeof input.scan === 'function' ? input.scan : scanHome;
  const runInput = {
    ...input,
    scan: (scanArgs) => {
      progress('scan', 0, 0);
      const scanned = engineScan(scanArgs);
      progress('select', 0, 0);
      progress('store', 0, 0);
      return scanned;
    },
  };
  try {
    const result = runBackup(runInput);
    postRunCheckpoints(result);
    return result;
  } finally {
    clearPasswords(runInput);
  }
}

/**
 * Handle one `start` message. Never throws: a thrown error becomes a structured `{type:'error'}` message so the
 * host never sees an unhandled rejection from a worker thread and the named failure path in the runner is reached.
 */
export async function handleStart(message) {
  if (settled === true) return;
  if (!isObject(message) || message.type !== 'start') return;
  const input = isObject(message.input) ? message.input : {};
  const jobs = normalizeJobs(message.jobs);
  // `verifyOptions` falls back to `input`: a verify-only job is the same "open this repository" call the run's
  // post-commit verify would make, so callers do not have to pass two objects for one job.
  const verifyOptions = isObject(message.verifyOptions) ? message.verifyOptions : input;
  const secrets = secretStrings(input, verifyOptions);
  try {
    const results = {};
    if (jobs.includes('run')) {
      results.run = runWithProgress(input);
      // When a verify follows, it may need the same credential: keep it until the second job is done.
      if (!jobs.includes('verify') && verifyOptions !== input) clearPasswords(input, message.input);
    }
    if (jobs.includes('verify')) {
      progress('verify', 0, 0);
      results.verify = verifyRepo(verifyOptions === input && jobs.length === 1 ? input : verifyOptions);
    }
    settled = true;
    post({ type: 'done', result: jobs.length === 1 ? results[jobs[0]] : results });
  } catch (error) {
    settled = true;
    const code = typeof error?.code === 'string' && error.code !== '' ? error.code : WORKER_FAILED_CODE;
    const rawDetail = error instanceof Error ? error.message : (error?.detail ?? String(error));
    post({ type: 'error', code, detail: redact(rawDetail, secrets) });
  } finally {
    clearPasswords(input, message.input, verifyOptions, message.verifyOptions);
  }
}

// A module imported in the main thread (a test, a static analyzer) has no parentPort: it must be inert rather than
// throw at import time. Inside the worker, every message is handled through the guarded function above.
if (parentPort !== null) {
  parentPort.on('message', (message) => {
    handleStart(message).catch((error) => {
      if (settled === true) return;
      settled = true;
      post({ type: 'error', code: WORKER_FAILED_CODE, detail: redact(error instanceof Error ? error.message : String(error), []) });
    });
  });
}
