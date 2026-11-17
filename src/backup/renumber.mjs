/**
 * Gate G4: the ONE legal way to delete or insert an event in a DSH v4 session log.
 *
 * ## Why a tool and not a text edit
 *
 * The 2026-11-17 recovery drill (`docs/RETRO-SESSION-RECOVERY-20261117.md`) names hand-editing as the trap: an
 * event removed from the JSON text leaves `seq` non-dense and leaves every `sourceEventSeqs` / `messageSeqs` /
 * `headerSeq` / `surfaceOp.{startSeq,endSeq}` reference pointing at the wrong event. The log then either fails to
 * open or opens with a history that is silently wrong. The drill's G4 says the only legal way to delete or insert
 * is a tool that does all of it in one pass.
 *
 * ## The pipeline (`renumberBuffer` -> `planRenumber` -> `applyRenumber`)
 *
 *   parse (frames -> rows; torn / non-v4 / non-dense / bad edits are refused)
 *   -> apply delete/insert to the event list
 *   -> renumber: `seq` becomes the dense index 0..N-1
 *   -> rewrite every `*Seq` / `*Seqs` integer reference old->new; a reference to a deleted seq is a hard refusal
 *   -> recompute `inheritedEventCount` from the last `session/end-seed` with `data.inherited === true`
 *   -> encode (header alone in frame 1, then one frame per event)
 *   -> plan validates the RESULT: static doctor (G1 pre-filter) + future-append simulation (G3) + installed
 *      Harness runtime verdict when available (G5; the gate)
 *   -> apply copies the original to `<file>.bak-<timestamp>`, writes atomically, then re-reads and verifies
 *
 * ## What it deliberately does not do
 *
 * It edits **history**. It is not part of backup/restore (restore publishes original bytes and never edits), and
 * it refuses a log it cannot prove dense before the edit -- an already-gapped log has ambiguous `deleteSeqs`
 * targets, and "fixing" it is what a restore is for. Every successful apply leaves a `.bak-<timestamp>` beside the
 * file; that copy is the way back.
 *
 * The static doctor (`src/util/session-validate.mjs`) is a pre-filter and is labelled as such. The evidence is the
 * installed Harness's own validator (`runtime-validate.mjs`); when none is installed the caller must opt in with
 * `allowStaticValidation` and every report says `runtime_verified: false`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { compressFrame, decompressFrame, scanFrames } from '../fix/zstd.mjs';
import { diagnoseSessionBuffer } from '../util/session-validate.mjs';
import { writeFileAtomic } from './atomic.mjs';
import { futureAppendVerdict } from './future-append.mjs';
import { sha256Hex } from './manifest.mjs';
import { validateCandidate } from './runtime-validate.mjs';

/** Named refusals. Greppable on purpose: a report cites a code, not a sentence. */
export const RENUMBER_CODES = Object.freeze({
  /** The file/edits/log cannot be interpreted as a v4 log plus an edit set. */
  INPUT_INVALID: 'RENUMBER_INPUT_INVALID',
  /** The container ends with a partial zstd frame (a crash during append). */
  TORN_INPUT: 'RENUMBER_TORN_INPUT',
  /** An edited event (or the log itself) references a seq that no longer exists. */
  DANGLING_REFERENCE: 'RENUMBER_DANGLING_REFERENCE',
  /** The static doctor (or the static future-append simulation) refused the result. */
  STATIC_REJECTED: 'RENUMBER_STATIC_REJECTED',
  /** The runtime verdict is required, but no installed Harness could be found. */
  RUNTIME_UNAVAILABLE: 'RENUMBER_RUNTIME_UNAVAILABLE',
  /** The installed Harness refused the renumbered log (or the log plus one legal append). */
  RUNTIME_REJECTED: 'RENUMBER_RUNTIME_REJECTED',
  /** The file changed between plan and apply. */
  TARGET_CHANGED: 'RENUMBER_TARGET_CHANGED',
  /** Copying the original, or writing the result, failed. */
  WRITE_FAILED: 'RENUMBER_WRITE_FAILED',
  /** The bytes read back after the write do not match the plan, or no longer pass the doctor. */
  VERIFY_FAILED: 'RENUMBER_VERIFY_FAILED',
});

