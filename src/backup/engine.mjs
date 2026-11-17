/**
 * The backup engine: scan, choose scope, write missing blocks, commit a snapshot, rotate superseded versions.
 *
 * ## The order the steps happen in, and why
 *
 *   1. **lock** -- one writer, or none (see `locks.mjs`);
 *   2. **layout** -- create the repository on the first run;
 *   3. **key** -- open or mint the repository DEK before writing anything, so a run cannot fail *after* it has
 *      already written blocks nobody can ever read;
 *   4. **scan** -- read-only enumeration of the home;
 *   5. **blocks** -- read each selected file once, split it into 4 MiB blocks, and write only the blocks whose
 *      content address is absent (that absence check *is* the deduplication);
 *   6. **commit** -- manifest + key copy staged, renamed, index appended (see `repo.mjs`);
 *   7. **rotation** -- after the snapshot is committed, record the superseded version and move `current/` forward.
 *
 * Rotation deliberately happens **after** the commit: if the process dies between them, the snapshot is durable
 * and the old pointer still names the previous version, so re-running records the same superseded version again
 * (idempotent filename, deterministic content) rather than losing it.
 *
 * ## What the engine refuses
 *
 *   * no openable key (`BACKUP_NO_PERMISSION`) -- before any block is written;
 *   * another writer (`BACKUP_LOCKED`);
 *   * a scope that selects nothing (`BACKUP_SCOPED_NOTHING`);
 *   * a non-repository target (`BACKUP_DIR_*` codes from `layout.mjs`);
 *   * an invalid retention window (`BACKUP_ROTATION_POLICY_INVALID`) or a mirror path inside the repository /
 *     the home it copies (`BACKUP_MIRROR_INVALID`) -- both before any write, so a configuration mistake leaves
 *     no half-built snapshot behind.
 *
 * ## The offsite mirror is best effort, and strictly after the primary
 *
 * When a mirror is configured, `runBackup` copies the committed snapshot's sealed blocks and metadata to it after
 * the commit and rotation succeed. A mirror failure is reported as `mirror.ok: false` plus a warning on an
 * `ok: true` result: the primary backup is durable and correct, and a second copy that failed must not downgrade
 * it. With no mirror configured the result shape is unchanged (no `mirror` key).
 *
 * Every refusal is a `{ok:false, reason_code, detail}` result, not an exception: the route and the CLI print the
 * same refusal, and a scheduled run logs it instead of tearing the timer down.
 */

import fs from 'node:fs';
import path from 'node:path';

import { BackupLayoutError, ensureLayout, repoPaths } from './layout.mjs';
import { buildManifest, normalizeRelPath, sha256Hex, splitBlocks } from './manifest.mjs';
import { sealObject } from './crypto.mjs';
import { writeFileAtomic } from './atomic.mjs';
import { withRepoLock } from './locks.mjs';
import { openRepoKey } from './keystore.mjs';
import { detectMachineKeySupport } from './machine-key.mjs';
import { appendLegalEvent, futureAppendVerdict } from './future-append.mjs';
import { buildArtifactFromBuffer, runtimeValidateBatch } from './runtime-validate.mjs';
import { scanHome } from './scan.mjs';
import { DEFAULT_KEEP_OLD, resolveMaxAgeDays, rotateForEntry } from './rotation.mjs';
import { MIRROR_CODES, resolveMirrorRoot, syncToMirror } from './mirror.mjs';
import { commitSnapshot, makeSnapshotId } from './repo.mjs';
import { scanFrames } from '../fix/zstd.mjs';

/** Backup scopes. `selected` is only meaningful with an explicit list of session ids. */
export const SCOPES = Object.freeze(['all', 'active', 'archived', 'selected']);

