/**
 * Plugin-side half of S8: run the backup engine on a `worker_threads` worker, with a named failure path and an
 * unchanged inline fallback.
 *
 * ## What the host gets
 *
 *   * `run(input)` / `run(input, {jobs:['verify'], verifyOptions})` returns
 *     `{ok, mode:'worker'|'inline', result, progress?, code?, error?}` and never waits on the host event loop: the
 *     synchronous engine call happens on the worker thread, so the panel, timers and route loop keep running.
 *   * Progress is mirrored to `<DSH_HOME>/xclient/w2m-backup/worker.json` (atomic replace, 0600 mode where the OS
 *     supports it) so the panel can show a live stage. The file contains no input and no credential: only
 *     `{started_at, updated_at, stage, done, total, mode, pid}`.
 *   * Named failures instead of exceptions: a worker out-of-memory is `BACKUP_WORKER_OOM`, a run past
 *     `backupWorkerTimeoutMs` is `BACKUP_WORKER_TIMEOUT`, any other crash is `BACKUP_WORKER_FAILED`. In every case
 *     the worker is terminated and the progress file is removed.
 *   * The fallback is the pre-S8 behaviour: if Node exposes no `Worker`, the injected factory throws synchronously,
 *     the worker cannot receive the start message, or `W2M_BACKUP_INLINE=1`, the caller's `runBackup`/`verifyRepo`
 *     import runs inline with `mode:'inline'` and a logger warning. The inline path is deliberately unchanged.
 *
 * ## Why the engine itself is not modified
 *
 * `runBackup` stays the one synchronous implementation the CLI also uses (docs/REFACTOR-P1-PLAN.md §1.5: "纯函数引
 * 擎（现状不变）"). That means the worker cannot stream per-block progress out of the engine; it reports the
 * checkpoints it can observe (see `src/backup/engine-worker.mjs`). This module only supervises the process boundary.
 *
 * ## Why the failure codes are results, not throws
 *
 * The scheduled path must log a named reason and arm the next slot, and the panel route must answer 200 with
 * `{ok:false, reason_code}` exactly as it does for an engine refusal -- a timer or a route that throws is a dead
 * timer/500 response. So `run()` resolves every worker failure as a value. The caller maps `code` to `reason_code`.
 *
 * ## The progress file is best effort
 *
 * Losing a progress update (a permission problem, a full disk) must never fail a backup: it is logged once per run
 * and the run continues. The terminal `done`/`error` message and the engine result are the source of truth; the file
 * is observability only, removed when the run settles.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { runBackup } from '../backup/engine.mjs';
import { backupStateDir } from '../backup/runtime-verdict.mjs';
import { verifyRepo } from '../backup/verify.mjs';

/** Named worker failures the runner mints. `code` is what the route/logger reports as `reason_code`. */
export const WORKER_CODES = Object.freeze({
  OOM: 'BACKUP_WORKER_OOM',
  TIMEOUT: 'BACKUP_WORKER_TIMEOUT',
  FAILED: 'BACKUP_WORKER_FAILED',
});

/** Default budget for one worker job: 30 minutes (long real backups are minutes, not hours; configurable). */
export const DEFAULT_WORKER_TIMEOUT_MS = 30 * 60 * 1000;

/** The progress file's name inside the plugin state directory. */
export const WORKER_STATE_FILE_NAME = 'worker.json';

/**
 * The worker's heap ceiling. The worker gets its own V8 heap, so a runaway materialisation kills the worker with
 * `ERR_WORKER_OUT_OF_MEMORY` instead of the host; the engine's own memory guard (v3.5.1) still applies inside.
 */
export const WORKER_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 1024 });

/** The progress vocabulary the worker reports; the runner drops an unknown stage rather than persisting junk. */
export const WORKER_STAGES = Object.freeze(['starting', 'scan', 'select', 'store', 'commit', 'rotate', 'mirror', 'verify']);