/**
 * Keys whose numeric values are event seq references.
 *
 * The suffix rule is the doctor's (`src/util/session-validate.mjs`) said once more here rather than imported:
 * it is the same question ("does this number address a seq?") and the same regex, so a new `*Seq` field is
 * covered without a second list. `seq` itself does not match (case-sensitive), which is what keeps the
 * renumbering from rewriting the new seq values it just assigned.
 */
const SEQ_REF_KEY = /(?:Seq|Seqs)$/;

/** How many dangling references a refusal quotes before truncating. */
const MAX_DANGLING_DETAILS = 5;

/** An empty result object on the failure path: the shape callers branch on, never `undefined`. */
function coreFailure(code, detail, context = {}) {
  return {
    ok: false,
    buffer: null,
    changed: false,
    mapping: {},
    rewritten_references: context.rewritten_references ?? 0,
    inherited_event_count: context.inherited_event_count ?? 0,
    events_before: context.events_before ?? 0,
    events_after: context.events_after ?? 0,
    session_id: context.session_id ?? null,
    codes: [code],
    detail,
  };
}

/**
 * Decode a v4 log into its header and event rows, refusing anything this tool must not guess about.
 *
 * @param {Buffer} buffer
 * @returns {{ok: true, header: object, events: object[]} | {ok: false, code: string, detail: object}}
 */
function parseLog(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return { ok: false, code: RENUMBER_CODES.INPUT_INVALID, detail: { message: 'the log must be a Buffer' } };
  }
  if (buffer.length === 0) {
    return { ok: false, code: RENUMBER_CODES.INPUT_INVALID, detail: { message: 'the log is empty' } };
  }
  let scanned;
  try {
    scanned = scanFrames(buffer);
  } catch (error) {
    return {
      ok: false,
      code: RENUMBER_CODES.INPUT_INVALID,
      detail: { message: `the zstd container is unreadable: ${error instanceof Error ? error.message : String(error)}` },
    };
  }
  if (scanned.tornStart !== undefined) {
    return {
      ok: false,
      code: RENUMBER_CODES.TORN_INPUT,
      detail: { message: `the log ends with a partial zstd frame at byte ${scanned.tornStart}; a torn log is not renumbered`, torn_start: scanned.tornStart },
    };
  }
  if (scanned.frames.length === 0) {
    return { ok: false, code: RENUMBER_CODES.INPUT_INVALID, detail: { message: 'the log contains no complete zstd frame' } };
  }

  const rows = [];
  for (const [frameIndex, frame] of scanned.frames.entries()) {
    let text;
    try {
      text = decompressFrame(buffer.subarray(frame.start, frame.end));
    } catch (error) {
      return {
        ok: false,
        code: RENUMBER_CODES.INPUT_INVALID,
        detail: { frame: frameIndex, message: `frame ${frameIndex} could not be decompressed: ${error instanceof Error ? error.message : String(error)}` },
      };
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        return {
          ok: false,
          code: RENUMBER_CODES.INPUT_INVALID,
          detail: { frame: frameIndex, message: `frame ${frameIndex} contains a line that is not JSON` },
        };
      }
    }
  }
  if (rows.length === 0) {
    return { ok: false, code: RENUMBER_CODES.INPUT_INVALID, detail: { message: 'the log decoded to no rows' } };
  }
  const [header, ...events] = rows;
  if (header === null || typeof header !== 'object' || Array.isArray(header) || header.type !== 'session') {
    return { ok: false, code: RENUMBER_CODES.INPUT_INVALID, detail: { message: 'the first row is not a session header' } };
  }
  if (header.version !== 4) {
    return {
      ok: false,
      code: RENUMBER_CODES.INPUT_INVALID,
      detail: { message: `only v4 session logs are renumbered, and this header announces version ${JSON.stringify(header.version)}`, version: header.version ?? null },
    };
  }
  for (const [index, event] of events.entries()) {
    if (event === null || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string' || event.type === '') {
      return { ok: false, code: RENUMBER_CODES.INPUT_INVALID, detail: { message: `row ${index + 1} is not an event object with a type`, index: index + 1 } };
    }
    if (event.seq !== index) {
      return {
        ok: false,
        code: RENUMBER_CODES.INPUT_INVALID,
        detail: {
          index,
          seq: event.seq ?? null,
          message: `event ${index} carries seq ${JSON.stringify(event.seq ?? null)}; edits are addressed by dense zero-based seq, so a log that is already gapped must be restored instead of renumbered`,
        },
      };
    }
  }
  return { ok: true, header, events };
}

