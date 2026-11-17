/**
 * Restore: publish snapshot bytes back into the live DSH home.
 *
 * ## The four gates (from `docs/RETRO-SESSION-RECOVERY-20261117.md`), and where they live
 *
 *   * **G1** a restored candidate must pass session-doctor *before* it is published, or nothing is published;
 *   * **G2** the workspace registry is client-owned state: plan once for the whole restore, write atomically,
 *     read back, and report the residual risk (`registry.mjs`);
 *   * **G3** only original bytes are written -- never a hand-authored event -- and the log plus one legal appended
 *     event must both be accepted by the runtime (`validateCandidates` with `appendCheck`);
 *   * **G5** confirmation is the installed Harness's own validator (`runtime-validate.mjs`), not our parser.
 *
 * ## The order of operations, which is the whole safety story
 *
 *   plan (decode + validate + conflict + registry plan, **no writes**)
 *   -> apply: pre-restore copy of everything that will be touched
 *   -> write session files atomically (identical ones are skipped, not rewritten)
 *   -> write attachment objects
 *   -> registry write + read-back verification
 *   -> re-read every written file and compare its digest to the plan
 *   -> prune old pre-restore copies (keep the newest N)
 *
 * If any step fails after the pre-restore copy exists, the copy is the way back and the report says how.
 *
 * ## Two sources
 *
 * `planRestore` reads from a repository snapshot; `planRestoreFromArchive` reads the same shape out of a
 * `.tar.zst` archive. The plan/apply pipeline is shared: an archive is a second way to carry backup bytes, not a
 * second restore implementation.
 */

import fs from 'node:fs';
import path from 'node:path';

import { openRepo, readSnapshot } from './repo.mjs';
import { openRepoKey } from './keystore.mjs';
import { rebuildFile } from './materialize.mjs';
import { writeFileAtomic } from './atomic.mjs';
import { sha256Hex } from './manifest.mjs';
import { applyRegistryRestore, planRegistryRestores, workspaceRegistryPath, workspaceSlug } from './registry.mjs';
import { readArchive } from './archive.mjs';
import { validateCandidates } from './runtime-validate.mjs';
import { clientGate } from './client.mjs';
import { isInside, resolveBackupScopes } from './scopes.mjs';
import { scanFrames } from '../fix/zstd.mjs';
import { diagnoseSessionBuffer } from '../util/session-validate.mjs';

/** Named restore refusals. */
export const RESTORE_CODES = Object.freeze({
  NOT_INITIALIZED: 'BACKUP_REPO_NOT_INITIALIZED',
  NO_PERMISSION: 'BACKUP_NO_PERMISSION',
  NO_SNAPSHOT: 'BACKUP_REPO_SNAPSHOT_MISSING',
  NO_SESSION: 'BACKUP_RESTORE_NO_SESSION',
  CANDIDATE_INVALID: 'BACKUP_CANDIDATE_INVALID',
  RUNTIME_UNAVAILABLE: 'BACKUP_RUNTIME_UNAVAILABLE',
  RUNTIME_REJECTED: 'BACKUP_RUNTIME_REJECTED',
  REGISTRY_FAILED: 'BACKUP_REGISTRY_WRITE_FAILED',
  ATTACHMENT_CONFLICT: 'BACKUP_ATTACHMENT_CONFLICT',
  WRITE_FAILED: 'BACKUP_WRITE_FAILED',
  VERIFY_FAILED: 'BACKUP_RESTORE_VERIFY_FAILED',
  TARGET_CHANGED: 'BACKUP_RESTORE_TARGET_CHANGED',
  ARCHIVE_UNREADABLE: 'BACKUP_ARCHIVE_UNREADABLE',
  REGISTRY_INVALID: 'BACKUP_RESTORE_REGISTRY_INVALID',
  TARGET_ESCAPE: 'BACKUP_RESTORE_TARGET_ESCAPE',
  SCOPE_UNKNOWN: 'BACKUP_SCOPE_UNKNOWN',
});

/** How many pre-restore copies are kept by default. */
export const DEFAULT_KEEP_PRE_RESTORE = 10;

/**
 * The directory (inside `$DSH_HOME`) that holds pre-restore copies.
 *
 * It lives at the home root, not under `sessions/`: anything under `sessions/` looks like a session workspace to a
 * recursive walker, and the first real run after a restore picked these copies up and produced an invalid manifest
 * rel path (the restore-backup copies were treated as 17th/18th sessions). A dot-directory at the home root is
 * outside every scan root, and the session walker skips dot-directories as a second line of defence.
 */
export function preRestoreRoot(dshHome) {
  return path.join(dshHome, '.w2m-restore-backups');
}

/** `<root>/<compact timestamp>` for one restore. */
function preRestoreDir(dshHome, now) {
  const compact = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return path.join(preRestoreRoot(dshHome), compact);
}

/** The session dir inside a home: `sessions/<workspace>/<session-id>/<log filename>`. */
export function sessionTargetPath(dshHome, entry) {
  const rel = String(entry.rel).replace(/\\/g, '/');
  return path.join(dshHome, ...rel.split('/'));
}

