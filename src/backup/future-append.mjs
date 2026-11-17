/**
 * Gate G3: backups store **original bytes**, and a restored log is validated by simulating the *next* append.
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
 */

import { compressFrame, decompressFrame, scanFrames } from '../fix/zstd.mjs';
import { diagnoseSessionBuffer } from '../util/session-validate.mjs';

/** The type/data of the one event the simulation appends. */
export const APPEND_EVENT = Object.freeze({ type: 'permission/preset', data: Object.freeze({ preset: 'workspace-write' }) });

/**
 * Count the rows (header + events) of a session log without parsing every JSON row.
 *
 * Used to compute the next dense seq for the appended event, and by the engine that already has the bytes; the
 * runtime path parses rows anyway and uses its artifact's count.
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
 * Append one legal event to a session log, in memory.
 *
 * @param {Buffer} buffer
 * @param {{nextSeq?: number}} [options] `nextSeq` defaults to the dense row count minus the header
 * @returns {Buffer} the original bytes followed by one compressed event frame
 */
export function appendLegalEvent(buffer, options = {}) {
  const nextSeq = options.nextSeq ?? Math.max(0, countLogRows(buffer).rows - 1);
  const event = { type: APPEND_EVENT.type, seq: nextSeq, time: Date.now(), data: APPEND_EVENT.data };
  return Buffer.concat([buffer, compressFrame(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'))]);
}

/**
 * Simulate the next append and validate the result with the static pre-filter.
 *
 * @param {Buffer} buffer
 * @returns {{ok: boolean, codes: string[], detail: object|null, appended_bytes: number}}
 */
export function futureAppendVerdict(buffer) {
  let appended;
  try {
    appended = appendLegalEvent(buffer);
  } catch (error) {
    return { ok: false, codes: ['BACKUP_SCAN_HEADER_UNREADABLE'], detail: { error: error instanceof Error ? error.message : String(error) }, appended_bytes: 0 };
  }
  const verdict = diagnoseSessionBuffer(appended);
  return {
    ok: verdict.ok === true,
    codes: verdict.codes,
    detail: verdict.detail ?? null,
    appended_bytes: appended.length - buffer.length,
  };
}