/**
 * Normalise and range-check one edit set.
 *
 * @param {{deleteSeqs?: number[], insert?: Array<{atSeq: number, event: object}>}} edits
 * @param {number} eventCount
 * @returns {{ok: true, deleteSeqs: number[], insert: Array<{atSeq: number, event: object}>} | {ok: false, code: string, detail: object}}
 */
function normalizeEdits(edits, eventCount) {
  const source = edits !== null && typeof edits === 'object' ? edits : {};
  const rawDeletes = source.deleteSeqs ?? [];
  if (!Array.isArray(rawDeletes)) {
    return { ok: false, code: RENUMBER_CODES.INPUT_INVALID, detail: { field: 'deleteSeqs', message: 'deleteSeqs must be an array of seq numbers' } };
  }
  const deleteSeqs = [];
  for (const raw of rawDeletes) {
    if (!Number.isInteger(raw) || raw < 0 || raw >= eventCount) {
      return {
        ok: false,
        code: RENUMBER_CODES.INPUT_INVALID,
        detail: { field: 'deleteSeqs', value: raw ?? null, message: `deleteSeqs entry ${JSON.stringify(raw ?? null)} is not a seq in 0..${Math.max(0, eventCount - 1)}` },
      };
    }
    if (!deleteSeqs.includes(raw)) deleteSeqs.push(raw);
  }

  const rawInsert = source.insert ?? [];
  if (!Array.isArray(rawInsert)) {
    return { ok: false, code: RENUMBER_CODES.INPUT_INVALID, detail: { field: 'insert', message: 'insert must be an array of {atSeq, event}' } };
  }
  const insert = [];
  for (const [index, row] of rawInsert.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, code: RENUMBER_CODES.INPUT_INVALID, detail: { field: 'insert', index, message: `insert[${index}] must be an object with atSeq and event` } };
    }
    if (!Number.isInteger(row.atSeq) || row.atSeq < 0 || row.atSeq > eventCount) {
      return {
        ok: false,
        code: RENUMBER_CODES.INPUT_INVALID,
        detail: { field: 'insert', index, at_seq: row.atSeq ?? null, message: `insert[${index}].atSeq ${JSON.stringify(row.atSeq ?? null)} is not a position in 0..${eventCount}` },
      };
    }
    let event;
    try {
      // A JSON round-trip is exactly the bytes the encoder will write, and it keeps the caller's object untouched.
      event = JSON.parse(JSON.stringify(row.event));
    } catch {
      return { ok: false, code: RENUMBER_CODES.INPUT_INVALID, detail: { field: 'insert', index, message: `insert[${index}].event is not JSON-serializable` } };
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string' || event.type === '') {
      return { ok: false, code: RENUMBER_CODES.INPUT_INVALID, detail: { field: 'insert', index, message: `insert[${index}].event is not an event object with a type` } };
    }
    if (event.type === 'session') {
      return { ok: false, code: RENUMBER_CODES.INPUT_INVALID, detail: { field: 'insert', index, message: `insert[${index}].event is a session header, not an event` } };
    }
    insert.push({ atSeq: row.atSeq, event });
  }
  return { ok: true, deleteSeqs, insert };
}

/**
 * Rewrite every integer value under a `*Seq` / `*Seqs` key in one event, in place.
 *
 * The walk is recursive because the recorded references are nested (`data.sourceEventSeqs`,
 * `data.messageSeqs`, `surfaceOp.startSeq`/`endSeq`, and deeper fields the client may add). An unmappable value
 * is recorded and left alone: guessing a replacement is exactly the failure class this gate exists to prevent.
 *
 * @param {object} event
 * @param {{alias: Map<number, number>, deleted: Set<number>, rewritten: number, dangling: object[]}} context
 */
function rewriteEventReferences(event, context) {
  const walk = (node, keyPath) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const [index, entry] of node.entries()) walk(entry, `${keyPath}[${index}]`);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const here = keyPath === '' ? key : `${keyPath}.${key}`;
      if (SEQ_REF_KEY.test(key)) {
        if (Number.isInteger(value)) {
          node[key] = mapReference(value, { at: here, key, eventType: event.type }, context);
        } else if (Array.isArray(value)) {
          node[key] = value.map((item, index) =>
            Number.isInteger(item) ? mapReference(item, { at: `${here}[${index}]`, key, eventType: event.type }, context) : item,
          );
        }
      }
      walk(node[key], here);
    }
  };
  walk(event, '');
}