/** Entries of the snapshot, split the way a restore treats them. */
/**
 * G2's pause half, applied before any bytes are decrypted or written.
 *
 * Runs only when the caller opted in: the offline CLI passes `clientCheck` (and `--allow-live-home` to accept the
 * read-back + post-save protocol), the panel passes `allowLiveHome: true` because the client is by definition
 * running inside it. Tests and library callers that pass neither are not silently gated.
 *
 * @param {object} input
 * @returns {{ok: true, detail: string} | {ok: false, reason_code: string, detail: string}}
 */
function gateClient(input) {
  if (typeof input.clientCheck !== 'function' && input.allowLiveHome !== false) return { ok: true, detail: 'client gate not requested' };
  const gate = clientGate({
    allowLiveHome: input.allowLiveHome === true,
    check: typeof input.clientCheck === 'function' ? input.clientCheck : undefined,
    platform: input.platform,
    runner: input.runner,
  });
  return gate;
}

/**
 * Entries of the snapshot, split the way a restore treats them.
 *
 * @param {object} snapshot
 * @param {Set<string>|null} wanted session ids, or null for every session
 * @param {Set<string>} scopes the restore's selected scopes (default: all present)
 * @returns {{sessions: Array<object>, attachments: Array<object>, extras: Array<object>, registryEntry: object|null}}
 */
function itemsFromSnapshot(snapshot, wanted, scopes) {
  const files = snapshot.manifest.files;
  const sessions = scopes.has('sessions')
    ? files.filter((entry) => entry.kind === 'session' && (wanted === null || wanted.has(entry.session_id)))
    : [];
  const attachments = scopes.has('attachments') ? files.filter((entry) => entry.kind === 'attachment') : [];
  const extras = files.filter((entry) => entry.kind === 'registry' || entry.kind === 'config' || entry.kind === 'state')
    .filter((entry) => scopes.has(entry.kind));
  const registryEntry = extras.find((entry) => entry.kind === 'registry' && entry.rel === 'storages/workspace.json') ?? null;
  return { sessions, attachments, extras, registryEntry };
}

/** Resolve a restore's scope filter (absent = every scope present in the snapshot). */
function restoreScopes(value) {
  return resolveBackupScopes(value);
}

/** The target path of an extra (config/state) entry, refused when it would escape the home. */
function extraTargetPath(dshHome, entry) {
  const target = path.join(dshHome, ...String(entry.rel).replace(/\\/g, '/').split('/'));
  if (!isInside(dshHome, target)) return { ok: false, target };
  return { ok: true, target };
}

/**
 * Plan one restore from a repository snapshot: no writes, all decisions.
 *
 * @param {{
 *   root: string, dshHome: string, snapshotId?: string|null, sessionIds?: string[],
 *   accountId?: string|null, password?: string|Buffer|null, machineKey?: boolean, platform?: string, runner?: Function,
 *   allowStaticValidation?: boolean, requireFutureAppend?: boolean, workspacePath?: string|null,
 *   keepBoth?: boolean, keepPreRestore?: number, now?: Date, harness?: object|null,
 *   env?: Record<string, string|undefined>,
 * }} input
 * @returns {object} a plan -- `ok:false` carries `reason_code`/`detail`
 */
