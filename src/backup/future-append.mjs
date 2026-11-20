/**
 * Gate G3/G5: backups store **original bytes**, and a restored log is validated by simulating the *next* append.
 *
 * ## The two halves, and why they live together
 *
 * 1. **原始字节**: the engine never parses-and-rewrites a session log; it chunks the file bytes, seals the blocks and
 *    records `sha256`/`size`/`mtime` in the manifest. That is why a torn or already-broken log can still be backed
 *    up -- preserving the evidence is the point -- and why restore can prove byte fidelity by hashing what it writes.
 * 2. **未来追加模拟**: "it opens today" is not "it keeps opening". The 2026-11-17 drill's failures showed up on the
 *    *next* append (a late `system/message`, a missing `surfaceOp`), so the validator also checks the log plus one
 *    legal appended event. `permission/preset` is the weakest legal append found empirically against the installed
 *    Harness: session-level, no turn state, no surface, no references (`turn/start` needs the next turn number,
 *    which depends on state that a validator should not have to guess).
 *
 * The append helper is pure (bytes in, bytes out). Engine reports the simulation's outcome without refusing the
 * backup; restore refuses when the appended log fails; verify re-runs it for every snapshot, and with `--runtime`
 * asks the installed Harness about the appended artifact too.
 *
 * ## Reading the artifact: every row counts (2026-11-21)
 *
 * The simulation used to compute the appended `seq` as "row count minus the header" and to validate the result with
 * the doctor's **strict** reading, which treats the rows that share the header frame as "not events". A real artifact
 * re-encoded by a tool (not by the client) can put the first N events in the header frame; on the 2026-11-20
 * real-machine drill that single shape difference produced four findings on one log:
 *
 * | code | was it real? |
 * |---|---|
 * | `ZSTD_HEADER_FRAME_INVALID` | **yes** -- the installed Harness's `assertZstdHeaderFrame` requires exactly one header line, so the client refuses this file (`393` of the `394` real logs on this machine comply) |
 * | `SEQ_GAP` at 0 | no -- the events in the header frame (`seq 0..91`) were dropped from the event list |
 * | `PROTECTED_HEAD_MISSING` | no -- the protected `system/message` head *is* the first surface event, but it lives in that frame |
 * | `SEQ_REF_DANGLING` | no -- the refs (`seq 61`, `seq 88`, ...) address those same dropped events |
 *
 * So this module now reads **every row** ({@link lastEventSeq}, via `readLogContainer`) and derives the appended
 * `seq` from the true last seq, not from a row count (a row count is right only while the seq run is dense from 0;
 * `src/fix/session.mjs#readSession` derives `lastSeq` the same way). It also separates the findings:
 *
 * - `append_codes` -- what the one appended event *introduced* (a genuine future-append failure);
 * - `graph_codes` -- event-graph defects already in the artifact (`SEQ_GAP`, `PROTECTED_HEAD_MISSING`, ...);
 * - `container_codes` -- physical-container defects already in the artifact (`ZSTD_HEADER_FRAME_INVALID`, a missing
 *   header): the client refuses such a file before reading an event, so the append probe cannot be quoted as evidence
 *   for it. That case is reported with the named observation {@link FUTURE_APPEND_UNSUPPORTED} instead of pretending
 *   the append said something.
 *
 * The boolean `ok` stays strict (`ok === true` iff the appended artifact passes every rule), because the engine's
 * "N/N still load after one legal append" line and renumber's static gate must not count an unreadable container as a
 * pass. Callers that need the distinction read the three code lists and `observation`.
 */

import { compressFrame, decompressFrame, scanFrames } from '../fix/zstd.mjs';
import { diagnoseSessionBuffer } from '../util/session-validate.mjs';

/** The type/data of the one event the simulation appends. */
export const APPEND_EVENT = Object.freeze({ type: 'permission/preset', data: Object.freeze({ preset: 'workspace-write' }) });

/**
 * Named observation: the append probe cannot be quoted as evidence for this artifact.
 *
 * It is an `observation`, not a problem code: the defect that makes the probe meaningless is reported separately
 * (`container_codes`); this name says only "do not cite the append simulation here".
 */
export const FUTURE_APPEND_UNSUPPORTED = 'BACKUP_FUTURE_APPEND_UNSUPPORTED';

/** Doctor codes that describe the physical container rather than the event graph. */
const CONTAINER_CODES = new Set(['ZSTD_HEADER_FRAME_INVALID', 'SESSION_HEADER_MISSING', 'LOG_UNREADABLE', 'LOG_EMPTY']);

/** Fallback code when the bytes are not a Zstandard frame stream at all. */
const UNREADABLE_CODE = 'BACKUP_SCAN_HEADER_UNREADABLE';

