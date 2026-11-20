/**
 * Full verification: does every block the repository claims still decrypt to the bytes the snapshot recorded?
 *
 * ## Why this is not "re-run the backup"
 *
 * A backup can look complete (files present, index appended) and still be useless: one flipped byte in an object,
 * a missing block, a manifest whose counts disagree with its own files. `verify` walks the *claims* -- manifest →
 * block list → object bytes → plaintext hash -- and reports every divergence with a code. It is also the only place
 * that exercises the write path's counterpart for every snapshot, not just the newest.
 *
 * ## The future-append simulation (gate G3)
 *
 * The 2026-11-17 drill taught that "opens today" is not "keeps opening": a log whose protected head or surface
 * ops are wrong fails on the *next* append by the client. So verify optionally appends one legal event to the
 * reassembled bytes **in memory** and runs the validator on the result. A log that passes today and fails after
 * one append is reported as `FUTURE_APPEND_FAILED` before it is ever published.
 *
 * ## Old full copies are decrypted too (v3.5.0 additive)
 *
 * A version record is verified through its blocks (§24), but a record that also carries `full_copy` makes a second
 * promise: those bytes are recoverable even if `objects/` is not. Verify now keeps that promise honest by opening
 * the `.enc` with the repository DEK and the `old` identity (`{sha256, length: size, kind: 'old'}`), checking the
 * plaintext digest and length, and reporting `BACKUP_VERIFY_OLD_COPY_MISSING`/`BACKUP_VERIFY_OLD_COPY_FAILED` with
 * the offending record. The counters live in `old_copies: {checked, ok, failed, missing}`; a record without a copy
 * is not counted, because there is nothing extra to verify. This works for an unencrypted repository too: the
 * `open` envelope supplies the DEK without any credential.
 *
 * ## Two copy formats, decided by the file's own magic (v3.5.x, P2/O2)
 *
 * A copy written before the chunked format is ONE sealed object (`W2MBLOB1`), and it keeps exactly the path it had:
 * the `oldCopyMaxBytes` bound, the heap guard, one whole-file read, `openObject` with the `old` identity. A copy
 * written in the chunked v2 format (`W2MOLD2`, `chunked.mjs`) is read record by record instead, so its peak memory
 * is one chunk (at most 16 MiB) rather than its size, and the whole-file bound does not apply to it -- that bound
 * exists because a v1 copy cannot be read any other way. **The counters and the problem codes do not change**: a v2
 * copy that fails is still `BACKUP_VERIFY_OLD_COPY_FAILED`, with the chunked code (`BACKUP_CHUNKED_*`) named in the
 * detail, so a report reader sees one shape and one place to look. The sniff is the file's first eight bytes, never
 * the record's `full_copy.format`: a record field is a claim, and this is the one check whose job is to test claims.
 */

import fs from 'node:fs';
import path from 'node:path';

import { repoPaths } from './layout.mjs';
import { openRepo, readIndex, readSnapshot, listSnapshots } from './repo.mjs';
import { openRepoKey } from './keystore.mjs';
import { sha256Hex } from './manifest.mjs';
import { DEFAULT_OLD_COPY_MAX_BYTES, DEFAULT_STREAM_THRESHOLD_BYTES, rebuildFile, digestEntryStreaming, objectFile } from './materialize.mjs';
import { BACKUP_MEMORY_GUARD, createMemoryGuardReport, memoryGuard, resolveMaxHeapBytes } from './memory-guard.mjs';
import { OLD_COPY_KIND, openObject } from './crypto.mjs';
import { CHUNKED_FORMAT, isChunkedV2, openChunkedStream } from './chunked.mjs';
import { fullCopyPathFor, listOldVersions } from './rotation.mjs';
import { readCurrentPointers } from './gc.mjs';
import { buildArtifactFromBuffer, runtimeValidateBatch } from './runtime-validate.mjs';
import { appendLegalEvent, futureAppendVerdict } from './future-append.mjs';
import { readJsonSafe } from './atomic.mjs';
import { DEFAULT_BACKUP_SCOPES, RESTORE_COPY_ROOT, classReason, classifyHomePath, collectScopeFiles, displayRel, homeInventory } from './scopes.mjs';

/** Codes `verifyRepo` can report. */
export const VERIFY_CODES = Object.freeze({
  NOT_INITIALIZED: 'BACKUP_REPO_NOT_INITIALIZED',
  NO_PERMISSION: 'BACKUP_NO_PERMISSION',
  OBJECT_MISSING: 'BACKUP_OBJECT_MISSING',
  BLOCK_AUTH_FAILED: 'BACKUP_DECRYPT_AUTH_FAILED',
  SIZE_MISMATCH: 'BACKUP_SIZE_MISMATCH',
  DIGEST_MISMATCH: 'BACKUP_MANIFEST_DIGEST_MISMATCH',
  SNAPSHOT_INVALID: 'BACKUP_REPO_SNAPSHOT_INVALID',
  INDEX_MISMATCH: 'BACKUP_INDEX_MISMATCH',
  OLD_RECORD_BLOCK_MISSING: 'BACKUP_OLD_RECORD_BLOCK_MISSING',
  OLD_COPY_MISSING: 'BACKUP_VERIFY_OLD_COPY_MISSING',
  OLD_COPY_FAILED: 'BACKUP_VERIFY_OLD_COPY_FAILED',
  FUTURE_APPEND_FAILED: 'BACKUP_FUTURE_APPEND_FAILED',
  RUNTIME_APPEND_FAILED: 'BACKUP_RUNTIME_APPEND_FAILED',
  COVERAGE_GAP: 'BACKUP_VERIFY_COVERAGE_GAP',
  OLD_COPY_TOO_LARGE: 'BACKUP_VERIFY_OLD_COPY_TOO_LARGE',
});

/** The zeroed `old_copies` counter block (also the shape every early return reports). */
function emptyOldCopies() {
  return { checked: 0, ok: 0, failed: 0, missing: 0 };
}