/**
 * Map one old seq to its new position, or record a dangling reference.
 *
 * @param {number} oldSeq
 * @param {{at: string, key: string, eventType: string}} where
 * @param {{alias: Map<number, number>, deleted: Set<number>, rewritten: number, dangling: object[]}} context
 * @returns {number}
 */
function mapReference(oldSeq, where, context) {
  const mapped = context.alias.get(oldSeq);
  if (mapped === undefined) {
    context.dangling.push({
      event_type: where.eventType,
      key: where.key,
      at: where.at,
      seq: oldSeq,
      deleted: context.deleted.has(oldSeq),
      reason: context.deleted.has(oldSeq) ? 'this edit deletes the event this reference names' : 'no event in the log carries this seq',
    });
    return oldSeq;
  }
  if (mapped !== oldSeq) context.rewritten += 1;
  return mapped;
}

/** Compact timestamp for the sibling backup: `20261117T152201Z`. */
function compactStamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** The sibling copy a successful apply writes before touching the file. */
function backupPathFor(file, now) {
  return `${file}.bak-${compactStamp(now)}`;
}

/**
 * Encode a log the way this package writes one: the header alone in frame 1, then one independent frame per event.
 *
 * @param {object} header
 * @param {object[]} events
 * @returns {Buffer}
 */
