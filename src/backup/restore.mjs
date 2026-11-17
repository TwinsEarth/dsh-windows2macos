/**
 * Restore: publish snapshot bytes back into the live DSH home.
 *
 * ## The four gates (from `docs/RETRO-SESSION-RECOVERY-20261117.md`), and where they live
 *
 *   * **G1** a restored candidate must pass session-doctor *before* it is published, or nothing is published;
 *   * **G2** the workspace registry is client-owned state: write atomically, read back, and report the residual
 *     risk (`registry.mjs`);
 *   * **G3** only original bytes are written -- never a hand-authored event -- and a future append must still
 *     succeed (`verify.simulateFutureAppend`);
 *   * **G5** confirmation is the installed Harness's own validator (`runtime-validate.mjs`), not our parser.
 *
 * ## The order of operations, which is the whole safety story
 *
 *   plan (decode + validate + conflict + registry plan, **no writes**)
 *   -> apply: pre-restore copy of everything that will be touched
 *   -> write session files atomically
 *   -> write attachment objects
 *   -> registry write + read-back verification
 *   -> re-read every written file and compare its digest to the plan
 *
 * If any step fails after the pre-restore copy exists, the copy is the way back and the report says how.
 */

import fs from 'node:fs';
import path from 'node:path';

import { repoPaths } from './layout.mjs';
import { openRepo, readSnapshot } from './repo.mjs';
import { openRepoKey } from './keystore.mjs';
import { rebuildFile } from './materialize.mjs';
import { writeFileAtomic } from './atomic.mjs';
import { sha256Hex } from './manifest.mjs';
import { applyRegistryRestore, planRegistryRestore, workspaceSlug } from './registry.mjs';
import { simulateFutureAppend } from './verify.mjs';
import { validateCandidate } from './runtime-validate.mjs';
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
});