/** Named engine refusals. */
export const ENGINE_CODES = Object.freeze({
  LOCKED: 'BACKUP_LOCKED',
  NO_PERMISSION: 'BACKUP_NO_PERMISSION',
  SCOPED_NOTHING: 'BACKUP_SCOPED_NOTHING',
  SCOPE_INVALID: 'BACKUP_SCOPE_INVALID',
  HOME_MISSING: 'BACKUP_SCAN_HOME_MISSING',
  KEY_UNWRAP_FAILED: 'BACKUP_KEY_UNWRAP_FAILED',
  WRITE_FAILED: 'BACKUP_WRITE_FAILED',
});

/** Block size used by the engine; identical to the manifest's, referenced for readability. */
const BLOCK_BYTES = 4 * 1024 * 1024;

/**
 * Validate a scope request.
 *
 * @param {{scope?: string, selected?: string[]}} input
 * @returns {{ok: true, scope: string, selected: string[]} | {ok: false, reason_code: string, detail: string}}
 */
export function normalizeScope(input = {}) {
  const scope = input.scope ?? 'all';
  if (!SCOPES.includes(scope)) {
    return { ok: false, reason_code: ENGINE_CODES.SCOPE_INVALID, detail: `scope must be one of ${SCOPES.join(', ')}, got ${JSON.stringify(scope)}` };
  }
  const selected = (Array.isArray(input.selected) ? input.selected : [])
    .map((value) => String(value).trim())
    .filter((value) => value !== '');
  if (scope === 'selected' && selected.length === 0) {
    return { ok: false, reason_code: ENGINE_CODES.SCOPED_NOTHING, detail: 'scope "selected" needs at least one session id' };
  }
  return { ok: true, scope, selected };
}

/**
 * Apply a scope to scanned sessions.
 *
 * Archived sessions are excluded from `active` and only included by `archived`; a session whose flags are
 * unknown (unreadable registry) is treated as active -- losing it silently is worse than backing up one session
 * the registry cannot describe.
 *
 * @param {Array<object>} sessions rows from `scan.mjs`
 * @param {{scope: string, selected: string[]}} request
 * @returns {{chosen: Array<object>, skipped: number, unknown_selected: string[]}}
 */
export function selectSessions(sessions, request) {
  if (request.scope === 'selected') {
    const wanted = new Set(request.selected);
    const chosen = sessions.filter((row) => wanted.has(row.session_id));
    const found = new Set(chosen.map((row) => row.session_id));
    return { chosen, skipped: sessions.length - chosen.length, unknown_selected: request.selected.filter((id) => !found.has(id)) };
  }
  const chosen = sessions.filter((row) => {
    if (request.scope === 'all') return true;
    const archived = row.flags?.archived === true;
    if (request.scope === 'active') return archived !== true;
    if (request.scope === 'archived') return archived === true;
    return false;
  });
  return { chosen, skipped: sessions.length - chosen.length, unknown_selected: [] };
}

/** Content address of one block: `objects/<aa>/<sha256>`. */
export function blockObjectPath(root, sha256) {
  return path.join(repoPaths(root).objects, sha256.slice(0, 2), sha256);
}

/**
 * Describe and write the blocks of one file.
 *
 * The bytes are read once: `sha256Hex` and `splitBlocks` need the same buffer, and the resulting description is
 * handed to `buildManifest` so the manifest does not re-read the file.
 *
 * ## A live session log may end mid-frame
 *
 * The DSH client appends zstd frames to a session log while it is being used, so a backup read can catch the file
 * between two writes. That is not corruption of the file, but the captured prefix would restore as a torn log --
 * so the container is checked with the same frame walker the repair path uses, and a torn tail is retried once
 * (the appending process usually finishes the frame in milliseconds). If it is still torn, the bytes are stored
 * anyway (a backup must not silently drop a session) and the session is reported in `torn_sessions` so the
 * operator and the next run know.
 *
 * @param {{root: string, file: string, dek: Buffer, dryRun: boolean, expectZstd?: boolean}} input
 * @returns {{description: object, blocks_new: number, blocks_reused: number, bytes_written: number, bytes_read: number,
 *   torn: boolean, container_error: string|null}}
 */