function encodeLog(header, events) {
  const frames = [compressFrame(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))];
  for (const event of events) frames.push(compressFrame(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')));
  return Buffer.concat(frames);
}

/**
 * Deletes/inserts events in a session log **in memory** and returns the renumbered bytes.
 *
 * `deleteSeqs` removes those dense zero-based seqs. `insert` places an event *before* the event currently at
 * `atSeq`; `atSeq === events.length` appends. The inserted event's `seq` (if any) is overwritten with its new
 * dense position, and any `*Seq`/`*Seqs` references it carries are interpreted against the **pre-edit** seqs of
 * the events that already existed -- there is no way to address another inserted event by its new seq.
 *
 * @param {Buffer} buffer
 * @param {{deleteSeqs?: number[], insert?: Array<{atSeq: number, event: object}>}} [edits]
 * @returns {{
 *   ok: boolean, buffer: Buffer|null, changed: boolean, mapping: Record<number, number>,
 *   rewritten_references: number, inherited_event_count: number, events_before: number, events_after: number,
 *   session_id: string|null, codes: string[], detail: object,
 * }}
 */
export function renumberBuffer(buffer, edits = {}) {
  const parsed = parseLog(buffer);
  if (parsed.ok !== true) return coreFailure(parsed.code, parsed.detail);

  const eventsBefore = parsed.events.length;
  const sessionId = typeof parsed.header.id === 'string' ? parsed.header.id : null;
  const context = { events_before: eventsBefore, session_id: sessionId };

  const normalized = normalizeEdits(edits, eventsBefore);
  if (normalized.ok !== true) return coreFailure(normalized.code, normalized.detail, context);

  const deleted = new Set(normalized.deleteSeqs);
  const insertsByAtSeq = new Map();
  for (const row of normalized.insert) {
    const list = insertsByAtSeq.get(row.atSeq) ?? [];
    list.push(row.event);
    insertsByAtSeq.set(row.atSeq, list);
  }

  // The post-edit list, remembering which rows came from the original log (their old seq is the alias key).
  const rows = [];
  for (let atSeq = 0; atSeq <= eventsBefore; atSeq += 1) {
    for (const event of insertsByAtSeq.get(atSeq) ?? []) rows.push({ event, oldSeq: null });
    if (atSeq < eventsBefore && !deleted.has(atSeq)) rows.push({ event: parsed.events[atSeq], oldSeq: atSeq });
  }

  const alias = new Map();
  for (const [index, row] of rows.entries()) if (row.oldSeq !== null) alias.set(row.oldSeq, index);
  const mapping = {};
  for (const [oldSeq, newSeq] of alias) if (oldSeq !== newSeq) mapping[oldSeq] = newSeq;

  const rewrite = { alias, deleted, rewritten: 0, dangling: [] };
  for (const row of rows) rewriteEventReferences(row.event, rewrite);
  if (rewrite.dangling.length > 0) {
    const first = rewrite.dangling[0];
    return coreFailure(
      RENUMBER_CODES.DANGLING_REFERENCE,
      {
        message:
          `an event ${first.event_type} ${first.key} at ${first.at} references seq ${first.seq}, which ` +
          `${first.deleted ? 'this edit deletes' : 'does not exist'}; refusing rather than guessing a replacement`,
        references: rewrite.dangling.slice(0, MAX_DANGLING_DETAILS),
        dangling_references: rewrite.dangling.length,
      },
      { ...context, rewritten_references: rewrite.rewritten, events_after: rows.length },
    );
  }

  // Dense renumbering: the array position IS the seq, and every event carries exactly one.
  for (const [index, row] of rows.entries()) row.event.seq = index;

  // The runtime derives inheritedEventCount from "events up to and including the last inherited seed end"; the
  // position moves when events before it are deleted or inserted, so it is recomputed from the post-edit list.
  let inheritedEventCount = 0;
  for (const [index, row] of rows.entries()) {
    if (row.event.type === 'session/end-seed' && row.event.data?.inherited === true) inheritedEventCount = index + 1;
  }
  if (parsed.header.isSeeded !== true && inheritedEventCount > 0) {
    return coreFailure(
      RENUMBER_CODES.INPUT_INVALID,
      {
        message:
          `the header says isSeeded:false but the post-edit log has ${inheritedEventCount} inherited event(s) ` +
          'up to a session/end-seed with data.inherited=true',
        inherited_event_count: inheritedEventCount,
      },
      { ...context, rewritten_references: rewrite.rewritten, events_after: rows.length, inherited_event_count: inheritedEventCount },
    );
  }

  let encoded;
  try {
    encoded = encodeLog(parsed.header, rows.map((row) => row.event));
  } catch (error) {
    return coreFailure(
      RENUMBER_CODES.INPUT_INVALID,
      { message: `the renumbered log could not be encoded: ${error instanceof Error ? error.message : String(error)}` },
      { ...context, rewritten_references: rewrite.rewritten, events_after: rows.length },
    );
  }

  const changed = !encoded.equals(buffer);
  return {
    ok: true,
    // An unchanged log is handed back as the caller's own bytes: re-encoding may otherwise look like a change
    // (a differently framed but equivalent input) that no caller asked for.
    buffer: changed ? encoded : buffer,
    changed,
    mapping,
    rewritten_references: rewrite.rewritten,
    inherited_event_count: inheritedEventCount,
    events_before: eventsBefore,
    events_after: rows.length,
    session_id: sessionId,
    codes: [],
    detail: { frames: rows.length + 1, header_is_seeded: parsed.header.isSeeded === true },
  };
}

/** The human sentence for a core refusal. */
function describeCoreRefusal(core) {
  if (typeof core.detail?.message === 'string') return core.detail.message;
  return core.codes[0] ?? RENUMBER_CODES.INPUT_INVALID;
}

/**
 * Plan one renumber: read the file, apply the edit set, then validate the RESULT before any write.
 *
 * Refuses with no write on a static doctor failure, a static future-append failure, a runtime rejection, or a
 * required-but-unavailable runtime. `allowStaticValidation: true` accepts static-only evidence when no Harness can
 * be found and reports `runtime_verified: false` (this is the same downgrade restore uses).
 *
 * @param {{
 *   file: string, deleteSeqs?: number[], insert?: Array<{atSeq: number, event: object}>,
 *   allowStaticValidation?: boolean, harness?: object|null, env?: Record<string, string|undefined>,
 *   now?: Date,
 * }} input
 * @returns {object} a plan -- `ok:false` carries `reason_code`/`detail` and no bytes to write
 */
export function planRenumber(input = {}) {
  const started = Date.now();
  const now = input.now instanceof Date ? input.now : new Date();
  const file = input.file === undefined || input.file === null ? null : path.resolve(String(input.file));
  const plan = {
    ok: false,
    file,
    session_id: null,
    original_bytes: null,
    new_bytes: null,
    original_size: 0,
    new_size: 0,
    original_sha256: null,
    new_sha256: null,
    changed: false,
    events_before: 0,
    events_after: 0,
    mapping: {},
    rewritten_references: 0,
    inherited_event_count: 0,
    validation: {
      static: { ok: false, codes: [] },
      runtime_verified: false,
      runtime: null,
      future_append: null,
      future_append_evidence: 'static-prefilter',
      static_future_append: { ok: false, codes: [], evidence: 'static-prefilter' },
    },
    backup_file: null,
    reason_code: null,
    detail: '',
    reason_detail: null,
    codes: [],
    duration_ms: 0,
  };
  if (file === null) {
    return { ...plan, reason_code: RENUMBER_CODES.INPUT_INVALID, detail: 'planRenumber needs a file path', codes: [RENUMBER_CODES.INPUT_INVALID] };
  }

  let original;
  try {
    original = fs.readFileSync(file);
  } catch (error) {
    return {
      ...plan,
      reason_code: RENUMBER_CODES.INPUT_INVALID,
      detail: `${file}: the log could not be read (${error?.code ?? (error instanceof Error ? error.message : String(error))})`,
      codes: [RENUMBER_CODES.INPUT_INVALID],
    };
  }
  plan.original_bytes = original;
  plan.original_size = original.length;
  plan.original_sha256 = sha256Hex(original);

  const core = renumberBuffer(original, { deleteSeqs: input.deleteSeqs, insert: input.insert });
  plan.events_before = core.events_before;
  plan.session_id = core.session_id;
  if (core.ok !== true) {
    return {
      ...plan,
      reason_code: core.codes[0] ?? RENUMBER_CODES.INPUT_INVALID,
      detail: describeCoreRefusal(core),
      reason_detail: core.detail,
      codes: core.codes,
      duration_ms: Date.now() - started,
    };
  }

  plan.new_bytes = core.buffer;
  plan.new_size = core.buffer.length;
  plan.new_sha256 = sha256Hex(core.buffer);
  plan.changed = core.changed === true;
  plan.mapping = core.mapping;
  plan.rewritten_references = core.rewritten_references;
  plan.inherited_event_count = core.inherited_event_count;
  plan.events_after = core.events_after;

  // Validation of the RESULT, never of the input: the edit can break a surface/seq rule even when the source was
  // healthy, and an unchanged result still has to be legal before the tool says "nothing to do".
  const requireRuntime = input.allowStaticValidation !== true;
  const staticFuture = futureAppendVerdict(core.buffer);
  const gate = validateCandidate({
    buffer: core.buffer,
    expectedSessionId: core.session_id ?? null,
    appendCheck: true,
    harness: input.harness,
    requireRuntime,
    env: input.env,
  });
  const runtimeAvailable = gate.runtime !== null && gate.runtime !== undefined;
  plan.validation = {
    static: { ok: gate.static?.ok === true, codes: gate.static?.codes ?? [] },
    runtime_verified: gate.runtime_verified === true,
    runtime: gate.runtime ?? null,
    // When the runtime ran, its appended-artifact verdict is the evidence. Otherwise the static simulation is
    // quoted and labelled, exactly as the backup path does (G3/G5).
    future_append: runtimeAvailable ? gate.future_append === true : staticFuture.ok === true,
    future_append_evidence: runtimeAvailable ? 'installed-harness' : 'static-prefilter',
    static_future_append: { ok: staticFuture.ok === true, codes: staticFuture.codes, evidence: 'static-prefilter' },
  };

  if (plan.validation.static.ok !== true || staticFuture.ok !== true) {
    const parts = [];
    if (plan.validation.static.ok !== true) parts.push(`the doctor refused the renumbered log: ${plan.validation.static.codes.join(', ') || 'no code'}`);
    if (staticFuture.ok !== true) parts.push(`the future-append simulation refused the renumbered log: ${staticFuture.codes.join(', ') || 'no code'}`);
    return {
      ...plan,
      new_bytes: null,
      reason_code: RENUMBER_CODES.STATIC_REJECTED,
      detail: parts.join('; '),
      reason_detail: { static: plan.validation.static, future_append: staticFuture },
      codes: [RENUMBER_CODES.STATIC_REJECTED],
      duration_ms: Date.now() - started,
    };
  }
  if (gate.reason_code === 'BACKUP_RUNTIME_UNAVAILABLE') {
    return {
      ...plan,
      new_bytes: null,
      reason_code: RENUMBER_CODES.RUNTIME_UNAVAILABLE,
      detail: `${gate.detail}; pass --allow-static-validation to accept static-only evidence`,
      reason_detail: { runtime: gate.runtime, future_append: staticFuture },
      codes: [RENUMBER_CODES.RUNTIME_UNAVAILABLE],
      duration_ms: Date.now() - started,
    };
  }
  if (gate.ok !== true) {
    return {
      ...plan,
      new_bytes: null,
      reason_code: RENUMBER_CODES.RUNTIME_REJECTED,
      detail: gate.detail,
      reason_detail: { runtime: gate.runtime, future_append: gate.future_append },
      codes: [RENUMBER_CODES.RUNTIME_REJECTED],
      duration_ms: Date.now() - started,
    };
  }

  return {
    ...plan,
    ok: true,
    backup_file: core.changed ? backupPathFor(file, now) : null,
    detail: runtimeAvailable
      ? `static and runtime validation both passed; ${plan.changed ? `${plan.events_before} -> ${plan.events_after} event(s), ${plan.rewritten_references} reference(s) rewritten` : 'the log is already dense, nothing to do'}`
      : `static validation passed (runtime_verified:false; static-only evidence accepted because no runtime verdict was required or available); ${plan.changed ? `${plan.events_before} -> ${plan.events_after} event(s)` : 'the log is already dense, nothing to do'}`,
    duration_ms: Date.now() - started,
  };
}

/** Pick a sibling backup path that does not overwrite an earlier run's copy. */
function reserveBackupPath(planned) {
  if (!fs.existsSync(planned)) return planned;
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = `${planned}-${suffix}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`could not find a free backup name next to ${planned}`);
}

/**
 * Apply a planned renumber: copy the original to `<file>.bak-<timestamp>`, write the new bytes atomically, then
 * read the file back and verify both its digest and the doctor.
 *
 * @param {{plan: object, dryRun?: boolean}} input
 * @returns {{
 *   ok: boolean, dry_run: boolean, changed: boolean, file: string|null, backup_file: string|null,
 *   bytes: number, mapping_changes: number, rewritten_references: number, sha256: string|null,
 *   reason_code: string|null, detail: string, duration_ms: number,
 * }}
 */
export function applyRenumber(input = {}) {
  const started = Date.now();
  const plan = input.plan;
  const dryRun = input.dryRun === true;
  const mappingChanges = plan?.mapping !== null && typeof plan?.mapping === 'object' ? Object.keys(plan.mapping).length : 0;
  const base = {
    ok: false,
    dry_run: dryRun,
    changed: false,
    file: plan?.file ?? null,
    backup_file: null,
    bytes: 0,
    mapping_changes: mappingChanges,
    rewritten_references: Number.isSafeInteger(plan?.rewritten_references) ? plan.rewritten_references : 0,
    sha256: null,
    reason_code: null,
    detail: '',
    duration_ms: 0,
  };
  if (plan === null || typeof plan !== 'object' || plan.ok !== true) {
    return {
      ...base,
      reason_code: plan?.reason_code ?? RENUMBER_CODES.INPUT_INVALID,
      detail: plan?.detail ?? 'there is no successful plan to apply',
      duration_ms: Date.now() - started,
    };
  }
  if (plan.changed !== true) {
    return {
      ...base,
      ok: true,
      detail: 'the log is already dense; nothing was written',
      sha256: plan.original_sha256 ?? null,
      duration_ms: Date.now() - started,
    };
  }
  if (!Buffer.isBuffer(plan.new_bytes) || !Buffer.isBuffer(plan.original_bytes)) {
    return { ...base, reason_code: RENUMBER_CODES.WRITE_FAILED, detail: 'the plan does not carry the bytes to write', duration_ms: Date.now() - started };
  }
  if (dryRun) {
    return {
      ...base,
      ok: true,
      dry_run: true,
      changed: true,
      backup_file: plan.backup_file ?? null,
      sha256: plan.new_sha256 ?? sha256Hex(plan.new_bytes),
      detail: 'dry run: nothing was written',
      duration_ms: Date.now() - started,
    };
  }

  // The plan was made from the bytes on disk; a file that moved under us (the live client appends) must not be
  // overwritten with a renumbered version of a different log.
  let current;
  try {
    current = fs.readFileSync(plan.file);
  } catch (error) {
    return {
      ...base,
      reason_code: RENUMBER_CODES.INPUT_INVALID,
      detail: `${plan.file}: the log could not be re-read before writing (${error?.code ?? (error instanceof Error ? error.message : String(error))})`,
      duration_ms: Date.now() - started,
    };
  }
  if (sha256Hex(current) !== sha256Hex(plan.original_bytes)) {
    return {
      ...base,
      reason_code: RENUMBER_CODES.TARGET_CHANGED,
      detail: `${plan.file} changed after the plan was made (the DSH client may be appending); nothing was written. Quit the client and plan again.`,
      duration_ms: Date.now() - started,
    };
  }

  let backupFile;
  try {
    backupFile = reserveBackupPath(plan.backup_file);
    fs.copyFileSync(plan.file, backupFile);
  } catch (error) {
    return {
      ...base,
      reason_code: RENUMBER_CODES.WRITE_FAILED,
      detail: `could not write the sibling backup next to ${plan.file}: ${error instanceof Error ? error.message : String(error)}`,
      duration_ms: Date.now() - started,
    };
  }
  // Read the copy back before touching the original: a failed copy with the original still intact is a refusal;
  // a failed copy followed by a write is a lost log.
  let backupBytes;
  try {
    backupBytes = fs.readFileSync(backupFile);
  } catch (error) {
    return {
      ...base,
      backup_file: backupFile,
      reason_code: RENUMBER_CODES.WRITE_FAILED,
      detail: `the sibling backup ${backupFile} could not be read back (${error?.code ?? (error instanceof Error ? error.message : String(error))}); nothing was written`,
      duration_ms: Date.now() - started,
    };
  }
  if (!backupBytes.equals(plan.original_bytes)) {
    try {
      fs.rmSync(backupFile, { force: true });
    } catch {
      /* best effort: the original is untouched and remains the source of truth */
    }
    return {
      ...base,
      reason_code: RENUMBER_CODES.WRITE_FAILED,
      detail: `the sibling backup ${backupFile} does not match the original bytes; nothing was written`,
      duration_ms: Date.now() - started,
    };
  }

  try {
    writeFileAtomic(plan.file, plan.new_bytes);
  } catch (error) {
    return {
      ...base,
      backup_file: backupFile,
      reason_code: RENUMBER_CODES.WRITE_FAILED,
      detail: `${error?.detail ?? (error instanceof Error ? error.message : String(error))}. The original is preserved at ${backupFile}`,
      duration_ms: Date.now() - started,
    };
  }

  let written;
  try {
    written = fs.readFileSync(plan.file);
  } catch (error) {
    return {
      ...base,
      backup_file: backupFile,
      reason_code: RENUMBER_CODES.VERIFY_FAILED,
      detail: `the written log could not be read back (${error?.code ?? (error instanceof Error ? error.message : String(error))}); the original is preserved at ${backupFile}`,
      duration_ms: Date.now() - started,
    };
  }
  const writtenSha = sha256Hex(written);
  if (writtenSha !== plan.new_sha256) {
    return {
      ...base,
      backup_file: backupFile,
      reason_code: RENUMBER_CODES.VERIFY_FAILED,
      detail: `the written log hashes to ${writtenSha}, not to the planned ${plan.new_sha256}; the original is preserved at ${backupFile}`,
      duration_ms: Date.now() - started,
    };
  }
  const verdict = diagnoseSessionBuffer(written, { expectedSessionId: plan.session_id ?? null });
  if (verdict.ok !== true) {
    return {
      ...base,
      backup_file: backupFile,
      reason_code: RENUMBER_CODES.VERIFY_FAILED,
      detail: `the written log no longer passes the doctor (${verdict.codes.join(', ')}); the original is preserved at ${backupFile}`,
      duration_ms: Date.now() - started,
    };
  }

  return {
    ...base,
    ok: true,
    changed: true,
    backup_file: backupFile,
    bytes: written.length,
    sha256: writtenSha,
    detail: `wrote ${written.length} byte(s); the original is preserved at ${backupFile}`,
    duration_ms: Date.now() - started,
  };
}