export function planRestore(input) {
  const now = input.now ?? new Date();
  const state = openRepo({ root: input.root, dshHome: input.dshHome });
  if (state.initialized !== true) {
    return { ok: false, reason_code: RESTORE_CODES.NOT_INITIALIZED, detail: state.error?.detail ?? 'the repository is not initialised' };
  }
  const gate = gateClient(input);
  if (gate.ok !== true) return { ok: false, reason_code: gate.reason_code, detail: gate.detail, client: gate.detection ?? null };

  const key = openRepoKey({
    root: input.root,
    dshHome: input.dshHome,
    accountId: input.accountId ?? null,
    password: input.password ?? null,
    machineKey: input.machineKey,
    platform: input.platform,
    runner: input.runner,
  });
  if (key.ok !== true) return { ok: false, reason_code: RESTORE_CODES.NO_PERMISSION, detail: key.detail };

  const snapshotId = input.snapshotId ?? state.latest?.snapshot_id ?? null;
  if (snapshotId === null) return { ok: false, reason_code: RESTORE_CODES.NO_SNAPSHOT, detail: 'the repository has no valid snapshot yet' };
  let snapshot;
  try {
    snapshot = readSnapshot({ root: input.root, snapshotId });
  } catch (error) {
    return { ok: false, reason_code: RESTORE_CODES.NO_SNAPSHOT, detail: error?.detail ?? String(error?.message ?? error) };
  }
  const scopePolicy = restoreScopes(input.scopes);
  if (scopePolicy.ok !== true) return { ok: false, reason_code: RESTORE_CODES.SCOPE_UNKNOWN, detail: scopePolicy.detail };
  const scopes = new Set(scopePolicy.scopes);
  const wanted = Array.isArray(input.sessionIds) && input.sessionIds.length > 0 ? new Set(input.sessionIds.map(String)) : null;
  const { sessions, attachments, extras } = itemsFromSnapshot(snapshot, wanted, scopes);
  if (sessions.length === 0 && scopes.has('sessions')) {
    return {
      ok: false,
      reason_code: RESTORE_CODES.NO_SESSION,
      detail: wanted === null ? `snapshot ${snapshotId} contains no session` : `none of the requested session(s) are in snapshot ${snapshotId}`,
    };
  }
  if (sessions.length === 0 && extras.length === 0) {
    return {
      ok: false,
      reason_code: RESTORE_CODES.NO_SESSION,
      detail: `snapshot ${snapshotId} contains none of the selected scopes (${scopePolicy.scopes.join(', ') || 'none'})`,
    };
  }

  const decoded = [];
  for (const entry of sessions) {
    const rebuilt = rebuildFile({ root: input.root, entry, dek: key.dek });
    if (rebuilt.ok !== true) return { ok: false, reason_code: rebuilt.code, detail: rebuilt.detail };
    if (sha256Hex(rebuilt.buffer) !== entry.sha256) {
      return { ok: false, reason_code: RESTORE_CODES.VERIFY_FAILED, detail: `${entry.rel}: the repository bytes do not match the manifest digest` };
    }
    decoded.push({ entry, buffer: rebuilt.buffer });
  }
  const decodedAttachments = [];
  for (const entry of attachments) {
    const rebuilt = rebuildFile({ root: input.root, entry, dek: key.dek });
    if (rebuilt.ok !== true) return { ok: false, reason_code: rebuilt.code, detail: rebuilt.detail };
    if (sha256Hex(rebuilt.buffer) !== entry.sha256) {
      return { ok: false, reason_code: RESTORE_CODES.VERIFY_FAILED, detail: `${entry.rel}: the repository bytes do not match the manifest digest` };
    }
    decodedAttachments.push({ entry, buffer: rebuilt.buffer });
  }
  const decodedExtras = [];
  let registryDocument = null;
  for (const entry of extras) {
    const rebuilt = rebuildFile({ root: input.root, entry, dek: key.dek });
    if (rebuilt.ok !== true) return { ok: false, reason_code: rebuilt.code, detail: rebuilt.detail };
    if (sha256Hex(rebuilt.buffer) !== entry.sha256) {
      return { ok: false, reason_code: RESTORE_CODES.VERIFY_FAILED, detail: `${entry.rel}: the repository bytes do not match the manifest digest` };
    }
    if (entry.kind === 'registry') {
      // The backed-up registry document is a **base**, not a copied file: parse it now, and refuse by name when it
      // is present but broken. Falling back to slug guessing here would restore sessions into wrong/absent
      // workspaces while looking successful -- the exact failure the backup document exists to prevent.
      try {
        registryDocument = JSON.parse(rebuilt.buffer.toString('utf8'));
      } catch (error) {
        return {
          ok: false,
          reason_code: RESTORE_CODES.REGISTRY_INVALID,
          detail: `${entry.rel}: the backed-up workspace registry is not valid JSON (${error instanceof Error ? error.message : String(error)}); refusing to guess workspace mappings`,
        };
      }
      if (registryDocument === null || typeof registryDocument !== 'object' || registryDocument.tables === undefined) {
        return {
          ok: false,
          reason_code: RESTORE_CODES.REGISTRY_INVALID,
          detail: `${entry.rel}: the backed-up file is not a workspace registry document (no tables); refusing to guess workspace mappings`,
        };
      }
      continue;
    }
    decodedExtras.push({ entry, buffer: rebuilt.buffer });
  }

  return buildPlan({
    input,
    now,
    scopes: scopePolicy.scopes,
    source: { kind: 'repository', snapshot_id: snapshotId, snapshot_digest: snapshot.digest },
    sessions: decoded,
    attachments: decodedAttachments,
    extras: decodedExtras,
    registryDocument,
  });
}

/**
 * Plan one restore directly from a `.tar.zst` archive.
 *
 * The archive carries the same manifest a snapshot does (files, digests, session ids, flags), so the same gates
 * and the same writer apply. This is what makes an archive "鍙В鍘嬨€佸彲鏍￠獙銆佸彲杩樺師" rather than "鍙В鍘?.
 *
 * @param {{file: string, dshHome: string, sessionIds?: string[], allowStaticValidation?: boolean,
 *   requireFutureAppend?: boolean, workspacePath?: string|null, keepBoth?: boolean, now?: Date,
 *   harness?: object|null, env?: Record<string, string|undefined>}} input
 * @returns {object} a plan
 */
export function planRestoreFromArchive(input) {
  const now = input.now ?? new Date();
  const gate = gateClient(input);
  if (gate.ok !== true) return { ok: false, reason_code: gate.reason_code, detail: gate.detail, client: gate.detection ?? null };
  const archive = readArchive(input.file);
  if (archive.manifest === null || archive.ok !== true) {
    return {
      ok: false,
      reason_code: RESTORE_CODES.ARCHIVE_UNREADABLE,
      detail: `${input.file}: ${archive.detail ?? archive.reason_code}`,
      problems: archive.problems,
    };
  }
  const entries = new Map(archive.entries.map((entry) => [entry.name, entry.data]));
  const scopePolicy = restoreScopes(input.scopes);
  if (scopePolicy.ok !== true) return { ok: false, reason_code: RESTORE_CODES.SCOPE_UNKNOWN, detail: scopePolicy.detail };
  const scopes = new Set(scopePolicy.scopes);
  const wanted = Array.isArray(input.sessionIds) && input.sessionIds.length > 0 ? new Set(input.sessionIds.map(String)) : null;
  const sessions = [];
  const attachments = [];
  for (const file of archive.manifest.files) {
    if (file.kind === 'registry' || file.kind === 'config' || file.kind === 'state') continue;
    if (!scopes.has(file.kind === 'session' ? 'sessions' : 'attachments')) continue;
    if (wanted !== null && file.kind === 'session' && !wanted.has(file.session_id)) continue;
    const data = entries.get(file.rel);
    if (data === undefined) {
      return { ok: false, reason_code: RESTORE_CODES.ARCHIVE_UNREADABLE, detail: `${input.file}: ${file.rel} is missing from the archive` };
    }
    if (file.kind === 'session') {
      sessions.push({ entry: { ...file, workspace: file.rel.split('/')[1], flags: file.flags ?? null }, buffer: data });
    } else {
      attachments.push({ entry: { ...file }, buffer: data });
    }
  }
  if (sessions.length === 0) {
    return { ok: false, reason_code: RESTORE_CODES.NO_SESSION, detail: `${input.file}: no session matches the request` };
  }
  return buildPlan({
    input,
    now,
    scopes: scopePolicy.scopes,
    source: { kind: 'archive', archive_file: input.file, snapshot_id: archive.manifest.source_snapshot ?? null, snapshot_digest: archive.manifest.source_digest ?? null },
    sessions,
    attachments,
    // An archive is a plaintext pack of session logs and attachment objects; the expanded-scope files are not in it,
    // so a restore from an archive restores what the archive actually carries (and says so in the plan).
    extras: [],
    registryDocument: null,
  });
}

