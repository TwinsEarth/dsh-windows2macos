/**
 * `session-reframe`: rebuild a v4 session log whose FIRST Zstandard frame carries the header
 * together with event rows into the shape the installed client requires.
 *
 * ## The defect (measured on a real log, 2026-11-21)
 *
 * `dsh-session-persistence-jsonl` refuses a session whose first frame is not exactly one header
 * line (`assertZstdHeaderFrame`, `src/index.ts:77-82`; compiled identically at
 * `lib/index.js:2298-2300`). The 2026-11-21 drill measured one such artifact on this machine:
 *
 *   `C:\Users\fangw\.dsh\sessions\--E-ToFuture--\session-9603c5c8-...\session.v4.jsonl.zstd`
 *   7,835,561 B, sha256 `45cc0452…a20b1c6`, 138 frames, 11,047 rows, first frame = 93 rows
 *   (the header plus events `seq 0..91`).
 *
 * The installed client's `open()` refused it with "first frame is not exactly one header line";
 * the app therefore never loaded the session. Nothing in the JSON text is wrong: the same rows,
 * re-framed, decode to 11,046 events (`seq 0..11045`) and are accepted by the client's own row
 * decoder (the drill's runtime gate passed on the broken bytes too -- the row decoder never looks
 * at frame boundaries, which is exactly why the frame rule has to be enforced separately).
 *
 * ## The repair (and why it cannot lose a byte)
 *
 *   frame 0 of the source   ->  decompressed once
 *   split at the FIRST 0x0A ->  header row | the event rows that shared that frame
 *   rebuilt container       ->  frame 0 = the header row ALONE
 *                               frame 1 = the event rows, copied verbatim, as ONE batch frame
 *                               frames 2..N = the source frames 1.. copied BYTE-IDENTICALLY
 *
 * The decompressed row stream is never re-serialised: the two halves are the original plaintext
 * bytes, split once. That is why the row-stream sha256 must stay equal, and it is verified twice:
 * before writing (the rebuilt container is decoded again, frame by frame) and after writing (the
 * file on disk is re-read and re-summarised). A mismatch is a refusal, never a "probably fine".
 *
 * One event frame holding many rows is legal: the client's scanner splits frames on newlines
 * (`src/format.ts:417-443`) and its own writer emits `eventLines(events) + '\n'` as one frame
 * (`src/index.ts:1381-1393`). The source frames after the first are copied unchanged, so the
 * repair neither fixes nor worsens anything about them (e.g. the drill log's tail frames carry no
 * zstd checksum: preserved as-is).
 *
 * ## Safety semantics (decided here, not left to the caller)
 *
 * * **The source is never written by default.** `--out <path>` names a *new* file; writing is a
 *   temp sibling -> fsync -> atomic rename in the target's own directory
 *   (`src/backup/atomic.mjs#writeFileAtomic`). The source's sha256 and mtime are untouched, and the
 *   real-log evidence run proves it.
 * * **In place is a separate, doubly explicit mode.** `--in-place` is accepted only together with
 *   `--force`; it refuses while DeepSeek Harness appears to be running (its live session holds its
 *   own append position); it copies the log to `<file>.bak-<utc-stamp>`, verifies that copy, and
 *   only then renames. If the written file fails its post-write verification, the verified copy is
 *   written back atomically -- an in-place repair never leaves an unverified log in place.
 * * **An existing `--out` is refused without `--force`.** Overwriting is a decision, not a default.
 * * **The source must not move under the plan.** Apply re-hashes the source; a changed file is a
 *   refusal (`FIX_REFUSED_BUSY`) rather than "write a repair of the previous bytes".
 * * **Already legal is a no-op.** Frame 0 = exactly one header line means nothing is written, not
 *   even a copy (`NOOP_ALREADY_LEGAL`).
 *
 * ## Refusal matrix
 *
 * | code | when | CLI exit |
 * |---|---|---|
 * | `FIX_REFUSED_TORN_TAIL` | the container ends with a partial zstd frame (the missing bytes may belong to any row, so no row boundary can be trusted) | 1 |
 * | `FIX_REFUSED_CONTAINER` | the file cannot be read, is empty, is not a frame stream (bad magic / reserved bit / reserved block type), has a frame that does not decompress, or the frames do not tile the file | 1 |
 * | `FIX_REFUSED_HEADER` | frame 0 has no newline, its first row is not JSON, is not the session header, or announces a version other than 4 | 1 |
 * | `FIX_REFUSED_ROW` | a row is not verifiable: a frame ends mid-row, a row is not JSON, or the event `seq` run is not dense from 0 (a frame repair cannot fix, and must not hide, a graph defect) | 1 |
 * | `FIX_REFUSED_ROW_MISMATCH` | the rebuilt container does not reproduce the source row stream (sha256 / row count / last seq / tail bytes / one-line frame 0), or a gate refuses it; `stage` names the check (`rebuild`, `static-doctor`, `future-append`, `runtime`) | 1 |
 * | `FIX_REFUSED_BUSY` | a write precondition failed: the source changed after planning, the destination exists without `--force`, `--out` names the source, the options contradict, or an in-place write was asked for while the client runs / without `--force` | 3 |
 * | `FIX_REFUSED_NO_RUNTIME` | the runtime gate is required (the default) and no installed Harness was found; `--allow-static` accepts static-only evidence instead | 1 |
 * | `FIX_REFUSED_WRITE` | the target could not be written, the bytes on disk do not verify, or an in-place rollback failed | 1 |
 * | `NOOP_ALREADY_LEGAL` | frame 0 is already exactly one header line: nothing was written | 0 |
 *
 * ## The gates, and why the static doctor alone is not evidence
 *
 * The default gate chain is:
 *
 *   1. **the container rule** -- the installed client's `assertZstdHeaderFrame`, transcribed here.
 *      It is the rule that refused the source, so the repaired bytes must satisfy it; it is
 *      checked, not assumed (`container_gate: 'transcribed'`).
 *   2. **the static doctor** (`diagnoseSessionBuffer`) -- a pre-filter, on the rebuilt container.
 *   3. **the future-append simulation** (`futureAppendVerdict`) -- the rebuilt log plus one legal
 *      `permission/preset` append must pass the doctor, and the appended `seq` must be
 *      `lastSeq + 1`; "it opens today" is not "it keeps opening".
 *   4. **the installed Harness** (`runtimeValidateBatch`, when found) -- the runtime verdict is
 *      the evidence (G5). `--allow-static` skips it, and every report then says
 *      `runtime_verified: false`.
 *
 * On the *source* shape the doctor emits three findings that are **graph false-positives**, not
 * defects of this log (they vanish by construction once the rows are counted, and the drill
 * measured them all gone after the repair):
 *
 * | source finding | why it is not a defect of this log |
 * |---|---|
 * | `ZSTD_HEADER_FRAME_INVALID` | **real** -- this is the defect being repaired |
 * | `SEQ_GAP` at 0 | false: the doctor's strict reading drops the rows that share the header frame, so `seq 0..91` look missing |
 * | `PROTECTED_HEAD_MISSING` | false: the protected `system/message` head is `seq 0`, which lives in that same frame |
 * | `SEQ_REF_DANGLING` (e.g. `seq 61`, `seq 88`) | false: those references address the same dropped events |
 *
 * The full explanation lives in `src/backup/future-append.mjs` lines 19-42; the short form is "a
 * frame boundary is a storage detail, rows are the log". The rebuilt log re-reads the rows from
 * ordinary frames, so the strict reading agrees with the append reading and all three disappear.
 *
 * ## Why `open()` is the authoritative gate and why it is not callable here
 *
 * The frame rule is enforced in the client's read path only: `open()` -> `requireStoredLog` ->
 * `decodeStoredLog` -> `readZstdPrefix` -> `assertZstdHeaderFrame` (`src/index.ts:1018`), *before*
 * any event row is parsed. `runtimeValidateBatch` cannot stand in for it: its driver builds
 * `{header, events}` from rows and never sees frame boundaries -- the drill proved that by passing
 * the broken log through it. The real proof is the client's `open()` itself, which lives inside
 * `resources/app.asar` and needs Electron's patched `fs`, so a plain `node` cannot import it. The
 * drill drove it out of process (`client-open-driver.mjs`): it accepted the repaired copy and
 * refused the original. **This command cannot call it**, so it transcribes the rule, reports
 * `container_gate: 'transcribed'`, and the docs say the operator's final check is to open the
 * session in the app.
 *
 * ## Memory
 *
 * The repair itself is streaming: `scanFramesFromFile` walks frame headers (256 KiB window), then
 * one frame at a time is decompressed and its rows parsed one at a time. Peak memory is the
 * largest single frame's plaintext (278 KB on the real log) -- not the 39 MB row stream, and not
 * the 7.8 MB file as one parse.
 *
 * The **gates** are buffer-based (`diagnoseSessionBuffer`, `futureAppendVerdict`,
 * `runtimeValidateBatch` all take a `Buffer`/artifact), so a plan that runs them materialises the
 * rebuilt container once (~container size) and the runtime gate additionally builds the artifact
 * object. Measured on the 2026-11-21 log (7.8 MB, 11,047 rows): 426-492 MB peak RSS across runs
 * (`--allow-static` 468.8 MB, runtime 491.5 MB, final 426.0 MB) -- the doctor's `splitFrames`
 * holds every row's string, which dominates; the streaming repair pass itself is kilobytes.
 * `peak_rss_mb` is reported so the cost is visible, and `--allow-static` removes the runtime half.
 * This split is deliberate: the repair must be safe on an arbitrarily large log, while the repo's
 * validators are what they are.
 *
 * Layer note: this module sits in `fix/` and reaches down to `backup/` for the gates and the
 * atomic writer (the same edge `fix/cli -> backup/renumber` already uses) and to `util/` for the
 * doctor. The `fix -> util` edge is declared in `scripts/layer-model.mjs`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { writeFileAtomic } from '../backup/atomic.mjs';
import { futureAppendVerdict } from '../backup/future-append.mjs';
import { buildArtifactFromBuffer, findHarnessInstallation, runtimeValidateBatch } from '../backup/runtime-validate.mjs';
import { diagnoseSessionBuffer } from '../util/session-validate.mjs';
import { compressFrame, scanFrames, scanFramesFromFile } from './zstd.mjs';

/** Named refusals and the no-op marker. Greppable on purpose: a report cites a code, not a sentence. */
export const REFRAME_CODES = Object.freeze({
  /** A partial zstd frame at the end of the container; the missing bytes may belong to any row. */
  TORN_TAIL: 'FIX_REFUSED_TORN_TAIL',
  /** Not a readable frame stream: bad magic, reserved header bit, a frame that does not decompress. */
  CONTAINER: 'FIX_REFUSED_CONTAINER',
  /** Frame 0 does not start with exactly one session-header row. */
  HEADER: 'FIX_REFUSED_HEADER',
  /** A row (or the `seq` run) cannot be verified, so the row stream cannot be trusted. */
  ROW: 'FIX_REFUSED_ROW',
  /** The rebuilt log does not reproduce the source row stream, or a gate refused it. */
  ROW_MISMATCH: 'FIX_REFUSED_ROW_MISMATCH',
  /** A write precondition failed (source changed, destination occupied, client running, bad options). */
  BUSY: 'FIX_REFUSED_BUSY',
  /** The runtime gate is required but no installed Harness was found. */
  NO_RUNTIME: 'FIX_REFUSED_NO_RUNTIME',
  /** The target could not be written, or the bytes written do not verify. */
  WRITE_FAILED: 'FIX_REFUSED_WRITE',
  /** Frame 0 is already exactly one header line; nothing was written. */
  NOOP: 'NOOP_ALREADY_LEGAL',
});