/** The zeroed `future_append` block (also the shape every early return reports). */
function emptyFutureAppend() {
  return {
    checked: 0,
    failed: 0,
    failed_sessions: [],
    observations: [],
    unsupported: 0,
    skipped: 0,
    skipped_sessions: [],
    evidence: 'static-prefilter',
  };
}

/**
 * The one-line detail of a failed future-append verdict, split by what the append did.
 *
 * A reader must be able to tell "the append broke this log" (`append_codes`) from "this log was already broken, the
 * append did not change that" (`preexisting_codes`), and -- when the container itself is unreadable -- from the
 * appended event's own verdict, which is not evidence in that case (`src/backup/future-append.mjs`).
 *
 * @param {ReturnType<typeof simulateFutureAppend>} simulation
 * @returns {string}
 */
function futureAppendFailureDetail(simulation) {
  const append = simulation.append_codes ?? [];
  const container = simulation.container_codes ?? [];
  const graph = simulation.graph_codes ?? [];
  const already = [...container, ...graph];
  if (append.length > 0) {
    return `appending one legal event introduces: ${append.join(', ')}${already.length === 0 ? '' : ` (already present: ${already.join(', ')})`}`;
  }
  const parts = [];
  if (container.length > 0) parts.push(`the log is not a readable v4 container before any append: ${container.join(', ')}`);
  if (container.includes('ZSTD_HEADER_FRAME_INVALID') && Number.isSafeInteger(simulation.detail?.header_frame_rows)) {
    parts.push(`the first frame carries ${simulation.detail.header_frame_rows} row(s); the installed Harness requires exactly one header line`);
  }
  if (graph.length > 0) parts.push(`the event graph is already invalid before the append: ${graph.join(', ')}`);
  return `${parts.join('; ')} (the appended event itself adds nothing)`;
}

/** The session id a manifest `rel` belongs to (`sessions/<workspace>/<session>/session.v4.jsonl.zstd`). */
function sessionOfRel(rel) {
  const parts = String(rel ?? '').split('/');
  return parts.length >= 2 ? parts.at(-2) : null;
}

/** Union `source` into `target`, preserving first-seen order and never repeating a code. */
function mergeCodes(target, source) {
  for (const code of source ?? []) if (!target.includes(code)) target.push(code);
}

/**
 * Record that one `(sha256, snapshot)` pair is evidence for a per-session record (`observation` or `failure`).
 *
 * A session can appear in many snapshots and, if it was active, with different bytes in each. The record is keyed by
 * the session, so the versions are what keeps the evidence complete: `versions[]` names every distinct content once,
 * with the snapshots that hold it, while `snapshot_ids` keeps the flat list for a report.
 *
 * @param {{versions: object[], snapshot_ids: string[]}} record
 * @param {{sha256: string, snapshot_id: string, reason?: string|null}} version
 * @returns {object} the version record that now holds this snapshot
 */
function noteVersion(record, version) {
  if (!record.snapshot_ids.includes(version.snapshot_id)) record.snapshot_ids.push(version.snapshot_id);
  let entry = record.versions.find((candidate) => candidate.sha256 === version.sha256);
  if (entry === undefined) {
    entry = { sha256: version.sha256, snapshot_ids: [], reason: version.reason ?? null };
    record.versions.push(entry);
  }
  if (!entry.snapshot_ids.includes(version.snapshot_id)) entry.snapshot_ids.push(version.snapshot_id);
  return entry;
}

/**
 * Check one old record's sealed whole-file copy, if it has one.
 *
 * A record without `full_copy` is not checked at all: there is no copy to verify, and the record's own blocks are
 * already verified above. A record WITH one promises the bytes are recoverable without `objects/`, so absence,
 * malformed metadata, a failed authentication and a digest/size mismatch are all divergences that must be named.
 * The identity passed to the reader is the record's plaintext identity (`sha256`, `length: size`): exactly what
 * rotation/backfill sealed with, and the reason a copy sealed for another version cannot be passed off as this one.
 *
 * The **format is decided by the file's own magic**, never by a field on the record: a v1 copy is one sealed object
 * (`W2MBLOB1`) read whole under `oldCopyMaxBytes`; a chunked v2 copy (`W2MOLD2`) is read one record at a time
 * ({@link verifyOldFullCopyChunked}). Both report through the same `null | {missing, detail}` shape, so `verifyRepo`
 * counts and names them identically.
 *
 * @param {{root: string, record: object, dek: Buffer, maxCopyBytes?: number, maxHeapBytes?: number,
 *   heapUsedBytes?: number}} input
 * @returns {null | {missing: boolean, detail: string, code?: string}} `null` when the copy is fine
 */
function verifyOldFullCopy(input) {
  const { root, record } = input;
  const copyFile = fullCopyPathFor(root, record);
  if (copyFile === null) {
    return { missing: true, detail: 'full_copy.file does not name a path under old/, so it is never followed' };
  }
  if (record.full_copy.sha256 !== record.sha256 || record.full_copy.size !== record.size) {
    return {
      missing: false,
      detail:
        `full_copy metadata (${String(record.full_copy.sha256)} / ${String(record.full_copy.size)}) disagrees with ` +
        `the version's own identity (${String(record.sha256)} / ${String(record.size)})`,
    };
  }
  if (typeof record.sha256 !== 'string' || !Number.isSafeInteger(record.size)) {
    return { missing: false, detail: 'the record has no usable sha256/size to verify the copy against' };
  }
  let stat;
  try {
    stat = fs.statSync(copyFile);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { missing: true, detail: `the full copy at ${copyFile} is missing` };
    }
    return { missing: false, detail: `the full copy at ${copyFile} is unreadable: ${error?.code ?? 'unknown'}` };
  }
  // The sniff reads eight bytes and happens BEFORE the v1 size bound: a chunked copy is exactly the case in which
  // "the file is larger than one allocation" is no longer a reason to refuse, because its reader never allocates
  // the file. A v1 copy keeps the bound below, unchanged.
  if (isChunkedV2(copyFile)) {
    return verifyOldFullCopyChunked({ copyFile, record, dek: input.dek });
  }
  return verifyOldFullCopyV1({ ...input, copyFile, stat });
}

