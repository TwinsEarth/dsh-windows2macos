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
import { resolveCommand } from './resolve.mjs';

/** Per-stream default retention cap (task-8: 2 MiB each). */
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** §5.2: `stdout_head` / `stdout_tail` carry 4 KiB each. */
export const SAMPLE_BYTES = 4 * 1024;

/** Warning code emitted when we retained less than the command produced. */
export const WARN_OUTPUT_TRUNCATED = 'OUTPUT_TRUNCATED';

/** Warning code emitted when the executable could not be started at all. */
export const WARN_PATH_INVALID = 'PATH_INVALID';

/**
 * The stable codes this gate refuses with.
 *
 * These are the last check before `spawn`, and they are what makes one invariant legible: **no shell,
 * ever**. A string command, an empty argv and a non-string element are all refused here, and until
 * now each was a bare `TypeError` with no code — a caller could see *that* the execution gate said no
 * and not *which* rule said it. `code` and `detail` are attached rather than replacing the type, so
 * `assert.throws(..., TypeError)` keeps meaning what it meant and `parseAllowedCommands`' own
 * `err.code = 'ALLOWED_COMMANDS_INVALID'` stays the house convention rather than an exception.
 */
export const EXEC_REFUSAL = Object.freeze({
  /**
   * `argv` was not a non-empty array. This is the "no shell string" rule: `runArgv('node --test')`
   * is refused because that string would have to be split by *something* to become a process, and the
   * something would be a shell.
   */
  ARGV_NOT_ARRAY: 'EXEC_ARGV_NOT_ARRAY',
  /** An element of `argv` was not a string; nothing here coerces, because coercion is a re-parse. */
  ARGV_ENTRY_NOT_STRING: 'EXEC_ARGV_ENTRY_NOT_STRING',
  /** `argv[0]` was the empty string, which names no executable. */
  ARGV_EXECUTABLE_EMPTY: 'EXEC_ARGV_EXECUTABLE_EMPTY',
  /** The process could not be started at all (ENOENT, EACCES, …); the OS code stays in `code`. */
  SPAWN_FAILED: 'EXEC_SPAWN_FAILED',
});

/**
 * Build the refusal `runArgv` throws: a real `TypeError`, carrying a stable code and a remedy.
 *
 * @param {string} code One of {@link EXEC_REFUSAL}.
 * @param {string} message What was refused and why it cannot be run.
 * @param {string} detail What would make the same call acceptable.
 * @returns {TypeError}
 */
function execRefusal(code, message, detail) {
  const error = new TypeError(message);
  error.code = code;
  error.detail = detail;
  return error;
}

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
 * @property {{code: string, reason_code: string, message: string}|null} spawn_error
 *   `code` is the OS error code (ENOENT, EACCES) or `SPAWN_FAILED`; `reason_code` is this gate's own
 *   stable code, so a reader can tell "the execution gate refused" from "the operating system did".
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
 * @param {boolean} [options.resolveExecutable] Look `argv[0]` up the way the
 *        capability probe does — PATH first, DSH's bundled runtime second —
 *        instead of handing the bare name to `spawn`. Defaults to true, so a
 *        capability the probe advertised is one a task can actually use. Set
 *        false to spawn `argv[0]` verbatim.
 * @returns {Promise<ExecResult>}
 */
export function runArgv(argv, options = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw execRefusal(
      EXEC_REFUSAL.ARGV_NOT_ARRAY,
      'runArgv: argv must be a non-empty array of strings',
      'pass the command and its arguments as separate array elements, for example ["node","--test"] - a command line in one string is refused because splitting it would need a shell',
    );
  }
  for (const part of argv) {
    if (typeof part !== 'string') {
      throw execRefusal(
        EXEC_REFUSAL.ARGV_ENTRY_NOT_STRING,
        `runArgv: argv entries must be strings, got ${part === null ? 'null' : typeof part}`,
        'stringify the argument at the caller, so this gate never has to re-parse a value it did not receive',
      );
    }
  }
  if (argv[0] === '') {
    throw execRefusal(
      EXEC_REFUSAL.ARGV_EXECUTABLE_EMPTY,
      'runArgv: argv[0] must not be empty',
      'name the executable in argv[0], for example "node" or an absolute path to it',
    );
  }

  const {
    cwd = process.cwd(),
    env: extraEnv,
    timeoutMs = 0,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    signal,
    killSignal = 'SIGTERM',
    killGraceMs = 2000,
    resolveExecutable = true,
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
      // The probe resolves a tool by PATH first, then in DSH's bundled runtime, so a machine with no
      // system `node` still reports a real `caps.node`. Execution has to use the same order, or the
      // capability is one the machine advertises and cannot use: `spawn('node', …, {shell:false})`
      // only ever searches PATH.
      const childEnv = extraEnv ? { ...process.env, ...extraEnv } : process.env;
      const executable = resolveExecutable ? resolveCommand(argv[0], { env: childEnv }) : argv[0];
      child = spawn(executable, argv.slice(1), {
        cwd,
        env: childEnv,
        shell: false, // non-negotiable
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (error) {
      finish(null, null, {
        code: error?.code ?? 'SPAWN_FAILED',
        reason_code: EXEC_REFUSAL.SPAWN_FAILED,
        message: String(error?.message ?? error),
      });
      return;
    }

    child.stdout?.on('data', (chunk) => outCollector.push(chunk));
    child.stderr?.on('data', (chunk) => errCollector.push(chunk));

    child.on('error', (error) => {
      finish(null, null, {
        code: error?.code ?? 'SPAWN_FAILED',
        reason_code: EXEC_REFUSAL.SPAWN_FAILED,
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