/**
 * Count the rows (header + events) of a session log without parsing every JSON row.
 *
 * Kept for callers that only need a cheap size/shape reading (and for the tests that pin the frame walk). The append
 * simulation no longer derives `seq` from it: see {@link lastEventSeq}.
 *
 * @param {Buffer} buffer
 * @returns {{frames: number, rows: number, torn: boolean, error: string|null}}
 */
export function countLogRows(buffer) {
  const scanned = scanFrames(buffer);
  let rows = 0;
  let error = null;
  for (const frame of scanned.frames) {
    try {
      const text = decompressFrame(buffer.subarray(frame.start, frame.end));
      for (const line of text.split('\n')) if (line.trim() !== '') rows += 1;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      break;
    }
  }
  return { frames: scanned.frames.length, rows, torn: scanned.tornStart !== undefined, error };
}

/**
 * Walk the container and parse every row, including the rows that share the header frame.
 *
 * The walk is the same one the runtime artifact builder does (`buildArtifactFromBuffer`): frame boundaries are a
 * storage detail, rows are the log. `legible` is the narrow container rule the installed Harness enforces
 * (`assertZstdHeaderFrame`): exactly one row in the first frame, and that row is the session header.
 *
 * @param {Buffer} buffer
 * @returns {{ok: boolean, error: string|null, frames: number, torn: boolean, rows: number,
 *   headerFrameRows: number, headerFrameRowsParsed: number, firstRowIsHeader: boolean, legible: boolean,
 *   lastSeq: number}}
 */
function readLogContainer(buffer) {
  let scanned;
  try {
    scanned = scanFrames(buffer);
  } catch (error) {
    return unreadableContainer(error);
  }
  let rows = 0;
  let headerFrameRows = 0;
  let headerFrameRowsParsed = 0;
  let firstRow = null;
  let firstRowSeen = false;
  let lastSeq = -1;
  for (const [frameIndex, frame] of scanned.frames.entries()) {
    let text;
    try {
      text = decompressFrame(buffer.subarray(frame.start, frame.end));
    } catch (error) {
      return unreadableContainer(error);
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    if (frameIndex === 0) headerFrameRows = lines.length;
    for (const line of lines) {
      rows += 1;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        row = null;
      }
      if (row !== null && frameIndex === 0) headerFrameRowsParsed += 1;
      if (!firstRowSeen) {
        firstRow = row;
        firstRowSeen = true;
      }
      if (Number.isInteger(row?.seq) && row.seq > lastSeq) lastSeq = row.seq;
    }
  }
  const firstRowIsHeader = firstRow?.type === 'session';
  // Rows that are not JSON are not events, but their presence in the header frame still breaks the container rule.
  const legible = firstRowIsHeader && headerFrameRows === 1;
  return {
    ok: true,
    error: null,
    frames: scanned.frames.length,
    torn: scanned.tornStart !== undefined,
    rows,
    headerFrameRows,
    headerFrameRowsParsed,
    firstRowIsHeader,
    legible,
    lastSeq,
  };
}

/** The container result for bytes that are not a decodable frame stream. */
function unreadableContainer(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: message,
    frames: 0,
    torn: false,
    rows: 0,
    headerFrameRows: 0,
    headerFrameRowsParsed: 0,
    firstRowIsHeader: false,
    legible: false,
    lastSeq: -1,
  };
}

/**
 * The highest event `seq` in the log, or `null` when the container cannot be read at all.
 *
 * `-1` means "readable, but it carries no events" (a header-only artifact). This is the same number
 * `src/fix/session.mjs#readSession` reports as `lastSeq`, derived from the bytes instead of a file path because the
 * backup paths hold the bytes already.
 *
 * @param {Buffer} buffer
 * @returns {number|null}
 */
export function lastEventSeq(buffer) {
  const container = readLogContainer(buffer);
  if (container.ok !== true) return null;
  return container.lastSeq;
}

/**
 * Append one legal event to a session log, in memory.
 *
 * The appended `seq` is `lastEventSeq + 1`. For a healthy log (dense `seq` from 0, one header row) that is exactly
 * the old `rows - 1`; for an artifact whose rows are not dense, or whose header frame carries events, only this
 * derivation is correct.
 *
 * @param {Buffer} buffer
 * @param {{nextSeq?: number}} [options] `nextSeq` overrides the derivation (tests, or a caller that already read it)
 * @returns {Buffer} the original bytes followed by one compressed event frame
 */