/**
 * Check a **v1** whole-file copy: one sealed object, read whole.
 *
 * Unchanged from v3.5.1 in behaviour: bounded twice (the per-copy limit and the heap guard), then `openObject` with
 * the `old` identity, then the plaintext digest and length. The bound exists because this reader materialises the
 * file; it is not applied to the chunked format, which does not.
 *
 * @param {{record: object, copyFile: string, dek: Buffer, stat: fs.Stats, maxCopyBytes?: number,
 *   maxHeapBytes?: number, heapUsedBytes?: number}} input
 * @returns {null | {missing: boolean, detail: string, code?: string}}
 */
function verifyOldFullCopyV1(input) {
  const { record, copyFile, stat } = input;
  const maxCopyBytes = Number.isSafeInteger(input.maxCopyBytes) && input.maxCopyBytes >= 0 ? input.maxCopyBytes : DEFAULT_OLD_COPY_MAX_BYTES;
  // v3.5.1: a single whole-file copy is materialised (its format is one sealed object), so it is bounded twice:
  // by the configured per-copy limit and by the process-wide heap guard. Both refusals are named, never an OOM.
  if (stat.size > maxCopyBytes) {
    return {
      missing: false,
      code: VERIFY_CODES.OLD_COPY_TOO_LARGE,
      oversized: true,
      detail: `the full copy at ${copyFile} is ${stat.size} bytes, above the ${maxCopyBytes}-byte verify limit; it was not decrypted`,
    };
  }
  const guard = memoryGuard({ requestedBytes: stat.size * 3, maxHeapBytes: input.maxHeapBytes, label: copyFile, heapUsedBytes: input.heapUsedBytes });
  if (guard.ok !== true) return { missing: false, code: BACKUP_MEMORY_GUARD, guarded: true, detail: guard.detail };
  let sealed;
  try {
    sealed = fs.readFileSync(copyFile);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { missing: true, detail: `the full copy at ${copyFile} is missing` };
    }
    return { missing: false, detail: `the full copy at ${copyFile} is unreadable: ${error?.code ?? 'unknown'}` };
  }
  let plaintext;
  try {
    plaintext = openObject(sealed, input.dek, { sha256: record.sha256, length: record.size, kind: OLD_COPY_KIND });
  } catch (error) {
    return {
      missing: false,
      detail: `the full copy at ${copyFile} does not decrypt to the recorded version: ${error?.code ?? 'BACKUP_DECRYPT_AUTH_FAILED'}: ${error?.detail ?? error?.message ?? String(error)}`,
    };
  }
  const digest = sha256Hex(plaintext);
  if (plaintext.length !== record.size || digest !== record.sha256) {
    return {
      missing: false,
      detail: `the full copy at ${copyFile} decrypts to ${plaintext.length} bytes / ${digest}, not the recorded ${record.size} bytes / ${record.sha256}`,
    };
  }
  return null;
}

/**
 * Check a **chunked-v2** whole-file copy: one record at a time, peak one chunk (P2/O2).
 *
 * No `oldCopyMaxBytes` bound and no whole-file heap guard, because neither is needed: the format caps one chunk at
 * 16 MiB, so the reader's peak is bounded by the format itself, whatever the copy's size.
 * The record's identity is passed as the expected one, so a copy that belongs to ANOTHER version is refused with a
 * header mismatch naming both identities instead of a generic authentication failure. The plaintext digest/size are
 * still compared here as the last line: the reader returns what it decrypted, and this check decides whether it is
 * the version the record claims.
 *
 * @param {{copyFile: string, record: object, dek: Buffer}} input
 * @returns {null | {missing: boolean, detail: string}}
 */
function verifyOldFullCopyChunked(input) {
  const { copyFile, record } = input;
  let opened;
  try {
    opened = openChunkedStream(copyFile, {
      dek: input.dek,
      sha256: record.sha256,
      size: record.size,
    });
  } catch (error) {
    return {
      missing: false,
      detail:
        `the ${CHUNKED_FORMAT} full copy at ${copyFile} does not open as the recorded version: ` +
        `${error?.code ?? 'BACKUP_CHUNKED_AUTH_FAILED'}: ${error?.detail ?? error?.message ?? String(error)}`,
    };
  }
  if (opened.size !== record.size || opened.sha256 !== record.sha256) {
    return {
      missing: false,
      detail:
        `the ${CHUNKED_FORMAT} full copy at ${copyFile} decrypts to ${opened.size} bytes / ${opened.sha256}, ` +
        `not the recorded ${record.size} bytes / ${record.sha256}`,
    };
  }
  return null;
}

/**
 * Append one legal event to a session log, in memory, and validate the result.
 *
 * The event is not written anywhere. `permission/preset` with the next dense seq is the weakest legal append: it
 * changes no surface state and carries no references, so a failure in `append_codes` means the *append* broke the
 * log -- exactly what the next real append would trip over. Failures that predate the append are returned separately
 * (`preexisting_codes`), and an artifact whose container the installed Harness refuses is marked with the named
 * observation `BACKUP_FUTURE_APPEND_UNSUPPORTED` instead of being quoted as append evidence (see
 * `src/backup/future-append.mjs`).
 *
 * @param {Buffer} buffer
 * @returns {{ok: boolean, codes: string[], append_codes: string[], preexisting_codes: string[],
 *   container_codes: string[], graph_codes: string[], observation: {code: string, reason: string}|null,
 *   detail: object|null}}
 */
