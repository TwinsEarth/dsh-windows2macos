/**
 * The backup engine: scan, choose scope, write missing blocks, commit a snapshot, rotate superseded versions.
 *
 * ## The order the steps happen in, and why
 *
 *   1. **scan** -- read-only enumeration of the home, FIRST: the scope, the rel-path pre-check and the `full`
 *      whole-file copy cap are all derived from it, and a refusal derived from the scan must leave no state at all
 *      (not even a repository directory);
 *   2. **layout** -- create the repository on the first run;
 *   3. **lock** -- one writer, or none (see `locks.mjs`);
 *   4. **key** -- open or mint the repository DEK before writing anything, so a run cannot fail *after* it has
 *      already written blocks nobody can ever read;
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
 *     the home it copies, including through a symlink or junction (`BACKUP_MIRROR_INVALID` /
 *     `BACKUP_MIRROR_SYMLINK`) -- both before any write, so a configuration mistake leaves no half-built
 *     snapshot behind;
 *   * in `full` mode, a session file larger than the whole-file-copy cap without an explicit approval
 *     (`BACKUP_FULL_COPY_APPROVAL_REQUIRED`) -- also before any write, so the refusal is a clean pending state.
 *
 * ## The offsite mirror is best effort, and strictly after the primary
 *
 * When a mirror is configured, `runBackup` copies the committed snapshot's sealed blocks and metadata to it after
 * the commit and rotation succeed. A mirror failure is reported as `mirror.ok: false` plus a warning on an
 * `ok: true` result: the primary backup is durable and correct, and a second copy that failed must not downgrade
 * it. With no mirror configured the result shape is unchanged (no `mirror` key).
 *
 * ## `oldFormat` decides what a superseded version costs
 *
 * `oldFormat: 'records'` (the default) keeps the deduplicated version record only. `oldFormat: 'full'` also
 * writes one sealed whole-file copy per rotated version (see `rotation.mjs`), which doubles the bytes of every
 * superseded version on top of the blocks it already references -- the cost the default exists to avoid, so it
 * is opt-in. The option is validated before the lock, the layout and the key, like the retention window and the
 * mirror: a typo is a configuration mistake and must not surface after a committed snapshot. In `full` mode the
 * DEK is handed to rotation, which rebuilds the superseded bytes from their blocks and seals them; a copy that
 * cannot be written refuses the rotation (`BACKUP_ROTATION_WRITE_FAILED`) rather than recording a copy that is
 * not there, and the already-committed snapshot is reported with `committed: true` exactly as any rotation
 * failure is.
 *
 * Every refusal is a `{ok:false, reason_code, detail}` result, not an exception: the route and the CLI print the
 * same refusal, and a scheduled run logs it instead of tearing the timer down.
 *
 * ## The `full` whole-file copy cap (`maxFullCopyBytes`, default 300 MiB)
 *
 * `oldFormat: 'full'` writes one sealed whole-file copy per superseded version, so a single huge session would
 * silently double its bytes on every change. The run therefore scans the sessions it would back up **before the
 * repository is laid out, locked or opened**, and refuses with `BACKUP_FULL_COPY_APPROVAL_REQUIRED` when any
 * session file is larger than the cap and the run was not explicitly approved (`allowLargeFullCopy: true`). The
 * refusal is complete and leaves the repository untouched -- nothing is committed and no partial state is written,
 * which is what makes "refused, awaiting approval" a safe state for an unattended schedule slot. An approved run
 * records the approval twice: `full_copy_approved_over_cap: [{session_id, size}]` in the result, and
 * `full_copy.approved_over_cap: true` + `full_copy.cap_bytes` on the version record it wrote. `maxFullCopyBytes: 0`
 * disables the cap explicitly (documented, never the default); `records` mode ignores it because it writes no
 * whole-file copy at all.
 *
 * ## The size of `old/` is not capped: it is measured, and a growth reminder is reported (v3.5.0, §24.3)
 *
 * The user's decision is explicit: **no total limit on `old/`; remind every 10 GB and let the user decide whether
 * to clean up manually.** The per-session keep window and the per-full-copy cap are untouched; what this run adds
 * is one read-only walk of `old/` after rotation (the point where `old/` is final) whose result is reported as
 * `old_usage: {bytes, files, reminder_bytes, due, since_last_ack_bytes, next_reminder_at_bytes}`. The reminder is
 * **growth since the last acknowledgement** (`oldUsageAckBytes`), not a fixed 10/20/30 ladder: the plugin persists
 * the ack mark when the operator clicks 「知道了」, and `due` is `reminder_bytes > 0 && bytes - ack >= reminder`.
 * When it is due the warning is added to `warnings`, and **nothing is deleted**: the walk only reads directory
 * entries and file sizes, the engine has no cleanup path for it, and manual cleanup is the operator's
 * `w2m-backup gc` (which is also the thing the reminder points at). `oldUsageReminderBytes: 0` disables `due`;
 * an invalid value is refused before the scan/layout/lock/key like every other policy option.
 */