/** The installed client's rule, verbatim in effect (`src/index.ts:77-82`). */
const HEADER_FRAME_MESSAGE = 'corrupt Zstandard session log: first frame is not exactly one header line';

/** Only v4 logs are in scope; a v3 artifact is refused rather than guessed about. */
const SUPPORTED_VERSION = 4;

/** How much of the source is read at a time when hashing the whole file for the "unchanged" check. */
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

/** The stage a `FIX_REFUSED_ROW_MISMATCH` came from, so a refusal says *which* check refused. */
const STAGE = Object.freeze({
  REBUILD: 'rebuild',
  STATIC: 'static-doctor',
  APPEND: 'future-append',
  RUNTIME: 'runtime',
});

/**
 * The installed client's first-frame rule, transcribed from
 * `dsh-session-persistence-jsonl/src/index.ts:77-82` (= `lib/index.js:2298-2300`).
 *
 * The client's expression is `plaintext.indexOf(0x0A) !== plaintext.length - 1`: exactly one
 * newline, and it is the last byte. Accepts a string (the client's shape) or a Buffer (this
 * module's shape).
 *
 * @param {string|Buffer} plaintext
 * @returns {void}
 * @throws {Error} with the client's own message when the frame is not exactly one header line
 */
export function assertZstdHeaderFrame(plaintext) {
  const bytes = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  if (bytes.length === 0 || bytes.indexOf(0x0a) !== bytes.length - 1) {
    throw new Error(HEADER_FRAME_MESSAGE);
  }
}

/** The message of any thrown value. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The peak RSS sampler: one number, sampled where the plan can grow. */
function createMemorySampler() {
  let peak = process.memoryUsage().rss;
  return {
    sample() {
      const rss = process.memoryUsage().rss;
      if (rss > peak) peak = rss;
    },
    /** @returns {number} peak RSS in MiB, one decimal */
    peakMb() {
      return Math.round((peak / (1024 * 1024)) * 10) / 10;
    },
  };
}