export function appendLegalEvent(buffer, options = {}) {
  const nextSeq = options.nextSeq ?? nextAppendSeq(buffer);
  const event = { type: APPEND_EVENT.type, seq: nextSeq, time: Date.now(), data: APPEND_EVENT.data };
  return Buffer.concat([buffer, compressFrame(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'))]);
}

/** The `seq` the next legal event must carry (`lastEventSeq + 1`; row count only as an unreadable fallback). */
function nextAppendSeq(buffer) {
  const lastSeq = lastEventSeq(buffer);
  if (lastSeq !== null) return lastSeq + 1;
  return Math.max(0, countLogRows(buffer).rows - 1);
}

/**
 * Split the doctor's findings into "the container is not a v4 log" and "the event graph is broken".
 *
 * @param {string[]} codes
 * @returns {{container_codes: string[], graph_codes: string[]}}
 */
function classifyCodes(codes) {
  const container = [];
  const graph = [];
  for (const code of codes) (CONTAINER_CODES.has(code) ? container : graph).push(code);
  return { container_codes: container, graph_codes: graph };
}

/**
 * The reason a probe result cannot be quoted, or `null` when it can.
 *
 * @param {ReturnType<typeof readLogContainer>} container
 * @returns {{code: string, reason: string}|null}
 */
function unsupportedObservation(container) {
  if (container.ok !== true) {
    return {
      code: FUTURE_APPEND_UNSUPPORTED,
      reason:
        `the artifact is not a decodable Zstandard frame stream (${container.error ?? 'unknown error'}), so there is no ` +
        'legal next append to simulate against these bytes',
    };
  }
  if (container.legible === true) return null;
  const which = container.firstRowIsHeader
    ? `the first frame carries ${container.headerFrameRows} row(s)`
    : 'the first row is not the session header';
  const defect = container.firstRowIsHeader ? 'ZSTD_HEADER_FRAME_INVALID' : 'SESSION_HEADER_MISSING';
  return {
    code: FUTURE_APPEND_UNSUPPORTED,
    reason:
      `the artifact is not a legible v4 container (${which}; the installed Harness's assertZstdHeaderFrame requires ` +
      'exactly one header line in the first frame), so appending one event to these bytes cannot be quoted as evidence ' +
      `that the next append will load; the container defect is reported separately as ${defect}`,
  };
}

/**
 * Simulate the next append and validate the result with the static pre-filter.
 *
 * The event list includes the rows that share the header frame (see the module documentation), so the three
 * false findings of the 2026-11-20 drill cannot be produced by such an artifact again. `ok` is strict: it is
 * `true` only when the appended artifact has no finding at all.
 *
 * @param {Buffer} buffer
 * @returns {{
 *   ok: boolean, codes: string[], append_codes: string[], preexisting_codes: string[],
 *   container_codes: string[], graph_codes: string[], observation: {code: string, reason: string}|null,
 *   detail: object|null, appended_bytes: number, evidence: string
 * }} `evidence` is always `'static-prefilter'`: G5 says this may pre-screen but must never be quoted as the gate;
 *   the installed Harness's verdict (`runtime-validate.mjs`) is the evidence.
 */
export function futureAppendVerdict(buffer) {
  const container = readLogContainer(buffer);
  const observation = unsupportedObservation(container);
  const diagnoseOptions = { includeHeaderFrameEvents: true };
  let appended;
  try {
    appended = appendLegalEvent(buffer, { nextSeq: container.ok === true ? container.lastSeq + 1 : undefined });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      codes: [UNREADABLE_CODE],
      append_codes: [],
      preexisting_codes: [UNREADABLE_CODE],
      container_codes: [UNREADABLE_CODE],
      graph_codes: [],
      observation: {
        code: FUTURE_APPEND_UNSUPPORTED,
        reason: `these bytes could not be read for an append simulation: ${detail}`,
      },
      detail: { error: detail },
      appended_bytes: 0,
      evidence: 'static-prefilter',
    };
  }
  const before = diagnoseSessionBuffer(buffer, diagnoseOptions);
  const after = diagnoseSessionBuffer(appended, diagnoseOptions);
  const preexisting = [...before.codes];
  const appendCodes = after.codes.filter((code) => !preexisting.includes(code));
  const classified = classifyCodes(preexisting);
  const nextSeq = container.ok === true ? container.lastSeq + 1 : null;
  return {
    ok: after.ok === true,
    codes: after.codes,
    append_codes: appendCodes,
    preexisting_codes: preexisting,
    container_codes: classified.container_codes,
    graph_codes: classified.graph_codes,
    observation,
    detail: {
      ...(after.detail ?? {}),
      append_induced_codes: appendCodes,
      preexisting_codes: preexisting,
      header_frame_rows: container.headerFrameRows,
      header_frame_parsed_rows: container.headerFrameRowsParsed,
      container_legible: container.legible === true,
      last_seq: container.lastSeq,
      next_seq: nextSeq,
      torn_tail: container.torn === true,
    },
    appended_bytes: appended.length - buffer.length,
    evidence: 'static-prefilter',
  };
}