/**
 * Shared planning: validate every candidate through both gates, classify conflicts, plan the registry once, and
 * classify every config/state file the snapshot carries.
 *
 * @param {{input: object, now: Date, scopes: string[], source: object,
 *   sessions: Array<{entry: object, buffer: Buffer}>, attachments: Array<{entry: object, buffer: Buffer}>,
 *   extras?: Array<{entry: object, buffer: Buffer}>, registryDocument?: object|null}} context
 * @returns {object}
 */
function buildPlan(context) {
  const { input, now, source, sessions, attachments, extras, registryDocument } = context;
  const scopes = Array.isArray(context.scopes) ? context.scopes : ['sessions', 'attachments', 'registry', 'config', 'state'];
  const requireRuntime = input.allowStaticValidation !== true;
  const validation = validateCandidates({
    items: sessions.map((row) => ({
      buffer: row.buffer,
      expectedSessionId: row.entry.session_id ?? null,
      appendCheck: input.requireFutureAppend !== false,
    })),
    harness: input.harness,
    requireRuntime,
    env: input.env,
  });
  const failures = [];
  const candidates = [];
  for (const [index, row] of sessions.entries()) {
    const verdict = validation.results[index];
    const entry = row.entry;
    if (verdict.ok !== true) {
      failures.push({ rel: entry.rel, session_id: entry.session_id, reason_code: verdict.reason_code, detail: verdict.detail });
      continue;
    }
    const target = sessionTargetPath(input.dshHome, entry);
    const existing = fs.existsSync(target) ? sha256Hex(fs.readFileSync(target)) : null;
    const conflict = existing === null ? 'new' : existing === row.entry.sha256 ? 'identical' : 'differs';
    // The digest the plan saw: apply refuses if the file changed in between (a live client appends to it).
    candidates.push({
      rel: entry.rel,
      session_id: entry.session_id,
      workspace: entry.workspace ?? String(entry.rel).split('/')[1],
      size: row.buffer.length,
      sha256: row.entry.sha256,
      buffer: row.buffer,
      target,
      existing_sha256: existing,
      conflict,
      resolution: conflict === 'differs' ? (input.keepBoth === true ? 'keep-both' : 'backup-and-replace') : conflict,
      flags: entry.flags ?? { registered: false, archived: false, pinned: false },
      validation: {
        runtime_verified: verdict.runtime_verified === true,
        future_append: verdict.future_append,
        static_codes: verdict.static?.codes ?? [],
      },
    });
  }
  if (failures.length > 0) {
    const first = failures[0];
    return {
      ok: false,
      reason_code: first.reason_code ?? RESTORE_CODES.CANDIDATE_INVALID,
      detail: failures.map((row) => `${row.rel}: ${row.reason_code} (${row.detail})`).join('; '),
      problems: failures,
      runtime_available: validation.runtime_available,
    };
  }

  // One registry plan for the whole restore: planning per session would let the last write erase the others.
  // A backed-up registry document is the **base** when the registry scope is selected: every workspace and its
  // path/title/order/default survive, and sessions are matched against the document's own paths.
  //
  // A restore that selects neither `sessions` nor `registry` (for example `--scopes config`) plans no registry at
  // all: there is nothing to register, and demanding a workspace path for it would make a config-only restore
  // impossible on a fresh home.
  let registry;
  if (candidates.length === 0 && (registryDocument === null || registryDocument === undefined) && !scopes.includes('sessions')) {
    registry = {
      ok: true,
      reason_code: null,
      detail: null,
      file: workspaceRegistryPath(input.dshHome),
      document: null,
      changed: false,
      actions: [],
      created_document: false,
      created_workspaces: [],
      base_document_restored: false,
      assignments: [],
    };
  } else {
    registry = planRegistryRestores({
      dshHome: input.dshHome,
      sessions: candidates.map((candidate) => ({
        session_id: candidate.session_id,
        workspace: candidate.workspace,
        archived: candidate.flags.archived === true,
        pinned: candidate.flags.pinned === true,
      })),
      workspacePath: input.workspacePath ?? null,
      allowCreateRegistry: true,
      ...(registryDocument !== null && registryDocument !== undefined ? { baseDocument: registryDocument } : {}),
    });
  }
  if (registry.ok !== true) {
    return { ok: false, reason_code: RESTORE_CODES.REGISTRY_FAILED, detail: registry.detail, registry };
  }

  // Config/state files carried by the snapshot. They are ordinary file writes with a conflict classification; an
  // existing different file is replaced only after a `.bak` copy (or written beside it with keepBoth).
  const decoratedExtras = [];
  for (const row of extras ?? []) {
    const resolved = extraTargetPath(input.dshHome, row.entry);
    if (resolved.ok !== true) {
      return {
        ok: false,
        reason_code: RESTORE_CODES.TARGET_ESCAPE,
        detail: `${row.entry.rel}: the restore target would resolve outside the DSH home; refusing to write it`,
      };
    }
    const existing = fs.existsSync(resolved.target) ? sha256Hex(fs.readFileSync(resolved.target)) : null;
    const sha256 = sha256Hex(row.buffer);
    const conflict = existing === null ? 'new' : existing === sha256 ? 'identical' : 'differs';
    decoratedExtras.push({
      rel: row.entry.rel,
      kind: row.entry.kind,
      scope: row.entry.scope ?? row.entry.kind,
      reason: row.entry.reason ?? null,
      sha256,
      size: row.buffer.length,
      buffer: row.buffer,
      target: resolved.target,
      existing_sha256: existing,
      conflict,
      resolution: conflict === 'differs' ? (input.keepBoth === true ? 'keep-both' : 'backup-and-replace') : conflict,
      action: conflict === 'differs' ? (input.keepBoth === true ? 'write kept-both copy' : 'backup then replace') : conflict,
    });
  }

  const decoratedAttachments = [];
  for (const row of attachments) {
    const target = path.join(input.dshHome, ...String(row.entry.rel).replace(/\\/g, '/').split('/'));
    const existing = fs.existsSync(target) ? sha256Hex(fs.readFileSync(target)) : null;
    if (existing !== null && existing !== sha256Hex(row.buffer)) {
      return { ok: false, reason_code: RESTORE_CODES.ATTACHMENT_CONFLICT, detail: `${row.entry.rel}: an attachment object at this id holds different bytes` };
    }
    decoratedAttachments.push({ rel: row.entry.rel, attachment_id: row.entry.attachment_id, sha256: sha256Hex(row.buffer), buffer: row.buffer, target, existing: existing !== null });
  }

  const filesSummary = {
    registry: registry.base_document_restored === true ? 1 : 0,
    config: decoratedExtras.filter((row) => row.kind === 'config').length,
    state: decoratedExtras.filter((row) => row.kind === 'state').length,
    written: 0,
    conflicts: decoratedExtras.filter((row) => row.conflict === 'differs').length,
    entries: decoratedExtras.map((row) => ({
      rel: row.rel,
      kind: row.kind,
      size: row.size,
      sha256: row.sha256,
      target: row.target,
      conflict: row.conflict,
      action: row.action,
      resolution: row.resolution,
    })),
  };

  return {
    ok: true,
    created_at: now.toISOString(),
    source,
    dsh_home: input.dshHome,
    snapshot_id: source.snapshot_id,
    snapshot_digest: source.snapshot_digest,
    scopes,
    candidates,
    attachments: decoratedAttachments,
    files: decoratedExtras,
    files_summary: filesSummary,
    registry,
    registry_from_backup_document: registry.base_document_restored === true,
    registry_source: registry.base_document_restored === true ? 'backup-document' : 'live-registry',
    pre_restore: { dir: preRestoreDir(input.dshHome, now), files: [] },
    keep_pre_restore: Number.isSafeInteger(input.keepPreRestore) ? input.keepPreRestore : DEFAULT_KEEP_PRE_RESTORE,
    summary: {
      sessions: candidates.length,
      new: candidates.filter((row) => row.conflict === 'new').length,
      identical: candidates.filter((row) => row.conflict === 'identical').length,
      conflicts: candidates.filter((row) => row.conflict === 'differs').length,
      attachments: decoratedAttachments.length,
      registry: filesSummary.registry,
      config: filesSummary.config,
      state: filesSummary.state,
      file_conflicts: filesSummary.conflicts,
      runtime_verified: candidates.filter((row) => row.validation.runtime_verified).length,
      runtime_available: validation.runtime_available,
    },
  };
}