/**
 * Open a file, run `fn(fd)`, and always close it.
 *
 * @template T
 * @param {string} file
 * @param {(fd: number) => T} fn
 * @returns {T}
 */
function withFile(file, fn) {
  const fd = fs.openSync(file, 'r');
  try {
    return fn(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read exactly `[start, end)` from an open file descriptor.
 *
 * @param {number} fd
 * @param {number} start
 * @param {number} end
 * @returns {Buffer}
 */
function readExact(fd, start, end) {
  const buffer = Buffer.allocUnsafe(end - start);
  const read = fs.readSync(fd, buffer, 0, buffer.length, start);
  if (read !== buffer.length) throw new Error(`short read at byte ${start}: wanted ${buffer.length}, got ${read}`);
  return buffer;
}

/**
 * Split one decompressed frame into its rows, byte-exactly.
 *
 * Rows are newline-terminated; `terminated` says whether the frame ends on a row boundary (the
 * client's scanner requires that -- a frame that stops mid-row is a torn write, not a row).
 *
 * @param {Buffer} plain
 * @returns {{rows: Buffer[], terminated: boolean}}
 */
function splitRows(plain) {
  const terminated = plain.length === 0 || plain[plain.length - 1] === 0x0a;
  const rows = [];
  let start = 0;
  while (start < plain.length) {
    const end = plain.indexOf(0x0a, start);
    if (end === -1) break;
    rows.push(plain.subarray(start, end));
    start = end + 1;
  }
  if (!terminated) rows.push(plain.subarray(start));
  return { rows, terminated };
}

/** Decompress one frame to BYTES (the repo helper decodes to a string; the split needs bytes). */
function plainFrame(raw) {
  return zlib.zstdDecompressSync(raw);
}

/** The failure shape {@link scanContainer} returns (counts are partial: enough for a report). */
function scanFailure(code, detail, counts) {
  return { ok: false, code, detail, ...counts };
}

/**
 * Walk a container's frames, hash the decompressed row stream and verify the event `seq` run.
 *
 * Called twice with different byte sources: the source file (pass A) and the rebuilt container
 * (pass B). `tailFrom` says where the "tail" starts, so the same function proves both that the
 * source tail was copied and that the rebuilt tail region is byte-identical.
 *
 * `parseRows: false` is the no-op summary: rows are counted and hashed, but no JSON is parsed and
 * no `seq` rule is applied (a no-op repair writes nothing, so there is no result to prove).
 *
 * @param {{
 *   frames: Array<{start: number, end: number}>, readRaw: (index: number, frame: object) => Buffer,
 *   expectFrame0Plain?: Buffer|null, parseRows?: boolean, tailFrom?: number,
 * }} options
 * @returns {{
 *   ok: boolean, code: string|null, detail: {message: string}|null, frames: number, rows: number,
 *   events: number, lastSeq: number, sha256: string|null, fileSha256: string|null,
 *   tailSha256: string|null, tailBytes: number, headerFrameRows: number, firstRowType: string|null,
 * }}
 */
function scanContainer(options) {
  const frames = options.frames;
  const parseRows = options.parseRows !== false;
  const expectFrame0Plain = options.expectFrame0Plain ?? null;
  const tailFrom = Number.isSafeInteger(options.tailFrom) ? options.tailFrom : 1;
  const fileHash = crypto.createHash('sha256');
  const rowHash = crypto.createHash('sha256');
  const tailHash = crypto.createHash('sha256');
  let rows = 0;
  let events = 0;
  let lastSeq = -1;
  let tailBytes = 0;
  let headerFrameRows = 0;
  let firstRowType = null;
  const counts = () => ({ frames: frames.length, rows, events, lastSeq, headerFrameRows, tailBytes });
  const fail = (code, detail) => ({
    ...scanFailure(code, detail, counts()),
    sha256: null,
    fileSha256: null,
    tailSha256: null,
    firstRowType,
  });

  for (const [index, frame] of frames.entries()) {
    const raw = options.readRaw(index, frame);
    fileHash.update(raw);
    if (index >= tailFrom) {
      tailHash.update(raw);
      tailBytes += raw.length;
    }
    let plain;
    try {
      plain = plainFrame(raw);
    } catch (error) {
      return fail(REFRAME_CODES.CONTAINER, {
        message: `frame ${index} (bytes ${frame.start}..${frame.end}) could not be decompressed: ${errorText(error)}`,
      });
    }
    if (expectFrame0Plain !== null && index === 0 && !plain.equals(expectFrame0Plain)) {
      return fail(REFRAME_CODES.CONTAINER, {
        message: 'frame 0 decompressed to different bytes on the second read; the file changed while it was being read',
      });
    }
    rowHash.update(plain);
    const split = splitRows(plain);
    if (index === 0) headerFrameRows = split.rows.length;
    if (!split.terminated) {
      return fail(REFRAME_CODES.ROW, {
        message: `frame ${index} ends with a row that is not newline-terminated; a complete frame must end on a row boundary`,
      });
    }
    for (const line of split.rows) {
      rows += 1;
      if (rows === 1) {
        // Row 1 is the header; the caller has already validated it. Its type is reported so the
        // rebuilt container can prove the header survived the split.
        if (parseRows) {
          try {
            firstRowType = JSON.parse(line.toString('utf8'))?.type ?? null;
          } catch {
            return fail(REFRAME_CODES.HEADER, { message: 'row 1 (the header) is not JSON' });
          }
        }
        continue;
      }
      events += 1;
      if (!parseRows) continue;
      const expectedSeq = events - 1;
      let row;
      try {
        row = JSON.parse(line.toString('utf8'));
      } catch {
        return fail(REFRAME_CODES.ROW, { message: `row ${rows} in frame ${index} is not JSON` });
      }
      if (!Number.isInteger(row?.seq)) {
        return fail(REFRAME_CODES.ROW, {
          message: `row ${rows} in frame ${index} carries no integer seq (${JSON.stringify(row?.seq ?? null)})`,
        });
      }
      if (row.seq !== expectedSeq) {
        return fail(REFRAME_CODES.ROW, {
          message:
            `row ${rows} in frame ${index} carries seq ${row.seq}, expected ${expectedSeq}; the event seq run is not ` +
            'dense from 0, and a frame repair cannot fix (or must not hide) a graph defect',
        });
      }
      lastSeq = row.seq;
    }
  }

  return {
    ok: true,
    code: null,
    detail: null,
    frames: frames.length,
    rows,
    events,
    lastSeq,
    sha256: rowHash.digest('hex'),
    fileSha256: fileHash.digest('hex'),
    tailSha256: tailHash.digest('hex'),
    tailBytes,
    headerFrameRows,
    firstRowType,
  };
}

/** Hash a file's bytes, streaming (used by apply to prove the source did not move). */
function hashFile(file) {
  const hash = crypto.createHash('sha256');
  return withFile(file, (fd) => {
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
    return hash.digest('hex');
  });
}

/** Compact UTC timestamp for the in-place sibling copy: `20261121T063902Z`. */
function compactStamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** The in-place copy written before the log is replaced. */
function backupPathFor(file, now) {
  return `${file}.bak-${compactStamp(now)}`;
}

/** Pick a sibling path that does not overwrite an earlier run's copy. */
function reserveSiblingPath(planned) {
  if (!fs.existsSync(planned)) return planned;
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = `${planned}-${suffix}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`could not find a free sibling name next to ${planned}`);
}

/**
 * The default runtime gate: one batch, one installed Harness, the repaired artifact.
 *
 * Only the repaired container is validated here (not the appended artifact). The append half is
 * `futureAppendVerdict`'s job; adding it to the runtime batch doubles a measured ~850 MB parent
 * footprint for a 7.8 MB log, and the runtime cannot see frame boundaries anyway (it decodes
 * rows), so the second artifact would add no container evidence.
 *
 * @param {{buffer: Buffer, harness: object, timeoutMs?: number}} input
 * @returns {{available: boolean, ok: boolean, detail: string, events: number, runtime: string|null,
 *   source: string|null, duration_ms: number}}
 */
function defaultRuntimeGate(input) {
  let artifact;
  try {
    artifact = buildArtifactFromBuffer(input.buffer);
  } catch (error) {
    return {
      available: true,
      ok: false,
      detail: `the rebuilt log could not be decoded into rows for the runtime validator: ${errorText(error)}`,
      events: 0,
      runtime: null,
      source: null,
      duration_ms: 0,
    };
  }
  const batch = runtimeValidateBatch({ artifacts: [artifact], harness: input.harness, timeoutMs: input.timeoutMs });
  const verdict = batch.verdicts[0] ?? { ok: false, detail: 'no verdict for the rebuilt artifact', events: 0 };
  return {
    available: batch.available === true,
    ok: batch.available === true && verdict.ok === true,
    detail: verdict.detail,
    events: verdict.events,
    runtime: batch.runtime,
    source: batch.source,
    duration_ms: batch.duration_ms,
  };
}

/** The empty plan: every field present, so a consumer never branches on `undefined`. */
function basePlan(context) {
  return {
    ok: false,
    refused: true,
    code: null,
    detail: '',
    file: context.file,
    outPath: context.outPath,
    dryRun: context.dryRun,
    inPlace: context.inPlace,
    force: context.force,
    allowStatic: context.allowStatic,
    noop: false,
    wrote: false,
    fileBytes: 0,
    frames: 0,
    framesAfter: 0,
    rows: 0,
    events: 0,
    lastSeq: null,
    nextSeq: null,
    headerFrameRows: 0,
    headerBytes: 0,
    eventBytes: 0,
    tailBytes: 0,
    tailFrames: 0,
    tailSha256: null,
    headerFrameBytesAfter: 0,
    eventFrameBytesAfter: 0,
    fileBytesAfter: 0,
    sha256Before: null,
    sha256After: null,
    fileSha256Before: null,
    fileSha256After: null,
    backupPath: null,
    newBytes: null,
    validation: {
      container_gate: 'transcribed',
      static: null,
      future_append: null,
      runtime: null,
      runtime_required: context.allowStatic !== true,
      runtime_verified: false,
    },
    peakRssMb: 0,
    durationMs: 0,
  };
}

/**
 * The public plan input, documented once.
 *
 * @typedef {{
 *   file: string, out?: string|null, dryRun?: boolean, inPlace?: boolean, force?: boolean,
 *   allowStatic?: boolean, dshRunning?: boolean, harness?: object|null,
 *   env?: Record<string, string|undefined>, timeoutMs?: number, runtimeGate?: Function, now?: Date,
 * }} PlanInput
 */

/**
 * Plan one re-frame. Reads the source, verifies it, rebuilds the container IN MEMORY, verifies the
 * rebuild and runs the gates; nothing is written (see {@link applySessionReframe}).
 *
 * `harness` is injectable so the "no installation" branch is deterministic in tests;
 * `runtimeGate` is a test seam with the shape of {@link defaultRuntimeGate} and is never passed by
 * the CLI.
 *
 * @param {PlanInput} input
 * @returns {object} the plan: `ok:false` carries `code`/`detail` and no bytes to write; `ok:true`
 *   carries the numbers and (unless it is a no-op) `newBytes` for {@link applySessionReframe}.
 *   `code === NOOP_ALREADY_LEGAL` means the log already satisfies the container rule, and nothing
 *   will be written.
 */
export function planSessionReframe(input = {}) {
  const started = Date.now();
  const memory = createMemorySampler();
  const now = input.now instanceof Date ? input.now : new Date();
  const dryRun = input.dryRun === true;
  const inPlace = input.inPlace === true;
  const force = input.force === true;
  const allowStatic = input.allowStatic === true;
  const file = input.file === undefined || input.file === null || input.file === '' ? null : path.resolve(String(input.file));
  const out = input.out === undefined || input.out === null || input.out === '' ? null : path.resolve(String(input.out));
  const context = { file, outPath: inPlace ? file : out, dryRun, inPlace, force, allowStatic, memory, started };

  /** A refusal plan with the sampler's numbers filled in. */
  const refuse = (code, detail, extra = {}) => ({
    ...basePlan(context),
    code,
    detail,
    peakRssMb: memory.peakMb(),
    durationMs: Date.now() - started,
    ...extra,
  });

  if (file === null) return refuse(REFRAME_CODES.CONTAINER, 'planSessionReframe needs a file path');
  if (inPlace && out !== null) {
    return refuse(REFRAME_CODES.BUSY, '--out and --in-place are mutually exclusive; refusing rather than guessing which one you meant');
  }
  if (inPlace) {
    if (!force) {
      return refuse(
        REFRAME_CODES.BUSY,
        'in-place writing needs --force as well: it replaces the session log (a verified <file>.bak-<stamp> copy is made first)',
      );
    }
    if (input.dshRunning === true) {
      return refuse(
        REFRAME_CODES.BUSY,
        'DeepSeek Harness appears to be running; its live session holds its own append position. Quit it before an ' +
          'in-place repair, or write a copy with --out',
      );
    }
  }

  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    return refuse(REFRAME_CODES.CONTAINER, `${file}: the log could not be read (${error?.code ?? errorText(error)})`);
  }
  if (!stat.isFile()) return refuse(REFRAME_CODES.CONTAINER, `${file}: not a regular file`);
  if (stat.size === 0) return refuse(REFRAME_CODES.CONTAINER, `${file}: the log is empty`);

  // -- structural scan: frame headers only, never payload bytes -------------------------------
  let walked;
  try {
    walked = scanFramesFromFile(file);
  } catch (error) {
    return refuse(REFRAME_CODES.CONTAINER, `${file}: the zstd container is unreadable: ${errorText(error)}`);
  }
  if (walked.tornStart !== undefined) {
    return refuse(
      REFRAME_CODES.TORN_TAIL,
      `${file}: the log ends with a partial zstd frame at byte ${walked.tornStart}; the missing bytes may belong to any ` +
        'row, so no row boundary can be trusted and a frame repair would be a guess',
      { fileBytes: walked.file_bytes, frames: walked.frames.length },
    );
  }
  const frames = walked.frames;
  if (frames.length === 0) return refuse(REFRAME_CODES.CONTAINER, `${file}: the log contains no complete zstd frame`);
  if (frames[frames.length - 1].end !== stat.size) {
    return refuse(
      REFRAME_CODES.CONTAINER,
      `${file}: the frames end at byte ${frames[frames.length - 1].end} but the file is ${stat.size} bytes long; the ` +
        'container does not tile the file',
    );
  }

  // -- frame 0: split it, byte-exactly, at the FIRST newline ----------------------------------
  let frame0Raw;
  let frame0Plain;
  try {
    frame0Raw = withFile(file, (fd) => readExact(fd, frames[0].start, frames[0].end));
    frame0Plain = plainFrame(frame0Raw);
  } catch (error) {
    return refuse(REFRAME_CODES.CONTAINER, `${file}: frame 0 could not be read/decompressed: ${errorText(error)}`);
  }
  const firstNewline = frame0Plain.indexOf(0x0a);
  if (firstNewline === -1) {
    return refuse(
      REFRAME_CODES.HEADER,
      `${file}: frame 0 holds no newline, so there is no header row boundary to split at (${frame0Plain.length} byte(s))`,
    );
  }
  const headerBytes = frame0Plain.subarray(0, firstNewline + 1);
  const eventBytes = frame0Plain.subarray(firstNewline + 1);
  let header;
  try {
    header = JSON.parse(headerBytes.subarray(0, headerBytes.length - 1).toString('utf8'));
  } catch {
    return refuse(REFRAME_CODES.HEADER, `${file}: the first row of frame 0 is not JSON, so there is no session header to preserve`);
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header) || header.type !== 'session') {
    return refuse(
      REFRAME_CODES.HEADER,
      `${file}: the first row of frame 0 is not the session header (type ${JSON.stringify(header?.type ?? null)})`,
    );
  }
  if (header.version !== SUPPORTED_VERSION) {
    return refuse(
      REFRAME_CODES.HEADER,
      `${file}: only v${SUPPORTED_VERSION} session logs are reframed, and this header announces version ` +
        `${JSON.stringify(header.version ?? null)}`,
    );
  }

  // The no-op and the repair share one row accounting, so the numbers in both reports mean the
  // same thing.
  const summarizeSource = (options) => {
    try {
      return withFile(file, (fd) =>
        scanContainer({
          frames,
          readRaw: (index, frame) => (index === 0 ? frame0Raw : readExact(fd, frame.start, frame.end)),
          expectFrame0Plain: frame0Plain,
          tailFrom: 1,
          ...options,
        }),
      );
    } catch (error) {
      return { ok: false, code: REFRAME_CODES.CONTAINER, detail: { message: `${file}: a frame could not be read: ${errorText(error)}` } };
    }
  };

  if (eventBytes.length === 0) {
    // The header alone occupies frame 0: the installed client's rule is already satisfied.
    const light = summarizeSource({ parseRows: false });
    memory.sample();
    if (light.ok !== true) {
      return refuse(light.code, light.detail?.message ?? 'the log could not be summarised', {
        fileBytes: stat.size,
        frames: frames.length,
        rows: light.rows ?? 0,
        events: light.events ?? 0,
      });
    }
    return {
      ...basePlan(context),
      ok: true,
      refused: false,
      code: REFRAME_CODES.NOOP,
      noop: true,
      detail:
        'frame 0 already holds exactly one header line, which is the shape the installed client requires; nothing was ' +
        'written (not even a copy)',
      fileBytes: stat.size,
      frames: frames.length,
      framesAfter: frames.length,
      rows: light.rows,
      events: light.events,
      headerFrameRows: 1,
      headerBytes: headerBytes.length,
      eventBytes: 0,
      tailBytes: light.tailBytes,
      tailFrames: frames.length - 1,
      tailSha256: light.tailSha256,
      fileBytesAfter: stat.size,
      sha256Before: light.sha256,
      sha256After: light.sha256,
      fileSha256Before: light.fileSha256,
      fileSha256After: light.fileSha256,
      peakRssMb: memory.peakMb(),
      durationMs: Date.now() - started,
    };
  }

  // -- the write target (checked before the expensive gates: a destination that will be refused
  //    must not cost a runtime validation) ------------------------------------------------------
  const outPath = inPlace ? file : out;
  if (outPath !== null) {
    if (!inPlace && outPath === file) {
      return refuse(REFRAME_CODES.BUSY, '--out names the source log itself; pass --in-place --force for a deliberate in-place repair instead');
    }
    if (outPath !== file && fs.existsSync(outPath)) {
      let isDirectory = false;
      try {
        isDirectory = fs.statSync(outPath).isDirectory();
      } catch {
        isDirectory = false;
      }
      if (isDirectory) return refuse(REFRAME_CODES.BUSY, `${outPath} is a directory, not a file path`);
      if (!force) return refuse(REFRAME_CODES.BUSY, `${outPath} already exists; pass --force to overwrite it`);
    }
  }

  // -- the source row stream: every frame, one at a time --------------------------------------
  const source = summarizeSource({ parseRows: true });
  memory.sample();
  if (source.ok !== true) {
    return refuse(source.code, source.detail?.message ?? 'the log could not be summarised', {
      fileBytes: stat.size,
      frames: frames.length,
      rows: source.rows ?? 0,
      events: source.events ?? 0,
    });
  }

  // -- rebuild: header frame + one event-batch frame + the untouched tail bytes ----------------
  let headerFrame;
  let eventFrame;
  try {
    headerFrame = compressFrame(headerBytes);
    eventFrame = compressFrame(eventBytes);
  } catch (error) {
    return refuse(REFRAME_CODES.ROW_MISMATCH, `the header/event frames could not be compressed: ${errorText(error)}`, {
      stage: STAGE.REBUILD,
    });
  }
  const chunks = [headerFrame, eventFrame];
  try {
    withFile(file, (fd) => {
      for (let index = 1; index < frames.length; index += 1) chunks.push(readExact(fd, frames[index].start, frames[index].end));
    });
  } catch (error) {
    return refuse(REFRAME_CODES.CONTAINER, `${file}: a tail frame could not be read for the rebuild: ${errorText(error)}`);
  }
  const newBytes = Buffer.concat(chunks);
  memory.sample();

  // -- verify the rebuild before anything is written -----------------------------------------
  let rebuiltFrames;
  try {
    rebuiltFrames = scanFrames(newBytes).frames;
  } catch (error) {
    return refuse(REFRAME_CODES.ROW_MISMATCH, `the rebuilt container is not a readable frame stream: ${errorText(error)}`, {
      stage: STAGE.REBUILD,
    });
  }
  const expectedFrame0Plain = Buffer.from(headerBytes);
  const built = scanContainer({
    frames: rebuiltFrames,
    readRaw: (index, frame) => newBytes.subarray(frame.start, frame.end),
    expectFrame0Plain: expectedFrame0Plain,
    parseRows: true,
    tailFrom: 2,
  });
  memory.sample();
  if (built.ok !== true) {
    return refuse(REFRAME_CODES.ROW_MISMATCH, built.detail?.message ?? 'the rebuilt container could not be verified', {
      stage: STAGE.REBUILD,
      rebuilt: { frames: rebuiltFrames.length },
    });
  }
  const mismatches = [];
  if (built.frames !== frames.length + 1) mismatches.push(`frames ${built.frames} != ${frames.length + 1}`);
  if (built.headerFrameRows !== 1) mismatches.push(`frame 0 holds ${built.headerFrameRows} row(s), not 1`);
  if (built.firstRowType !== 'session') mismatches.push(`frame 0's first row is ${JSON.stringify(built.firstRowType ?? null)}`);
  if (built.rows !== source.rows) mismatches.push(`rows ${built.rows} != ${source.rows}`);
  if (built.events !== source.events) mismatches.push(`events ${built.events} != ${source.events}`);
  if (built.lastSeq !== source.lastSeq) mismatches.push(`last seq ${built.lastSeq} != ${source.lastSeq}`);
  if (built.sha256 !== source.sha256) mismatches.push(`row-stream sha256 ${built.sha256} != ${source.sha256}`);
  if (built.tailBytes !== source.tailBytes) mismatches.push(`tail bytes ${built.tailBytes} != ${source.tailBytes}`);
  if (built.tailSha256 !== source.tailSha256) mismatches.push('the tail frames are not byte-identical');
  if (mismatches.length > 0) {
    return refuse(REFRAME_CODES.ROW_MISMATCH, `the rebuilt container does not reproduce the source row stream: ${mismatches.join('; ')}`, {
      stage: STAGE.REBUILD,
      mismatches,
      sha256Before: source.sha256,
      sha256After: built.sha256,
    });
  }
  try {
    assertZstdHeaderFrame(expectedFrame0Plain);
  } catch (error) {
    return refuse(REFRAME_CODES.ROW_MISMATCH, `the rebuilt frame 0 fails the client's rule: ${errorText(error)}`, {
      stage: STAGE.REBUILD,
    });
  }

  // -- gates: static doctor, future append, then the installed Harness -------------------------
  const staticVerdict = diagnoseSessionBuffer(newBytes);
  memory.sample();
  if (staticVerdict.ok !== true) {
    return refuse(REFRAME_CODES.ROW_MISMATCH, `the rebuilt log does not pass the static doctor: ${staticVerdict.codes.join(', ')}`, {
      stage: STAGE.STATIC,
      codes: staticVerdict.codes,
    });
  }
  const future = futureAppendVerdict(newBytes);
  memory.sample();
  const nextSeq = future?.detail?.next_seq ?? null;
  if (future.ok !== true || future.observation !== null || (future.codes ?? []).length > 0) {
    return refuse(
      REFRAME_CODES.ROW_MISMATCH,
      `the rebuilt log fails the future-append simulation: ${(future.codes ?? []).join(', ') || future.observation?.code || 'no code'}`,
      { stage: STAGE.APPEND, codes: future.codes ?? [], observation: future.observation ?? null },
    );
  }
  if (nextSeq !== source.lastSeq + 1) {
    return refuse(
      REFRAME_CODES.ROW_MISMATCH,
      `the future-append simulation would append seq ${JSON.stringify(nextSeq)} instead of ${source.lastSeq + 1}`,
      { stage: STAGE.APPEND },
    );
  }

  let runtimeVerdict = null;
  if (!allowStatic) {
    const harness = input.harness !== undefined ? input.harness : findHarnessInstallation({ env: input.env });
    if (harness === null || harness === undefined) {
      return refuse(
        REFRAME_CODES.NO_RUNTIME,
        'no installed DeepSeek Harness was found, so the runtime verdict (the evidence) cannot run; pass --allow-static ' +
          'to accept static-only evidence (the report then says runtime_verified:false)',
        { stage: STAGE.RUNTIME },
      );
    }
    const gate = typeof input.runtimeGate === 'function' ? input.runtimeGate : defaultRuntimeGate;
    try {
      runtimeVerdict = gate({ buffer: newBytes, harness, timeoutMs: input.timeoutMs });
    } catch (error) {
      return refuse(REFRAME_CODES.NO_RUNTIME, `the runtime gate could not run: ${errorText(error)}`, { stage: STAGE.RUNTIME });
    }
    memory.sample();
    if (runtimeVerdict?.available !== true) {
      return refuse(REFRAME_CODES.NO_RUNTIME, `the runtime validator is unavailable: ${runtimeVerdict?.detail ?? 'no verdict'}`, {
        stage: STAGE.RUNTIME,
      });
    }
    if (runtimeVerdict.ok !== true) {
      return refuse(REFRAME_CODES.ROW_MISMATCH, `the installed Harness refused the rebuilt log: ${runtimeVerdict.detail ?? 'no detail'}`, {
        stage: STAGE.RUNTIME,
        runtime: runtimeVerdict,
      });
    }
    if (runtimeVerdict.events !== source.events) {
      return refuse(
        REFRAME_CODES.ROW_MISMATCH,
        `the installed Harness accepted ${runtimeVerdict.events} event(s) but the rebuilt log carries ${source.events}; a ` +
          'verdict that accounts for fewer events is not evidence',
        { stage: STAGE.RUNTIME, runtime: runtimeVerdict },
      );
    }
  }

  return {
    ...basePlan(context),
    ok: true,
    refused: false,
    code: null,
    detail:
      (dryRun ? 'dry run: the log can be reframed' : 'the log can be reframed') +
      ` (${source.rows} row(s), ${source.events} event(s))` +
      (dryRun ? '; nothing was written' : ''),
    fileBytes: stat.size,
    frames: frames.length,
    framesAfter: frames.length + 1,
    rows: source.rows,
    events: source.events,
    lastSeq: source.lastSeq,
    nextSeq,
    headerFrameRows: source.headerFrameRows,
    headerBytes: headerBytes.length,
    eventBytes: eventBytes.length,
    tailBytes: source.tailBytes,
    tailFrames: frames.length - 1,
    tailSha256: source.tailSha256,
    headerFrameBytesAfter: headerFrame.length,
    eventFrameBytesAfter: eventFrame.length,
    fileBytesAfter: newBytes.length,
    sha256Before: source.sha256,
    sha256After: built.sha256,
    fileSha256Before: source.fileSha256,
    fileSha256After: built.fileSha256,
    outPath,
    backupPath: inPlace ? backupPathFor(file, now) : null,
    newBytes,
    validation: {
      container_gate: 'transcribed',
      static: {
        ok: staticVerdict.ok === true,
        codes: staticVerdict.codes,
        events: staticVerdict.events,
        frames: staticVerdict.detail?.frames ?? null,
      },
      future_append: {
        ok: future.ok === true,
        codes: future.codes ?? [],
        next_seq: nextSeq,
        evidence: future.evidence,
        appended_bytes: future.appended_bytes,
      },
      runtime: runtimeVerdict,
      runtime_required: !allowStatic,
      runtime_verified: runtimeVerdict !== null && runtimeVerdict.ok === true,
    },
    peakRssMb: memory.peakMb(),
    durationMs: Date.now() - started,
  };
}

/**
 * Verify a written file against the plan, streaming frame by frame.
 *
 * @param {string} file
 * @param {object} plan
 * @returns {{ok: boolean, code: string|null, detail: string, frames: number, rows: number,
 *   lastSeq: number|null, sha256: string|null, tailBytes: number}}
 */
function verifyWrittenFile(file, plan) {
  const failure = (code, detail, counts = {}) => ({
    ok: false,
    code,
    detail,
    frames: counts.frames ?? 0,
    rows: counts.rows ?? 0,
    lastSeq: counts.lastSeq ?? null,
    sha256: counts.sha256 ?? null,
    tailBytes: counts.tailBytes ?? 0,
  });
  let walked;
  try {
    walked = scanFramesFromFile(file);
  } catch (error) {
    return failure(REFRAME_CODES.WRITE_FAILED, `the written file is not a frame stream: ${errorText(error)}`);
  }
  if (walked.tornStart !== undefined) {
    return failure(REFRAME_CODES.WRITE_FAILED, `the written file ends with a partial frame at byte ${walked.tornStart}`, {
      frames: walked.frames.length,
    });
  }
  let summary;
  try {
    summary = withFile(file, (fd) =>
      scanContainer({
        frames: walked.frames,
        readRaw: (index, frame) => readExact(fd, frame.start, frame.end),
        parseRows: true,
        tailFrom: 2,
      }),
    );
  } catch (error) {
    return failure(REFRAME_CODES.WRITE_FAILED, `the written file could not be read back: ${errorText(error)}`);
  }
  const counts = { frames: summary.frames, rows: summary.rows, lastSeq: summary.lastSeq, sha256: summary.sha256, tailBytes: summary.tailBytes };
  // Every post-write finding is `FIX_REFUSED_WRITE`: whatever the written file is, the write is the
  // step that failed. The plan-stage codes (ROW_MISMATCH in particular) describe the rebuild.
  if (summary.ok !== true) return failure(REFRAME_CODES.WRITE_FAILED, summary.detail?.message ?? 'the written file could not be summarised', counts);
  if (summary.frames !== plan.framesAfter) return failure(REFRAME_CODES.WRITE_FAILED, `the written file has ${summary.frames} frame(s), expected ${plan.framesAfter}`, counts);
  if (summary.headerFrameRows !== 1) return failure(REFRAME_CODES.WRITE_FAILED, `the written frame 0 holds ${summary.headerFrameRows} row(s), not 1`, counts);
  if (summary.firstRowType !== 'session') return failure(REFRAME_CODES.WRITE_FAILED, `the written frame 0's first row is ${JSON.stringify(summary.firstRowType ?? null)}, not the session header`, counts);
  if (summary.rows !== plan.rows) return failure(REFRAME_CODES.WRITE_FAILED, `the written file has ${summary.rows} row(s), expected ${plan.rows}`, counts);
  if (summary.lastSeq !== plan.lastSeq) return failure(REFRAME_CODES.WRITE_FAILED, `the written file's last seq is ${summary.lastSeq}, expected ${plan.lastSeq}`, counts);
  if (summary.sha256 !== plan.sha256After) {
    return failure(REFRAME_CODES.WRITE_FAILED, `the written file's row-stream sha256 is ${summary.sha256}, expected ${plan.sha256After}`, counts);
  }
  if (summary.tailBytes !== plan.tailBytes || summary.tailSha256 !== plan.tailSha256) {
    return failure(REFRAME_CODES.WRITE_FAILED, 'the written file does not preserve the tail frames byte-identically', counts);
  }
  if (summary.fileSha256 !== plan.fileSha256After) {
    return failure(REFRAME_CODES.WRITE_FAILED, `the written file's sha256 is ${summary.fileSha256}, expected ${plan.fileSha256After}`, counts);
  }
  return {
    ok: true,
    code: null,
    detail: 'the written file reproduces the planned row stream, row count, last seq, tail bytes and file sha256',
    frames: summary.frames,
    rows: summary.rows,
    lastSeq: summary.lastSeq,
    sha256: summary.sha256,
    tailBytes: summary.tailBytes,
  };
}

/**
 * Put the verified in-place copy back, atomically.
 *
 * A failed post-write verification of an in-place repair must not leave unverified bytes where the
 * log was. The copy was hashed against the plan before the rename, so it is the known-good state.
 *
 * @param {string} file
 * @param {string} backupPath
 * @param {string} expectedSha256
 * @returns {{ok: boolean, detail: string}}
 */
function restoreFromBackup(file, backupPath, expectedSha256) {
  let bytes;
  try {
    bytes = fs.readFileSync(backupPath);
  } catch (error) {
    return { ok: false, detail: `the verified copy ${backupPath} could not be read (${errorText(error)})` };
  }
  try {
    writeFileAtomic(file, bytes);
  } catch (error) {
    return { ok: false, detail: `the verified copy could not be written back (${error?.detail ?? errorText(error)})` };
  }
  let restoredSha;
  try {
    restoredSha = hashFile(file);
  } catch (error) {
    return { ok: false, detail: `the restored log could not be read back (${errorText(error)})` };
  }
  if (restoredSha !== expectedSha256) {
    return { ok: false, detail: `the restored log hashes to ${restoredSha}, not to ${expectedSha256}` };
  }
  return { ok: true, detail: `the original bytes were restored from ${backupPath}` };
}

/**
 * Apply a planned re-frame: write a temp sibling, fsync it, rename it into place, then re-read the
 * written file and verify it reproduces the planned row stream.
 *
 * A plan with `dryRun: true`, `noop: true` or no output target writes nothing and says so.
 *
 * @param {object} plan the object {@link planSessionReframe} returned
 * @returns {{
 *   ok: boolean, wrote: boolean, code: string|null, detail: string, dry_run: boolean,
 *   file: string|null, outPath: string|null, bytes: number, sha256: string|null,
 *   backupPath: string|null, restored_from_backup: boolean, verified: object|null, durationMs: number,
 * }}
 */
export function applySessionReframe(plan) {
  const started = Date.now();
  const outcome = (fields) => ({
    ok: false,
    wrote: false,
    code: null,
    detail: '',
    dry_run: plan?.dryRun === true,
    file: plan?.file ?? null,
    outPath: plan?.outPath ?? null,
    bytes: 0,
    sha256: null,
    backupPath: null,
    restored_from_backup: false,
    verified: null,
    durationMs: Date.now() - started,
    ...fields,
  });
  if (plan === null || typeof plan !== 'object') {
    return outcome({ code: REFRAME_CODES.CONTAINER, detail: 'there is no plan to apply' });
  }
  if (plan.noop === true) {
    return outcome({ ok: true, code: REFRAME_CODES.NOOP, detail: plan.detail ?? 'frame 0 is already legal; nothing was written' });
  }
  if (plan.ok !== true) {
    return outcome({ code: plan.code ?? REFRAME_CODES.ROW_MISMATCH, detail: plan.detail ?? 'the plan is not successful' });
  }
  if (plan.dryRun === true) {
    return outcome({ ok: true, dry_run: true, detail: 'dry run: nothing was written' });
  }
  if (plan.outPath === null || plan.outPath === undefined) {
    return outcome({
      code: REFRAME_CODES.BUSY,
      detail: 'the plan has no output target; pass --out <path> (or --in-place --force) instead of only --dry-run',
    });
  }
  if (!Buffer.isBuffer(plan.newBytes)) {
    return outcome({ code: REFRAME_CODES.WRITE_FAILED, detail: 'the plan does not carry the bytes to write' });
  }

  // The plan described the bytes that were on disk. A source that moved under us (the live client
  // appends) must not be replaced by a repair of different bytes.
  let currentSize;
  try {
    currentSize = fs.statSync(plan.file).size;
  } catch (error) {
    return outcome({ code: REFRAME_CODES.BUSY, detail: `${plan.file}: the source log disappeared before the write (${error?.code ?? errorText(error)})` });
  }
  if (currentSize !== plan.fileBytes) {
    return outcome({
      code: REFRAME_CODES.BUSY,
      detail: `${plan.file} changed after the plan was made (${currentSize} B now, ${plan.fileBytes} B then); nothing was ` +
        'written. Quit the client and plan again',
    });
  }
  let currentSha;
  try {
    currentSha = hashFile(plan.file);
  } catch (error) {
    return outcome({ code: REFRAME_CODES.BUSY, detail: `${plan.file}: the source log could not be re-read (${errorText(error)})` });
  }
  if (currentSha !== plan.fileSha256Before) {
    return outcome({
      code: REFRAME_CODES.BUSY,
      detail: `${plan.file} changed after the plan was made (sha256 ${currentSha} now, ${plan.fileSha256Before} then); ` +
        'nothing was written. Quit the client and plan again',
    });
  }

  const inPlace = plan.inPlace === true;
  if (!inPlace && path.resolve(plan.outPath) === path.resolve(plan.file)) {
    // Defence in depth: the planner already refuses this, but a hand-built plan must not turn
    // "write a copy" into "replace the source behind the operator's back".
    return outcome({ code: REFRAME_CODES.BUSY, detail: 'the output path is the source log itself; nothing was written' });
  }
  let backupPath = null;
  if (inPlace) {
    if (plan.force !== true) {
      return outcome({ code: REFRAME_CODES.BUSY, detail: 'in-place writing needs --force; nothing was written' });
    }
    try {
      backupPath = reserveSiblingPath(plan.backupPath ?? backupPathFor(plan.file, new Date()));
      fs.copyFileSync(plan.file, backupPath);
    } catch (error) {
      return outcome({
        code: REFRAME_CODES.WRITE_FAILED,
        detail: `${plan.file}: could not write the sibling copy before the in-place repair: ${errorText(error)}`,
      });
    }
    // Read the copy back before touching the original: a failed copy with the original intact is a
    // refusal; a failed copy followed by a rename is a lost log.
    let copySha;
    try {
      copySha = hashFile(backupPath);
    } catch (error) {
      return outcome({
        code: REFRAME_CODES.WRITE_FAILED,
        backupPath,
        detail: `the sibling copy ${backupPath} could not be read back (${errorText(error)}); nothing was written`,
      });
    }
    if (copySha !== plan.fileSha256Before) {
      try {
        fs.rmSync(backupPath, { force: true });
      } catch {
        /* best effort: the original is untouched and remains the source of truth */
      }
      return outcome({
        code: REFRAME_CODES.WRITE_FAILED,
        detail: `the sibling copy ${backupPath} does not match the original bytes; nothing was written`,
      });
    }
  } else if (fs.existsSync(plan.outPath) && plan.force !== true) {
    return outcome({ code: REFRAME_CODES.BUSY, detail: `${plan.outPath} already exists; pass --force to overwrite it` });
  }

  try {
    writeFileAtomic(plan.outPath, plan.newBytes);
  } catch (error) {
    return outcome({
      code: REFRAME_CODES.WRITE_FAILED,
      backupPath,
      detail: `${error?.detail ?? errorText(error)}${backupPath === null ? '' : `; the original is preserved at ${backupPath}`}`,
    });
  }

  // Re-read the bytes on disk: the plan's promises are about the file, not about the Buffer.
  let writtenStat;
  try {
    writtenStat = fs.statSync(plan.outPath);
  } catch (error) {
    return outcome({ code: REFRAME_CODES.WRITE_FAILED, backupPath, detail: `${plan.outPath}: the written file is missing (${errorText(error)})` });
  }
  let verify;
  try {
    verify = verifyWrittenFile(plan.outPath, plan);
  } catch (error) {
    verify = { ok: false, code: REFRAME_CODES.WRITE_FAILED, detail: `the written file could not be verified: ${errorText(error)}` };
  }
  if (verify.ok !== true) {
    let restored = false;
    let restoreDetail = '';
    if (inPlace) {
      const back = restoreFromBackup(plan.file, backupPath, plan.fileSha256Before);
      restored = back.ok === true;
      restoreDetail = back.ok === true
        ? `; ${back.detail}`
        : `; ROLLBACK FAILED: ${back.detail} -- the verified copy is at ${backupPath}`;
    } else {
      // A fresh --out that does not verify must not be left behind looking like a repaired log.
      try {
        fs.rmSync(plan.outPath, { force: true });
      } catch {
        /* best effort: the refusal is the point */
      }
      restoreDetail = '; the output was removed';
    }
    return outcome({
      code: verify.code ?? REFRAME_CODES.WRITE_FAILED,
      backupPath,
      restored_from_backup: restored,
      detail: `${verify.detail ?? 'the written file does not verify'}${restoreDetail}`,
    });
  }

  return outcome({
    ok: true,
    wrote: true,
    code: null,
    detail: `wrote ${writtenStat.size} byte(s) to ${plan.outPath}` + (backupPath === null ? '' : `; the original is preserved at ${backupPath}`),
    bytes: writtenStat.size,
    sha256: plan.fileSha256After,
    backupPath,
    verified: verify,
  });
}
