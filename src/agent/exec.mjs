/**
 * Direct argv execution for the W2M Localside agent.
 *
 * Two invariants matter more than anything else in this file:
 *
 *   1. **No shell, ever.**  `spawn(file, args, {shell: false})` is the only way
 *      a command is started.  A string is not accepted as `argv`, so a caller
 *      cannot smuggle a command line in by accident; the type check throws.
 *      This is what keeps `node --test && rm -rf /` from being two commands.
 *
 *   2. **Raw byte streams are the evidence.**  `stdout_sha256` / `stdout_bytes`
 *      describe the *entire* stream, not the retained sample, so a result stays
 *      comparable between machines even when a chatty command prints more than
 *      we are willing to keep in memory.  Truncation only limits what we retain
 *      for `stdout_head` / `stdout_tail`, and it is reported as a warning.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Per-stream default retention cap (task-8: 2 MiB each). */
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** §5.2: `stdout_head` / `stdout_tail` carry 4 KiB each. */
export const SAMPLE_BYTES = 4 * 1024;

/** Warning code emitted when we retained less than the command produced. */
export const WARN_OUTPUT_TRUNCATED = 'OUTPUT_TRUNCATED';

/** Warning code emitted when the executable could not be started at all. */
export const WARN_PATH_INVALID = 'PATH_INVALID';

/**
 * Lowercase hex SHA-256 of a Buffer/string.
 *
 * @param {Buffer|Uint8Array|string} data
 * @returns {string}
 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of the empty stream; used by refusal envelopes. */
export const EMPTY_SHA256 = sha256Hex(Buffer.alloc(0));

/**
 * @typedef {object} ExecResult
 * @property {string[]} argv
 * @property {string} cwd
 * @property {number|null} exit_code Exit status, `null` when killed by a signal.
 * @property {string|null} signal Signal name, `null` on a normal exit.
 * @property {Buffer} stdout Retained prefix of stdout (<= maxOutputBytes).
 * @property {Buffer} stderr Retained prefix of stderr (<= maxOutputBytes).
 * @property {number} stdout_bytes Total bytes seen on stdout.
 * @property {number} stderr_bytes Total bytes seen on stderr.
 * @property {string} stdout_sha256 SHA-256 of the *entire* stdout stream.
 * @property {string} stderr_sha256 SHA-256 of the *entire* stderr stream.
 * @property {string} stdout_head First 4 KiB of stdout, UTF-8 (lossy).
 * @property {string} stdout_tail Last 4 KiB of stdout, UTF-8 (lossy).
 * @property {string} stderr_head First 4 KiB of stderr, UTF-8 (lossy).
 * @property {string} stderr_tail Last 4 KiB of stderr, UTF-8 (lossy).
 * @property {boolean} truncated_stdout True when stdout exceeded the retention cap.
 * @property {boolean} truncated_stderr True when stderr exceeded the retention cap.
 * @property {string} started_at RFC3339 UTC.
 * @property {string} ended_at RFC3339 UTC.
 * @property {number} duration_ms Wall-clock duration.
 * @property {boolean} timed_out We killed it because `timeoutMs` elapsed.
 * @property {boolean} cancelled We killed it because the signal aborted.
 * @property {{code: string, message: string}|null} spawn_error
 * @property {string[]} warnings
 */

/**
 * Streaming collector: hashes and counts everything, retains a capped prefix
 * plus a rolling 4 KiB tail.
 *
 * @param {number} maxOutputBytes
 */
function createCollector(maxOutputBytes) {
  /** @type {Buffer[]} */
  const heads = [];
  /** @type {Buffer[]} */
  const tails = [];
  let kept = 0;
  let total = 0;
  let tailLen = 0;
  const hasher = createHash('sha256');

  return {
    /** @param {Buffer} chunk */
    push(chunk) {
      total += chunk.length;
      hasher.update(chunk);
      if (kept < maxOutputBytes) {
        const room = maxOutputBytes - kept;
        const piece = chunk.length <= room ? chunk : chunk.subarray(0, room);
        heads.push(piece);
        kept += piece.length;
      }
      tails.push(chunk);
      tailLen += chunk.length;
      // Drop whole chunks from the front while the rest still covers 4 KiB.
      while (tails.length > 1 && tailLen - tails[0].length >= SAMPLE_BYTES) {
        tailLen -= tails.shift().length;
      }
    },
    finish() {
      const all = Buffer.concat(tails, tailLen);
      return {
        out: Buffer.concat(heads, kept),
        head: all.subarray(0, Math.min(SAMPLE_BYTES, all.length)),
        tail: all.length > SAMPLE_BYTES ? all.subarray(all.length - SAMPLE_BYTES) : all,
        bytes: total,
        sha: hasher.digest('hex'),
        truncated: total > kept,
      };
    },
  };
}

/**
 * Start `argv` directly, capture both streams, enforce a timeout.
 *
 * Never rejects: a failure to even start the process is part of the result,
 * because "could not spawn" is a result the Rabbit side has to see.
 *
 * @param {string[]} argv Command and arguments; `argv[0]` is the executable.
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {Record<string,string|undefined>} [options.env] Extra environment entries.
 * @param {number} [options.timeoutMs] 0/undefined means "no timeout".
 * @param {number} [options.maxOutputBytes] Per-stream retention cap.
 * @param {AbortSignal} [options.signal] Cancellation (task.cancel / shutdown).
 * @param {string} [options.killSignal]
 * @param {number} [options.killGraceMs] Delay before escalating to SIGKILL.
 * @returns {Promise<ExecResult>}
 */
