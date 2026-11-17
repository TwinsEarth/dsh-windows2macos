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
 */

import fs from 'node:fs';

import { repoPaths } from './layout.mjs';
import { openRepo, readIndex, readSnapshot, listSnapshots } from './repo.mjs';
import { openRepoKey } from './keystore.mjs';
import { sha256Hex } from './manifest.mjs';
import { rebuildFile, objectFile } from './materialize.mjs';
import { listOldVersions } from './rotation.mjs';
import { readCurrentPointers } from './gc.mjs';
import { diagnoseSessionBuffer } from '../util/session-validate.mjs';
import { buildArtifactFromBuffer, runtimeValidate } from './runtime-validate.mjs';
import { compressFrame } from '../fix/zstd.mjs';

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
  FUTURE_APPEND_FAILED: 'BACKUP_FUTURE_APPEND_FAILED',
});

/**
 * Append one legal event to a session log, in memory, and validate the result.
 *
 * The event is not written anywhere. `turn/start` with the next dense seq is the weakest legal append: it changes no
 * surface state and carries no references, so a failure here means the log's own invariants (header frame, dense
 * seqs, protected head, surface ops) are wrong -- exactly what the next real append would trip over.
 *
 * @param {Buffer} buffer
 * @returns {{ok: boolean, codes: string[], detail: object|null}}
 */
export function simulateFutureAppend(buffer) {
  let artifact;
  try {
    artifact = buildArtifactFromBuffer(buffer);
  } catch (error) {
    return { ok: false, codes: ['BACKUP_SCAN_HEADER_UNREADABLE'], detail: { error: error instanceof Error ? error.message : String(error) } };
  }
  const nextSeq = artifact.events.length;
  const appended = Buffer.concat([
    buffer,
    compressFrame(Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: nextSeq, time: Date.now(), data: { turn: 1 } })}\n`, 'utf8')),
  ]);
  const verdict = diagnoseSessionBuffer(appended, { expectedSessionId: artifact.header.id ?? null });
  return { ok: verdict.ok === true, codes: verdict.codes, detail: verdict.detail ?? null };
}

/**
 * Verify a whole repository.
 *
 * @param {{
 *   root: string, dshHome: string, password?: string|Buffer|null, machineKey?: boolean,
 *   platform?: string, runner?: Function,
 *   futureAppend?: boolean, runtime?: boolean,
 * }} input
 * @returns {{
 *   ok: boolean, reason_code: string|null, detail: string|null,
 *   counts: {snapshots: number, files: number, blocks: number, bytes: number, old: number, current: number},
 *   problems: Array<{code: string, file: string|null, snapshot_id: string|null, detail: string}>,
 *   snapshots: Array<{snapshot_id: string, files: number, blocks: number, bytes: number, ok: boolean, problems: number}>,
 *   future_append: {checked: number, failed: number},
 *   runtime_verified: {checked: number, failed: number},
 * }}
 */
export function verifyRepo(input) {
  const problems = [];
  const snapshots = [];
  const counts = { snapshots: 0, files: 0, blocks: 0, bytes: 0, old: 0, current: 0 };
  const futureAppend = { checked: 0, failed: 0 };
  const runtimeChecked = { checked: 0, failed: 0 };
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
    };
  }
  const key = openRepoKey({
    root: input.root,
    dshHome: input.dshHome,
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
    for (const entry of snapshot.manifest.files) {
      summary.files += 1;
      summary.blocks += entry.blocks.length;
      summary.bytes += entry.size;
      counts.files += 1;
      counts.blocks += entry.blocks.length;
      counts.bytes += entry.size;
      const rebuilt = rebuildFile({ root: input.root, entry, dek: key.dek });
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
        const simulation = simulateFutureAppend(rebuilt.buffer);
        futureAppend.checked += 1;
        if (simulation.ok !== true) {
          futureAppend.failed += 1;
          summary.ok = false;
          summary.problems += 1;
          problems.push({ code: VERIFY_CODES.FUTURE_APPEND_FAILED, file: entry.rel, snapshot_id: row.snapshot_id, detail: `appending one legal event fails: ${simulation.codes.join(', ')}` });
        }
      }
      if (entry.kind === 'session' && input.runtime === true) {
        const verdict = runtimeValidate({ buffer: rebuilt.buffer, env: input.env });
        runtimeChecked.checked += 1;
        if (verdict.available !== true) {
          problems.push({ code: 'BACKUP_RUNTIME_UNAVAILABLE', file: entry.rel, snapshot_id: row.snapshot_id, detail: verdict.detail });
          summary.ok = false;
          summary.problems += 1;
        } else if (verdict.ok !== true) {
          runtimeChecked.failed += 1;
          summary.ok = false;
          summary.problems += 1;
          problems.push({ code: 'BACKUP_RUNTIME_REJECTED', file: entry.rel, snapshot_id: row.snapshot_id, detail: verdict.detail });
        }
      }
    }
  }

  // Old version records and current pointers are references too: a block they name must exist.
  const objectsRoot = repoPaths(input.root).objects;
  const old = listOldVersions(input.root);
  counts.old = old.length;
  for (const record of old) {
    for (const block of record.record.blocks ?? []) {
      const file = objectFile(input.root, block.sha256);
      if (fs.existsSync(file)) continue;
      problems.push({ code: VERIFY_CODES.OLD_RECORD_BLOCK_MISSING, file: record.file, snapshot_id: record.record.snapshot_id ?? null, detail: `block ${block.sha256} named by the version record is missing` });
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

  return {
    ok: problems.length === 0,
    reason_code: problems.length === 0 ? null : problems[0].code,
    detail: problems.length === 0 ? null : `${problems.length} problem(s) found`,
    counts,
    problems,
    snapshots,
    future_append: futureAppend,
    runtime_verified: runtimeChecked,
  };
}