export function simulateFutureAppend(buffer) {
  const verdict = futureAppendVerdict(buffer);
  return {
    ok: verdict.ok === true,
    codes: verdict.codes,
    append_codes: verdict.append_codes ?? [],
    preexisting_codes: verdict.preexisting_codes ?? [],
    container_codes: verdict.container_codes ?? [],
    graph_codes: verdict.graph_codes ?? [],
    observation: verdict.observation ?? null,
    detail: verdict.detail ?? null,
  };
}

/** Resolve a byte-limit option: a non-negative integer wins, absent means the module default. */
function resolveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** The scope a manifest file entry counts toward. */
function scopeOfEntry(entry) {
  if (entry.kind === 'session') return 'sessions';
  if (entry.kind === 'attachment') return 'attachments';
  if (entry.kind === 'restore-copy') return 'restore_copies';
  return entry.kind;
}

/** Pick the dominant class of an uncovered row: most bytes, ties by report order. */
function dominantClass(classes) {
  const order = ['credential', 'self-copy', 'restore-copy', 'cache', 'reinstallable', 'not-in-scope', 'unknown'];
  let best = 'unknown';
  let bestBytes = -1;
  for (const [cls, bytes] of classes) {
    if (bytes > bestBytes || (bytes === bestBytes && order.indexOf(cls) < order.indexOf(best))) {
      best = cls;
      bestBytes = bytes;
    }
  }
  return best;
}

/**
 * Home coverage: how much of the live `$DSH_HOME` the latest snapshot covers, what the rest is, and which files
 * the selected scopes would capture but the snapshot does not hold.
 *
 * This is the answer to the audit's finding ("42 files of 13,462, ~22.6% of the bytes"). It is deliberately honest:
 * `covered` is the manifest's own bytes, `uncovered` is a real walk of the live home classified by the same scope
 * rules, and `gaps` is the **symmetric difference** between the files `collectScopeFiles` selects today and the
 * expanded-scope entries in the snapshot. A file created after the snapshot and a file deleted after it are both
 * named: the backup does not match the home it is supposed to cover.
 *
 * @param {{dshHome: string, manifest: object}} input
 * @returns {object} the `coverage` block `verifyRepo` reports
 */
export function buildCoverage(input) {
  const manifest = input.manifest;
  const scopes = Array.isArray(manifest?.scopes) ? [...manifest.scopes] : [...DEFAULT_BACKUP_SCOPES];
  const secretsIncluded = manifest?.secrets_included === true;
  const inventory = homeInventory({ dshHome: input.dshHome });
  const covered = { bytes: 0, files: 0, by_scope: {} };
  for (const name of DEFAULT_BACKUP_SCOPES) covered.by_scope[name] = { files: 0, bytes: 0 };
  const coveredRels = new Map();
  for (const entry of manifest?.files ?? []) {
    covered.files += 1;
    covered.bytes += entry.size;
    const scope = scopeOfEntry(entry);
    // A snapshot written by a newer version may carry a scope this build does not know; count it rather than
    // throwing, so verify still answers for the rest of the snapshot.
    if (covered.by_scope[scope] === undefined) covered.by_scope[scope] = { files: 0, bytes: 0 };
    covered.by_scope[scope].files += 1;
    covered.by_scope[scope].bytes += entry.size;
    coveredRels.set(entry.rel, scope);
  }

  // Walk the live home: covered rels are skipped by path; the rest is aggregated into display rows by class. A path
  // that is "in scope" by shape but absent from the manifest is reported as `not-in-scope` -- the incompleteness
  // signal the audit asked for.
  const uncoveredAgg = new Map();
  const walk = (dir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      let stat;
      try {
        stat = fs.lstatSync(`${dir}/${entry.name}`);
      } catch {
        continue;
      }
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(`${dir}/${entry.name}`, rel);
        continue;
      }
      if (!stat.isFile()) continue;
      if (coveredRels.has(rel)) continue;
      let cls = classifyHomePath(rel);
      if (cls === 'in-scope') cls = 'not-in-scope';
      const row = displayRel(rel);
      const key = `${row}\0${cls}`;
      const bucket = uncoveredAgg.get(key) ?? { rel: row, bytes: 0, files: 0, class: cls, classes: new Map() };
      bucket.bytes += stat.size;
      bucket.files += 1;
      bucket.classes.set(cls, (bucket.classes.get(cls) ?? 0) + stat.size);
      uncoveredAgg.set(key, bucket);
    }
  };
  if (inventory.exists) walk(input.dshHome, '');

  const uncovered = [...uncoveredAgg.values()].map((row) => {
    const cls = dominantClass(row.classes);
    return { rel: row.rel, bytes: row.bytes, files: row.files, class: cls, reason: classReason(row.rel, cls) };
  }).sort((a, b) => (a.rel === b.rel ? a.class.localeCompare(b.class) : a.rel.localeCompare(b.rel)));

  // The gap set: expanded-scope files the snapshot has but the home lost, and files the scopes would select today
  // but the snapshot does not hold. Credentials are in this comparison only when the snapshot included them.
  // Restore copies participate only when the snapshot recorded that scope AND the directory still exists: a
  // narrowed snapshot (written without restore_copies) must not report every restore copy as a gap.
  let restoreCopyDirExists = false;
  try {
    restoreCopyDirExists = fs.lstatSync(path.join(input.dshHome, RESTORE_COPY_ROOT)).isDirectory();
  } catch {
    restoreCopyDirExists = false;
  }
  const compareRestoreCopies = scopes.includes('restore_copies') && restoreCopyDirExists;
  const manifestExtraRels = new Set(
    [...coveredRels]
      .filter(([, scope]) => scope === 'registry' || scope === 'config' || scope === 'state' || (compareRestoreCopies && scope === 'restore_copies'))
      .map(([rel]) => rel),
  );
  const collected = collectScopeFiles({ dshHome: input.dshHome, scopes, includeSecrets: secretsIncluded });
  const expanded = new Set(['registry', 'config', 'state']);
  if (compareRestoreCopies) expanded.add('restore_copies');
  const collectedRels = new Set(
    collected.ok === true
      ? collected.files.filter((row) => expanded.has(row.scope)).map((row) => row.rel)
      : [],
  );
  const gaps = [
    ...[...manifestExtraRels].filter((rel) => !collectedRels.has(rel)),
    ...[...collectedRels].filter((rel) => !manifestExtraRels.has(rel)),
  ].sort();
  const homeBytes = inventory.bytes;
  const percent = homeBytes === 0 ? 100 : Math.min(100, Math.round((covered.bytes / homeBytes) * 1000) / 10);
  return {
    snapshot_id: manifest?.snapshot_id ?? null,
    scopes,
    secrets_included: secretsIncluded,
    home: { bytes: homeBytes, files: inventory.files },
    covered,
    uncovered,
    percent,
    gaps: gaps.slice(0, 20),
    gap_count: gaps.length,
    truncated: inventory.truncated === true,
  };
}