/** The directory (inside `$DSH_HOME`) that holds pre-restore copies. */
export function preRestoreRoot(dshHome) {
  return path.join(dshHome, 'sessions', '.w2m-restore-backups');
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

/**
 * Plan one restore: no writes, all decisions.
 *
 * @param {{
 *   root: string, dshHome: string, snapshotId?: string|null, sessionIds?: string[],
 *   password?: string|Buffer|null, machineKey?: boolean, platform?: string, runner?: Function,
 *   allowStaticValidation?: boolean, requireFutureAppend?: boolean, workspacePath?: string|null,
 *   keepBoth?: boolean, now?: Date, env?: Record<string, string|undefined>,
 * }} input
 * @returns {object} a plan (see the module docs) -- `ok:false` carries `reason_code`/`detail`
 */
export function planRestore(input) {
  const now = input.now ?? new Date();
  const state = openRepo({ root: input.root, dshHome: input.dshHome });
  if (state.initialized !== true) {
    return { ok: false, reason_code: RESTORE_CODES.NOT_INITIALIZED, detail: state.error?.detail ?? 'the repository is not initialised' };
  }
  const key = openRepoKey({
    root: input.root,
    dshHome: input.dshHome,
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
  const wanted = Array.isArray(input.sessionIds) && input.sessionIds.length > 0 ? new Set(input.sessionIds.map(String)) : null;
  const sessionEntries = snapshot.manifest.files.filter((entry) => entry.kind === 'session' && (wanted === null || wanted.has(entry.session_id)));
  if (sessionEntries.length === 0) {
    return {
      ok: false,
      reason_code: RESTORE_CODES.NO_SESSION,
      detail: wanted === null ? `snapshot ${snapshotId} contains no session` : `none of the requested session(s) are in snapshot ${snapshotId}`,
    };
  }

  const problems = [];
  const candidates = [];
  const requireRuntime = input.allowStaticValidation !== true;
  for (const entry of sessionEntries) {
    const rebuilt = rebuildFile({ root: input.root, entry, dek: key.dek });
    if (rebuilt.ok !== true) return { ok: false, reason_code: rebuilt.code, detail: rebuilt.detail };
    const digest = sha256Hex(rebuilt.buffer);
    if (digest !== entry.sha256) {
      return { ok: false, reason_code: RESTORE_CODES.VERIFY_FAILED, detail: `${entry.rel}: the repository bytes do not match the manifest digest` };
    }
    const validation = validateCandidate({
      buffer: rebuilt.buffer,
      expectedSessionId: entry.session_id,
      requireRuntime,
      env: input.env,
    });
    if (validation.ok !== true) problems.push({ rel: entry.rel, session_id: entry.session_id, reason_code: validation.reason_code, detail: validation.detail });
    const future = input.requireFutureAppend === false ? null : simulateFutureAppend(rebuilt.buffer);
    if (future !== null && future.ok !== true) {
      problems.push({ rel: entry.rel, session_id: entry.session_id, reason_code: RESTORE_CODES.CANDIDATE_INVALID, detail: `future append fails: ${future.codes.join(', ')}` });
    }
    const target = sessionTargetPath(input.dshHome, entry);
    const existing = fs.existsSync(target) ? sha256Hex(fs.readFileSync(target)) : null;
    const conflict = existing === null ? 'new' : existing === entry.sha256 ? 'identical' : 'differs';
    candidates.push({
      rel: entry.rel,
      session_id: entry.session_id,
      workspace: entry.workspace,
      size: entry.size,
      sha256: entry.sha256,
      buffer: rebuilt.buffer,
      target,
      conflict,
      resolution: conflict === 'differs' ? (input.keepBoth === true ? 'keep-both' : 'backup-and-replace') : conflict,
      flags: entry.flags ?? { registered: false, archived: false, pinned: false },
      validation: {
        runtime_verified: validation.runtime_verified === true,
        future_append: future === null ? null : future.ok === true,
        codes: validation.static.codes,
      },
    });
  }
  if (problems.length > 0) {
    const first = problems[0];
    return {
      ok: false,
      reason_code: first.reason_code ?? RESTORE_CODES.CANDIDATE_INVALID,
      detail: problems.map((row) => `${row.rel}: ${row.reason_code} (${row.detail})`).join('; '),
      problems,
    };
  }

  // Registry plans per session. A workspace that is not registered is a refusal, not an invention (see registry.mjs).
  const registryPlans = [];
  for (const candidate of candidates) {
    const plan = planRegistryRestore({
      dshHome: input.dshHome,
      sessionId: candidate.session_id,
      workspaceName: candidate.workspace,
      archived: candidate.flags.archived === true,
      pinned: candidate.flags.pinned === true,
      workspacePath: input.workspacePath ?? null,
    });
    if (plan.ok !== true) {
      return { ok: false, reason_code: RESTORE_CODES.REGISTRY_FAILED, detail: `${candidate.rel}: ${plan.detail}`, registry: plan };
    }
    registryPlans.push({ session_id: candidate.session_id, plan });
  }

  const preDir = preRestoreDir(input.dshHome, now);
  const attachments = [];
  for (const entry of snapshot.manifest.files.filter((row) => row.kind === 'attachment')) {
    const rebuilt = rebuildFile({ root: input.root, entry, dek: key.dek });
    if (rebuilt.ok !== true) return { ok: false, reason_code: rebuilt.code, detail: rebuilt.detail };
    const target = path.join(input.dshHome, ...String(entry.rel).replace(/\\/g, '/').split('/'));
    const existing = fs.existsSync(target) ? sha256Hex(fs.readFileSync(target)) : null;
    if (existing !== null && existing !== entry.sha256) {
      return { ok: false, reason_code: RESTORE_CODES.ATTACHMENT_CONFLICT, detail: `${entry.rel}: an attachment object at this id holds different bytes` };
    }
    attachments.push({ rel: entry.rel, attachment_id: entry.attachment_id, sha256: entry.sha256, buffer: rebuilt.buffer, target, existing: existing !== null });
  }

  return {
    ok: true,
    created_at: now.toISOString(),
    snapshot_id: snapshotId,
    snapshot_digest: snapshot.digest,
    dsh_home: input.dshHome,
    candidates,
    attachments,
    registry: registryPlans,
    pre_restore: { dir: preDir, files: [] },
    summary: {
      sessions: candidates.length,
      new: candidates.filter((row) => row.conflict === 'new').length,
      identical: candidates.filter((row) => row.conflict === 'identical').length,
      conflicts: candidates.filter((row) => row.conflict === 'differs').length,
      attachments: attachments.length,
      runtime_verified: candidates.filter((row) => row.validation.runtime_verified).length,
    },
  };
}

/**
 * Apply a planned restore.
 *
 * @param {{plan: object, dshHome: string, dryRun?: boolean, now?: Date}} input
 * @returns {object} `{ok, dry_run, restored, attachments, pre_restore_dir, registry, bytes_written, duration_ms}`
 */
export function applyRestore(input) {
  const started = Date.now();
  const plan = input.plan;
  if (plan.ok !== true) {
    return { ok: false, reason_code: plan.reason_code, detail: plan.detail, dry_run: input.dryRun === true, restored: [], attachments: [], pre_restore_dir: null, bytes_written: 0, duration_ms: 0 };
  }
  if (input.dryRun === true) {
    return {
      ok: true,
      dry_run: true,
      restored: plan.candidates.map((row) => ({ session_id: row.session_id, target: row.target, conflict: row.conflict, resolution: row.resolution })),
      attachments: plan.attachments.length,
      pre_restore_dir: plan.pre_restore.dir,
      registry: plan.registry.map((row) => ({ session_id: row.session_id, actions: row.plan.actions })),
      bytes_written: 0,
      duration_ms: Date.now() - started,
    };
  }

  // Pre-restore copy first: after this point every touched path has a way back.
  const preDir = plan.pre_restore.dir;
  const copied = [];
  try {
    for (const candidate of plan.candidates) {
      if (!fs.existsSync(candidate.target)) continue;
      const copy = path.join(preDir, ...String(candidate.rel).replace(/\\/g, '/').split('/'));
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.copyFileSync(candidate.target, copy);
      copied.push(copy);
    }
    const registryFile = plan.registry.find((row) => row.plan.file !== undefined)?.plan.file ?? null;
    if (registryFile !== null && fs.existsSync(registryFile)) {
      const copy = path.join(preDir, 'workspace.json');
      fs.mkdirSync(preDir, { recursive: true });
      fs.copyFileSync(registryFile, copy);
      copied.push(copy);
    }
    fs.mkdirSync(preDir, { recursive: true });
  } catch (error) {
    return { ok: false, reason_code: RESTORE_CODES.WRITE_FAILED, detail: `could not make the pre-restore copy: ${error?.message ?? error}`, dry_run: false, restored: [], attachments: [], pre_restore_dir: preDir, bytes_written: 0, duration_ms: Date.now() - started };
  }

  const restored = [];
  let bytesWritten = 0;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  try {
    for (const candidate of plan.candidates) {
      const target = candidate.resolution === 'keep-both' ? `${candidate.target}.restored-${stamp}` : candidate.target;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, candidate.buffer);
      bytesWritten += candidate.buffer.length;
      restored.push({ session_id: candidate.session_id, target, conflict: candidate.conflict, resolution: candidate.resolution, bytes: candidate.buffer.length, sha256: candidate.sha256 });
    }
    for (const attachment of plan.attachments) {
      if (attachment.existing) continue;
      fs.mkdirSync(path.dirname(attachment.target), { recursive: true });
      writeFileAtomic(attachment.target, attachment.buffer);
      bytesWritten += attachment.buffer.length;
    }
  } catch (error) {
    return { ok: false, reason_code: error?.code ?? RESTORE_CODES.WRITE_FAILED, detail: error?.detail ?? String(error?.message ?? error), dry_run: false, restored, attachments: [], pre_restore_dir: preDir, bytes_written: bytesWritten, duration_ms: Date.now() - started };
  }

  const registryResults = [];
  for (const row of plan.registry) {
    const applied = applyRegistryRestore({ dshHome: input.dshHome, plan: row.plan });
    registryResults.push({ session_id: row.session_id, ...applied });
    if (applied.ok !== true) {
      return {
        ok: false,
        reason_code: RESTORE_CODES.REGISTRY_FAILED,
        detail: `${row.session_id}: ${applied.detail}`,
        dry_run: false,
        restored,
        attachments: unreadAttachments(plan),
        pre_restore_dir: preDir,
        bytes_written: bytesWritten,
        registry: registryResults,
        duration_ms: Date.now() - started,
      };
    }
  }

  // Read back what was written: same bytes, and still valid as a file on disk.
  const problems = [];
  for (const row of restored) {
    const buffer = fs.readFileSync(row.target);
    if (sha256Hex(buffer) !== row.sha256) problems.push({ session_id: row.session_id, detail: 'the written file does not hash to the planned digest' });
    const verdict = diagnoseSessionBuffer(buffer, { expectedSessionId: row.session_id });
    if (verdict.ok !== true) problems.push({ session_id: row.session_id, detail: `the written file no longer validates: ${verdict.codes.join(', ')}` });
  }
  if (problems.length > 0) {
    return {
      ok: false,
      reason_code: RESTORE_CODES.VERIFY_FAILED,
      detail: problems.map((row) => `${row.session_id}: ${row.detail}`).join('; '),
      dry_run: false,
      restored,
      attachments: unreadAttachments(plan),
      pre_restore_dir: preDir,
      bytes_written: bytesWritten,
      registry: registryResults,
      duration_ms: Date.now() - started,
    };
  }

  return {
    ok: true,
    dry_run: false,
    restored,
    attachments: unreadAttachments(plan),
    pre_restore_dir: preDir,
    pre_restore_files: copied.length,
    bytes_written: bytesWritten,
    registry: registryResults,
    warnings: registryResults.filter((row) => typeof row.warning === 'string').map((row) => row.warning),
    duration_ms: Date.now() - started,
  };
}

/** Count the attachments a plan would write (they are not "restored sessions"). */
function unreadAttachments(plan) {
  return plan.attachments.filter((row) => !row.existing).length;
}

/** Re-export for callers that want the canonical slug without importing registry. */
export { workspaceSlug };

/** Where the pre-restore copies live for one home (listed by the CLI's `status`). */
export function listPreRestoreSnapshots(dshHome) {
  const root = preRestoreRoot(dshHome);
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
  return names.map((name) => ({ id: name, dir: path.join(root, name) }));
}

/** The object path the repository uses, exposed for diagnostics. */
export function repoObjectPath(root, sha256) {
  return path.join(repoPaths(root).objects, sha256.slice(0, 2), sha256);
}