import fs from 'node:fs';
import path from 'node:path';

import { BackupLayoutError, descriptorEncryption, ensureLayout, readDescriptor, repoPaths } from './layout.mjs';
import { buildManifest, normalizeRelPath, sha256Hex, splitBlocks } from './manifest.mjs';
import { sealObject } from './crypto.mjs';
import { writeFileAtomic } from './atomic.mjs';
import { withRepoLock } from './locks.mjs';
import { openRepoKey, bindAccount, resolveEncryptionMode } from './keystore.mjs';
import { detectMachineKeySupport } from './machine-key.mjs';
import { appendLegalEvent, futureAppendVerdict } from './future-append.mjs';
import { buildArtifactFromBuffer, runtimeValidateBatch } from './runtime-validate.mjs';
import { scanHome } from './scan.mjs';
import { SECRETS_WARNING, collectScopeFiles, resolveBackupScopes } from './scopes.mjs';
import { DEFAULT_KEEP_OLD, buildOldUsageReport, measureOldUsage, oldUsageReminderWarning, resolveMaxAgeDays, resolveMaxFullCopyBytes, resolveOldFormat, resolveOldUsageReminderBytes, rotateForEntry } from './rotation.mjs';
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
  /** `oldFormat: 'full'`: a whole-file copy would exceed `maxFullCopyBytes` and was not explicitly approved. */
  FULL_COPY_APPROVAL_REQUIRED: 'BACKUP_FULL_COPY_APPROVAL_REQUIRED',
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
 *   accountId?: string|null,
 *   password?: string|Buffer|null,
 *   platform?: string,
 *   runner?: Function,
 *   now?: Date,
 *   keepOldPerSession?: number,
 *   maxOldVersionDays?: number|null,
 *   oldFormat?: 'records'|'full',
 *   maxFullCopyBytes?: number,
 *   allowLargeFullCopy?: boolean,
 *   oldUsageReminderBytes?: number,
 *   oldUsageAckBytes?: number,
 *   mirrorRoot?: string|null,
 *   dryRun?: boolean,
 *   exclude_session_ids?: string[],
 *   scopes?: string[],
 *   includeSecrets?: boolean,
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
  // The `old/` shape is validated here for the same reason as the retention window: `full` changes what rotation
  // writes, and an unknown value must be refused before the lock/layout/key rather than discovered after commit.
  const formatPolicy = resolveOldFormat(input.oldFormat);
  if (formatPolicy.ok !== true) {
    return { ok: false, reason_code: formatPolicy.reason_code, detail: formatPolicy.detail, dry_run: dryRun };
  }
  const oldFormat = formatPolicy.format;
  // The `full` whole-file copy cap is a policy value, so it is validated with the rest of them: before the scan,
  // the layout, the lock and the key. A refused run therefore writes nothing at all.
  const capPolicy = resolveMaxFullCopyBytes(input.maxFullCopyBytes);
  if (capPolicy.ok !== true) {
    return { ok: false, reason_code: capPolicy.reason_code, detail: capPolicy.detail, dry_run: dryRun };
  }
  const maxFullCopyBytes = capPolicy.maxBytes;
  // The `old/` usage reminder is a policy value like the cap: validated before the scan, the layout, the lock and
  // the key, so a typo is refused without leaving a repository behind. `0` disables only the reminder, never the
  // measurement: the run still reports how big `old/` is.
  const reminderPolicy = resolveOldUsageReminderBytes(input.oldUsageReminderBytes);
  if (reminderPolicy.ok !== true) {
    return { ok: false, reason_code: reminderPolicy.reason_code, detail: reminderPolicy.detail, dry_run: dryRun };
  }
  const oldUsageReminderBytes = reminderPolicy.reminderBytes;
  // The acknowledgement mark is state, not policy: a corrupt value (a missing/corrupt plugin state file) is read as
  // 0 so the failure mode is an extra reminder, never a suppressed one. It is never written by the engine.
  const oldUsageAckBytes = Number.isSafeInteger(input.oldUsageAckBytes) && input.oldUsageAckBytes >= 0
    ? input.oldUsageAckBytes
    : 0;
  // Only the exact boolean counts: `allowLargeFullCopy: 1` / `"yes"` is a caller bug, not an approval. An approval
  // is a deliberate act by the operator, never something inferred from a truthy value.
  const allowLargeFullCopy = input.allowLargeFullCopy === true;
  // The expanded scope set. Absent means "all six" (the approved default); an unknown name is a configuration
  // mistake and must be refused before the lock/layout/key, exactly like the retention policy above.
  const scopePolicy = resolveBackupScopes(input.scopes);
  if (scopePolicy.ok !== true) return { ok: false, reason_code: scopePolicy.reason_code, detail: scopePolicy.detail, dry_run: dryRun };
  const selectedScopes = new Set(scopePolicy.scopes);
  // The P1 credential opt-in. Only the exact boolean `true` includes credentials: `backupIncludeSecrets: 1` is a
  // caller bug, not consent.
  const includeSecrets = input.includeSecrets === true;

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
    // The protection mode is validated here, like the retention window and the mirror: an invalid
    // `encryption` value, or an explicit `none` combined with a password, is a configuration mistake and must
    // be refused before the lock/layout/key -- not discovered after blocks were written.
    const modePolicy = resolveEncryptionMode({
      encryption: input.encryption,
      password: input.password,
      machineKey: input.machineKey,
      accountId: input.accountId,
    });
    if (modePolicy.ok !== true) return { ok: false, reason_code: modePolicy.reason_code, detail: modePolicy.detail, dry_run: dryRun };
    // A descriptor that already says `sealed` is never silently downgraded on first use (a half-initialised
    // sealed repository must not become unencrypted because this run carried no credential).
    let creationMode = modePolicy.mode;
    if (input.encryption === undefined && existed === true) {
      try {
        const descriptor = readDescriptor(root);
        if (descriptorEncryption(descriptor) === 'sealed') creationMode = 'sealed';
      } catch {
        creationMode = 'sealed';
      }
    }
    // A first run that asks for protection but has no credential path must not create the repository: the same
    // no-permission rule the keystore enforces, applied *before* the layout, so a refused run leaves no
    // half-initialised directory. The default `none` mode needs no credential by design and is never refused.
    if (dryRun !== true && existed !== true && creationMode === 'sealed') {
      const password = input.password ?? null;
      const hasPassword = Buffer.isBuffer(password) ? password.length > 0 : typeof password === 'string' && password.length > 0;
      const support = input.machineKey === false ? { available: false, reason: 'disabled-by-configuration' } : detectMachineKeySupport({ platform: input.platform, runner: input.runner });
      if (!hasPassword && support.available !== true) {
        return {
          ok: false,
          reason_code: ENGINE_CODES.NO_PERMISSION,
          detail: `encryption "sealed" was requested, but no credential can protect a new backup on this machine: the OS keystore is unavailable (${support.reason ?? 'unknown'}) and no unlock PIN/password was supplied`,
          dry_run: false,
        };
      }
    }
    // The scan is READ-ONLY and therefore runs before the layout/lock/key: the scope selection, the rel-path
    // fail-fast and the `full` copy cap are all derived from it, and a refusal derived from it must leave the
    // repository exactly as it was -- not even created. (The scan never writes; see scan.mjs.)
    const run = typeof input.scan === 'function' ? input.scan : scanHome;
    const scan = run({ dshHome });
    if (scan.exists !== true) {
      return { ok: false, reason_code: ENGINE_CODES.HOME_MISSING, detail: `${dshHome} does not exist`, dry_run: dryRun };
    }
    // The expanded scopes are collected read-only, before the layout/lock/key: an over-cap refusal (or an unknown
    // scope) therefore leaves the repository exactly as it was, not even created. `excludeRoots` is the
    // self-reference guard: the repository root itself (before or after it exists) is never a backup candidate, so
    // a misconfigured `backupDir` inside the home cannot make the backup copy its own repository.
    const scopeSkipped = [];
    const collected = collectScopeFiles({ dshHome, scopes: scopePolicy.scopes, includeSecrets, excludeRoots: [root] });
    if (collected.ok !== true) return { ok: false, reason_code: collected.reason_code, detail: collected.detail, dry_run: dryRun };
    for (const row of collected.skipped) scopeSkipped.push(row);
    if (!selectedScopes.has('sessions')) {
      scopeSkipped.push({ rel: 'sessions', reason: 'scope "sessions" not selected for this run', class: 'not-in-scope' });
    }
    if (!selectedScopes.has('attachments')) {
      scopeSkipped.push({ rel: 'attachments', reason: 'scope "attachments" not selected for this run', class: 'not-in-scope' });
    }
    const excluded = new Set((input.exclude_session_ids ?? []).map(String));
    const candidates = selectedScopes.has('sessions')
      ? scan.sessions.filter((row) => row.ok === true && !excluded.has(row.session_id))
      : [];
    const selection = selectedScopes.has('sessions')
      ? selectSessions(candidates, { scope: scope.scope, selected: scope.selected })
      : { chosen: [], skipped: scan.sessions.length, unknown_selected: [] };
    if (selectedScopes.has('sessions') && selection.chosen.length === 0) {
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
    if (selection.chosen.length === 0 && collected.files.length === 0) {
      return {
        ok: false,
        reason_code: ENGINE_CODES.SCOPED_NOTHING,
        detail: `the selected scopes (${[...selectedScopes].join(', ') || 'none'}) captured no file in ${dshHome}`,
        dry_run: dryRun,
        scopes: [...scopePolicy.scopes],
        scope_skipped: scopeSkipped,
      };
    }
    const attachmentsToStore = selectedScopes.has('attachments') ? scan.attachments.filter((attachment) => attachment.ok === true) : [];

    // Fail fast on a rel path the manifest would reject: without this, a stray directory (a pre-restore copy area,
    // say) is written as blocks first and only then refused -- minutes of work for nothing, and a half-built
    // snapshot directory to clean up.
    for (const row of [...selection.chosen, ...attachmentsToStore, ...collected.files]) {
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

    // `full` doubles a superseded version's bytes, so a run that would write a whole-file copy larger than the cap
    // refuses BEFORE any write unless the operator explicitly approved this run. The scan's `size` is the size of
    // the version on disk right now -- exactly the version that becomes the old record -- so the decision needs no
    // repository read and cannot drift from what rotation will later copy. `records` mode writes no whole-file copy
    // and therefore ignores the cap; `maxFullCopyBytes: 0` disables it explicitly.
    const oversizedSessions =
      oldFormat === 'full' && maxFullCopyBytes > 0
        ? selection.chosen.filter((row) => Number.isSafeInteger(row.size) && row.size > maxFullCopyBytes)
        : [];
    if (oversizedSessions.length > 0 && allowLargeFullCopy !== true) {
      const listed = oversizedSessions.slice(0, 20).map((row) => ({
        session_id: row.session_id,
        rel: row.rel,
        size: row.size,
        cap: maxFullCopyBytes,
      }));
      const described = listed.map((row) => `${row.session_id} (${row.rel}): ${row.size} bytes > cap ${row.cap} bytes`).join('; ');
      return {
        ok: false,
        reason_code: ENGINE_CODES.FULL_COPY_APPROVAL_REQUIRED,
        codes: [ENGINE_CODES.FULL_COPY_APPROVAL_REQUIRED],
        detail:
          `${oversizedSessions.length} session(s) would get an old-format "full" whole-file copy larger than the ` +
          `${maxFullCopyBytes}-byte cap; nothing was written. Re-run with an explicit approval ` +
          `(allowLargeFullCopy: true / --allow-large-full-copy) to write them: ${described}` +
          `${oversizedSessions.length > listed.length ? `; … ${oversizedSessions.length - listed.length} more` : ''}`,
        full_copy_oversized: listed,
        over_cap_count: oversizedSessions.length,
        cap_bytes: maxFullCopyBytes,
        dry_run: dryRun,
      };
    }
    const approvedOverCapIds = new Set(
      oversizedSessions.map((row) => row.session_id),
    );

    if (dryRun !== true) {
      try {
        ensureLayout(root, { dshHome, now, encryption: input.encryption === undefined && existed === true ? undefined : creationMode });
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
      ? { ok: true, dek: null, keys: null, created: false, unlocked_via: 'dry-run', encryption: null, available_paths: [], machine: { ok: false, reason: 'dry-run' }, machine_envelope_added: false }
      : openRepoKey({
          root,
          dshHome,
          accountId: input.accountId ?? null,
          password: input.password ?? null,
          encryption: input.encryption,
          platform: input.platform,
          runner: input.runner,
          machineKey: input.machineKey,
          now,
        });
    if (key.ok !== true) {
      return { ok: false, reason_code: key.reason_code, detail: key.detail, machine: key.machine, dry_run: dryRun };
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
    for (const attachment of attachmentsToStore) {
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
    // The expanded P0/P1/P3 files (registry/config/state and the restore copies). They are ordinary
    // content-addressed blocks too; only the manifest entry differs (`kind`/`scope`/`reason`). No future-append
    // simulation and no rotation: they are not session logs.
    for (const extra of collected.files) {
      const stored = storeFileBlocks({ root, file: extra.file, dek: key.dek, dryRun, expectZstd: false });
      if (stored.error !== undefined) return { ok: false, ...stored.error, dry_run: dryRun };
      blocksNew += stored.blocks_new;
      blocksReused += stored.blocks_reused;
      bytesWritten += stored.bytes_written;
      bytesRead += stored.bytes_read;
      entries.push({
        rel: extra.rel,
        file: extra.file,
        kind: extra.kind,
        scope: extra.scope,
        reason: extra.reason,
        description: stored.description,
      });
    }

    // Rotation: session entries only. The expanded scope files are state, not versioned logs, and rotating one
    // would record a `current/` pointer for a file the restore path does not read (and could delete the live state).
    const sessionEntries = entries.filter((entry) => entry.kind === undefined && entry.session_id !== undefined);
    const attachmentEntries = entries.filter((entry) => entry.attachment_id !== undefined);
    const extraEntries = entries.filter((entry) => entry.kind === 'registry' || entry.kind === 'config' || entry.kind === 'state' || entry.kind === 'restore-copy');
    const manifest = buildManifest({
      snapshotId,
      createdAt: now,
      dshHome,
      sessions: sessionEntries,
      attachments: attachmentEntries,
      extraFiles: extraEntries,
      scopes: scopePolicy.scopes,
      secretsIncluded: includeSecrets,
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
      // A dry run writes nothing, but `old/` that already exists is a read fact: measuring it answers "how big is
      // the old-version tree now, and would the reminder be due" without writing a byte. No warning is emitted
      // here because a dry run has no `warnings` list; the CLI prints the `old_usage` line from the result.
      const measuredOld = measureOldUsage(root);
      const oldUsage = buildOldUsageReport({
        ...measuredOld,
        ackBytes: oldUsageAckBytes,
        reminderBytes: oldUsageReminderBytes,
      });
      return {
        ok: true,
        dry_run: true,
        snapshot_id: snapshotId,
        scope: scope.scope,
        scopes: [...scopePolicy.scopes],
        sessions: selection.chosen.length,
        attachments: attachmentEntries.length,
        files: manifest.counts.files,
        bytes: manifest.counts.bytes,
        counts_by_scope: manifest.counts_by_scope,
        secrets_included: includeSecrets,
        scope_skipped: scopeSkipped,
        ...(includeSecrets ? { warnings: [SECRETS_WARNING] } : {}),
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
        encryption: key.encryption ?? null,
        available_paths: key.available_paths ?? [],
        keep_old_per_session: keepOld,
        max_old_version_days: maxOldVersionDays,
        old_format: oldFormat,
        old_usage: oldUsage,
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
        // `full` needs the DEK to seal the whole-file copy; `records` ignores it. Passing it unconditionally keeps
        // the call site from having two shapes that could drift apart.
        format: oldFormat,
        dek: key.dek,
        // Only a session the pre-write check found over the cap carries the approval onto its record: the approval
        // is tied to the bytes that triggered it, not to the whole run.
        approvedOverCap: approvedOverCapIds.has(entry.session_id),
        capBytes: maxFullCopyBytes,
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
    // `old/` is final now (this run's records and sealed copies are written, the per-session window is pruned), so
    // this is the one point where the measurement describes what the repository actually keeps. One read-only walk;
    // the report compares it with the persisted acknowledgement mark and never deletes anything.
    const measuredOld = measureOldUsage(root);
    const oldUsage = buildOldUsageReport({
      ...measuredOld,
      ackBytes: oldUsageAckBytes,
      reminderBytes: oldUsageReminderBytes,
    });
    // The sealed whole-file copies, in rotation order. Only `full` mode produces them, and the key is only added
    // in that mode so a default run keeps exactly the result shape it had before this option existed.
    const fullOldVersions = rotated.map((row) => row.full_copy?.file).filter((file) => typeof file === 'string');
    // The sessions whose over-cap copy this run was explicitly allowed to write. Present only when an approval
    // actually covered something; a `full` run that stayed under the cap keeps the shape it had before the cap.
    const approvedOverCap = oldFormat === 'full' && allowLargeFullCopy === true
      ? selection.chosen
          .filter((row) => approvedOverCapIds.has(row.session_id))
          .map((row) => ({ session_id: row.session_id, size: row.size }))
      : [];

    // Account binding is best effort and strictly after the committed snapshot. It only makes sense for a
    // **sealed** repository: an unencrypted repository opens without any credential, so binding it to an
    // account would silently turn the default `none` mode back into `sealed` after the first run (and the
    // requirement is that `none` stays `none` until the operator asks otherwise).
    const warnings = [];
    // P1: a run that includes credentials must be impossible to mistake for a safe one. The warning is part of the
    // result, not only the CLI text, so the panel and the operation log carry it too.
    if (includeSecrets) warnings.push(SECRETS_WARNING);
    // The usage reminder is a warning, not a limit: the run is `ok`, the snapshot is committed, and the line is the
    // operator's cue to clean up manually (`w2m-backup gc`) or acknowledge in the panel.
    if (oldUsage.due) warnings.push(oldUsageReminderWarning(oldUsage));
    let accountBinding = null;
    if (key.encryption !== 'none' && typeof input.accountId === 'string' && input.accountId.trim() !== '') {
      try {
        const bound = bindAccount({
          root,
          dshHome,
          accountId: input.accountId,
          password: input.password ?? null,
          platform: input.platform,
          runner: input.runner,
          machineKey: input.machineKey,
          now,
        });
        accountBinding = {
          bound: bound.account?.bound === true,
          added: bound.added === true,
          id_hint: bound.account?.id_hint ?? null,
          ...(bound.ok === true ? {} : { reason_code: bound.reason_code }),
        };
        if (bound.ok !== true) {
          warnings.push(`${String(bound.reason_code ?? 'BACKUP_ACCOUNT_BIND_FAILED')}: the snapshot is committed, but the account id was not bound: ${String(bound.detail ?? '')}`.trimEnd());
        }
      } catch (error) {
        warnings.push(
          `${String(error?.code ?? 'BACKUP_ACCOUNT_BIND_FAILED')}: the snapshot is committed, but the account id was not bound: ` +
            `${String(error?.detail ?? (error instanceof Error ? error.message : error))}`,
        );
      }
    }

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
          copied: error?.copied ?? { files: 0, bytes: 0, repaired: 0, old_files: 0, old_bytes: 0 },
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
      scopes: [...scopePolicy.scopes],
      sessions: selection.chosen.length,
      attachments: attachmentEntries.length,
      files: manifest.counts.files,
      bytes: manifest.counts.bytes,
      counts_by_scope: manifest.counts_by_scope,
      secrets_included: includeSecrets,
      scope_skipped: scopeSkipped,
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
      encryption: key.encryption ?? null,
      available_paths: key.available_paths ?? [],
      key_created: key.created,
      key_upgraded: key.machine_envelope_added === true,
      machine: { available: key.machine?.ok === true, reason: key.machine?.reason ?? null },
      keep_old_per_session: keepOld,
      max_old_version_days: maxOldVersionDays,
      old_format: oldFormat,
      old_usage: oldUsage,
      rotated: rotated.length,
      old_versions: rotated.map((row) => row.old_file),
      ...(oldFormat === 'full' ? { full_old_versions: fullOldVersions } : {}),
      ...(approvedOverCap.length === 0 ? {} : { full_copy_approved_over_cap: approvedOverCap }),
      // Absent unless a mirror is configured: a repository with no mirror keeps the exact result shape it had
      // before the offsite feature existed.
      ...(mirrorRoot === null ? {} : { mirror }),
      ...(accountBinding === null ? {} : { account_binding: accountBinding }),
      ...(warnings.length + (mirrorWarnings?.length ?? 0) === 0 ? {} : { warnings: [...warnings, ...(mirrorWarnings ?? [])] }),
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