/**
 * Verify a whole repository.
 *
 * @param {{
 *   root: string, dshHome: string, accountId?: string|null, password?: string|Buffer|null, machineKey?: boolean,
 *   platform?: string, runner?: Function,
 *   futureAppend?: boolean, runtime?: boolean,
 * }} input
 * @returns {{
 *   ok: boolean, reason_code: string|null, detail: string|null,
 *   counts: {snapshots: number, files: number, blocks: number, bytes: number, old: number, current: number},
 *   problems: Array<{code: string, file: string|null, snapshot_id: string|null, detail: string}>,
 *   snapshots: Array<{snapshot_id: string, files: number, blocks: number, bytes: number, ok: boolean, problems: number}>,
 *   future_append: {checked: number, failed: number, failed_sessions: object[], observations: object[],
 *     unsupported: number},
 *   runtime_verified: {checked: number, failed: number},
 *   old_copies: {checked: number, ok: number, failed: number, missing: number},
 * }}
 */
export function verifyRepo(input) {
  const problems = [];
  const snapshots = [];
  const counts = { snapshots: 0, files: 0, blocks: 0, bytes: 0, old: 0, current: 0 };
  const streamThreshold = resolveLimit(input.streamThresholdBytes, DEFAULT_STREAM_THRESHOLD_BYTES);
  const futureAppendLimit = resolveLimit(input.futureAppendMaxBytes, DEFAULT_STREAM_THRESHOLD_BYTES);
  const runtimeMaxBytes = resolveLimit(input.runtimeMaxBytes, DEFAULT_STREAM_THRESHOLD_BYTES);
  const oldCopyMaxBytes = resolveLimit(input.oldCopyMaxBytes, DEFAULT_OLD_COPY_MAX_BYTES);
  const heapPolicy = resolveMaxHeapBytes(input.maxHeapBytes);
  if (heapPolicy.ok !== true) {
    return {
      ok: false,
      reason_code: heapPolicy.reason_code,
      detail: heapPolicy.detail,
      counts,
      problems: [{ code: heapPolicy.reason_code, file: null, snapshot_id: null, detail: heapPolicy.detail }],
      snapshots,
      future_append: emptyFutureAppend(),
      runtime_verified: { checked: 0, failed: 0, evidence: 'installed-harness' },
      old_copies: emptyOldCopies(),
    };
  }
  const maxHeapBytes = heapPolicy.maxHeapBytes;
  const memoryReport = createMemoryGuardReport();
  const futureAppend = emptyFutureAppend();
  // One finding per **session**, not per snapshot: the same session appears in every later snapshot (and an active
  // one appears with different bytes), and repeating the same conclusion once per snapshot is noise (the 2026-11-20
  // drill saw one session reported twice). The versions that failed are kept inside the finding, so deduplicating the
  // report never drops evidence. Verdicts are cached by content because diagnosing the same bytes twice is pure cost.
  const futureFindings = new Map();
  const futureVerdicts = new Map();
  const runtimeChecked = { checked: 0, failed: 0, skipped: 0, skipped_sessions: [], evidence: 'installed-harness', snapshots: 0 };
  const oldCopies = emptyOldCopies();
  // v3.5.1: entries at or above the threshold are digest-checked block-by-block (streaming.peak_block_bytes is
  // one 4 MiB block); smaller entries still take the whole-buffer path, which is where the future-append
  // simulation runs. The counters are part of the result so a reader can see which path verified what.
  const streaming = { files: 0, bytes: 0, blocks: 0, threshold_bytes: streamThreshold, peak_block_bytes: 0 };
  let latestManifest = null;
  let latestSnapshot = null;
  let coverage = null;
  const state = openRepo({ root: input.root, dshHome: input.dshHome });
  if (state.initialized !== true) {
    return {
      ok: false,
      reason_code: VERIFY_CODES.NOT_INITIALIZED,
      detail: state.error?.detail ?? 'the repository is not initialised',
      counts,
      problems,
      snapshots,
      future_append: futureAppend,
      runtime_verified: runtimeChecked,
      old_copies: oldCopies,
      streaming,
      memory_guard: { ...memoryReport, limit_bytes: maxHeapBytes },
    };
  }
  const key = openRepoKey({
    root: input.root,
    dshHome: input.dshHome,
    accountId: input.accountId ?? null,
    password: input.password ?? null,
    machineKey: input.machineKey,
    platform: input.platform,
    runner: input.runner,
  });
  if (key.ok !== true) {
    return {
      ok: false,
      reason_code: VERIFY_CODES.NO_PERMISSION,
      detail: key.detail,
      counts,
      problems,
      snapshots,
      future_append: futureAppend,
      runtime_verified: runtimeChecked,
      old_copies: oldCopies,
      streaming,
      memory_guard: { ...memoryReport, limit_bytes: maxHeapBytes },
    };
  }

  // Index vs snapshot directories: both directions, because either can be the one that drifted.
  const index = readIndex(input.root);
  const valid = listSnapshots(input.root, { full: true });
  const onDisk = new Set(valid.map((row) => row.snapshot_id));
  for (const entry of index.entries) {
    if (!onDisk.has(entry.snapshot_id)) {
      problems.push({ code: VERIFY_CODES.INDEX_MISMATCH, file: index.file, snapshot_id: entry.snapshot_id, detail: 'the index names a snapshot that is not on disk' });
    }
  }
  for (const row of valid) {
    if (!index.entries.some((entry) => entry.snapshot_id === row.snapshot_id)) {
      problems.push({ code: VERIFY_CODES.INDEX_MISMATCH, file: repoPaths(input.root).index, snapshot_id: row.snapshot_id, detail: 'the snapshot is on disk but not in the index (crash between rename and append?)' });
    }
  }

  // The repository's own descriptor: if this is not readable, every path below it is a guess.
  const descriptor = readJsonSafe(repoPaths(input.root).descriptor);
  if (descriptor === null || typeof descriptor.format !== 'string' || !Number.isSafeInteger(descriptor.version)) {
    problems.push({ code: VERIFY_CODES.SNAPSHOT_INVALID, file: repoPaths(input.root).descriptor, snapshot_id: null, detail: 'backup.json is missing or does not carry a format/version' });
  }

  for (const row of valid) {
    const summary = { snapshot_id: row.snapshot_id, files: 0, blocks: 0, bytes: 0, ok: true, problems: 0 };
    snapshots.push(summary);
    counts.snapshots += 1;
    if (row.valid !== true) {
      summary.ok = false;
      summary.problems += 1;
      problems.push({ code: VERIFY_CODES.SNAPSHOT_INVALID, file: null, snapshot_id: row.snapshot_id, detail: row.detail ?? 'snapshot is invalid' });
      continue;
    }
    const snapshot = readSnapshot({ root: input.root, snapshotId: row.snapshot_id });
    if (latestManifest === null) {
      latestManifest = snapshot.manifest;
      latestSnapshot = snapshot;
    }
    for (const entry of snapshot.manifest.files) {
      summary.files += 1;
      summary.blocks += entry.blocks.length;
      summary.bytes += entry.size;
      counts.files += 1;
      counts.blocks += entry.blocks.length;
      counts.bytes += entry.size;
      // Large entries: digest without materialising. Peak memory is one block, not the file (v3.5.1).
      if (Number.isSafeInteger(entry.size) && entry.size >= streamThreshold) {
        const streamed = digestEntryStreaming({ root: input.root, entry, dek: key.dek, maxHeapBytes, memoryReport });
        if (streamed.ok !== true) {
          summary.ok = false;
          summary.problems += 1;
          problems.push({ code: streamed.code, file: entry.rel, snapshot_id: row.snapshot_id, detail: streamed.detail });
          continue;
        }
        streaming.files += 1;
        streaming.bytes += entry.size;
        streaming.blocks += streamed.blocks;
        streaming.peak_block_bytes = Math.max(streaming.peak_block_bytes, streamed.peak_block_bytes);
        // G3's simulation needs the whole log, so a streamed entry never runs it here. It is deferred **by name**
        // whether the size or the configured threshold is what streamed it -- a report must not imply a check that
        // did not happen. The bytes themselves are still verified by digest.
        if (entry.kind === 'session' && input.futureAppend !== false) {
          futureAppend.skipped += 1;
          futureAppend.skipped_sessions.push({
            rel: entry.rel,
            reason_code: entry.size > futureAppendLimit
              ? 'BACKUP_FUTURE_APPEND_SKIPPED_LARGE'
              : 'BACKUP_FUTURE_APPEND_SKIPPED_STREAMED',
            snapshot_id: row.snapshot_id,
            size: entry.size,
          });
        }
        continue;
      }
      const rebuilt = rebuildFile({ root: input.root, entry, dek: key.dek, maxHeapBytes, memoryReport });
      if (rebuilt.ok !== true) {
        summary.ok = false;
        summary.problems += 1;
        problems.push({ code: rebuilt.code, file: entry.rel, snapshot_id: row.snapshot_id, detail: rebuilt.detail });
        continue;
      }
      if (rebuilt.buffer.length !== entry.size) {
        summary.ok = false;
        summary.problems += 1;
        problems.push({ code: VERIFY_CODES.SIZE_MISMATCH, file: entry.rel, snapshot_id: row.snapshot_id, detail: `rebuilt ${rebuilt.buffer.length} of ${entry.size} bytes` });
        continue;
      }
      const digest = sha256Hex(rebuilt.buffer);
      if (digest !== entry.sha256) {
        summary.ok = false;
        summary.problems += 1;
        problems.push({ code: VERIFY_CODES.DIGEST_MISMATCH, file: entry.rel, snapshot_id: row.snapshot_id, detail: `rebuilt bytes hash to ${digest}, manifest says ${entry.sha256}` });
        continue;
      }
      if (entry.kind === 'session' && input.futureAppend !== false) {
        // One simulation per distinct content: a session that did not change between snapshots is the same bytes,
        // and diagnosing the same multi-megabyte log once per snapshot is pure cost. `checked` still counts every
        // occurrence, because that is the work the report claims was done on each snapshot.
        let simulation = futureVerdicts.get(entry.sha256);
        if (simulation === undefined) {
          simulation = simulateFutureAppend(rebuilt.buffer);
          futureVerdicts.set(entry.sha256, simulation);
        }
        futureAppend.checked += 1;
        let finding = futureFindings.get(entry.rel);
        if (finding === undefined) {
          finding = { problem: null, failure: null, observation: null };
          futureFindings.set(entry.rel, finding);
        }
        // The named observation is about the PROBE, not about the log: an artifact whose container the installed
        // Harness refuses has no legal next append to simulate, so the simulation must not be quoted as evidence.
        // It is surfaced once per **session**, not once per snapshot or per version, and it is not a problem by
        // itself -- the container defect that causes it is reported as a problem below.
        if (simulation.observation !== null) {
          if (finding.observation === null) {
            finding.observation = {
              code: simulation.observation.code,
              file: entry.rel,
              session: sessionOfRel(entry.rel),
              reason: simulation.observation.reason,
              versions: [],
              snapshot_ids: [],
            };
            futureAppend.unsupported += 1;
            futureAppend.observations.push(finding.observation);
          }
          noteVersion(finding.observation, { sha256: entry.sha256, snapshot_id: row.snapshot_id, reason: simulation.observation.reason });
        }
        if (simulation.ok !== true) {
          summary.ok = false;
          summary.problems += 1;
          futureAppend.failed += 1;
          if (finding.problem === null) {
            finding.problem = {
              code: VERIFY_CODES.FUTURE_APPEND_FAILED,
              file: entry.rel,
              snapshot_id: row.snapshot_id,
              detail: futureAppendFailureDetail(simulation),
              snapshot_ids: [],
              sha256s: [],
              occurrences: 0,
            };
            problems.push(finding.problem);
            finding.failure = {
              rel: entry.rel,
              session: sessionOfRel(entry.rel),
              codes: [],
              append_codes: [],
              container_codes: [],
              graph_codes: [],
              versions: [],
              snapshot_ids: [],
              detail: null,
              occurrences: 0,
            };
            futureAppend.failed_sessions.push(finding.failure);
          }
          const failure = finding.failure;
          const problem = finding.problem;
          failure.occurrences += 1;
          problem.occurrences += 1;
          mergeCodes(failure.codes, simulation.codes);
          mergeCodes(failure.append_codes, simulation.append_codes);
          mergeCodes(failure.container_codes, simulation.container_codes);
          mergeCodes(failure.graph_codes, simulation.graph_codes);
          if (!failure.snapshot_ids.includes(row.snapshot_id)) failure.snapshot_ids.push(row.snapshot_id);
          if (!problem.snapshot_ids.includes(row.snapshot_id)) problem.snapshot_ids.push(row.snapshot_id);
          if (!problem.sha256s.includes(entry.sha256)) problem.sha256s.push(entry.sha256);
          let version = failure.versions.find((candidate) => candidate.sha256 === entry.sha256);
          if (version === undefined) {
            version = {
              sha256: entry.sha256,
              snapshot_ids: [],
              codes: [...(simulation.codes ?? [])],
              append_codes: [...(simulation.append_codes ?? [])],
              container_codes: [...(simulation.container_codes ?? [])],
              graph_codes: [...(simulation.graph_codes ?? [])],
              header_frame_rows: simulation.detail?.header_frame_rows ?? null,
              detail: futureAppendFailureDetail(simulation),
            };
            failure.versions.push(version);
          }
          if (!version.snapshot_ids.includes(row.snapshot_id)) version.snapshot_ids.push(row.snapshot_id);
          // One problem per session, recomputed from the union of every failing version: a reader sees the first
          // version's message, and -- when a *different* version of the same session failed too -- how many and where
          // to find them. The per-version detail lives in `future_append.failed_sessions`.
          const base = futureAppendFailureDetail({
            append_codes: failure.append_codes,
            container_codes: failure.container_codes,
            graph_codes: failure.graph_codes,
            detail: { header_frame_rows: failure.versions[0].header_frame_rows },
          });
          failure.detail = base;
          problem.detail = failure.versions.length > 1
            ? `${base} (${failure.versions.length} different version(s) of this session failed across ${failure.snapshot_ids.length} snapshot(s); see future_append.failed_sessions)`
            : base;
        }
      }
    }
  }

  // Old version records and current pointers are references too: a block they name must exist.
  const objectsRoot = repoPaths(input.root).objects;
  const old = listOldVersions(input.root);
  counts.old = old.length;
  for (const record of old) {
    const info = record.record;
    for (const block of info.blocks ?? []) {
      if (fs.existsSync(objectFile(input.root, block.sha256))) continue;
      problems.push({ code: VERIFY_CODES.OLD_RECORD_BLOCK_MISSING, file: record.file, snapshot_id: info.snapshot_id ?? null, detail: `block ${block.sha256} named by the version record is missing` });
    }
    // An old record is a manifest entry too: verify the digest it recorded. Streamed like every other large
    // entry (v3.5.1): a superseded 118 MB version is checked block-by-block, never materialised.
    if (typeof info.sha256 === 'string' && Number.isSafeInteger(info.size)) {
      const streamed = digestEntryStreaming({
        root: input.root,
        entry: { blocks: info.blocks ?? [], size: info.size, sha256: info.sha256, rel: info.rel ?? 'old-record' },
        dek: key.dek,
        maxHeapBytes,
        memoryReport,
      });
      if (streamed.ok !== true) {
        problems.push({ code: streamed.code, file: record.file, snapshot_id: info.snapshot_id ?? null, detail: streamed.detail });
      }
    }
    // Records WITH a sealed whole-file copy promise those bytes are recoverable without `objects/`; verify that
    // promise by decrypting the copy. A record without `full_copy` has nothing extra to check (its blocks above are
    // the whole claim), so the counters stay untouched for it.
    if (info.full_copy !== undefined && info.full_copy !== null) {
      oldCopies.checked += 1;
      const failure = verifyOldFullCopy({ root: input.root, record: info, dek: key.dek, maxHeapBytes, maxCopyBytes: oldCopyMaxBytes });
      if (failure === null) {
        oldCopies.ok += 1;
      } else if (failure.missing === true) {
        oldCopies.missing += 1;
        problems.push({
          code: VERIFY_CODES.OLD_COPY_MISSING,
          file: record.file,
          snapshot_id: info.snapshot_id ?? null,
          detail: `${record.file}: the version record claims a full copy: ${failure.detail}`,
        });
      } else {
        oldCopies.failed += 1;
        problems.push({
          code: failure.code ?? VERIFY_CODES.OLD_COPY_FAILED,
          file: record.file,
          snapshot_id: info.snapshot_id ?? null,
          detail: `${record.file}: the version record's full copy is not usable: ${failure.detail}`,
        });
      }
    }
  }
  const current = readCurrentPointers(input.root);
  counts.current = current.pointers.length;
  for (const record of current.problems) {
    problems.push({ code: VERIFY_CODES.SNAPSHOT_INVALID, file: record.file, snapshot_id: null, detail: record.detail });
  }
  for (const pointer of current.pointers) {
    for (const block of pointer.pointer.blocks ?? []) {
      if (fs.existsSync(objectFile(input.root, block.sha256))) continue;
      problems.push({ code: VERIFY_CODES.OLD_RECORD_BLOCK_MISSING, file: pointer.file, snapshot_id: pointer.pointer.snapshot_id ?? null, detail: `block ${block.sha256} named by the current pointer is missing` });
    }
  }
  void objectsRoot;

  if (latestManifest !== null) {
    coverage = buildCoverage({ dshHome: input.dshHome, manifest: latestManifest });
    if (coverage.gap_count > 0) {
      problems.push({
        code: VERIFY_CODES.COVERAGE_GAP,
        file: null,
        snapshot_id: coverage.snapshot_id,
        detail:
          `${coverage.gap_count} file(s) the enabled scopes cover do not match the snapshot (first: ` +
          `${coverage.gaps.slice(0, 5).join(', ')})`,
      });
    }
  }

  // G5 runtime evidence (v3.5.1): ONE session at a time, buffers released before the next, and only for the
  // LATEST snapshot. 3.5.0 queued two decoded artifacts per session for every snapshot (924 on the real 21-snapshot
  // repository) before spawning one batch -- the measured 4 GB-host OOM. Older snapshots were validated on the
  // night they were latest; their blocks and digests are still verified here, and the cached record says when the
  // runtime last looked. A session above the runtime byte limit is skipped by name, never buffered.
  const latestSessionSummaries = new Map(snapshots.map((row) => [row.snapshot_id, row]));
  if (input.runtime === true && latestSnapshot !== null) {
    runtimeChecked.snapshots = 1;
    const runBatch = typeof input.runtimeValidateBatch === 'function' ? input.runtimeValidateBatch : runtimeValidateBatch;
    const latestSummary = latestSessionSummaries.get(latestSnapshot.snapshot_id) ?? null;
    for (const entry of latestSnapshot.manifest.files) {
      if (entry.kind !== 'session') continue;
      if (Number.isSafeInteger(entry.size) && entry.size > runtimeMaxBytes) {
        runtimeChecked.skipped += 1;
        runtimeChecked.skipped_sessions.push({ rel: entry.rel, reason_code: 'BACKUP_RUNTIME_SKIPPED_LARGE', size: entry.size, limit_bytes: runtimeMaxBytes });
        continue;
      }
      const rebuilt = rebuildFile({ root: input.root, entry, dek: key.dek, maxHeapBytes, memoryReport });
      if (rebuilt.ok !== true) {
        runtimeChecked.skipped += 1;
        runtimeChecked.skipped_sessions.push({ rel: entry.rel, reason_code: rebuilt.code, detail: rebuilt.detail });
        continue;
      }
      let artifacts;
      try {
        artifacts = [buildArtifactFromBuffer(rebuilt.buffer), buildArtifactFromBuffer(appendLegalEvent(rebuilt.buffer))];
      } catch (error) {
        runtimeChecked.checked += 1;
        runtimeChecked.failed += 1;
        if (latestSummary !== null) {
          latestSummary.ok = false;
          latestSummary.problems += 1;
        }
        problems.push({ code: 'BACKUP_RUNTIME_REJECTED', file: entry.rel, snapshot_id: latestSnapshot.snapshot_id, detail: `could not decode for the runtime: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      const batch = runBatch({ artifacts, env: input.env });
      runtimeChecked.checked += 1;
      const original = batch.verdicts[0] ?? { ok: false, detail: 'no verdict', events: 0 };
      const appended = batch.verdicts[1] ?? { ok: false, detail: 'no verdict', events: 0 };
      if (batch.available !== true) {
        if (latestSummary !== null) {
          latestSummary.ok = false;
          latestSummary.problems += 1;
        }
        problems.push({ code: 'BACKUP_RUNTIME_UNAVAILABLE', file: entry.rel, snapshot_id: latestSnapshot.snapshot_id, detail: original.detail });
        continue;
      }
      if (original.ok !== true) {
        runtimeChecked.failed += 1;
        if (latestSummary !== null) {
          latestSummary.ok = false;
          latestSummary.problems += 1;
        }
        problems.push({ code: 'BACKUP_RUNTIME_REJECTED', file: entry.rel, snapshot_id: latestSnapshot.snapshot_id, detail: original.detail });
        continue;
      }
      if (appended.ok !== true) {
        runtimeChecked.failed += 1;
        if (latestSummary !== null) {
          latestSummary.ok = false;
          latestSummary.problems += 1;
        }
        problems.push({ code: VERIFY_CODES.RUNTIME_APPEND_FAILED, file: entry.rel, snapshot_id: latestSnapshot.snapshot_id, detail: `after one legal append the Harness refuses the log: ${appended.detail}` });
      }
      // Explicitly drop the only whole-file buffer this iteration held before the next session is rebuilt.
      artifacts = null;
    }
  }

  return {
    ok: problems.length === 0,
    reason_code: problems.length === 0 ? null : problems[0].code,
    detail: problems.length === 0 ? null : `${problems.length} problem(s) found`,
    counts,
    problems,
    snapshots,
    future_append: futureAppend,
    runtime_verified: runtimeChecked,
    old_copies: oldCopies,
    coverage,
    streaming,
    limits: { stream_threshold_bytes: streamThreshold, future_append_max_bytes: futureAppendLimit, runtime_max_bytes: runtimeMaxBytes, old_copy_max_bytes: oldCopyMaxBytes },
    memory_guard: { limit_bytes: maxHeapBytes, checks: memoryReport.checks, refusals: memoryReport.refusals, refused: memoryReport.refused },
  };
}