export function runArgv(argv, options = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError('runArgv: argv must be a non-empty array of strings');
  }
  for (const part of argv) {
    if (typeof part !== 'string') {
      throw new TypeError(
        `runArgv: argv entries must be strings, got ${part === null ? 'null' : typeof part}`,
      );
    }
  }
  if (argv[0] === '') throw new TypeError('runArgv: argv[0] must not be empty');

  const {
    cwd = process.cwd(),
    env: extraEnv,
    timeoutMs = 0,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    signal,
    killSignal = 'SIGTERM',
    killGraceMs = 2000,
  } = options;

  return new Promise((resolve) => {
    const outCollector = createCollector(maxOutputBytes);
    const errCollector = createCollector(maxOutputBytes);

    const startedAtWall = new Date();
    const startedHr = process.hrtime.bigint();

    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let timeoutTimer = null;
    let graceTimer = null;
    /** @type {import('node:child_process').ChildProcess} */
    let child;

    const finish = (exitCode, signalName, spawnError) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (signal) signal.removeEventListener('abort', onAbort);

      const out = outCollector.finish();
      const err = errCollector.finish();
      const durationMs = Number(process.hrtime.bigint() - startedHr) / 1e6;

      const warnings = [];
      if (out.truncated || err.truncated) warnings.push(WARN_OUTPUT_TRUNCATED);
      if (spawnError) warnings.push(WARN_PATH_INVALID);

      resolve({
        argv: [...argv],
        cwd,
        exit_code: exitCode,
        signal: signalName,
        stdout: out.out,
        stderr: err.out,
        stdout_bytes: out.bytes,
        stderr_bytes: err.bytes,
        stdout_sha256: out.sha,
        stderr_sha256: err.sha,
        stdout_head: out.head.toString('utf8'),
        stdout_tail: out.tail.toString('utf8'),
        stderr_head: err.head.toString('utf8'),
        stderr_tail: err.tail.toString('utf8'),
        truncated_stdout: out.truncated,
        truncated_stderr: err.truncated,
        started_at: startedAtWall.toISOString(),
        ended_at: new Date().toISOString(),
        duration_ms: Math.round(durationMs),
        timed_out: timedOut,
        cancelled,
        spawn_error: spawnError,
        warnings,
      });
    };

    /** Kill, then escalate if the process ignores SIGTERM. */
    const killChild = () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(killSignal);
      } catch {
        /* already gone */
      }
      if (killGraceMs > 0) {
        graceTimer = setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, killGraceMs);
        if (typeof graceTimer.unref === 'function') graceTimer.unref();
      }
    };

    const onAbort = () => {
      cancelled = true;
      killChild();
    };

    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        shell: false, // non-negotiable
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (error) {
      finish(null, null, {
        code: error?.code ?? 'SPAWN_FAILED',
        message: String(error?.message ?? error),
      });
      return;
    }

    child.stdout?.on('data', (chunk) => outCollector.push(chunk));
    child.stderr?.on('data', (chunk) => errCollector.push(chunk));

    child.on('error', (error) => {
      finish(null, null, {
        code: error?.code ?? 'SPAWN_FAILED',
        message: String(error?.message ?? error),
      });
    });

    child.on('close', (code, signalName) => {
      const signalled = signalName !== null && signalName !== undefined;
      // The contract wants exit_code null whenever a signal killed the process.
      finish(signalled ? null : code, signalled ? String(signalName) : null, null);
    });

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killChild();
      }, timeoutMs);
      if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
    }

    if (signal) {
      if (signal.aborted) {
        cancelled = true;
        killChild();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

/**
 * Map an execution result onto the contract's `status` enum.
 *
 * `refused` / `unverifiable` are decided by the caller, not here.
 *
 * @param {ExecResult} result
 * @returns {'ok'|'nonzero_exit'|'timeout'|'crashed'}
 */
export function classifyExit(result) {
  if (result.timed_out) return 'timeout';
  if (result.spawn_error) return 'crashed';
  if (result.cancelled) return 'crashed';
  if (result.exit_code === null) return 'crashed'; // killed by a signal
  return result.exit_code === 0 ? 'ok' : 'nonzero_exit';
}

// Control characters are the point of these patterns: they match the ANSI escape sequences a
// terminal emits. `no-control-regex` exists to catch control characters that slipped in by accident,
// which is the opposite of what is happening here, so the rule is disabled per line rather than
// globally -- a genuinely accidental control character elsewhere must still be reported.
// eslint-disable-next-line no-control-regex -- matches ANSI OSC terminators by definition
const ANSI_OSC = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
// eslint-disable-next-line no-control-regex -- matches ANSI CSI introducers by definition
const ANSI_CSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex -- matches ANSI single-character escapes by definition
const ANSI_OTHER = /\u001B[@-Z\\-_]/g;

/**
 * Apply `compare_policy` to a captured stream so that two machines can agree
 * on `stdout_normalized_sha256` despite ANSI colour and CRLF differences.
 *
 * The transform is lossy on purpose and intentionally *not* used for
 * `stdout_sha256`, which stays the raw byte stream.
 *
 * @param {Buffer|string} data
 * @param {{strip_ansi?: boolean, normalize_crlf?: boolean, strip_trailing_blank_lines?: boolean}} [policy]
 * @returns {Buffer}
 */
export function normalizeOutput(data, policy = {}) {
  const stripAnsi = policy.strip_ansi !== false;
  const normalizeCrlf = policy.normalize_crlf !== false;
  const stripTrailingBlank = policy.strip_trailing_blank_lines !== false;

  let text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  if (stripAnsi) text = text.replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(ANSI_OTHER, '');
  if (normalizeCrlf) text = text.replace(/\r\n/g, '\n');
  if (stripTrailingBlank) text = text.replace(/(?:\n[ \t]*)+$/, '');
  return Buffer.from(text, 'utf8');
}
