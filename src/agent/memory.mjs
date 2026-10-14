/**
 * Individual memory: what this machine did, in its own state directory.
 *
 * ## Why this file exists
 *
 * The relay's ledger is the only durable fleet record, and it deliberately keeps **hashes, not text** --
 * `command_hash`, `stdout_sha256`, `stdout_bytes`. That choice is defensible: the ledger is a
 * tamper-evident consistency record, and a relay compromise discloses no command text. The cost is that
 * nothing in the fleet can answer *"what did we already try on this machine, and what happened?"*
 *
 * The cost was paid repeatedly. In a single working session the same facts were rediscovered from
 * scratch at the price of a dozen dispatches -- that this box has no package manager, which node binary
 * actually runs, that its git cannot reach github.com while node's HTTPS can, that a task is expired at
 * roughly fifty seconds. None of it was retained anywhere the fleet could read.
 *
 * So the memory lives here, on the machine, for three reasons beyond convenience:
 *
 *   1. the machine already writes `agent-state.json` in this directory, so there is no new place to
 *      find and no new permission to grant;
 *   2. it owns the output at the moment it produces it, and this is the last point at which the *text*
 *      exists at all -- the relay never receives it, so nothing downstream could store it later;
 *   3. it survives a relay rebuild, which the ledger does not.
 *
 * It is also the only honest home for a machine-specific fact. *"This box has no package manager"* is a
 * property of this box, and a design that put it anywhere else would be guessing.
 *
 * ## Bounded by construction
 *
 * A byte cap with rotation, not an unbounded append. This is not hypothetical caution: the Linux host's
 * root filesystem filled to 100% today from 14.7 GB/day of logs written by a process that had no cap,
 * and the recovery cost real time. A memory that can fill a disk is a worse failure than no memory.
 *
 * Rotation keeps one previous generation rather than discarding it, because the question this file
 * answers is usually about the recent past and a single rotation boundary is exactly where "we just ran
 * that" sits.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The memory log's filename, beside `agent-state.json`. */
export const MEMORY_FILE = 'memory.jsonl';

/** The one rotated generation: `<file>.1`. Kept, not deleted -- see the header. */
export const MEMORY_FILE_PREVIOUS = `${MEMORY_FILE}.1`;

/**
 * Byte cap for the live file before it is rotated.
 *
 * 8 MiB holds on the order of 20,000 task records at the shape below -- several years of this fleet's
 * observed rate -- while staying small enough that reading the whole file to answer a question is
 * something a tool can do without a plan.
 */
export const MEMORY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * How much of a stream's tail is kept.
 *
 * The envelope already carries `stdout_tail` / `stderr_tail` for cross-machine comparison, so storing a
 * second copy costs nothing extra and keeps every record the same shape. It is clamped again here
 * rather than trusted, because this file is written on a machine the dispatcher does not control and a
 * cap that can be exceeded by an argument is not a cap.
 */
export const MEMORY_TAIL_BYTES = 4096;

/**
 * A bound on the recorded argv.
 *
 * The relay takes an argv array of arbitrary length, so an offer may legally carry a command longer than
 * any sane memory record. Truncating the *record* is right here: `command_argv` is not compared across
 * machines (only `command_hash` is), so a shortened argv cannot make two machines disagree.
 */
export const MEMORY_ARGV_LIMIT = 64;