/** The absolute progress file path for a DSH home. */
export function backupWorkerStateFile(dshHome) {
  return path.join(backupStateDir(dshHome), WORKER_STATE_FILE_NAME);
}

/**
 * Read the progress record, or `null` for a missing/corrupt file (a status read must never fail on it).
 *
 * @param {string} dshHome
 * @returns {{file: string, state: object|null}}
 */
export function readWorkerState(dshHome) {
  const file = backupWorkerStateFile(dshHome);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { file, state: null };
    return { file, state: parsed };
  } catch {
    return { file, state: null };
  }
}

/** Remove the progress file; absence is success (it is removed on every terminal path). */
export function removeWorkerState(dshHome) {
  try {
    fs.rmSync(backupWorkerStateFile(dshHome), { force: true });
  } catch {
    // A leftover progress file is cosmetic; the next run overwrites it.
  }
}

/** Atomic replace of the progress record: write a 0600 sibling, then rename it over the target. */
function writeWorkerStateAtomic(dshHome, record) {
  const target = backupWorkerStateFile(dshHome);
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${WORKER_STATE_FILE_NAME}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // Windows has no POSIX mode bits; the ACL of the parent directory is the real boundary there.
    }
    fs.renameSync(tmp, target);
    return target;
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort: reporting the write failure matters; a stale tmp file is harmless */
    }
    throw error;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** A positive integer budget; anything else (including 0) means "use the default", never "no timeout". */
function resolveTimeout(value, fallback = DEFAULT_WORKER_TIMEOUT_MS) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (Number.isSafeInteger(fallback) && fallback > 0) return fallback;
  return DEFAULT_WORKER_TIMEOUT_MS;
}

/** The jobs a run may name. Absent means the pre-S8 behaviour: one backup run. */
function normalizeJobs(raw) {
  const wanted = Array.isArray(raw) ? raw : ['run'];
  const jobs = [];
  for (const job of wanted) {
    if ((job === 'run' || job === 'verify') && !jobs.includes(job)) jobs.push(job);
  }
  return jobs.length > 0 ? jobs : ['run'];
}