export function storeFileBlocks(input) {
  let buffer;
  try {
    buffer = fs.readFileSync(input.file);
  } catch (error) {
    return { error: { reason_code: ENGINE_CODES.WRITE_FAILED, detail: `${input.file}: ${error?.code ?? 'unreadable'}` } };
  }
  let torn = false;
  let containerError = null;
  if (input.expectZstd === true && buffer.length > 0) {
    const check = (candidate) => {
      try {
        return { tornStart: scanFrames(candidate).tornStart !== undefined, error: null };
      } catch (error) {
        return { tornStart: false, error: error instanceof Error ? error.message : String(error) };
      }
    };
    let verdict = check(buffer);
    if (verdict.tornStart) {
      // One short retry: a session log in the middle of an append is normally complete a few milliseconds later.
      const retry = fs.existsSync(input.file) ? safeRead(input.file) : null;
      if (retry !== null) {
        const second = check(retry);
        if (second.tornStart === false && second.error === null) {
          buffer = retry;
          verdict = second;
        }
      }
    }
    torn = verdict.tornStart;
    containerError = verdict.error;
  }
  const blocks = splitBlocks(buffer, BLOCK_BYTES);
  const description = { size: buffer.length, mtime_ms: safeMtime(input.file), sha256: sha256Hex(buffer), blocks };
  let blocksNew = 0;
  let blocksReused = 0;
  let bytesWritten = 0;
  for (const block of blocks) {
    const object = blockObjectPath(input.root, block.sha256);
    if (fs.existsSync(object)) {
      blocksReused += 1;
      continue;
    }
    if (input.dryRun) {
      blocksNew += 1;
      bytesWritten += block.length;
      continue;
    }
    const plaintext = buffer.subarray(block.offset, block.offset + block.length);
    const sealed = sealObject(plaintext, input.dek, { sha256: block.sha256, length: block.length });
    try {
      writeFileAtomic(object, sealed);
    } catch (error) {
      return { error: { reason_code: error?.code ?? ENGINE_CODES.WRITE_FAILED, detail: error?.detail ?? String(error?.message ?? error) } };
    }
    blocksNew += 1;
    bytesWritten += block.length;
  }
  // G3's simulation: the bytes are already in memory, so asking "would the next append still load?" costs one
  // extra decode and turns a silent problem into a reported one. It does not refuse the backup: preserving the
  // evidence is the point; restore is where a failing log is refused.
  const future = input.expectZstd === true && input.futureAppend !== false ? futureAppendVerdict(buffer) : null;
  // G5 runtime evidence: the appended log is decoded here, while the bytes are still in hand, and validated once
  // for all sessions after the loop. Only when the caller explicitly asked for runtime evidence.
  let runtimeArtifact;
  if (input.expectZstd === true && input.runtimeFutureAppend === true && input.dryRun !== true) {
    try {
      runtimeArtifact = buildArtifactFromBuffer(appendLegalEvent(buffer));
    } catch {
      runtimeArtifact = undefined;
    }
  }
  return {
    description,
    blocks_new: blocksNew,
    blocks_reused: blocksReused,
    bytes_written: bytesWritten,
    bytes_read: buffer.length,
    torn,
    container_error: containerError,
    future_append: future,
    runtime_artifact: runtimeArtifact,
  };
}

/** Read a file, or `null` when it cannot be read. */
function safeRead(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** `statSync().mtimeMs`, or the current time when it cannot be read (the file was already read successfully). */
function safeMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return Date.now();
  }
}

/**
 * Run one backup.
 *
 * @param {{
 *   root: string,
 *   dshHome: string,
 *   scope?: string,
 *   selected?: string[],
 *   password?: string|Buffer|null,
 *   platform?: string,
 *   runner?: Function,
 *   now?: Date,
 *   keepOldPerSession?: number,
 *   maxOldVersionDays?: number|null,
 *   mirrorRoot?: string|null,
 *   dryRun?: boolean,
 *   exclude_session_ids?: string[],
 *   scan?: typeof scanHome,
 * }} input
 * @returns {object} `{ok, reason_code?, detail?, ..., summary}` -- never throws for an expected refusal
 */