/** @param {unknown} value @param {number} limit */
function clamp(value, limit) {
  if (typeof value !== 'string' || value === '') return null;
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…[truncated at ${limit} characters]`;
}

/**
 * The memory record for one finished task.
 *
 * Shaped to be readable by a person as much as by a tool: a reader asking "what happened here" should be
 * able to `tail` the file and get an answer without a query.
 *
 * `conclusion` is deliberately absent. It is the field §3.1 of the design shows, and it is reserved for
 * `w2m_memory` to fill in when a human or an agent decides what the result *meant* -- a machine that
 * invented one would be asserting an interpretation it cannot have, and the whole point of separating
 * fact from conclusion is that the two must not be confused later.
 *
 * @param {object} input
 * @param {object} input.envelope The built result envelope.
 * @param {string[]} input.commandArgv
 * @param {string|null} input.cwdRel
 * @param {number} input.ms Wall-clock duration of the attempt.
 * @param {number} [input.now]
 * @returns {object}
 */
export function memoryRecord({
  envelope,
  commandArgv,
  cwdRel,
  ms,
  now = Date.now(),
}) {
  const argv = Array.isArray(commandArgv) ? commandArgv.map(String) : [];
  const truncatedArgv = argv.length > MEMORY_ARGV_LIMIT;

  const record = {
    at: new Date(now).toISOString(),
    task_id: envelope.task_id,
    attempt: envelope.attempt,
    machine_id: envelope.machine_id,
    machine_name: envelope.machine_name ?? null,
    mode: envelope.mode ?? null,
    argv: truncatedArgv ? argv.slice(0, MEMORY_ARGV_LIMIT) : argv,
    cwd_rel: cwdRel ?? null,
    // The exit code and status are what a reader checks first, so they sit above the tails.
    exit_code: envelope.exit_code ?? null,
    status: envelope.status ?? null,
    refusal_reason: envelope.refusal_reason ?? null,
    ms: Number.isFinite(ms) ? ms : null,
    // Which way the offer travelled. Useful on its own: "this machine has not been reachable directly
    // since Tuesday" is a fact about the fleet that only these records would show.
    transport: envelope.transport ?? null,
    stdout_tail: clamp(envelope.stdout_tail, MEMORY_TAIL_BYTES),
    stderr_tail: clamp(envelope.stderr_tail, MEMORY_TAIL_BYTES),
    // Hashes are repeated from the envelope on purpose: they are what ties this human-readable record
    // to the relay's tamper-evident one, so the two can be cross-checked without trusting either.
    stdout_sha256: envelope.stdout_sha256 ?? null,
    stdout_bytes: envelope.stdout_bytes ?? null,
    // Filled in later by `w2m_memory`, never by the machine. See above.
    conclusion: null,
    tags: [],
  };
  if (truncatedArgv) record.argv_truncated_from = argv.length;
  return record;
}

/**
 * Append a record, rotating first when the file has reached its cap.
 *
 * Never throws. A memory that can fail a task is worse than a memory that misses one: the task is the
 * work, and this is a note about it. The caller gets `false` and the reason is on the record instead.
 *
 * Writes are synchronous and `O_APPEND`, so two attempts finishing at once interleave as whole lines
 * rather than as corrupt ones -- the failure mode that would make the whole file unreadable.
 *
 * `maxBytes` is a parameter rather than a closed-over constant so that rotation is testable without
 * writing eight megabytes to prove it. A cap that can only be exercised at production size is a cap
 * whose rotation path is only exercised in production, which is the wrong place to find out.
 *
 * @param {string} stateDir
 * @param {object} record
 * @param {{maxBytes?: number}} [options]
 * @returns {{ok: true, path: string, bytes: number, rotated: boolean}|{ok: false, error: string}}
 */
export function appendMemory(stateDir, record, { maxBytes = MEMORY_MAX_BYTES } = {}) {
  try {
    if (typeof stateDir !== 'string' || stateDir === '') {
      return { ok: false, error: 'MEMORY_NO_STATE_DIR' };
    }
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const path = join(stateDir, MEMORY_FILE);

    let rotated = false;
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size >= maxBytes) {
        // Replace the previous generation rather than skipping rotation: keeping more than one would
        // defeat the cap, and the cap is the point.
        renameSync(path, join(stateDir, MEMORY_FILE_PREVIOUS));
        writeFileSync(path, '', { mode: 0o600 });
        rotated = true;
      }
    }

    const line = `${JSON.stringify(record)}\n`;
    appendFileSync(path, line, { mode: 0o600 });
    return { ok: true, path, bytes: Buffer.byteLength(line), rotated };
  } catch (error) {
    return { ok: false, error: `MEMORY_APPEND_FAILED: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Read records back, newest first.
 *
 * Ordering is by file position reversed, not by parsing every `at`: the file is append-only, so position
 * *is* time, and sorting would both cost more and mis-order two records written in the same millisecond.
 *
 * A malformed line is skipped rather than fatal. A partially written final line is the expected outcome
 * of a machine losing power mid-append, and one damaged line must not make the rest unreadable -- which
 * is exactly how the relay's own ledger behaves (`ledger_lines_skipped`), and for the same reason.
 *
 * Synchronous on purpose, and named for it: the reader is called from a tool that answers a question
 * about a local file, and every other reader in this codebase (`w2m_status` on `agent-state.json`) is a
 * synchronous read for the same reason -- a memory query that could interleave with an append would
 * report a state the file was never in.
 *
 * @param {string} stateDir
 * @param {{limit?: number, previous?: boolean}} [options]
 * @returns {{records: object[], skipped: number, truncated: boolean, path: string|null, error?: string}}
 */
export function readMemorySync(stateDir, { limit = 50, previous = false } = {}) {
  const empty = { records: [], skipped: 0, truncated: false, path: null };
  if (typeof stateDir !== 'string' || stateDir === '') return { ...empty, error: 'MEMORY_NO_STATE_DIR' };
  const path = join(stateDir, previous ? MEMORY_FILE_PREVIOUS : MEMORY_FILE);
  if (!existsSync(path)) return { ...empty, path };

  try {
    const text = statSync(path).size === 0 ? '' : readFileSync(path, 'utf8');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    const records = [];
    let skipped = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (records.length >= limit) break;
      try {
        records.push(JSON.parse(lines[i]));
      } catch {
        skipped += 1;
      }
    }
    return { records, skipped, truncated: records.length >= limit, path };
  } catch (error) {
    return { ...empty, path, error: `MEMORY_READ_FAILED: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Retained under the shorter name: the reader has always been synchronous. */
export const readMemory = readMemorySync;
