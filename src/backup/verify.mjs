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
 */

import fs from 'node:fs';

import { repoPaths } from './layout.mjs';
import { openRepo, readIndex, readSnapshot, listSnapshots } from './repo.mjs';
import { openRepoKey } from './keystore.mjs';
import { sha256Hex } from './manifest.mjs';
import { rebuildFile, objectFile } from './materialize.mjs';
import { OLD_COPY_KIND, openObject } from './crypto.mjs';
import { fullCopyPathFor, listOldVersions } from './rotation.mjs';
import { readCurrentPointers } from './gc.mjs';
import { buildArtifactFromBuffer, runtimeValidateBatch } from './runtime-validate.mjs';
import { appendLegalEvent, futureAppendVerdict } from './future-append.mjs';
import { readJsonSafe } from './atomic.mjs';
import { DEFAULT_BACKUP_SCOPES, classReason, classifyHomePath, collectScopeFiles, displayRel, homeInventory } from './scopes.mjs';

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
});

/** The zeroed `old_copies` counter block (also the shape every early return reports). */
function emptyOldCopies() {
  return { checked: 0, ok: 0, failed: 0, missing: 0 };
}

/**
 * Check one old record's sealed whole-file copy, if it has one.
 *
 * A record without `full_copy` is not checked at all: there is no copy to verify, and the record's own blocks are
 * already verified above. A record WITH one promises the bytes are recoverable without `objects/`, so absence,
 * malformed metadata, a failed authentication and a digest/size mismatch are all divergences that must be named.
 * The identity passed to `openObject` is the record's plaintext identity (`sha256`, `length: size`) under
 * `kind: 'old'`: exactly what rotation/backfill sealed with, and the reason a block object cannot be passed off as
 * a whole-file copy.
 *
 * @param {{root: string, record: object, dek: Buffer}} input
 * @returns {null | {missing: boolean, detail: string}} `null` when the copy is fine
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
  const verdict = futureAppendVerdict(buffer);
  return { ok: verdict.ok === true, codes: verdict.codes, detail: verdict.detail };
}

/** The scope a manifest file entry counts toward. */
function scopeOfEntry(entry) {
  if (entry.kind === 'session') return 'sessions';
  if (entry.kind === 'attachment') return 'attachments';
  return entry.kind;
}

/** Pick the dominant class of an uncovered row: most bytes, ties by report order. */
function dominantClass(classes) {
  const order = ['credential', 'self-copy', 'cache', 'reinstallable', 'not-in-scope', 'unknown'];
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
  for (const name of ['sessions', 'attachments', 'registry', 'config', 'state']) covered.by_scope[name] = { files: 0, bytes: 0 };
  const coveredRels = new Map();
  for (const entry of manifest?.files ?? []) {
    covered.files += 1;
    covered.bytes += entry.size;
    const scope = scopeOfEntry(entry);
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
  const manifestExtraRels = new Set([...coveredRels].filter(([, scope]) => scope === 'registry' || scope === 'config' || scope === 'state').map(([rel]) => rel));
  const collected = collectScopeFiles({ dshHome: input.dshHome, scopes, includeSecrets: secretsIncluded });
  const expanded = new Set(['registry', 'config', 'state']);
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
 *   future_append: {checked: number, failed: number},
 *   runtime_verified: {checked: number, failed: number},
 *   old_copies: {checked: number, ok: number, failed: number, missing: number},
 * }}
 */
export function verifyRepo(input) {
  const problems = [];
  const snapshots = [];
  const counts = { snapshots: 0, files: 0, blocks: 0, bytes: 0, old: 0, current: 0 };
  const futureAppend = { checked: 0, failed: 0, evidence: 'static-prefilter' };
  const runtimeChecked = { checked: 0, failed: 0, evidence: 'installed-harness' };
  const oldCopies = emptyOldCopies();
  let latestManifest = null;
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

  const runtimeQueue = [];
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
    if (latestManifest === null) latestManifest = snapshot.manifest;
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
        try {
          runtimeQueue.push({
            entry,
            snapshot_id: row.snapshot_id,
            summary,
            artifact: buildArtifactFromBuffer(rebuilt.buffer),
            // G3: the runtime is asked about the log *and* the log plus one legal append.
            appended: buildArtifactFromBuffer(appendLegalEvent(rebuilt.buffer)),
          });
        } catch (error) {
          summary.ok = false;
          summary.problems += 1;
          runtimeChecked.checked += 1;
          runtimeChecked.failed += 1;
          problems.push({ code: 'BACKUP_RUNTIME_REJECTED', file: entry.rel, snapshot_id: row.snapshot_id, detail: `could not decode for the runtime: ${error instanceof Error ? error.message : String(error)}` });
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
    // An old record is a manifest entry too: rebuild it and compare the digest it recorded.
    if (typeof info.sha256 === 'string' && Number.isSafeInteger(info.size)) {
      const rebuilt = rebuildFile({ root: input.root, entry: { blocks: info.blocks ?? [], size: info.size, sha256: info.sha256, rel: info.rel ?? 'old-record' }, dek: key.dek });
      if (rebuilt.ok !== true) {
        problems.push({ code: rebuilt.code, file: record.file, snapshot_id: info.snapshot_id ?? null, detail: rebuilt.detail });
      } else if (rebuilt.buffer.length !== info.size || sha256Hex(rebuilt.buffer) !== info.sha256) {
        problems.push({ code: VERIFY_CODES.DIGEST_MISMATCH, file: record.file, snapshot_id: info.snapshot_id ?? null, detail: 'the rebuilt old version does not hash to the digest the record stored' });
      }
    }
    // Records WITH a sealed whole-file copy promise those bytes are recoverable without `objects/`; verify that
    // promise by decrypting the copy. A record without `full_copy` has nothing extra to check (its blocks above are
    // the whole claim), so the counters stay untouched for it.
    if (info.full_copy !== undefined && info.full_copy !== null) {
      oldCopies.checked += 1;
      const failure = verifyOldFullCopy({ root: input.root, record: info, dek: key.dek });
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
          code: VERIFY_CODES.OLD_COPY_FAILED,
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

  if (runtimeQueue.length > 0) {
    const artifacts = runtimeQueue.flatMap((row) => [row.artifact, row.appended]);
    const batch = runtimeValidateBatch({ artifacts, env: input.env });
    runtimeChecked.checked += runtimeQueue.length;
    for (const [offset, row] of runtimeQueue.entries()) {
      const original = batch.verdicts[offset * 2] ?? { ok: false, detail: 'no verdict', events: 0 };
      const appended = batch.verdicts[offset * 2 + 1] ?? { ok: false, detail: 'no verdict', events: 0 };
      if (batch.available !== true) {
        row.summary.ok = false;
        row.summary.problems += 1;
        problems.push({ code: 'BACKUP_RUNTIME_UNAVAILABLE', file: row.entry.rel, snapshot_id: row.snapshot_id, detail: original.detail });
        continue;
      }
      if (original.ok !== true) {
        runtimeChecked.failed += 1;
        row.summary.ok = false;
        row.summary.problems += 1;
        problems.push({ code: 'BACKUP_RUNTIME_REJECTED', file: row.entry.rel, snapshot_id: row.snapshot_id, detail: original.detail });
        continue;
      }
      if (appended.ok !== true) {
        runtimeChecked.failed += 1;
        row.summary.ok = false;
        row.summary.problems += 1;
        problems.push({ code: VERIFY_CODES.RUNTIME_APPEND_FAILED, file: row.entry.rel, snapshot_id: row.snapshot_id, detail: `after one legal append the Harness refuses the log: ${appended.detail}` });
      }
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
  };
}