/**
 * Recover a session log the client appended to while the restore was writing it.
 *
 * Shape of the damage: we wrote the snapshot bytes, then the live client appended its own events at the new end
 * (its in-memory seq count still matched the *pre-write* file, so the result has a seq gap). The recovery keeps
 * both sides: the pre-restore copy (newest pre-write content) followed by the client's post-write tail.
 *
 * Returns `{ok:true, bytes, sha256, tail_bytes}` when the file was healed on disk, or `{ok:false, detail}` when the
 * file did not have the shape this repair can safely handle (then the caller reports it and the pre-restore copy is
 * still the way back).
 *
 * @param {{row: object, plannedBytes: Buffer|undefined}} input
 * @returns {{ok: true, bytes: number, sha256: string, tail_bytes: number} | {ok: false, detail: string}}
 */
function healAfterConcurrentAppend(input) {
  const row = input.row;
  if (!Buffer.isBuffer(input.plannedBytes)) return { ok: false, detail: 'the planned bytes are not available' };
  let current;
  try {
    current = fs.readFileSync(row.target);
  } catch (error) {
    return { ok: false, detail: `the written file is unreadable: ${error?.code ?? error}` };
  }
  if (current.length < input.plannedBytes.length || !current.subarray(0, input.plannedBytes.length).equals(input.plannedBytes)) {
    return { ok: false, detail: 'the file does not start with the bytes this restore wrote (a different writer changed it)' };
  }
  const tail = current.subarray(input.plannedBytes.length);
  const frames = scanFrames(tail).frames;
  if (frames.length === 0 || frames[frames.length - 1].end !== tail.length) {
    return { ok: false, detail: 'the appended tail is not frame-aligned (a torn write)' };
  }
  if (typeof row.pre_copy !== 'string' || !fs.existsSync(row.pre_copy)) {
    return { ok: false, detail: 'there is no pre-restore copy to rebuild from' };
  }
  const preBytes = fs.readFileSync(row.pre_copy);
  const healed = Buffer.concat([preBytes, tail]);
  const verdict = diagnoseSessionBuffer(healed, { expectedSessionId: row.session_id });
  if (verdict.ok !== true) {
    return { ok: false, detail: `the rebuilt log fails validation: ${verdict.codes.join(', ')}` };
  }
  try {
    writeFileAtomic(row.target, healed);
  } catch (error) {
    return { ok: false, detail: `could not write the rebuilt log: ${error?.detail ?? error?.message ?? error}` };
  }
  return { ok: true, bytes: healed.length, sha256: sha256Hex(healed), tail_bytes: tail.length };
}