/** Where `<DSH_HOME>` is when the caller did not pass one: the documented `$DSH_HOME`, then `~/.dsh`. */
function resolveProgressHome(dshHome, env) {
  if (typeof dshHome === 'string' && dshHome.trim() !== '') return path.resolve(dshHome.trim());
  const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (fromEnv !== '') return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

/** OOM is the one crash with a distinct name; everything else is `BACKUP_WORKER_FAILED`. */
function classifyWorkerError(error) {
  const code = String(error?.code ?? '');
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (code === 'ERR_WORKER_OUT_OF_MEMORY' || /out of memory|heap out of memory|allocation failed/i.test(message)) {
    return WORKER_CODES.OOM;
  }
  return WORKER_CODES.FAILED;
}

/** Exit code 134 is the abort/sigabrt shape V8 uses for a fatal OOM inside a worker. */
function classifyExitCode(code) {
  return code === 134 ? WORKER_CODES.OOM : WORKER_CODES.FAILED;
}

/** The worker entry point this runner spawns; resolved against this module so a profile path works too. */
const WORKER_URL = new URL('../backup/engine-worker.mjs', import.meta.url);

/** The real factory. Injected by tests so the unit suite never spawns a thread it did not ask for. */
function defaultSpawn(url, workerOptions) {
  return new Worker(url, workerOptions);
}

/**
 * Create the plugin-side backup runner.
 *
 * @param {{
 *   spawn?: (url: URL, options: object) => object,   // Worker factory; injectable for tests
 *   env?: Record<string, string|undefined>,           // default process.env (`W2M_BACKUP_INLINE`)
 *   dshHome?: string,                                 // state-file home; default `$DSH_HOME` / `~/.dsh`
 *   timeoutMs?: number,                               // default 30 min (`backupWorkerTimeoutMs`)
 *   logger?: {warn?: Function, info?: Function},
 * }} [options]
 * @returns {{run: (input: object, runOptions?: object) => Promise<object>, mode: () => string,
 *   state_file: string}}
 */
export function createBackupWorkerRunner(options = {}) {
  const env = isObject(options.env) ? options.env : process.env;
  const logger = isObject(options.logger) ? options.logger : null;
  const spawn = typeof options.spawn === 'function' ? options.spawn : defaultSpawn;
  const dshHome = resolveProgressHome(options.dshHome, env);
  const defaultTimeoutMs = resolveTimeout(options.timeoutMs);
  const stateFile = backupWorkerStateFile(dshHome);
  let lastMode = 'idle';

  const warn = (line) => {
    try {
      logger?.warn?.(`w2m-dsh-backup: ${line}`);
    } catch {
      // A logger that throws must not turn observability into a failed backup.
    }
  };

  /**
   * The pre-S8 execution: the same synchronous engine call the CLI makes, with `mode:'inline'`. A throw here is the
   * caller's to catch, exactly as before S8, so the plugin's existing try/catch semantics are unchanged.
   */
  async function runInline(input, jobs, verifyOptions, reason) {
    lastMode = 'inline';
    warn(`backup engine: inline (${reason})`);
    let runResult;
    let verifyResult;
    if (jobs.includes('run')) runResult = runBackup(input);
    if (jobs.includes('verify')) verifyResult = verifyRepo(verifyOptions ?? input);
    return {
      ok: true,
      mode: 'inline',
      result: jobs.length === 1 ? (jobs[0] === 'run' ? runResult : verifyResult) : { run: runResult, verify: verifyResult },
    };
  }

  /**
   * Supervise one spawned worker: forward progress into the state file, map every terminal event to a value, and
   * always terminate the thread and remove the progress file.
   */
  function supervise(worker, { input, jobs, verifyOptions, timeoutMs }) {
    return new Promise((resolve) => {
      const startedAt = new Date().toISOString();
      const progressEvents = [];
      const record = { started_at: startedAt, updated_at: startedAt, stage: 'starting', done: 0, total: 0, mode: 'worker', pid: process.pid };
      let settled = false;
      let timer = null;
      let stateWriteWarned = false;

      const writeState = () => {
        try {
          writeWorkerStateAtomic(dshHome, record);
        } catch (error) {
          if (!stateWriteWarned) {
            stateWriteWarned = true;
            warn(`backup worker progress could not be written: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      };

      const settle = (outcome) => {
        if (settled === true) return;
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        removeWorkerState(dshHome);
        try {
          const termination = worker.terminate();
          if (termination !== null && typeof termination === 'object' && typeof termination.catch === 'function') {
            termination.catch(() => {});
          }
        } catch {
          // terminate() throwing means the thread is already gone; the outcome is already decided.
        }
        resolve(outcome);
      };

      const fail = (code, detail) => ({ ok: false, mode: 'worker', code, error: { code, detail } });

      worker.on('message', (message) => {
        if (settled === true || !isObject(message)) return;
        if (message.type === 'progress') {
          const stage = typeof message.stage === 'string' && WORKER_STAGES.includes(message.stage) ? message.stage : 'starting';
          const event = { stage, done: toCount(message.done), total: toCount(message.total), at: new Date().toISOString() };
          progressEvents.push(event);
          if (progressEvents.length > 64) progressEvents.shift();
          record.updated_at = event.at;
          record.stage = event.stage;
          record.done = event.done;
          record.total = event.total;
          writeState();
          return;
        }
        if (message.type === 'done') {
          settle({ ok: true, mode: 'worker', result: message.result, progress: progressEvents });
          return;
        }
        if (message.type === 'error') {
          const code = typeof message.code === 'string' && message.code !== '' ? message.code : WORKER_CODES.FAILED;
          const detail = typeof message.detail === 'string' && message.detail !== '' ? message.detail : 'the backup worker failed';
          settle(fail(code, detail));
        }
      });

      worker.on('error', (error) => {
        const code = classifyWorkerError(error);
        const detail = code === WORKER_CODES.OOM
          ? `the backup worker ran out of memory (resourceLimits.maxOldGenerationSizeMb=${WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb}) and was terminated`
          : `the backup worker crashed: ${error instanceof Error ? error.message : String(error)}`;
        settle(fail(code, detail));
      });

      worker.on('exit', (code) => {
        if (settled === true) return;
        const failureCode = classifyExitCode(code);
        const detail = failureCode === WORKER_CODES.OOM
          ? `the backup worker exited with code ${code} (out of memory) and was terminated`
          : `the backup worker exited with code ${code} before reporting a result`;
        settle(fail(failureCode, detail));
      });

      // The timeout is scoped to this run and always cleared by `settle`: the mount path owns no timer, and a run
      // that hangs fails with a name instead of holding a worker (or the host) forever.
      timer = setTimeout(() => {
        timer = null;
        settle(fail(WORKER_CODES.TIMEOUT, `the backup worker did not finish within ${timeoutMs} ms and was terminated`));
      }, timeoutMs);
      if (timer !== null && typeof timer.unref === 'function') timer.unref();

      writeState();
      try {
        worker.postMessage({ type: 'start', input, jobs, verifyOptions });
      } catch (error) {
        // An input that cannot be structured-cloned (a function seam handed through by a caller) is a transport
        // problem, not an engine result: terminate and let `run()` fall back to the unchanged inline path.
        settle({ ok: false, mode: 'worker', code: WORKER_CODES.FAILED, error: { code: WORKER_CODES.FAILED, detail: 'the backup worker could not be started' }, inlineFallback: error });
      }
    });
  }

  /**
   * Run the engine for `input` on a worker (or inline on the documented fallbacks).
   *
   * @param {object} input `runBackup` input, or `verifyRepo` input when `jobs:['verify']`
   * @param {{jobs?: string[], verifyOptions?: object, timeoutMs?: number}} [runOptions]
   * @returns {Promise<{ok: boolean, mode: 'worker'|'inline', result?: object, progress?: object[],
   *   code?: string, error?: {code: string, detail: string}, inlineFallback?: unknown}>}
   */
  async function run(input, runOptions = {}) {
    const options = isObject(runOptions) ? runOptions : {};
    const jobs = normalizeJobs(options.jobs);
    const verifyOptions = isObject(options.verifyOptions) ? options.verifyOptions : null;
    const timeoutMs = resolveTimeout(options.timeoutMs, defaultTimeoutMs);

    if (String(env?.W2M_BACKUP_INLINE ?? '') === '1') {
      return runInline(input, jobs, verifyOptions, 'W2M_BACKUP_INLINE=1');
    }
    if (spawn === defaultSpawn && typeof Worker !== 'function') {
      return runInline(input, jobs, verifyOptions, 'this Node has no worker_threads Worker');
    }

    let worker = null;
    try {
      worker = spawn(WORKER_URL, { resourceLimits: { ...WORKER_RESOURCE_LIMITS } });
    } catch (error) {
      // The documented fallback: a worker that cannot even be created keeps the pre-S8 behaviour.
      return runInline(input, jobs, verifyOptions, `worker spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isObject(worker) || typeof worker.postMessage !== 'function' || typeof worker.on !== 'function' || typeof worker.terminate !== 'function') {
      return runInline(input, jobs, verifyOptions, 'worker spawn returned no usable Worker instance');
    }

    const outcome = await supervise(worker, { input, jobs, verifyOptions, timeoutMs });
    if (outcome.inlineFallback !== undefined) {
      return runInline(input, jobs, verifyOptions, `worker could not receive the start message: ${outcome.inlineFallback instanceof Error ? outcome.inlineFallback.message : String(outcome.inlineFallback)}`);
    }
    lastMode = outcome.mode;
    return outcome;
  }

  return { run, mode: () => lastMode, state_file: stateFile };
}