export function runBackup(input) {
  const started = Date.now();
  const root = path.resolve(input.root);
  const dshHome = path.resolve(input.dshHome);
  const now = input.now ?? new Date();
  const dryRun = input.dryRun === true;
  const keepOld = Number.isSafeInteger(input.keepOldPerSession) && input.keepOldPerSession >= 0
    ? input.keepOldPerSession
    : DEFAULT_KEEP_OLD;
  // The age half of the retention policy is validated before the lock, the layout and the key: an invalid
  // window would otherwise be discovered only after the snapshot was committed (inside rotation), which would
  // turn a configuration mistake into a reported rotation failure on an otherwise durable backup.
  const agePolicy = resolveMaxAgeDays(input.maxOldVersionDays);
  if (agePolicy.ok !== true) {
    return { ok: false, reason_code: agePolicy.reason_code, detail: agePolicy.detail, dry_run: dryRun };
  }
  const maxOldVersionDays = agePolicy.maxAgeDays;

  // The offsite mirror is validated here too: a mirror path that points inside the repository (or the home it
  // copies) is refused before ensureLayout/lock/commit, so a refused configuration leaves no snapshot behind.
  // A dry run never mirrors, so it needs no mirror validation.
  let mirrorRoot = null;
  if (dryRun !== true && typeof input.mirrorRoot === 'string' && input.mirrorRoot.trim() !== '') {
    const resolved = resolveMirrorRoot({ repoRoot: root, dshHome, mirrorRoot: input.mirrorRoot });
    if (resolved.ok !== true) {
      return { ok: false, reason_code: resolved.reason_code ?? MIRROR_CODES.INVALID, detail: resolved.detail, dry_run: false };
    }
    mirrorRoot = resolved.root;
  }

  const scope = normalizeScope({ scope: input.scope, selected: input.selected });
  if (scope.ok !== true) return { ok: false, reason_code: scope.reason_code, detail: scope.detail, dry_run: dryRun };

  let lock = null;
  try {
    const existed = fs.existsSync(repoPaths(root).descriptor);
    // A first run that has no credential path must not create the repository: the same no-permission rule the
    // keystore enforces, applied *before* the layout, so a refused run leaves no half-initialised directory.
    if (dryRun !== true && existed !== true) {
      const password = input.password ?? null;
      const hasPassword = Buffer.isBuffer(password) ? password.length > 0 : typeof password === 'string' && password.length > 0;
      const support = input.machineKey === false ? { available: false, reason: 'disabled-by-configuration' } : detectMachineKeySupport({ platform: input.platform, runner: input.runner });
      if (!hasPassword && support.available !== true) {
        return {
          ok: false,
          reason_code: ENGINE_CODES.NO_PERMISSION,
          detail: `no credential can protect a new backup on this machine: the OS keystore is unavailable (${support.reason ?? 'unknown'}) and no unlock password was supplied`,
          dry_run: false,
        };
      }
    }
    if (dryRun !== true) {
      try {
        ensureLayout(root, { dshHome, now });
      } catch (error) {
        if (error instanceof BackupLayoutError) return { ok: false, reason_code: error.code, detail: error.detail, dry_run: dryRun };
        throw error;
      }
      lock = withRepoLock({ root, now: () => now.getTime() });
      if (lock.ok !== true) return { ok: false, reason_code: lock.reason_code, detail: lock.detail, holder: lock.holder, dry_run: dryRun };
    }

    // A dry run never writes -- including no layout and no key -- so it needs neither the lock nor the credential.
    // It still reports what would be written, and block reuse is decided by object existence, which needs no key.
    const key = dryRun === true
      ? { ok: true, dek: null, keys: null, created: false, unlocked_via: 'dry-run', machine: { ok: false, reason: 'dry-run' }, machine_envelope_added: false }
      : openRepoKey({
          root,
          dshHome,
          password: input.password ?? null,
          platform: input.platform,
          runner: input.runner,
          machineKey: input.machineKey,
          now,
        });
    if (key.ok !== true) {
      return { ok: false, reason_code: key.reason_code, detail: key.detail, machine: key.machine, dry_run: dryRun };
    }

    const run = typeof input.scan === 'function' ? input.scan : scanHome;
    const scan = run({ dshHome });
    if (scan.exists !== true) {
      return { ok: false, reason_code: ENGINE_CODES.HOME_MISSING, detail: `${dshHome} does not exist`, dry_run: dryRun };
    }
    const excluded = new Set((input.exclude_session_ids ?? []).map(String));
    const candidates = scan.sessions.filter((row) => row.ok === true && !excluded.has(row.session_id));
    const selection = selectSessions(candidates, { scope: scope.scope, selected: scope.selected });
    if (selection.chosen.length === 0) {
      return {
        ok: false,
        reason_code: ENGINE_CODES.SCOPED_NOTHING,
        detail:
          scope.scope === 'selected'
            ? `none of the selected session ids exist in this home${selection.unknown_selected.length > 0 ? ` (unknown: ${selection.unknown_selected.join(', ')})` : ''}`
            : `scope "${scope.scope}" selected no session`,
        dry_run: dryRun,
        unknown_selected: selection.unknown_selected,
      };
    }

    // Fail fast on a rel path the manifest would reject: without this, a stray directory (a pre-restore copy area,
    // say) is written as blocks first and only then refused -- minutes of work for nothing, and a half-built
    // snapshot directory to clean up.
    for (const row of [...selection.chosen, ...scan.attachments.filter((attachment) => attachment.ok === true)]) {
      try {
        normalizeRelPath(row.rel);
      } catch (error) {
        return {
          ok: false,
          reason_code: error?.code ?? ENGINE_CODES.WRITE_FAILED,
          detail: `${row.file ?? row.rel}: the source path cannot be expressed as a manifest rel path: ${error?.detail ?? error?.message ?? error}`,
          dry_run: dryRun,
        };
      }
    }

    // The snapshot id is minted here, before any block is written, because block objects are content-addressed
    // (not snapshot-addressed) -- but the manifest and the rotation records both name it.
    const snapshotId = makeSnapshotId(now);
    const entries = [];
    const tornSessions = [];
    const invalidContainers = [];
    const futureAppend = { checked: 0, failed: 0, sessions: [], evidence: 'static-prefilter' };
    // G5 runtime evidence: appended logs are queued and validated once, at the end, by the installed Harness.
    const runtimeQueue = input.runtimeFutureAppend === true ? [] : null;
    let blocksNew = 0;
    let blocksReused = 0;
    let bytesWritten = 0;
    let bytesRead = 0;

    for (const session of selection.chosen) {
      const stored = storeFileBlocks({ root, file: session.file, dek: key.dek, dryRun, expectZstd: true, futureAppend: input.futureAppend, runtimeFutureAppend: input.runtimeFutureAppend });
      if (stored.error !== undefined) return { ok: false, ...stored.error, dry_run: dryRun };
      blocksNew += stored.blocks_new;
      blocksReused += stored.blocks_reused;
      bytesWritten += stored.bytes_written;
      bytesRead += stored.bytes_read;
      if (stored.torn) tornSessions.push(session.rel);
      if (stored.container_error !== null) invalidContainers.push({ rel: session.rel, detail: stored.container_error });
      if (stored.future_append !== null && stored.future_append !== undefined) {
        futureAppend.checked += 1;
        if (stored.future_append.ok !== true) {
          futureAppend.failed += 1;
          futureAppend.sessions.push({ rel: session.rel, codes: stored.future_append.codes });
        }
      }
      if (runtimeQueue !== null && stored.runtime_artifact !== undefined) {
        runtimeQueue.push({ rel: session.rel, artifact: stored.runtime_artifact });
      }
      entries.push({
        rel: session.rel,
        file: session.file,
        session_id: session.session_id,
        workspace: session.workspace,
        format_version: session.format_version,
        flags: session.flags ?? { registered: false, archived: false, pinned: false },
        description: stored.description,
        // Top-level copies for rotation: a `current/` pointer and an `old/` record store exactly these three
        // fields, and making them explicit here keeps rotation from having to know the manifest's nesting.
        sha256: stored.description.sha256,
        size: stored.description.size,
        blocks: stored.description.blocks,
      });
    }
    for (const attachment of scan.attachments.filter((row) => row.ok === true)) {
      const stored = storeFileBlocks({ root, file: attachment.file, dek: key.dek, dryRun, expectZstd: false });
      if (stored.error !== undefined) return { ok: false, ...stored.error, dry_run: dryRun };
      blocksNew += stored.blocks_new;
      blocksReused += stored.blocks_reused;
      bytesWritten += stored.bytes_written;
      bytesRead += stored.bytes_read;
      entries.push({
        rel: attachment.rel,
        file: attachment.file,
        attachment_id: attachment.attachment_id,
        description: stored.description,
      });
    }

    const sessionEntries = entries.filter((entry) => entry.session_id !== undefined);
    const attachmentEntries = entries.filter((entry) => entry.attachment_id !== undefined);
    const manifest = buildManifest({
      snapshotId,
      createdAt: now,
      dshHome,
      sessions: sessionEntries,
      attachments: attachmentEntries,
      registry: {
        workspaces: scan.registry.workspaces.length,
        registered: scan.registry.registered.size,
        archived: scan.registry.archived.size,
        pinned: scan.registry.pinned.size,
      },
      exclusions: scan.exclusions,
    });

    // G5: one runtime process validates every appended log. A failed measurement is reported, never turned into
    // a pass; a refused appended log is reported with the Harness's own detail.
    let runtimeFutureAppend = null;
    if (runtimeQueue !== null && runtimeQueue.length > 0) {
      const batch = runtimeValidateBatch({ artifacts: runtimeQueue.map((row) => row.artifact), env: input.env });
      const summary = { available: batch.available, evidence: 'installed-harness', checked: runtimeQueue.length, failed: 0, sessions: [] };
      for (const [index, row] of runtimeQueue.entries()) {
        const verdict = batch.verdicts[index] ?? { ok: false, detail: 'no verdict' };
        if (verdict.ok !== true) {
          summary.failed += 1;
          summary.sessions.push({ rel: row.rel, detail: verdict.detail });
        }
      }
      runtimeFutureAppend = summary;
    }

    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        snapshot_id: snapshotId,
        scope: scope.scope,
        sessions: selection.chosen.length,
        attachments: attachmentEntries.length,
        files: manifest.counts.files,
        bytes: manifest.counts.bytes,
        blocks_new: blocksNew,
        blocks_reused: blocksReused,
        bytes_written: bytesWritten,
        bytes_read: bytesRead,
        skipped_sessions: selection.skipped,
        unknown_selected: selection.unknown_selected,
        torn_sessions: tornSessions,
        invalid_containers: invalidContainers,
        future_append: futureAppend,
        runtime_future_append: runtimeFutureAppend,
        dedupe_ratio: blocksNew + blocksReused === 0 ? 0 : blocksReused / (blocksNew + blocksReused),
        key_upgraded: key.machine_envelope_added === true,
        keep_old_per_session: keepOld,
        max_old_version_days: maxOldVersionDays,
        duration_ms: Date.now() - started,
      };
    }

    const committed = commitSnapshot({ root, manifest, keys: key.keys });

    // Rotation happens after the commit, so a rotation failure must not read as "no backup happened".
    let rotations;
    try {
      rotations = sessionEntries.map((entry) => rotateForEntry({
        root,
        entry,
        snapshotId: committed.snapshot_id,
        keep: keepOld,
        maxAgeDays: maxOldVersionDays,
        now,
      }));
    } catch (error) {
      return {
        ok: false,
        reason_code: error?.code ?? ENGINE_CODES.WRITE_FAILED,
        detail: `the snapshot was committed but rotation failed (the previous version pointers were not updated): ${error?.detail ?? error?.message ?? String(error)}`,
        committed: true,
        snapshot_id: committed.snapshot_id,
        digest: committed.digest,
        sessions: selection.chosen.length,
        files: manifest.counts.files,
        dry_run: false,
        duration_ms: Date.now() - started,
      };
    }
    const rotated = rotations.filter((row) => row.rotated === true);

    // The offsite copy is strictly after the primary commit and rotation: it is a second, best-effort location,
    // never a precondition. A mirror failure is reported in the result and as a warning, but it does not roll
    // back (the primary backup is durable and correct) and it must never turn `ok` false or throw.
    let mirror = null;
    let mirrorWarnings = null;
    if (mirrorRoot !== null) {
      try {
        const synced = syncToMirror({ root, mirrorRoot, dshHome, snapshotId: committed.snapshot_id, now });
        mirror = {
          ok: true,
          root: synced.root,
          copied: synced.copied,
          skipped: synced.skipped,
          index_appended: synced.index_appended,
          descriptor_copied: synced.descriptor_copied,
        };
      } catch (error) {
        const reasonCode = error?.code ?? MIRROR_CODES.FAILED;
        mirror = {
          ok: false,
          reason_code: reasonCode,
          reason: error?.detail ?? (error instanceof Error ? error.message : String(error)),
          copied: error?.copied ?? { files: 0, bytes: 0 },
        };
        mirrorWarnings = [`${reasonCode}: the primary backup is committed, but the offsite copy failed: ${mirror.reason}`];
      }
    }

    return {
      ok: true,
      dry_run: false,
      snapshot_id: committed.snapshot_id,
      digest: committed.digest,
      scope: scope.scope,
      sessions: selection.chosen.length,
      attachments: attachmentEntries.length,
      files: manifest.counts.files,
      bytes: manifest.counts.bytes,
      blocks_new: blocksNew,
      blocks_reused: blocksReused,
      blocks_total: blocksNew + blocksReused,
      bytes_written: bytesWritten,
      bytes_read: bytesRead,
      skipped_sessions: selection.skipped,
      unknown_selected: selection.unknown_selected,
      torn_sessions: tornSessions,
      invalid_containers: invalidContainers,
      future_append: futureAppend,
      runtime_future_append: runtimeFutureAppend,
      dedupe_ratio: blocksNew + blocksReused === 0 ? 0 : blocksReused / (blocksNew + blocksReused),
      unlocked_via: key.unlocked_via,
      key_created: key.created,
      key_upgraded: key.machine_envelope_added === true,
      machine: { available: key.machine?.ok === true, reason: key.machine?.reason ?? null },
      keep_old_per_session: keepOld,
      max_old_version_days: maxOldVersionDays,
      rotated: rotated.length,
      old_versions: rotated.map((row) => row.old_file),
      // Absent unless a mirror is configured: a repository with no mirror keeps the exact result shape it had
      // before the offsite feature existed.
      ...(mirrorRoot === null ? {} : { mirror }),
      ...(mirrorWarnings === null ? {} : { warnings: mirrorWarnings }),
      duration_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      reason_code: error?.code ?? ENGINE_CODES.WRITE_FAILED,
      detail: error?.detail ?? (error instanceof Error ? error.message : String(error)),
      dry_run: dryRun,
    };
  } finally {
    if (lock !== null && lock.ok === true) lock.release();
  }
}