/**
 * Apply a planned restore.
 *
 * @param {{plan: object, dshHome: string, dryRun?: boolean, now?: Date,
 *   afterWrite?: (context: {session_id: string, target: string, plannedBytes: Buffer}) => void}} input
 *   `afterWrite` is a test seam: production never passes it. It runs after a session file is written and before the
 *   read-back verification, which is how a test can simulate the live client appending to the file mid-restore.
 * @returns {object}
 */
export function applyRestore(input) {
  const started = Date.now();
  const plan = input.plan;
  if (plan.ok !== true) {
    return { ok: false, reason_code: plan.reason_code, detail: plan.detail, dry_run: input.dryRun === true, restored: [], skipped: 0, attachments: 0, pre_restore_dir: null, bytes_written: 0, duration_ms: 0 };
  }
  const toWrite = plan.candidates.filter((candidate) => candidate.conflict !== 'identical');
  const extrasToWrite = (plan.files ?? []).filter((row) => row.conflict !== 'identical');
  const fileCounts = () => ({
    registry: plan.registry_from_backup_document === true && plan.registry?.changed === true ? 1 : 0,
    config: extrasToWrite.filter((row) => row.kind === 'config').length,
    state: extrasToWrite.filter((row) => row.kind === 'state').length,
    written: 0,
    conflicts: extrasToWrite.filter((row) => row.conflict === 'differs').length,
  });
  if (input.dryRun === true) {
    return {
      ok: true,
      dry_run: true,
      restored: toWrite.map((row) => ({ session_id: row.session_id, target: row.target, conflict: row.conflict, resolution: row.resolution })),
      skipped: plan.candidates.length - toWrite.length,
      attachments: plan.attachments.filter((row) => !row.existing).length,
      pre_restore_dir: plan.pre_restore.dir,
      registry: plan.registry.actions,
      registry_from_backup_document: plan.registry_from_backup_document === true,
      scopes: plan.scopes,
      files: { ...fileCounts(), skipped_identical: (plan.files ?? []).filter((row) => row.conflict === 'identical').length },
      files_summary: plan.files_summary,
      bytes_written: 0,
      duration_ms: Date.now() - started,
    };
  }

  // Pre-restore copies first: after this point every path about to be touched has a way back.
  const preDir = plan.pre_restore.dir;
  const copied = [];
  try {
    for (const candidate of toWrite) {
      if (!fs.existsSync(candidate.target)) continue;
      const copy = path.join(preDir, ...String(candidate.rel).replace(/\\/g, '/').split('/'));
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.copyFileSync(candidate.target, copy);
      copied.push(copy);
    }
    // Every config/state target that will be overwritten gets a pre-restore copy too: the write is atomic per file,
    // but the `.bak` that an overwrite leaves is one file back, not the pre-restore snapshot.
    for (const extra of extrasToWrite) {
      if (!fs.existsSync(extra.target)) continue;
      const copy = path.join(preDir, ...String(extra.rel).replace(/\\/g, '/').split('/'));
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.copyFileSync(extra.target, copy);
      copied.push(copy);
    }
    if (fs.existsSync(plan.registry.file)) {
      fs.mkdirSync(preDir, { recursive: true });
      fs.copyFileSync(plan.registry.file, path.join(preDir, 'workspace.json'));
      copied.push(path.join(preDir, 'workspace.json'));
    }
    fs.mkdirSync(preDir, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      reason_code: RESTORE_CODES.WRITE_FAILED,
      detail: `could not make the pre-restore copy: ${error?.message ?? error}`,
      dry_run: false,
      restored: [],
      skipped: 0,
      attachments: 0,
      pre_restore_dir: preDir,
      bytes_written: 0,
      duration_ms: Date.now() - started,
    };
  }

  const restored = [];
  const written = [];
  let bytesWritten = 0;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  try {
    for (const candidate of toWrite) {
      // Re-check the target immediately before writing: a plan taken while the client was appending is stale, and
      // writing over a file that moved under us is exactly how a live session log gets a seq gap.
      const expected = candidate.existing_sha256 ?? null;
      const current = candidate.conflict === 'new' ? null : sha256Hex(fs.readFileSync(candidate.target));
      if (candidate.conflict === 'new' ? fs.existsSync(candidate.target) : current !== expected) {
        return {
          ok: false,
          reason_code: RESTORE_CODES.TARGET_CHANGED,
          detail:
            `${candidate.session_id}: ${candidate.target} changed after the plan was made ` +
            `(the DSH client is probably appending to it); nothing was written for this session. ` +
            'Quit the client, or plan again to include the new bytes, and retry.',
          dry_run: false,
          restored,
          skipped: 0,
          attachments: 0,
          pre_restore_dir: preDir,
          bytes_written: bytesWritten,
          duration_ms: Date.now() - started,
        };
      }
      const target = candidate.resolution === 'keep-both' ? `${candidate.target}.restored-${stamp}` : candidate.target;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, candidate.buffer);
      if (typeof input.afterWrite === 'function') input.afterWrite({ session_id: candidate.session_id, target, plannedBytes: candidate.buffer });
      bytesWritten += candidate.buffer.length;
      const row = { session_id: candidate.session_id, target, conflict: candidate.conflict, resolution: candidate.resolution, bytes: candidate.buffer.length, sha256: candidate.sha256 };
      restored.push(row);
      written.push({ ...row, pre_copy: path.join(preDir, ...String(candidate.rel).replace(/\\/g, '/').split('/')) });
    }
    for (const attachment of plan.attachments) {
      if (attachment.existing) continue;
      fs.mkdirSync(path.dirname(attachment.target), { recursive: true });
      writeFileAtomic(attachment.target, attachment.buffer);
      bytesWritten += attachment.buffer.length;
    }
  } catch (error) {
    return {
      ok: false,
      reason_code: error?.code ?? RESTORE_CODES.WRITE_FAILED,
      detail: error?.detail ?? String(error?.message ?? error),
      dry_run: false,
      restored,
      skipped: 0,
      attachments: 0,
      pre_restore_dir: preDir,
      bytes_written: bytesWritten,
      duration_ms: Date.now() - started,
    };
  }

  const applied = applyRegistryRestore({ dshHome: input.dshHome, plan: plan.registry });
  if (applied.ok !== true) {
    return {
      ok: false,
      reason_code: RESTORE_CODES.REGISTRY_FAILED,
      detail: applied.detail,
      dry_run: false,
      restored,
      skipped: 0,
      attachments: 0,
      pre_restore_dir: preDir,
      bytes_written: bytesWritten,
      registry: [applied],
      duration_ms: Date.now() - started,
    };
  }

  // Config/state files from the snapshot: one atomic write each, then a read-back digest check. A conflicting file
  // is first copied to `<target>.bak-<stamp>` (or, with keepBoth, the restored copy is written beside it as
  // `<target>.restored-<stamp>` and the live file is left alone). This is after the registry document so a failure
  // here names the file and does not leave a half-written registry.
  const writtenFiles = [];
  try {
    for (const extra of extrasToWrite) {
      let target = extra.target;
      if (extra.resolution === 'keep-both') {
        target = `${extra.target}.restored-${stamp}`;
      } else if (extra.conflict === 'differs' && fs.existsSync(extra.target)) {
        fs.copyFileSync(extra.target, `${extra.target}.bak-${stamp}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, extra.buffer);
      const readBack = fs.readFileSync(target);
      const digest = sha256Hex(readBack);
      if (digest !== extra.sha256) {
        return {
          ok: false,
          reason_code: RESTORE_CODES.VERIFY_FAILED,
          detail: `${extra.rel}: the written file hashes to ${digest}, not the planned ${extra.sha256}`,
          dry_run: false,
          restored,
          skipped: plan.candidates.length - toWrite.length,
          attachments: plan.attachments.filter((row) => !row.existing).length,
          pre_restore_dir: preDir,
          bytes_written: bytesWritten,
          registry: [applied],
          files: {
            registry: plan.registry_from_backup_document === true && plan.registry.changed === true ? 1 : 0,
            config: writtenFiles.filter((row) => row.kind === 'config').length,
            state: writtenFiles.filter((row) => row.kind === 'state').length,
            written: writtenFiles.length,
            conflicts: extrasToWrite.filter((row) => row.conflict === 'differs').length,
          },
          duration_ms: Date.now() - started,
        };
      }
      bytesWritten += extra.buffer.length;
      writtenFiles.push({
        rel: extra.rel,
        kind: extra.kind,
        target,
        conflict: extra.conflict,
        resolution: extra.resolution,
        bytes: extra.buffer.length,
        sha256: extra.sha256,
      });
    }
  } catch (error) {
    return {
      ok: false,
      reason_code: error?.code ?? RESTORE_CODES.WRITE_FAILED,
      detail: error?.detail ?? String(error?.message ?? error),
      dry_run: false,
      restored,
      skipped: plan.candidates.length - toWrite.length,
      attachments: plan.attachments.filter((row) => !row.existing).length,
      pre_restore_dir: preDir,
      bytes_written: bytesWritten,
      registry: [applied],
      files: {
        registry: plan.registry_from_backup_document === true && plan.registry.changed === true ? 1 : 0,
        config: writtenFiles.filter((row) => row.kind === 'config').length,
        state: writtenFiles.filter((row) => row.kind === 'state').length,
        written: writtenFiles.length,
        conflicts: extrasToWrite.filter((row) => row.conflict === 'differs').length,
      },
      duration_ms: Date.now() - started,
    };
  }
  const fileResult = {
    registry: plan.registry_from_backup_document === true && plan.registry.changed === true ? 1 : 0,
    config: writtenFiles.filter((row) => row.kind === 'config').length,
    state: writtenFiles.filter((row) => row.kind === 'state').length,
    written: writtenFiles.length,
    conflicts: extrasToWrite.filter((row) => row.conflict === 'differs').length,
  };

  // Read back what was written: same bytes, and still a valid file on disk. A mismatch here has one known cause:
  // the running client appended to the session between our write and this read. That case is recoverable without
  // losing the client's events -- restore the pre-copy (newest pre-write content), append the client's post-write
  // tail, and write that -- so the repair happens inside the same call instead of leaving a torn log behind.
  const problems = [];
  const healed = [];
  for (const row of written) {
    const buffer = fs.readFileSync(row.target);
    if (sha256Hex(buffer) === row.sha256) {
      const verdict = diagnoseSessionBuffer(buffer, { expectedSessionId: row.session_id });
      if (verdict.ok !== true) problems.push({ session_id: row.session_id, detail: `the written file no longer validates: ${verdict.codes.join(', ')}` });
      continue;
    }
    const repair = healAfterConcurrentAppend({ row, plannedBytes: plan.candidates.find((candidate) => candidate.session_id === row.session_id)?.buffer });
    if (repair.ok !== true) {
      problems.push({ session_id: row.session_id, detail: `the written file does not hash to the planned digest and could not be healed: ${repair.detail}` });
      continue;
    }
    healed.push({ session_id: row.session_id, target: row.target, bytes: repair.bytes, sha256: repair.sha256, tail_bytes: repair.tail_bytes });
  }
  if (problems.length > 0) {
    return {
      ok: false,
      reason_code: RESTORE_CODES.VERIFY_FAILED,
      detail: problems.map((row) => `${row.session_id}: ${row.detail}`).join('; '),
      dry_run: false,
      restored,
      skipped: plan.candidates.length - toWrite.length,
      attachments: plan.attachments.filter((row) => !row.existing).length,
      pre_restore_dir: preDir,
      bytes_written: bytesWritten,
      registry: [applied],
      duration_ms: Date.now() - started,
    };
  }

  const pruned = prunePreRestoreSnapshots({ dshHome: input.dshHome, keep: plan.keep_pre_restore ?? DEFAULT_KEEP_PRE_RESTORE });
  return {
    ok: true,
    dry_run: false,
    restored,
    skipped: plan.candidates.length - toWrite.length,
    attachments: plan.attachments.filter((row) => !row.existing).length,
    pre_restore_dir: preDir,
    pre_restore_files: copied.length,
    bytes_written: bytesWritten,
    registry: [applied],
    registry_from_backup_document: plan.registry_from_backup_document === true,
    scopes: plan.scopes,
    files: fileResult,
    files_written: writtenFiles,
    healed: healed.length > 0 ? healed : [],
    pruned_pre_restore: pruned.removed,
    warnings: typeof applied.warning === 'string' ? [applied.warning] : [],
    duration_ms: Date.now() - started,
  };
}

/**
 * List the pre-restore copies in a home, newest first by name (names are sortable timestamps).
 *
 * Only timestamp-named directories are restore copies. The register path keeps its registry copies in the same
 * root (`register-<timestamp>/`, see `register.mjs`), and counting them here would make a restore's retention keep
 * fewer real pre-restore copies than it promised -- and would then prune directories it does not own.
 */
export function listPreRestoreSnapshots(dshHome) {
  const root = preRestoreRoot(dshHome);
  let names = [];
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}Z$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => ({ id: name, dir: path.join(root, name) }));
}

/**
 * Keep only the newest `keep` pre-restore copies.
 *
 * Called after a *successful* restore: the way back from the newest restore is always kept, older copies are
 * bounded so a repeated restore cannot grow without limit. A failure path never prunes (the newest copy is the
 * one the user needs right then).
 *
 * @param {{dshHome: string, keep?: number}} input
 * @returns {{kept: number, removed: number, removed_ids: string[]}}
 */
export function prunePreRestoreSnapshots(input) {
  const keep = Number.isSafeInteger(input.keep) && input.keep >= 1 ? input.keep : DEFAULT_KEEP_PRE_RESTORE;
  const snapshots = listPreRestoreSnapshots(input.dshHome);
  const excess = snapshots.length - keep;
  if (excess <= 0) return { kept: snapshots.length, removed: 0, removed_ids: [] };
  const removed = [];
  for (const snapshot of snapshots.slice(0, excess)) {
    try {
      fs.rmSync(snapshot.dir, { recursive: true, force: true });
      removed.push(snapshot.id);
    } catch {
      // An undeletable old copy is harmless; it stays visible in the list.
    }
  }
  return { kept: snapshots.length - removed.length, removed: removed.length, removed_ids: removed };
}

/** Re-export for callers that want the canonical slug without importing registry. */
export { workspaceSlug };
