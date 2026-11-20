#!/usr/bin/env node
/**
 * `w2m-backup` command line: `status`, `scan`, `selftest`, `run`, `list`, `gc`.
 *
 * ## What this CLI is
 *
 * The operator's window onto the backup repository. In v3.4.6 it was read-only (`status`/`scan`/`selftest`);
 * v3.4.7 adds the commands that write, and they are all **explicit**: `run` performs one backup now, `list`
 * reads snapshots, `gc` removes unreferenced blocks. The scheduled path (daily 22:00) lives in the subplugin, not
 * here: a CLI process that exits cannot own a timer, and a scheduled backup must not depend on a terminal.
 *
 * ## What it never does
 *
 * No command stores a password. `run --password-stdin` reads it from stdin (never argv: a password in argv is in
 * the shell history and in every process listing), and the environment variable `W2M_BACKUP_PASSWORD` is accepted
 * for scripted use. Without either, the run opens the repository with the machine envelope only.
 *
 * The one argv exception is `unlock --set-password --hint "..."`: the hint is **public metadata by design**
 * (stored in clear in the repository's `keys.json` and shown by `unlock`), so putting it on the command line is
 * the intended use. A hint equal to the PIN is refused by the keystore, so the PIN cannot be smuggled in as one.
 *
 * ## The `full` whole-file-copy cap and "特批"
 *
 * `run --old-format full` refuses BEFORE writing when a session file that would become an old version is larger
 * than `--max-full-copy-mb` (default 300; `0` = no cap). `--allow-large-full-copy` approves that one run; without
 * it an interactive TTY asks `...是否特批本次写入？[y/N]` once and only `y` retries (a non-interactive stdin prints
 * the flag and exits 1 instead of waiting). The question goes to stderr in `--json` mode, so stdout stays JSON.
 *
 * `unlock --rotate-password` follows the same rule for both secrets: the new PIN comes from stdin or
 * `W2M_BACKUP_PASSWORD`, and the old PIN (only needed when the machine/account path cannot open the repository)
 * comes from `W2M_BACKUP_OLD_PASSWORD` or `--old-password-stdin`. With one stdin stream both are passed as two
 * lines (`old\nnew`). The hint stays public metadata, so `--hint` may be on argv, and `--clear-hint` drops it.
 *
 * ## The size of `old/` is not capped; it is reported and reminded (v3.5.0, §24.3)
 *
 * The user's decision is "no total limit on `old/`; remind every 10 GB and let the user decide whether to clean up
 * manually". `run` therefore prints `old usage : X GB (Y files)` and, once the tree has grown by
 * `--old-usage-reminder-gb` (default 10; `0` = reminders off) since the persisted acknowledgement, also the
 * reminder warning plus the manual-cleanup hint (`w2m-backup gc --dry-run` first). `status` prints the same size
 * and whether a reminder is pending, and `gc` prints `old usage before/after : X GB -> Y GB`. This CLI never
 * deletes anything because a size was crossed, and it has no acknowledgement command: acknowledging is the panel's
 * 「知道了」 action (`POST /api/w2m/backup/old-usage/ack`), which only moves the ack mark.
 *
 * Exit codes: 0 success; 1 a named refusal (the code is printed); 2 usage error.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BackupLayoutError, LAYOUT_CODES, REPO_ENCRYPTION_MODES, resolveBackupDir } from './layout.mjs';
import { scanHome } from './scan.mjs';
import { selftest } from './crypto.mjs';
import { buildManifest, manifestDigest, manifestSummary } from './manifest.mjs';
import { buildStatus } from './routes.mjs';
import { runBackup, SCOPES } from './engine.mjs';
import { OLD_FORMATS, oldUsageGbText, oldUsageReminderWarning } from './rotation.mjs';
import { backfillOldFullCopies } from './old-backfill.mjs';
import { applyOldRestore, planOldRestore } from './old-restore.mjs';
import { gc } from './gc.mjs';
import { openRepo } from './repo.mjs';
import { buildArchive } from './archive.mjs';
import { applyRestore, planRestore, planRestoreFromArchive } from './restore.mjs';
import { detectClientRunning } from './client.mjs';
import { recheckRegistry } from './registry-watch.mjs';
import { applyRegister, planRegister } from './register.mjs';
import { REGISTER_RESIDUAL_RISK_LINE, watchRegistrationSync } from './register-watch.mjs';
import { buildRuntimeVerdictRecord, readBackupState, writeBackupState } from './runtime-verdict.mjs';
import { describeUnlock, unlockRepo } from './unlock.mjs';
import {
  MIN_PASSWORD_BYTES,
  UNENCRYPTED_WARNING,
  WEAK_PIN_WARNING,
  rotatePassword,
  setEncryptionMode,
  setRepositoryPassword,
} from './keystore.mjs';
import { verifyRepo } from './verify.mjs';
import { BACKUP_MEMORY_GUARD } from './memory-guard.mjs';

/** Human-readable bytes: `172.0 MB`, `1.2 GB`. */
export function humanBytes(bytes) {
  const value = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${index === 0 ? String(size) : size.toFixed(1)} ${units[index]}`;
}

/** The named engine refusal that asks for a human ("特批") approval before writing oversized full copies. */
export const FULL_COPY_APPROVAL_CODE = 'BACKUP_FULL_COPY_APPROVAL_REQUIRED';

/**
 * The full-copy cap as MB text: the default 300 MiB cap reads `300`, a fractional cap keeps two decimals.
 *
 * The cap is stored in bytes (it is compared against `fs.statSync().size`), but the operator-facing unit is MB
 * because that is how the requirement and the design document phrase it.
 */
export function fullCopyCapText(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0';
  const mb = value / (1024 * 1024);
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(2).replace(/\.?0+$/u, '');
}

/**
 * The interactive question asked when a `full` run needs an over-cap approval.
 *
 * Deliberately explicit about "this write only" (特批本次写入): answering y approves one run, it does not lift the
 * cap for later runs. The default is N -- an empty line refuses -- and the CLI never prompts a non-interactive
 * stdin (a script must pass `--allow-large-full-copy`).
 *
 * @param {object} result the `BACKUP_FULL_COPY_APPROVAL_REQUIRED` refusal from the engine
 * @returns {string}
 */
export function formatFullCopyApprovalPrompt(result) {
  const count = Number(result?.over_cap_count) || 0;
  const cap = fullCopyCapText(result?.cap_bytes);
  const rows = Array.isArray(result?.full_copy_oversized) ? result.full_copy_oversized : [];
  const names = rows.slice(0, 5).map((row) => String(row?.session_id ?? '')).filter((name) => name !== '');
  const shown = names.length === 0 ? '' : `（${names.join('、')}${count > names.length ? ' 等' : ''}）`;
  return `${count} 个会话的 full 副本超过 ${cap} MB${shown}：是否特批本次写入？[y/N] `;
}

/** Injected TTY seam first (`io.stdinIsTTY`), then a possibly absent `process.stdin`: a test never needs a TTY. */
function stdinIsInteractive(io) {
  if (typeof io?.stdinIsTTY === 'boolean') return io.stdinIsTTY;
  if (typeof io?.stdin?.isTTY === 'boolean') return io.stdin.isTTY;
  return process.stdin?.isTTY === true;
}

/**
 * Print a question and read one line synchronously.
 *
 * `io.ask(question)` is the test seam (it returns the answer instead of reading stdin); production reads fd 0,
 * which is the same primitive `--password-stdin` already uses. A read failure is an empty answer, i.e. "no".
 */
function askLine(io, write, question) {
  write(question);
  if (typeof io?.ask === 'function') {
    const injected = io.ask(question);
    return typeof injected === 'string' ? injected : String(injected ?? '');
  }
  const buffer = Buffer.alloc(256);
  try {
    const read = fs.readSync(0, buffer, 0, buffer.length, null);
    return buffer.subarray(0, read).toString('utf8').replace(/\r?\n$/u, '');
  } catch {
    return '';
  }
}

/** Render the unlock probe for a terminal. */
export function formatUnlock(payload) {
  const lines = ['w2m-backup unlock', ''];
  lines.push(`repository    : ${payload.repository}`);
  lines.push(`initialized   : ${payload.initialized ? 'yes' : 'no'}`);
  if (payload.encryption !== undefined && payload.encryption !== null) {
    lines.push(`protection    : ${payload.encryption}${payload.encryption === 'none' ? ' (no credential required)' : ''}`);
  }
  if (Array.isArray(payload.available_paths) && payload.available_paths.length > 0) {
    lines.push(`available     : ${payload.available_paths.join(', ')}`);
  }
  if (payload.warning !== undefined && payload.warning !== null) {
    lines.push(`warning       : ${payload.warning}`);
  }
  if (payload.initialized) {
    lines.push(`envelopes     : ${payload.envelopes.join(', ') || 'none'}`);
    if (payload.encryption === 'none') {
      lines.push('unlock path   : none (the data key sits next to the data; anyone with this directory can restore)');
      lines.push('disable       : already unprotected (w2m-backup unlock --disable-protection is a no-op)');
    } else {
      lines.push(`machine path  : ${payload.machine_available ? 'available on this machine' : `unavailable (${payload.machine_reason ?? 'unknown'})`}`);
      // The account path is a comparison, not a secret: bound + matched means the account envelope opens without
      // a password; mismatch says to use the unlock password/PIN. Only the masked hint is printed.
      const account = payload.account ?? null;
      if (account === null || account.bound !== true) {
        lines.push('account path  : not bound (an identity binding is added after a successful sealed run)');
      } else if (account.matched === true) {
        lines.push(`account path  : matched (original account ${account.id_hint ?? '…'}) -- unlocks without a PIN`);
      } else if (account.matched === false) {
        lines.push(`account path  : this is not the original account (${account.id_hint ?? '…'}) -- switch to the unlock PIN/password`);
      } else {
        lines.push(`account path  : bound (${account.id_hint ?? '…'}), not compared -- pass --account-id to compare`);
      }
      lines.push(`password path : ${payload.password_required ? `available (a ${MIN_PASSWORD_BYTES}-6 digit PIN is a convenience gate, not confidentiality)` : 'not configured'}`);
    }
  }
  // The PUBLIC "备注提示词" (`--hint`): plain text on purpose, so it is printed verbatim to whoever asks how to
  // unlock. It never contains the PIN (the writer refuses a hint equal to the PIN).
  const passwordHint = payload.password_hint ?? null;
  if (passwordHint !== null && typeof passwordHint === 'object' && passwordHint.set === true && typeof passwordHint.text === 'string') {
    lines.push(`密码提示：${passwordHint.text}`);
  }
  if (payload.check !== undefined) {
    lines.push(`check         : ${payload.check.ok ? `opened via ${payload.check.via}` : `refused: ${payload.check.reason_code} ${payload.check.detail ?? ''}`.trimEnd()}`);
  }
  if (payload.ok !== true) lines.push(`refusal       : ${payload.reason_code} ${payload.detail ?? ''}`.trimEnd());
  return lines.join('\n');
}

/** Render a verification report for a terminal. */
export function formatVerify(result) {
  const lines = ['w2m-backup verify', ''];
  if (result.ok !== true) {
    lines.push(`refused       : ${result.reason_code} ${result.detail ?? ''}`.trimEnd());
    return lines.join('\n');
  }
  lines.push(`snapshots     : ${result.counts.snapshots}`);
  lines.push(`files         : ${result.counts.files} (${humanBytes(result.counts.bytes)})`);
  lines.push(`blocks        : ${result.counts.blocks}`);
  lines.push(`old versions  : ${result.counts.old}`);
  if (result.old_copies !== undefined && result.old_copies !== null) {
    const copies = result.old_copies;
    lines.push(`old copies    : ${copies.ok} ok / ${copies.failed} failed / ${copies.missing} missing`);
    // v3.5.1 bounded reader/guard: say which checks were skipped or refused rather than implying a clean pass.
    if (result.streaming !== undefined && result.streaming !== null) {
      lines.push(
        `streamed      : ${result.streaming.files} file(s) (${humanBytes(result.streaming.bytes)}) above ` +
          `${humanBytes(result.streaming.threshold_bytes)}; peak block ${humanBytes(result.streaming.peak_block_bytes)}`,
      );
    }
    if (Number(result.future_append?.skipped) > 0) {
      lines.push(`future append : ${result.future_append.skipped} session(s) deferred (large/streamed; bytes still digest-verified)`);
    }
    if (Number(result.runtime_verified?.skipped) > 0) {
      lines.push(`runtime check : ${result.runtime_verified.skipped} session(s) skipped (above the runtime byte limit)`);
    }
    if (Number(result.memory_guard?.refusals) > 0) {
      lines.push(`memory guard  : ${result.memory_guard.refusals} materialisation(s) REFUSED by ${BACKUP_MEMORY_GUARD}`);
    }
  if (result.coverage !== null && result.coverage !== undefined) {
    const cov = result.coverage;
    lines.push(`coverage      : ${cov.percent}% (covered ${(cov.covered.bytes / 1024 ** 2).toFixed(1)} MB / home ${(cov.home.bytes / 1024 ** 2).toFixed(1)} MB), gaps: ${cov.gap_count}`);
    if (cov.gap_count > 0) {
      for (const rel of cov.gaps.slice(0, 5)) lines.push(`gap           : ${rel}`);
    }
  }
  }
  lines.push(`current ptrs  : ${result.counts.current}`);
  lines.push(`future append : ${result.future_append.checked - result.future_append.failed}/${result.future_append.checked} passed`);
  // A distinct session can appear in many snapshots; the problems list is deduplicated per session content, so the
  // occurrence count and the distinct-session count are both worth saying out loud.
  if (Array.isArray(result.future_append.failed_sessions) && result.future_append.failed_sessions.length !== result.future_append.failed) {
    lines.push(`future append : ${result.future_append.failed_sessions.length} distinct session(s) across ${result.future_append.failed} failing snapshot check(s)`);
  }
  // The named observation is not a problem: it says the append probe could not certify the artifact, and the reason
  // names the container finding that IS reported as one.
  const futureObservations = result.future_append.observations ?? [];
  if (futureObservations.length > 0) {
    lines.push(`future append : ${futureObservations.length} session(s) the append probe cannot certify (${futureObservations[0].code})`);
    for (const observation of futureObservations.slice(0, 5)) {
      lines.push(`  - observation ${observation.code} ${observation.file ?? ''}`.trimEnd());
    }
  }
  if (result.runtime_verified.checked > 0) lines.push(`runtime check : ${result.runtime_verified.checked - result.runtime_verified.failed}/${result.runtime_verified.checked} passed`);
  lines.push(`result        : ${result.ok ? 'every claim holds' : `${result.problems.length} problem(s)`}`);
  for (const problem of result.problems.slice(0, 12)) lines.push(`  - ${problem.code} ${problem.file ?? ''} ${problem.detail}`.trimEnd());
  return lines.join('\n');
}

/** Render an archive result for a terminal. */
export function formatArchive(result) {
  const lines = ['w2m-backup archive', ''];
  if (result.ok !== true) {
    lines.push(`refused       : ${result.reason_code} ${result.detail ?? ''}`.trimEnd());
    return lines.join('\n');
  }
  lines.push(`file          : ${result.file}`);
  lines.push(`snapshot      : ${result.source_snapshot}`);
  lines.push(`sessions      : ${result.sessions}`);
  lines.push(`files         : ${result.files}`);
  if ((result.counts?.restore_copies_excluded ?? 0) > 0) {
    lines.push(`restore copies: ${result.counts.restore_copies_excluded} excluded (recovery material, not packed)`);
  }
  lines.push(`size          : ${humanBytes(result.bytes)} tar -> ${humanBytes(result.compressed_bytes)} zstd`);
  return lines.join('\n');
}

/** Render a restore plan or result for a terminal. */
export function formatRestore(plan, applied) {
  const lines = ['w2m-backup restore', ''];
  if (plan.ok !== true) {
    lines.push(`refused       : ${plan.reason_code} ${plan.detail ?? ''}`.trimEnd());
    return lines.join('\n');
  }
  lines.push(`source        : ${plan.source?.kind === 'archive' ? `archive ${plan.source.archive_file}` : `repository snapshot ${plan.snapshot_id}`}`);
  lines.push(`sessions      : ${plan.summary.sessions} (new ${plan.summary.new}, identical ${plan.summary.identical}, conflict ${plan.summary.conflicts})`);
  lines.push(`attachments   : ${plan.summary.attachments}`);
  lines.push(`runtime check : ${plan.summary.runtime_verified}/${plan.summary.sessions} sessions validated by the installed Harness`);
  if (plan.restore_copies !== undefined && plan.restore_copies !== null && (plan.restore_copies.count ?? 0) > 0) {
    lines.push(`restore copies: ${plan.restore_copies.count} skipped (${plan.restore_copies.detail})`);
  }
  lines.push(`pre-restore   : ${plan.pre_restore.dir}`);
  for (const candidate of plan.candidates) {
    lines.push(`  - ${candidate.session_id} ${candidate.conflict}${candidate.resolution === 'backup-and-replace' ? ' -> backup then replace' : ''}`);
  }
  if (applied === undefined) {
    lines.push('');
    lines.push('dry run: nothing was written. Re-run with --apply to restore.');
    return lines.join('\n');
  }
  lines.push('');
  if (applied.ok !== true) {
    lines.push(`failed        : ${applied.reason_code} ${applied.detail ?? ''}`.trimEnd());
    if (applied.pre_restore_dir) lines.push(`pre-restore   : ${applied.pre_restore_dir} (the way back)`);
    return lines.join('\n');
  }
  lines.push(`written       : ${applied.restored.length} session(s), ${humanBytes(applied.bytes_written)}`);
  lines.push(`registry      : ${applied.registry.filter((row) => row.ok).length}/${applied.registry.length} verified`);
  if (applied.registry_recheck !== undefined) {
    lines.push(`re-check      : ${applied.registry_recheck.ok ? 'still holds' : 'STILL OVERWRITTEN'} (rewrote: ${applied.registry_recheck.rewrote ? 'yes' : 'no'})`);
  }
  if (applied.pre_restore_dir) lines.push(`pre-restore   : ${applied.pre_restore_dir}`);
  for (const warning of applied.warnings ?? []) lines.push(`warning       : ${warning}`);
  return lines.join('\n');
}

/** Render a register plan or result for a terminal. */
export function formatRegister(plan, applied) {
  const lines = ['w2m-backup register', ''];
  lines.push(`DSH home      : ${plan.dsh_home ?? '—'}`);
  if (typeof plan.workspace_path === 'string' && plan.workspace_path !== '') lines.push(`workspace     : ${plan.workspace_path}`);
  lines.push(`requested     : ${Array.isArray(plan.requested) ? plan.requested.length : 0} session(s)`);
  if (plan.ok !== true) {
    lines.push(`refused       : ${plan.reason_code} ${plan.detail ?? ''}`.trimEnd());
    if (Array.isArray(plan.unknown) && plan.unknown.length > 0) lines.push(`unknown       : ${plan.unknown.join(', ')}`);
    lines.push('');
    lines.push('nothing was written.');
    return lines.join('\n');
  }
  const already = Array.isArray(plan.already_registered) ? plan.already_registered : [];
  if (already.length > 0) lines.push(`already reg.  : ${already.join(', ')}`);
  const result = applied === undefined ? null : applied;
  const registered = result === null ? (Array.isArray(plan.registered) ? plan.registered : []) : result.registered;
  lines.push(`registered    : ${registered.length > 0 ? registered.join(', ') : '(none)'}`);
  for (const action of (result === null ? plan.actions : result.actions) ?? []) lines.push(`  - ${action}`);
  if (result === null) {
    lines.push('');
    lines.push(plan.changed === true ? 'dry run: nothing was written. Re-run without --dry-run to register.' : 'nothing to do: every requested session is already registered.');
    return lines.join('\n');
  }
  lines.push(`registry      : ${result.verified === true ? 'verified (read back)' : 'NOT VERIFIED'}`);
  if (typeof result.backup_file === 'string' && result.backup_file !== '') lines.push(`registry copy : ${result.backup_file}`);
  if (result.pruned_register_backups !== null && result.pruned_register_backups !== undefined) {
    const pruned = result.pruned_register_backups;
    lines.push(`copies kept   : ${pruned.kept.length} of ${pruned.scanned} (pruned ${pruned.removed_count})`);
  }
  if (result.recheck !== undefined) {
    lines.push(`re-check      : ${result.recheck.ok ? 'still holds' : 'STILL OVERWRITTEN'} (rewrote: ${result.recheck.rewrote ? 'yes' : 'no'})`);
  }
  if (result.watch !== undefined && result.watch !== null) {
    const watch = result.watch;
    lines.push(
      `watch         : ${watch.minutes} min · ${watch.samples} sample(s) · clobbered ${watch.clobbered} · re-applied ${watch.reapplied}` +
        (typeof watch.stable_at === 'string' && watch.stable_at !== '' ? ` · stable since ${watch.stable_at}` : ' · NOT STABLE at the last sample'),
    );
  }
  if (typeof result.residual_risk === 'string') lines.push(`residual risk : ${result.residual_risk}`);
  if (typeof result.warning === 'string') lines.push(`warning       : ${result.warning}`);
  return lines.join('\n');
}

function usage() {
  return [
    'usage: w2m-backup <command> [options]',
    '',
    'commands:',
    '  status              where the repository is, whether it exists, free space (read-only)',
    '  scan                what a backup would copy: sessions, registry flags, attachments (read-only)',
    '  selftest            wrap/unwrap and tamper self-test of the backup cryptography (memory only)',
    '  run                 perform one backup now (writes blocks, a snapshot and rotation records)',
    '  list                snapshots in the repository, newest first (read-only)',
    '  gc                  remove unreferenced blocks and prune old versions (writes)',
    '  old-backfill        write the optional sealed whole-file copy for old/ records that predate full mode (writes)',
    '  old-restore         restore one superseded version from its sealed full copy under old/ (plan; --apply writes)',
    '  unlock              which credential opens this repository (read-only; --check tries it). Writing modes:',
    '                      --set-password adds a PIN, --rotate-password changes an existing one',
    '  verify              re-hash every snapshot: blocks, bytes, manifests, index, old records',
    '  archive             pack archived sessions (or --scope all) into one .tar.zst (writes)',
    '  restore             plan a restore; --apply writes sessions, attachments and the workspace registry',
    '  register            register sessions that are already on disk in the workspace registry (writes it)',
    '  help                this text',
    '',
    'options:',
    '  --dsh-home <path>   DSH home (default: $DSH_HOME, then ~/.dsh)',
    '  --backup-dir <path> repository root (default: $W2M_BACKUP_DIR, then D:\\DeepSeekHarness\\BackUP)',
    '  --json              machine-readable output',
    '  --deep              decompress every session log (event counts; slower)',
    '  --hash              hash every file (sha256; slower)',
    '  --manifest          build the in-memory manifest and print its digest (no writes)',
    '  --scope <s>         run: all | active | archived | selected (default: all)',
    '  --scopes <list>     run: sessions,attachments,registry,config,state,restore_copies (default: all six)',
    '  --include-secrets   run: also back up credentials (device keys, account credentials): off by default,',
    '                      the repository then holds everything needed to act as this machine/account',
    '  --session <id>      run --scope selected / register: a session id (repeatable)',
    '  --keep-old <n>      old versions kept per session (default: 10)',
    '  --old-format <f>    run: how a superseded version is kept: records (default, deduped record only)',
    '                      or full (also one sealed whole-file copy under old/, doubling that version\'s bytes)',
    '  --max-full-copy-mb <n>  run: cap on one full whole-file copy in MB (default 300; 0 = no cap). A session',
    '                      file larger than the cap refuses the run BEFORE any write unless it is approved.',
    '  --allow-large-full-copy run: explicitly approve this run when the full-copy cap is exceeded ("特批").',
    '                      Without it an interactive terminal asks y/N; a non-interactive run prints this flag',
    '                      and refuses without writing.',
    '  --old-usage-reminder-gb <n>  run: remind when old/ has grown by N GB since the last acknowledgement',
    '                      (default 10; 0 = reminders off). The reminder never deletes anything: clean up',
    '                      manually with `w2m-backup gc --dry-run` first, then `w2m-backup gc`.',
    '  --encrypt <mode>    run: repository protection for a NEW repository: none (default, unencrypted) or sealed',
    '                      (account/machine/PIN envelopes). An existing repository keeps its mode.',
    '  --no-encryption     run: shorthand for --encrypt none',
    '  --max-old-days <n>  run/gc: also prune old version records older than N days (0 = per-session count only)',
    '  --limit <n>         old-backfill: write at most N sealed copies this run (0 = plan only, writes nothing)',
    '  --record <path>     old-restore: the exact old/ version record to restore from',
    '  --rel <rel>         old-restore --session: narrow the match to this session log rel path',
    '  --latest-for <id>   old-restore: restore the newest version record of this session',
    '  --out <file>        old-restore: write the recovered log here (default: <record>.restored)',
    '  --overwrite         old-restore: replace an existing target (a .bak-<ts> copy is written first)',
    '  --force-invalid     old-restore: write even when the recovered log fails the static doctor',
    '  --mirror <dir>      run: copy the sealed blocks and snapshot metadata to this offsite directory',
    '  --dry-run           run/gc/old-backfill/restore/register: report what would happen, write nothing',
    '  --snapshot <id>     verify/archive/restore: a specific snapshot (default: the latest)',
    '  --archive <file>    restore: read the session bytes from a .tar.zst archive instead of the repository',
    '  --apply             restore/old-restore: actually write (without it, only the plan is printed)',
    '  --keep-both         restore/old-restore: keep an existing different file and write the restored one beside it',
    '  --allow-static-validation  restore: accept static-only evidence when no Harness is installed',
    '  --allow-live-home   restore/register: write even though the DSH client is running (read-back + recheck protocol)',
    '  --watch <minutes>   register: after writing, sample the registry for this many minutes (2/8/20/60 s, then every 60 s)',
    '                      and re-apply the same plan if a sample shows the client overwrote it (0 = no watch)',
    '  --registry-recheck <ms>  restore --apply / register: wait this long, then re-check the registry once (client save)',
    '  --workspace-path <p> restore/register: attach an unknown workspace to this directory, or create the registry there',
    '  --runtime           verify/run: confirm with the installed Harness validator (G5), not only the pre-filter',
    '  --runtime-verify    run: after a successful backup, run one full runtime verify and persist its verdict',
    '                      (cached for the panel; a failed verdict is reported as a warning, the backup stays ok)',
    '  --account-id <id>   unlock/run: the host account id to compare against the repository\'s bound id',
    '                      (advanced/manual: the host normally supplies it; the account id is an identifier,',
    '                      not a secret -- see docs/BACKUP-DESIGN.md section 25. `run --account-id` also binds',
    '                      it after a successful sealed run, so a matching account unlocks later without a PIN)',
    '  --check             unlock: attempt the unlock instead of only describing it',
    '  --set-password      unlock: add a password/PIN envelope to this repository (reads it from stdin/env) so it',
    '                      opens without this machine. 4-6 digits are the expected PIN: convenience, not',
    '                      confidentiality (the CLI prints that warning). Also turns an unencrypted repository',
    '                      back into a sealed one. A repository that already has a PIN is a no-op: use',
    '                      --rotate-password to change it.',
    '  --enable-protection alias of --set-password (turning protection on needs a PIN/password)',
    '  --rotate-password   unlock: change the existing PIN/PIN hint: open with a working credential (machine, a',
    '                      matching account id, or the old PIN), remove every old PIN envelope, write one new PIN',
    '                      envelope around the SAME data key, then verify the new PIN opens it and the OLD PIN no',
    '                      longer does (keys.json is copied to .bak-<ts> first and restored if a check fails).',
    '                      The new PIN comes from stdin/env like --set-password; the old PIN (only needed when the',
    '                      machine/account path cannot open the repository) from W2M_BACKUP_OLD_PASSWORD or',
    '                      --old-password-stdin. Without --hint the old public hint is dropped.',
    '  --hint <text>       unlock --set-password: attach a PUBLIC hint/note to the PIN (e.g. --hint "周六生日"),',
    '                      stored in the repository and printed by unlock. It is NOT a secret: it is plain text',
    '                      in keys.json, so argv is allowed for it (unlike the PIN, which stays on stdin).',
    '                      unlock --rotate-password: REPLACE the stored hint with this text; omitting it (or',
    '                      --clear-hint) drops the old hint. A new hint only replaces, it never appends.',
    '  --clear-hint        unlock --rotate-password: remove the stored public hint (the explicit spelling of omitting',
    '                      --hint). Cannot be combined with --hint.',
    '  --old-password-stdin unlock --rotate-password: read the OLD PIN from stdin; the new PIN then comes from',
    '                      W2M_BACKUP_PASSWORD (stdin is already taken). Not combinable with --password-stdin;',
    '                      that flag accepts both secrets as two lines: old\\nnew.',
    '  --disable-protection unlock: turn protection OFF: open with existing credentials, write an open envelope',
    '                      carrying the same data key; the repository then unlocks with no credential at all.',
    '                      Requires --confirm disable-protection because it weakens the repository.',
    '  --confirm <token>   unlock --disable-protection: the explicit confirmation token (disable-protection)',
    '  --password-stdin    run/restore/unlock --check/--set-password/--rotate-password/old-backfill: read the',
    '                      PIN/password from stdin (never argv) (environment fallback: W2M_BACKUP_PASSWORD, same',
    '                      "never argv" rule). With --rotate-password, two lines are accepted: old PIN, then new PIN.',
    '  --no-machine-key    run: do not use (or create) the OS-keystore machine envelope',
    '  --no-future-append  run: skip the "next append still loads" simulation (it decodes every log)',
    '',
    'scheduling: the daily run lives in the dsh-backup subplugin (default 22:00 Asia/Shanghai), not in this CLI.',
  ].join('\n');
}

/**
 * Parse argv.
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} [env]
 */
export function parseArgs(argv, env = process.env) {
  const options = {
    command: 'help',
    dshHome: resolveDshHome(env),
    backupDir: null,
    json: false,
    deep: false,
    hash: false,
    manifest: false,
    scope: null,
    selected: [],
    keepOld: null,
    oldFormat: null,
    maxFullCopyMb: null,
    oldUsageReminderGb: null,
    allowLargeFullCopy: false,
    maxOldDays: null,
    limit: null,
    recordFile: null,
    rel: null,
    latestFor: null,
    outFile: null,
    overwrite: false,
    forceInvalid: false,
    mirror: null,
    dryRun: false,
    passwordStdin: false,
    noMachineKey: false,
    noFutureAppend: false,
    snapshot: null,
    archiveFile: null,
    apply: false,
    keepBoth: false,
    allowStaticValidation: false,
    allowLiveHome: false,
    registryRecheckMs: 0,
    watch: 0,
    runtimeVerify: false,
    workspacePath: null,
    runtime: false,
    check: false,
    setPassword: false,
    enableProtection: false,
    // PIN rotation (docs/BACKUP-DESIGN.md §25.8): replaces the existing password envelope with a new one around the
    // same DEK. The old PIN and the new PIN never share a channel: see `rotateSecretsFor`.
    rotatePassword: false,
    oldPasswordStdin: false,
    clearHint: false,
    disableProtection: false,
    // The public "备注提示词" for a new PIN. Not a secret: it is stored in clear in keys.json, so argv is allowed
    // for it (the PIN itself never is).
    hint: null,
    confirm: null,
    encryption: null,
    accountId: null,
  };
  const rest = [...argv];
  if (rest.length > 0 && !rest[0].startsWith('-')) options.command = rest.shift();
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === '--json') options.json = true;
    else if (arg === '--deep') options.deep = true;
    else if (arg === '--hash') options.hash = true;
    else if (arg === '--manifest') options.manifest = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--password-stdin') options.passwordStdin = true;
    else if (arg === '--no-machine-key') options.noMachineKey = true;
    else if (arg === '--no-future-append') options.noFutureAppend = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--keep-both') options.keepBoth = true;
    else if (arg === '--overwrite') options.overwrite = true;
    else if (arg === '--force-invalid') options.forceInvalid = true;
    else if (arg === '--allow-static-validation') options.allowStaticValidation = true;
    else if (arg === '--allow-live-home') options.allowLiveHome = true;
    else if (arg === '--runtime') options.runtime = true;
    else if (arg === '--runtime-verify') options.runtimeVerify = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--set-password') options.setPassword = true;
    else if (arg === '--enable-protection') options.enableProtection = true;
    else if (arg === '--rotate-password') options.rotatePassword = true;
    else if (arg === '--old-password-stdin') options.oldPasswordStdin = true;
    else if (arg === '--clear-hint') options.clearHint = true;
    else if (arg === '--disable-protection') options.disableProtection = true;
    else if (arg === '--hint') {
      const raw = rest.shift() ?? '';
      if (raw.trim() === '') return { ...options, error: '--hint needs a hint text (it is public metadata, not the PIN)' };
      options.hint = raw;
    }
    else if (arg.startsWith('--hint=')) {
      const raw = arg.slice('--hint='.length);
      if (raw.trim() === '') return { ...options, error: '--hint needs a hint text (it is public metadata, not the PIN)' };
      options.hint = raw;
    }
    else if (arg === '--no-encryption') options.encryption = 'none';
    else if (arg === '--confirm') {
      const raw = rest.shift() ?? '';
      if (raw.trim() === '') return { ...options, error: '--confirm needs a token' };
      options.confirm = raw.trim();
    }
    else if (arg.startsWith('--confirm=')) {
      const raw = arg.slice('--confirm='.length);
      if (raw.trim() === '') return { ...options, error: '--confirm needs a token' };
      options.confirm = raw.trim();
    }
    else if (arg === '--encrypt') {
      const raw = rest.shift() ?? '';
      if (!REPO_ENCRYPTION_MODES.includes(raw)) {
        return { ...options, error: `--encrypt must be one of ${REPO_ENCRYPTION_MODES.join(', ')}, got ${JSON.stringify(raw)}` };
      }
      options.encryption = raw;
    }
    else if (arg.startsWith('--encrypt=')) {
      const raw = arg.slice('--encrypt='.length);
      if (!REPO_ENCRYPTION_MODES.includes(raw)) {
        return { ...options, error: `--encrypt must be one of ${REPO_ENCRYPTION_MODES.join(', ')}, got ${JSON.stringify(raw)}` };
      }
      options.encryption = raw;
    }
    else if (arg === '--account-id') {
      const raw = rest.shift() ?? '';
      if (raw.trim() === '') return { ...options, error: '--account-id needs an account id' };
      options.accountId = raw.trim();
    }
    else if (arg.startsWith('--account-id=')) {
      const raw = arg.slice('--account-id='.length);
      if (raw.trim() === '') return { ...options, error: '--account-id needs an account id' };
      options.accountId = raw.trim();
    }
    else if (arg === '--snapshot') options.snapshot = rest.shift() ?? null;
    else if (arg === '--archive') options.archiveFile = rest.shift() ?? null;
    else if (arg === '--workspace-path') options.workspacePath = path.resolve(rest.shift() ?? '');
    else if (arg === '--registry-recheck') {
      const raw = rest.shift() ?? '';
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0) return { ...options, error: `--registry-recheck needs a non-negative integer, got ${JSON.stringify(raw)}` };
      options.registryRecheckMs = value;
    }
    else if (arg === '--watch') {
      const raw = rest.shift() ?? '';
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isSafeInteger(value) || value < 0) {
        return { ...options, error: `--watch needs a non-negative integer number of minutes, got ${JSON.stringify(raw)}` };
      }
      options.watch = value;
    }
    else if (arg.startsWith('--watch=')) {
      const raw = arg.slice('--watch='.length);
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isSafeInteger(value) || value < 0) {
        return { ...options, error: `--watch needs a non-negative integer number of minutes, got ${JSON.stringify(raw)}` };
      }
      options.watch = value;
    }
    else if (arg.startsWith('--snapshot=')) options.snapshot = arg.slice('--snapshot='.length);
    else if (arg.startsWith('--archive=')) options.archiveFile = arg.slice('--archive='.length);
    else if (arg.startsWith('--workspace-path=')) options.workspacePath = path.resolve(arg.slice('--workspace-path='.length));
    else if (arg.startsWith('--max-old-days=')) {
      const raw = arg.slice('--max-old-days='.length);
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isSafeInteger(value) || value < 0) {
        return { ...options, error: `--max-old-days needs a non-negative integer, got ${JSON.stringify(raw)}` };
      }
      options.maxOldDays = value;
    } else if (arg.startsWith('--mirror=')) {
      const raw = arg.slice('--mirror='.length);
      if (raw.trim() === '') return { ...options, error: '--mirror needs a directory' };
      options.mirror = path.resolve(raw);
    }
    else if (arg === '--scope') options.scope = rest.shift() ?? null;
    else if (arg === '--scopes') {
      const raw = rest.shift() ?? '';
      options.scopes = raw.split(',').map((name) => name.trim()).filter((name) => name !== '');
      if (options.scopes.length === 0) return { ...options, error: '--scopes needs at least one scope' };
    } else if (arg.startsWith('--scopes=')) {
      const raw = arg.slice('--scopes='.length);
      options.scopes = raw.split(',').map((name) => name.trim()).filter((name) => name !== '');
      if (options.scopes.length === 0) return { ...options, error: '--scopes needs at least one scope' };
    } else if (arg === '--include-secrets') options.includeSecrets = true;
    else if (arg === '--session') options.selected.push(rest.shift() ?? '');
    else if (arg === '--keep-old') {
      const raw = rest.shift() ?? '';
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0) return { ...options, error: `--keep-old needs a non-negative integer, got ${JSON.stringify(raw)}` };
      options.keepOld = value;
    } else if (arg === '--old-format') {
      const raw = rest.shift() ?? '';
      if (!OLD_FORMATS.includes(raw)) return { ...options, error: `--old-format must be one of ${OLD_FORMATS.join(', ')}, got ${JSON.stringify(raw)}` };
      options.oldFormat = raw;
    } else if (arg.startsWith('--old-format=')) {
      const raw = arg.slice('--old-format='.length);
      if (!OLD_FORMATS.includes(raw)) return { ...options, error: `--old-format must be one of ${OLD_FORMATS.join(', ')}, got ${JSON.stringify(raw)}` };
      options.oldFormat = raw;
    } else if (arg === '--max-full-copy-mb') {
      const raw = rest.shift() ?? '';
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isSafeInteger(value) || value < 0) {
        return { ...options, error: `--max-full-copy-mb needs a non-negative integer (0 = no cap), got ${JSON.stringify(raw)}` };
      }
      options.maxFullCopyMb = value;
    } else if (arg.startsWith('--max-full-copy-mb=')) {
      const raw = arg.slice('--max-full-copy-mb='.length);
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isSafeInteger(value) || value < 0) {
        return { ...options, error: `--max-full-copy-mb needs a non-negative integer (0 = no cap), got ${JSON.stringify(raw)}` };
      }
      options.maxFullCopyMb = value;
    } else if (arg === '--old-usage-reminder-gb') {
      const raw = rest.shift() ?? '';
      const value = Number(raw);
      // A non-negative number of GB; `0` disables reminders. Fractional values are accepted (the engine consumes
      // bytes), so a 0.5 GB reminder is expressible and a test can use a tiny threshold.
      if (raw.trim() === '' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 1024 ** 3))) {
        return { ...options, error: `--old-usage-reminder-gb needs a non-negative number of GB (0 = reminders off), got ${JSON.stringify(raw)}` };
      }
      options.oldUsageReminderGb = value;
    } else if (arg.startsWith('--old-usage-reminder-gb=')) {
      const raw = arg.slice('--old-usage-reminder-gb='.length);
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 1024 ** 3))) {
        return { ...options, error: `--old-usage-reminder-gb needs a non-negative number of GB (0 = reminders off), got ${JSON.stringify(raw)}` };
      }
      options.oldUsageReminderGb = value;
    } else if (arg === '--allow-large-full-copy') {
      options.allowLargeFullCopy = true;
    } else if (arg === '--max-old-days') {
      const raw = rest.shift() ?? '';
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isSafeInteger(value) || value < 0) {
        return { ...options, error: `--max-old-days needs a non-negative integer, got ${JSON.stringify(raw)}` };
      }
      options.maxOldDays = value;
    } else if (arg === '--limit') {
      const raw = rest.shift() ?? '';
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isSafeInteger(value) || value < 0) {
        return { ...options, error: `--limit needs a non-negative integer, got ${JSON.stringify(raw)}` };
      }
      options.limit = value;
    } else if (arg.startsWith('--limit=')) {
      const raw = arg.slice('--limit='.length);
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isSafeInteger(value) || value < 0) {
        return { ...options, error: `--limit needs a non-negative integer, got ${JSON.stringify(raw)}` };
      }
      options.limit = value;
    } else if (arg === '--record') {
      const raw = rest.shift() ?? '';
      if (raw.trim() === '') return { ...options, error: '--record needs a path' };
      options.recordFile = path.resolve(raw);
    } else if (arg.startsWith('--record=')) {
      const raw = arg.slice('--record='.length);
      if (raw.trim() === '') return { ...options, error: '--record needs a path' };
      options.recordFile = path.resolve(raw);
    } else if (arg === '--rel') {
      const raw = rest.shift() ?? '';
      if (raw.trim() === '') return { ...options, error: '--rel needs a session log rel path' };
      options.rel = raw.trim();
    } else if (arg.startsWith('--rel=')) {
      const raw = arg.slice('--rel='.length);
      if (raw.trim() === '') return { ...options, error: '--rel needs a session log rel path' };
      options.rel = raw.trim();
    } else if (arg === '--latest-for') {
      const raw = rest.shift() ?? '';
      if (raw.trim() === '') return { ...options, error: '--latest-for needs a session id' };
      options.latestFor = raw.trim();
    } else if (arg.startsWith('--latest-for=')) {
      const raw = arg.slice('--latest-for='.length);
      if (raw.trim() === '') return { ...options, error: '--latest-for needs a session id' };
      options.latestFor = raw.trim();
    } else if (arg === '--out') {
      const raw = rest.shift() ?? '';
      if (raw.trim() === '') return { ...options, error: '--out needs a file path' };
      options.outFile = path.resolve(raw);
    } else if (arg.startsWith('--out=')) {
      const raw = arg.slice('--out='.length);
      if (raw.trim() === '') return { ...options, error: '--out needs a file path' };
      options.outFile = path.resolve(raw);
    } else if (arg === '--mirror') {
      const raw = rest.shift() ?? '';
      if (raw.trim() === '') return { ...options, error: '--mirror needs a directory' };
      options.mirror = path.resolve(raw);
    } else if (arg === '--help' || arg === '-h') options.command = 'help';
    else if (arg === '--dsh-home') options.dshHome = path.resolve(rest.shift() ?? options.dshHome);
    else if (arg === '--backup-dir') options.backupDir = path.resolve(rest.shift() ?? '');
    else if (arg.startsWith('--dsh-home=')) options.dshHome = path.resolve(arg.slice('--dsh-home='.length));
    else if (arg.startsWith('--backup-dir=')) options.backupDir = path.resolve(arg.slice('--backup-dir='.length));
    else if (arg.startsWith('--scope=')) options.scope = arg.slice('--scope='.length);
    else if (arg.startsWith('--session=')) options.selected.push(arg.slice('--session='.length));
    else return { ...options, error: `unknown argument: ${arg}` };
  }
  return options;
}

/** `$DSH_HOME`, then `~/.dsh`. */
export function resolveDshHome(env = process.env) {
  const explicit = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return explicit !== '' ? path.resolve(explicit) : path.join(os.homedir(), '.dsh');
}

/** Render a status payload for a terminal. */
export function formatStatus(payload) {
  const lines = [];
  const repo = payload.repository ?? null;
  lines.push('w2m-backup status');
  lines.push('');
  lines.push(`DSH home      : ${payload.dsh_home}`);
  if (repo === null) {
    lines.push(`repository    : ${payload.detail ?? 'could not be resolved'}`);
    return lines.join('\n');
  }
  lines.push(`repository    : ${repo.root}`);
  lines.push(`exists        : ${repo.exists ? 'yes' : 'no (the first backup creates it)'}`);
  if (repo.is_file) lines.push('state         : the path is a file, not a directory');
  lines.push(`initialized   : ${repo.initialized ? `yes (${repo.format} v${repo.version})` : 'no'}`);
  if (payload.encryption !== undefined && payload.encryption !== null) {
    lines.push(`protection    : ${payload.encryption}${payload.encryption === 'none' ? ' (unencrypted)' : ''}`);
  } else if (repo.encryption !== undefined && repo.encryption !== null) {
    lines.push(`protection    : ${repo.encryption}`);
  }
  if (Array.isArray(payload.available_paths) && payload.available_paths.length > 0) {
    lines.push(`unlock paths  : ${payload.available_paths.join(', ')}`);
  }
  if (payload.warning !== undefined && payload.warning !== null) lines.push(`warning       : ${payload.warning}`);
  // `null` means "not measurable without creating the directory", which is not the same as "not writable".
  lines.push(`writable      : ${repo.writable === null ? 'unknown (not created yet)' : repo.writable ? 'yes' : 'NO'}`);
  lines.push(`free space    : ${repo.free_bytes === null ? 'unknown' : humanBytes(repo.free_bytes)}`);
  // `old/` has no total cap (v3.5.0 §24.3): the size and whether a growth reminder is pending are the two facts the
  // operator needs to decide whether to clean up manually. A missing `old_usage` (an older payload) prints nothing.
  const oldUsage = payload.old_usage !== null && payload.old_usage !== undefined && typeof payload.old_usage === 'object'
    ? payload.old_usage
    : null;
  if (oldUsage !== null) {
    lines.push(`old usage     : ${oldUsageGbText(oldUsage.bytes)} GB (${Number(oldUsage.files) || 0} file(s))`);
    const pending = oldUsage.pending === true || oldUsage.due === true;
    const dueText = pending
      ? `pending (自上次确认增加 ${oldUsageGbText(oldUsage.since_last_ack_bytes)} GB，阈值 ${oldUsageGbText(oldUsage.reminder_bytes)} GB)`
      : (Number(oldUsage.reminder_bytes) === 0 ? 'off (reminders disabled)' : 'none');
    lines.push(`reminder      : ${dueText}`);
  }
  if (repo.initialized) {
    lines.push(`objects       : ${repo.counts.objects} prefix(es)`);
    lines.push(`snapshots     : ${repo.counts.snapshots}`);
    lines.push(`old versions  : ${repo.counts.old}`);
    if (repo.latest !== undefined && repo.latest !== null) {
      lines.push(`latest        : ${repo.latest.snapshot_id} (${repo.latest.sessions} session(s), ${humanBytes(repo.latest.bytes)})`);
      lines.push(`latest digest : ${repo.latest.digest}`);
    }
    if (repo.index !== undefined) {
      lines.push(`index         : ${repo.index.entries} entr(ies)${repo.index.torn_tail ? ', TORN tail' : ''}${repo.index.problems > 0 ? `, ${repo.index.problems} problem(s)` : ''}`);
    }
  }
  lines.push(`schedule      : ${payload.schedule.times.join(', ')} ${payload.schedule.time_zone} (${payload.schedule.implemented ? 'active' : 'engine in v3.4.7'})`);
  // v3.5.1: a missed slot is a PENDING state, not a run that happens inside the plugin mount. The CLI says which
  // slot and what clears it, because "the backup will run at some point" is not an answer an operator can act on.
  const pendingCatchUp = payload.pending_catch_up !== null && payload.pending_catch_up !== undefined && typeof payload.pending_catch_up === 'object'
    ? payload.pending_catch_up
    : null;
  if (pendingCatchUp === null) {
    lines.push('catch-up      : none pending');
  } else {
    lines.push(
      `catch-up      : PENDING missed slot ${String(pendingCatchUp.missed_slot ?? '?')} (` +
        `${pendingCatchUp.on_start_enabled === true ? 'runs at start: opt-in enabled' : 'not run at mount; run a backup explicitly to clear it'})`,
    );
  }
  if (payload.ok !== true) lines.push(`refusal       : ${payload.reason_code} ${payload.detail ?? ''}`.trimEnd());
  return lines.join('\n');
}

/** Render a scan payload for a terminal. */
export function formatScan(payload) {
  const totals = payload.totals ?? {};
  const lines = [];
  lines.push('w2m-backup scan (read-only)');
  lines.push('');
  lines.push(`DSH home      : ${payload.dsh_home}${payload.exists ? '' : ' (does not exist)'}`);
  lines.push(`sessions      : ${totals.sessions ?? 0} (${humanBytes(totals.session_bytes ?? 0)})`);
  lines.push(`  archived    : ${totals.archived ?? 0}`);
  lines.push(`  pinned      : ${totals.pinned ?? 0}`);
  lines.push(`  unregistered: ${totals.unregistered ?? 0}`);
  lines.push(`  unreadable  : ${totals.sessions_bad ?? 0}`);
  lines.push(`attachments   : ${totals.attachments ?? 0} (${humanBytes(totals.attachment_bytes ?? 0)})`);
  lines.push(`registry      : ${payload.registry.ok ? 'readable' : 'UNREADABLE'} (${payload.registry.workspaces} workspace(s), ${payload.registry.registered} registered)`);
  for (const row of payload.totals?.by_workspace ?? []) {
    lines.push(`  ${row.workspace.padEnd(28)} ${String(row.sessions).padStart(3)} session(s)  ${humanBytes(row.bytes)}`);
  }
  if (Array.isArray(payload.sessions)) {
    lines.push('');
    lines.push('session                                      size      archived pinned reg  verdict');
    for (const row of payload.sessions) {
      lines.push(
        `${row.rel.replace(/^sessions\//, '').padEnd(44).slice(0, 44)} ${humanBytes(row.size).padStart(9)} ` +
          `${row.flags?.archived === true ? 'yes' : ' - '}    ${row.flags?.pinned === true ? 'yes' : ' - '}   ${row.flags?.registered === true ? 'yes' : 'NO '}  ${row.ok ? 'ok' : `FAIL ${row.codes.join(',')}`}`,
      );
    }
  }
  if (Array.isArray(payload.exclusions) && payload.exclusions.length > 0) {
    lines.push('');
    lines.push('excluded (regenerable caches):');
    for (const entry of payload.exclusions) lines.push(`  ${entry.rel} — ${entry.reason}`);
  }
  return lines.join('\n');
}

/** Render a self-test result for a terminal. */
export function formatSelftest(result) {
  const lines = ['w2m-backup selftest', ''];
  for (const step of result.steps) {
    lines.push(`${step.ok ? 'PASS' : 'FAIL'}  ${step.name}${step.ok ? '' : `  (${step.code}: ${step.detail})`}`);
  }
  lines.push('');
  lines.push(result.ok ? 'result: OK — this machine can wrap and unwrap the backup key' : `result: FAILED (${result.code})`);
  return lines.join('\n');
}

/** Render a backup run summary for a terminal. */
export function formatRun(result) {
  const lines = ['w2m-backup run', ''];
  if (result.ok !== true) {
    lines.push(`refused       : ${result.reason_code}${result.detail === undefined ? '' : ` — ${result.detail}`}`);
    if (result.committed === true) {
      lines.push(`snapshot      : ${result.snapshot_id} (committed before the failure; the backup itself is durable)`);
    }
    // The full-copy cap refusal is a named *pending* state, not a broken run: nothing was written, and the same
    // run can be approved and retried. Name the sessions, the cap and the exact flag so the next command is obvious.
    if (result.reason_code === FULL_COPY_APPROVAL_CODE) {
      const rows = Array.isArray(result.full_copy_oversized) ? result.full_copy_oversized : [];
      lines.push(`cap           : ${fullCopyCapText(result.cap_bytes)} MB per sealed whole-file old copy`);
      for (const row of rows) {
        lines.push(
          `  over cap    : ${String(row.session_id)}  ${humanBytes(row.size)}  cap ${humanBytes(row.cap)}  ${String(row.rel)}`,
        );
      }
      if (Number(result.over_cap_count) > rows.length) {
        lines.push(`  …           : ${Number(result.over_cap_count) - rows.length} more session(s)`);
      }
      lines.push('approval      : nothing was written; re-run with --allow-large-full-copy to approve this run');
    }
    return lines.join('\n');
  }
  const dry = result.dry_run === true;
  lines.push(`mode          : ${dry ? 'dry run (nothing written)' : 'committed'}`);
  lines.push(`scope         : ${result.scope}${result.skipped_sessions > 0 ? ` (${result.skipped_sessions} session(s) skipped by scope)` : ''}`);
  lines.push(`snapshot      : ${result.snapshot_id}${dry ? ' (not committed)' : ''}`);
  if (result.digest !== undefined) lines.push(`digest        : ${result.digest}`);
  lines.push(`sessions      : ${result.sessions}`);
  lines.push(`files         : ${result.files} (${humanBytes(result.bytes)})`);
  lines.push(`blocks        : ${result.blocks_new} new, ${result.blocks_reused} reused (dedupe ${(result.dedupe_ratio * 100).toFixed(0)}%)`);
  lines.push(`bytes         : read ${humanBytes(result.bytes_read)}, written ${humanBytes(result.bytes_written)}`);
  if (result.rotated !== undefined) lines.push(`rotated       : ${result.rotated} old version(s) recorded`);
  if (result.keep_old_per_session !== undefined) {
    lines.push(
      `retention     : keep ${result.keep_old_per_session} old version(s) per session` +
        (result.max_old_version_days > 0 ? `, no record older than ${result.max_old_version_days} day(s)` : ' (age rule off)'),
    );
  }
  if (result.old_usage !== undefined && result.old_usage !== null) {
    const usage = result.old_usage;
    lines.push(`old usage     : ${oldUsageGbText(usage.bytes)} GB (${Number(usage.files) || 0} files)`);
    if (usage.due === true) {
      // The engine already puts the reminder into `warnings` on a committed run; a dry run has no `warnings` list,
      // so the line is printed here when it is not already present. The hint is always printed: a reminder is never
      // an action, and cleanup is the operator's `gc`.
      const warned = Array.isArray(result.warnings) && result.warnings.some((line) => typeof line === 'string' && line.startsWith('old/ 已增长'));
      if (warned !== true) lines.push(`warning       : ${oldUsageReminderWarning(usage)}`);
      lines.push('hint          : nothing was deleted; run `w2m-backup gc --dry-run` first, then `w2m-backup gc` (or `--max-old-days <n>`) to clean up manually');
    }
  }
  if (result.old_format === 'full') {
    const copies = Array.isArray(result.full_old_versions) ? result.full_old_versions.length : 0;
    lines.push(`old format    : full (${copies} sealed whole-file copy(-ies); storage doubles per superseded version)`);
  }
  if (Array.isArray(result.full_copy_approved_over_cap) && result.full_copy_approved_over_cap.length > 0) {
    lines.push(
      `approved cap  : ${result.full_copy_approved_over_cap.length} session(s) explicitly approved over the full-copy cap ` +
        `(recorded on the old/ version record as approved_over_cap)`,
    );
    for (const row of result.full_copy_approved_over_cap) {
      lines.push(`  - ${String(row.session_id)}  ${humanBytes(row.size)}`);
    }
  }
  if (result.mirror !== undefined) {
    if (result.mirror.ok === true) {
      const repaired = result.mirror.copied.repaired ?? 0;
      lines.push(
        `mirror        : ${result.mirror.root} (${result.mirror.copied.files} file(s), ${humanBytes(result.mirror.copied.bytes)} copied` +
          `${repaired > 0 ? `, ${repaired} repaired` : ''}, ${result.mirror.skipped.files} already present` +
          `${result.mirror.index_appended === true ? ', index line appended' : ''})`,
      );
    } else {
      lines.push(`mirror        : FAILED ${result.mirror.reason_code} — ${result.mirror.reason ?? 'the copy failed'} (the primary repository is committed)`);
    }
  }
  if (result.unlocked_via !== undefined) {
    lines.push(`unlocked via  : ${result.unlocked_via}${result.key_created === true ? ' (repository key created)' : ''}`);
  }
  if (result.encryption !== undefined && result.encryption !== null) {
    lines.push(`protection    : ${result.encryption}${result.encryption === 'none' ? ' (unencrypted)' : ''}`);
    if (result.encryption === 'none') lines.push(`warning       : ${UNENCRYPTED_WARNING}`);
  }
  if (result.key_upgraded === true) {
    lines.push('key           : machine envelope added to this repository (future runs need no password here)');
  }
  if (Array.isArray(result.torn_sessions) && result.torn_sessions.length > 0) {
    lines.push(`torn sessions : ${result.torn_sessions.length} captured mid-append (bytes kept; the next run supersedes them)`);
  }
  if (result.future_append !== undefined) {
    lines.push(
      `future append : ${result.future_append.checked - result.future_append.failed}/${result.future_append.checked} session(s) still load after one legal append (static pre-filter)`,
    );
    for (const failing of result.future_append.sessions ?? []) {
      lines.push(`  - ${failing.rel} ${(failing.codes ?? []).join(', ')}`);
    }
  }
  if (result.runtime_future_append !== undefined && result.runtime_future_append !== null) {
    const runtime = result.runtime_future_append;
    lines.push(
      `runtime append: ${runtime.checked - runtime.failed}/${runtime.checked} validated by the installed Harness` +
        `${runtime.available ? '' : ' (unavailable: this is not runtime evidence)'}`,
    );
    for (const failing of runtime.sessions ?? []) lines.push(`  - ${failing.rel} ${failing.detail ?? ''}`.trimEnd());
  }
  if (result.runtime_verify !== undefined && result.runtime_verify !== null) {
    const record = result.runtime_verify;
    lines.push(
      `runtime verdict: ${record.ok ? 'passed' : 'FAILED'} · checked ${record.checked}, failed ${record.failed} · ` +
        `${record.snapshots} snapshot(s) · evidence ${record.evidence}` +
        (result.runtime_verify_persisted === false ? ' (not persisted)' : ''),
    );
    for (const code of record.reason_codes ?? []) lines.push(`  - reason: ${code}`);
  }
  if (Array.isArray(result.invalid_containers) && result.invalid_containers.length > 0) {
    lines.push(`invalid logs  : ${result.invalid_containers.map((row) => row.rel).join(', ')}`);
  }
  for (const warning of result.warnings ?? []) lines.push(`warning       : ${warning}`);
  lines.push(`duration      : ${result.duration_ms} ms`);
  if (Array.isArray(result.unknown_selected) && result.unknown_selected.length > 0) {
    lines.push(`unknown ids   : ${result.unknown_selected.join(', ')}`);
  }
  return lines.join('\n');
}

/** Render the snapshot list for a terminal. */
export function formatList(state) {
  const lines = ['w2m-backup list', ''];
  lines.push(`repository    : ${state.root}`);
  lines.push(`initialized   : ${state.initialized ? 'yes' : 'no'}`);
  if (state.initialized !== true) return lines.join('\n');
  lines.push(`snapshots     : ${state.snapshots.length}`);
  if (state.snapshots.length > 0) {
    lines.push('');
    lines.push('snapshot                          created_at                sessions  files        size  digest');
    for (const row of state.snapshots) {
      const manifest = row.manifest;
      lines.push(
        `${row.snapshot_id.padEnd(33)} ${String(manifest?.created_at ?? '?').padEnd(24)} ` +
          `${String(manifest?.sessions ?? '?').padStart(8)} ${String(manifest?.files ?? '?').padStart(6)} ` +
          `${humanBytes(manifest?.session_bytes ?? 0).padStart(11)}  ${String(row.digest ?? (row.valid === false ? 'INVALID' : '?')).slice(0, 16)}`,
      );
    }
  }
  const index = state.index;
  lines.push('');
  lines.push(`index         : ${index.entries} entr(ies)${index.torn_tail ? ', TORN tail' : ''}${index.problems > 0 ? `, ${index.problems} problem(s)` : ''}`);
  return lines.join('\n');
}

/** Render a gc result for a terminal. */
export function formatGc(result) {
  const lines = ['w2m-backup gc', ''];
  if (result.safe !== true) {
    lines.push(`refused       : ${result.reason_code} — ${result.problems.length} unreadable reference(s); nothing was deleted`);
    if (result.detail !== undefined) lines.push(`detail        : ${result.detail}`);
    for (const problem of result.problems.slice(0, 10)) lines.push(`  ${problem.file}: ${problem.detail}`);
    return lines.join('\n');
  }
  lines.push(`mode          : ${result.dry_run ? 'dry run (nothing deleted)' : 'applied'}`);
  lines.push(`references    : ${result.references.blocks} block(s) from ${result.references.snapshots} snapshot(s), ${result.references.old} old version(s), ${result.references.current} current pointer(s)`);
  lines.push(`blocks        : ${result.blocks.scanned} scanned, ${result.blocks.removed} removed, ${result.blocks.kept} kept (${humanBytes(result.blocks.reclaimed_bytes)} reclaimed)`);
  lines.push(`old versions  : ${result.old_versions.pruned} pruned by the retention window`);
  if (result.old_versions?.pruned_by_age !== undefined) lines.push(`old by age    : ${result.old_versions.pruned_by_age} pruned by the age rule`);
  if (result.old_versions?.full_copies_pruned > 0) lines.push(`full copies   : ${result.old_versions.full_copies_pruned} pruned with their record(s)`);
  if (result.old_usage !== undefined && result.old_usage !== null && typeof result.old_usage === 'object') {
    const before = result.old_usage.before !== null && typeof result.old_usage.before === 'object' ? result.old_usage.before : {};
    const after = result.old_usage.after !== null && typeof result.old_usage.after === 'object' ? result.old_usage.after : {};
    // The whole `old/` tree (records + sealed full copies), before and after this pass: gc is the manual cleanup the
    // usage reminder points at, so it reports the number the reminder talks about.
    lines.push(`old usage before/after: ${oldUsageGbText(before.bytes)} GB -> ${oldUsageGbText(after.bytes)} GB`);
  }
  if (result.orphan_full_copies !== undefined && result.orphan_full_copies.scanned > 0) {
    lines.push(
      `orphan copies : ${result.orphan_full_copies.scanned} scanned, ${result.orphan_full_copies.removed} removed (${humanBytes(result.orphan_full_copies.reclaimed_bytes)} reclaimed)`,
    );
  }
  if (result.tmp !== undefined) lines.push(`tmp leftovers : ${result.tmp.scanned} scanned, ${result.tmp.removed} removed (crashed writers)`);
  if (result.empty_prefixes_removed !== undefined && result.empty_prefixes_removed > 0) {
    lines.push(`empty prefixes: ${result.empty_prefixes_removed} removed`);
  }
  return lines.join('\n');
}

/**
 * Render an old-backfill result for a terminal.
 *
 * Shows the four counts that answer "what changed", bounded per-record failure lines (a repository with a
 * thousand broken records must not bury the summary), and the explicit "nothing was written" line a dry run
 * needs so it cannot be mistaken for an applied migration.
 */
export function formatOldBackfill(result) {
  const lines = ['w2m-backup old-backfill', ''];
  lines.push(`mode          : ${result.dry_run ? 'dry run (nothing was written)' : 'applied'}`);
  if (result.ok !== true && result.reason_code !== null && result.failed.length === 0) {
    // A top-level refusal (no key, locked, not a repository): there is no per-record work to report.
    lines.push(`refused       : ${result.reason_code}${result.detail ? ` — ${result.detail}` : ''}`);
    return lines.join('\n');
  }
  lines.push(`backfilled    : ${result.backfilled} record(s) gained a sealed whole-file copy`);
  lines.push(`repaired      : ${result.repaired} copy(ies) rebuilt (a file was missing or the wrong length)`);
  lines.push(`already full  : ${result.skipped} record(s) already had a usable copy`);
  lines.push(`orphan copies : ${result.orphans} left for gc (nothing is deleted here)`);
  if (result.bytes_written > 0) lines.push(`bytes written : ${humanBytes(result.bytes_written)}`);
  if (result.failed.length > 0) lines.push('', `failed        : ${result.failed.length} record(s)`, ...failureLines(result.failed));
  if (result.dry_run) lines.push('', 'nothing was written (dry run)');
  return lines.join('\n');
}

/** Bounded per-record failure lines, shared by both old-backfill branches. */
function failureLines(failed) {
  const lines = failed.slice(0, 10).map((row) => `  ${row.record}: ${row.reason_code} — ${row.detail}`);
  if (failed.length > 10) lines.push(`  … ${failed.length - 10} more`);
  return lines;
}

/**
 * Render an old-restore plan or result for a terminal.
 *
 * The dry run prints record/source digest/doctor/target/plan and the explicit "nothing was written" line; the
 * applied output prints the file, its digest, the `.bak` path (the way back) and a warning when `--force-invalid`
 * wrote bytes the static doctor refused.
 */
export function formatOldRestore(plan, applied) {
  const lines = ['w2m-backup old-restore', ''];
  if (plan?.ok !== true) {
    lines.push(`refused       : ${plan?.reason_code ?? 'UNKNOWN'} ${plan?.detail ?? ''}`.trimEnd());
    return lines.join('\n');
  }
  lines.push(`record        : ${plan.record.file}`);
  lines.push(`session       : ${plan.record.session_id ?? '—'}${plan.record.rel === null ? '' : ` (${plan.record.rel})`}`);
  lines.push(`source digest : ${plan.source_sha256}`);
  // Which container the copy is (decided by the file's own magic, §28) and what that means for the write: a v2 copy
  // is streamed back in one-record pieces; a v1 copy is decrypted whole and written whole.
  lines.push(
    `copy          : ${
      plan.copy_format === 'chunked-v2'
        ? `chunked-v2 (streamed, peak one ${humanBytes(plan.peakChunkBytes)} record)`
        : 'v1 sealed object (whole file)'
    }`,
  );
  lines.push(`recovered     : ${humanBytes(plan.recovered.bytes)} sha256 ${plan.recovered.sha256}`);
  const doctorText = plan.recovered.doctor_ok
    ? 'passed (static pre-filter)'
    : `FAILED (${plan.recovered.doctor_codes.join(', ') || 'no code'})${plan.force_invalid === true ? ' — forced by --force-invalid' : ''}`;
  lines.push(`doctor        : ${doctorText}`);
  lines.push(`target        : ${plan.target.path} (${plan.target.exists ? 'exists' : 'does not exist'})`);
  lines.push(
    `plan          : ${plan.apply_plan.mode}` +
      `${plan.apply_plan.backs_up_existing === true ? ' (existing target is copied to .bak-<ts> first)' : ''} -> ${plan.target.write_path}`,
  );
  if (applied === undefined) {
    lines.push('');
    lines.push('dry run: nothing was written. Re-run with --apply to restore.');
    return lines.join('\n');
  }
  lines.push('');
  if (applied.ok !== true) {
    lines.push(`failed        : ${applied.reason_code} ${applied.detail ?? ''}`.trimEnd());
    return lines.join('\n');
  }
  lines.push(`written       : ${applied.file} (${humanBytes(applied.bytes)})`);
  lines.push(`sha256        : ${applied.sha256}`);
  if (applied.backup_file !== null) lines.push(`backup        : ${applied.backup_file} (the way back)`);
  if (applied.doctor_ok !== true) {
    lines.push('warning       : the recovered log failed the static doctor and was written because --force-invalid was given');
  }
  return lines.join('\n');
}

/** Read the unlock password from the injected value, stdin, or the environment (never from argv). */
function passwordFor(options, io) {
  if (typeof io.password === 'string') return io.password;
  if (options.passwordStdin === true) {
    try {
      return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    } catch {
      return '';
    }
  }
  const fromEnv = (io.env ?? process.env).W2M_BACKUP_PASSWORD;
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : null;
}

/** Read all of stdin once (a real run reads fd 0; `io.stdinText` is the test seam, like `io.password`). */
function stdinTextFor(io) {
  if (typeof io.stdinText === 'string') return io.stdinText;
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * The two rotation secrets, from their documented channels.
 *
 * The new PIN follows `--set-password` exactly: stdin (`--password-stdin`) or `W2M_BACKUP_PASSWORD`, never argv.
 * The old PIN is needed only when the machine/account path cannot open the repository, and comes from
 * `W2M_BACKUP_OLD_PASSWORD` or `--old-password-stdin`. Both on one stdin is the two-line form `old\nnew`
 * (documented in the usage): when the supplied text has two lines the first is the old PIN, one line is the new
 * PIN. A trailing newline is not a second line (so the ordinary single-secret stdin shape keeps working).
 *
 * @param {object} options parsed CLI options
 * @param {{password?: string, oldPassword?: string, stdinText?: string,
 *   env?: Record<string, string|undefined>}} io injection seam (tests pass secrets here; production reads stdin)
 * @returns {{newPassword: string|null, oldPassword: string|null}}
 */
function rotateSecretsFor(options, io) {
  const env = io.env ?? process.env;
  let newPassword = typeof io.password === 'string' ? io.password : null;
  let oldPassword = typeof io.oldPassword === 'string' ? io.oldPassword : null;
  if (options.passwordStdin === true && newPassword === null) {
    const lines = stdinTextFor(io).replace(/\r\n/g, '\n').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > 1) {
      if (oldPassword === null) oldPassword = lines[0];
      newPassword = lines[1];
    } else {
      newPassword = lines[0] ?? '';
    }
  } else if (options.oldPasswordStdin === true && oldPassword === null) {
    oldPassword = stdinTextFor(io).replace(/\r?\n$/, '');
  }
  if (newPassword === null) {
    const fromEnv = env.W2M_BACKUP_PASSWORD;
    newPassword = typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : null;
  }
  if (oldPassword === null) {
    const fromEnv = env.W2M_BACKUP_OLD_PASSWORD;
    oldPassword = typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : null;
  }
  return { newPassword, oldPassword };
}

/** Resolve the repository root, or report the layout refusal. */
function resolveDir(options, env) {
  try {
    return { ok: true, dir: resolveBackupDir({ explicit: options.backupDir, env }) };
  } catch (error) {
    if (error instanceof BackupLayoutError) return { ok: false, error };
    throw error;
  }
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv
 * @param {{env?: Record<string,string|undefined>, stdout?: (text: string) => void,
 *   stderr?: (text: string) => void, now?: () => Date}} [io]
 * @returns {number} exit code
 */
export function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const write = io.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const writeErr = io.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const options = parseArgs(argv, env);
  if (options.error !== undefined) {
    writeErr(`error: ${options.error}\n\n${usage()}`);
    return 2;
  }

  if (options.command === 'help') {
    write(usage());
    return 0;
  }

  if (options.command === 'status') {
    // The CLI prints the route's payload, verbatim: one status shape means the panel and the terminal cannot
    // disagree about whether a repository exists, what it holds, or why it is refusing.
    let payload;
    try {
      payload = buildStatus({ backupDir: options.backupDir, dshHome: options.dshHome, env });
    } catch (error) {
      if (error instanceof BackupLayoutError) {
        writeErr(`${error.code}: ${error.detail}`);
        return 1;
      }
      throw error;
    }
    write(options.json ? JSON.stringify(payload, null, 2) : formatStatus(payload));
    // An unresolved directory is a configuration error (exit 1); an absent repository is a state (exit 0).
    return payload.reason_code === LAYOUT_CODES.UNRESOLVED ? 1 : 0;
  }

  if (options.command === 'scan') {
    const scan = scanHome({ dshHome: options.dshHome, deep: options.deep, hash: options.hash });
    const payload = {
      ok: true,
      read_only: true,
      scanned_at: scan.scanned_at,
      dsh_home: scan.dsh_home,
      exists: scan.exists,
      zstd: scan.zstd,
      totals: scan.totals,
      registry: {
        ok: scan.registry.ok,
        workspaces: scan.registry.workspaces.length,
        registered: scan.registry.registered.size,
        archived: scan.registry.archived.size,
        pinned: scan.registry.pinned.size,
      },
      exclusions: scan.exclusions,
      sessions: scan.sessions.map((row) => ({
        session_id: row.session_id,
        workspace: row.workspace,
        rel: row.rel,
        size: row.size,
        mtime_ms: row.mtime_ms,
        format_version: row.format_version,
        ok: row.ok,
        codes: row.codes,
        flags: row.flags,
        ...(row.events === undefined ? {} : { events: row.events }),
        ...(row.hash === null ? {} : { hash: row.hash }),
      })),
      attachments: scan.attachments.map((row) => ({ attachment_id: row.attachment_id, rel: row.rel, size: row.size, ok: row.ok, hash: row.hash })),
    };
    if (options.manifest) {
      // Build the manifest IN MEMORY: this is the end-to-end proof that the files scan found can be described
      // in the protocol's shape and validated, without writing anything to a repository.
      const manifest = buildManifest({
        snapshotId: `dry-run-${Date.now()}`,
        createdAt: new Date(),
        dshHome: scan.dsh_home,
        sessions: scan.sessions.filter((row) => row.ok === true),
        attachments: scan.attachments.filter((row) => row.ok === true),
        registry: {
          workspaces: scan.registry.workspaces.length,
          registered: scan.registry.registered.size,
          archived: scan.registry.archived.size,
          pinned: scan.registry.pinned.size,
        },
        exclusions: scan.exclusions,
      });
      payload.manifest = manifestSummary(manifest);
      payload.manifest_digest = manifestDigest(manifest);
    }
    if (options.json) {
      write(JSON.stringify(payload, null, 2));
    } else {
      write(formatScan(payload));
      if (options.manifest) {
        write(
          `\nmanifest (in memory, nothing written):\n  sessions    : ${payload.manifest.sessions}` +
            `\n  attachments : ${payload.manifest.attachments}` +
            `\n  blocks      : ${payload.manifest.blocks}` +
            `\n  digest      : ${payload.manifest_digest}`,
        );
      }
    }
    return 0;
  }

  if (options.command === 'run') {
    if (options.scope !== null && !SCOPES.includes(options.scope)) {
      writeErr(`error: --scope must be one of ${SCOPES.join(', ')}\n\n${usage()}`);
      return 2;
    }
    const resolved = resolveDir(options, env);
    if (resolved.ok !== true) {
      writeErr(`${resolved.error.code}: ${resolved.error.detail}`);
      return 1;
    }
    const machineKey = options.noMachineKey === true || (io.env ?? process.env).W2M_BACKUP_NO_MACHINE_KEY === '1' ? false : undefined;
    // The acknowledgement mark lives in the plugin's persisted state; the CLI only READS it, so a panel 「知道了」
    // is honoured by the next CLI run and the CLI never moves the mark on its own.
    const persistedState = readBackupState(options.dshHome).state;
    const oldUsageAckBytes = Number.isSafeInteger(persistedState.old_usage_ack_bytes) && persistedState.old_usage_ack_bytes >= 0
      ? persistedState.old_usage_ack_bytes
      : 0;
    const runInput = {
      root: resolved.dir,
      dshHome: options.dshHome,
      scope: options.scope ?? 'all',
      selected: options.selected,
      keepOldPerSession: options.keepOld ?? undefined,
      maxOldVersionDays: options.maxOldDays ?? undefined,
      oldFormat: options.oldFormat ?? undefined,
      // MB on the command line, bytes in the engine (the engine compares against the session file's size).
      maxFullCopyBytes: options.maxFullCopyMb === null ? undefined : options.maxFullCopyMb * 1024 * 1024,
      // GB on the command line, bytes in the engine (the engine compares growth since the acknowledgement).
      oldUsageReminderBytes: options.oldUsageReminderGb === null ? undefined : Math.round(options.oldUsageReminderGb * 1024 ** 3),
      oldUsageAckBytes,
      allowLargeFullCopy: options.allowLargeFullCopy === true,
      scopes: options.scopes ?? undefined,
      includeSecrets: options.includeSecrets === true,
      encryption: options.encryption ?? undefined,
      mirrorRoot: options.mirror ?? undefined,
      dryRun: options.dryRun,
      futureAppend: options.noFutureAppend === true ? false : undefined,
      runtimeFutureAppend: options.runtime === true,
      accountId: options.accountId ?? undefined,
      password: passwordFor(options, io),
      machineKey,
    };
    let result = runBackup(runInput);
    if (result.ok === true && result.secrets_included === true) {
      // The warning is deliberately loud and on both channels: a repository with credentials is an identity.
      const secretsLine =
        'secrets       : 已包含凭据（device.key / gpw key / .credentials.yaml）：任何拿到这个仓库的人都能登录此账户、使用这台机器的身份。';
      if (options.json === true) writeErr(secretsLine);
      else write(secretsLine);
    }
    // The full-copy cap: an interactive terminal may approve THIS run once and retry; a script must pass the flag.
    // The question goes to stderr in --json mode so stdout stays the machine-readable result. Either way the
    // refusal wrote nothing, so "no" is a complete, safe outcome.
    let approvalHint = null;
    if (result.ok !== true && result.reason_code === FULL_COPY_APPROVAL_CODE && options.allowLargeFullCopy !== true) {
      if (stdinIsInteractive(io)) {
        const answer = askLine(io, options.json === true ? writeErr : write, formatFullCopyApprovalPrompt(result));
        if (/^\s*(y|yes|是)\s*$/iu.test(answer)) {
          result = runBackup({ ...runInput, allowLargeFullCopy: true });
          if (result.ok === true) result.approval = 'prompted';
        } else {
          approvalHint = '未特批：没有写入任何内容（回答不是 y）。';
        }
      } else {
        approvalHint =
          'hint          : 非交互环境不会等待确认；确认特批请加 --allow-large-full-copy（或调大 --max-full-copy-mb）。';
      }
    }
    if (approvalHint !== null) {
      // The hint must never corrupt --json output: a machine-readable run writes it to stderr instead.
      if (options.json === true) writeErr(approvalHint);
      else write(approvalHint);
    }
    if (options.runtimeVerify === true && result.ok === true && options.dryRun !== true) {
      // One manual runtime verdict, after the backup is committed: the verdict can never change the backup's
      // outcome (the bytes are already durable), so a failure here is a warning on a committed result.
      const startedMs = Date.now();
      const verifyResult = verifyRepo({
        root: resolved.dir,
        dshHome: options.dshHome,
        password: passwordFor(options, io),
        accountId: options.accountId ?? undefined,
        machineKey,
        futureAppend: true,
        runtime: true,
      });
      const record = buildRuntimeVerdictRecord({
        verifyResult,
        startedAt: startedMs,
        finishedAt: Date.now(),
        trigger: 'manual-cli',
        runtimeAvailable: true,
      });
      result.runtime_verify = record;
      const persisted = writeBackupState(options.dshHome, { last_runtime_verify: record });
      result.runtime_verify_persisted = persisted.ok;
      if (persisted.ok !== true) {
        result.warnings = [...(result.warnings ?? []), `the runtime verdict could not be persisted: ${persisted.error}`];
      }
      if (record.ok !== true) {
        result.warnings = [
          ...(result.warnings ?? []),
          `the runtime verdict failed: ${record.reason_codes.join(', ') || 'no code'} (the backup itself is committed)`,
        ];
      }
    }
    write(options.json ? JSON.stringify(result, null, 2) : formatRun(result));
    return result.ok === true ? 0 : 1;
  }

  if (options.command === 'list') {
    const resolved = resolveDir(options, env);
    if (resolved.ok !== true) {
      writeErr(`${resolved.error.code}: ${resolved.error.detail}`);
      return 1;
    }
    const state = openRepo({ root: resolved.dir, dshHome: options.dshHome, full: true });
    write(options.json ? JSON.stringify(state, null, 2) : formatList(state));
    return 0;
  }

  if (options.command === 'gc') {
    const resolved = resolveDir(options, env);
    if (resolved.ok !== true) {
      writeErr(`${resolved.error.code}: ${resolved.error.detail}`);
      return 1;
    }
    const result = gc({
      root: resolved.dir,
      dryRun: options.dryRun,
      keepOldPerSession: options.keepOld ?? undefined,
      maxOldVersionDays: options.maxOldDays ?? undefined,
    });
    write(options.json ? JSON.stringify(result, null, 2) : formatGc(result));
    return result.ok === true ? 0 : 1;
  }

  if (options.command === 'old-backfill') {
    const resolved = resolveDir(options, env);
    if (resolved.ok !== true) {
      writeErr(`${resolved.error.code}: ${resolved.error.detail}`);
      return 1;
    }
    const result = backfillOldFullCopies({
      root: resolved.dir,
      dshHome: options.dshHome,
      password: passwordFor(options, io),
      accountId: options.accountId ?? undefined,
      dryRun: options.dryRun,
      limit: options.limit ?? undefined,
      machineKey: options.noMachineKey === true || env.W2M_BACKUP_NO_MACHINE_KEY === '1' ? false : undefined,
    });
    write(options.json ? JSON.stringify(result, null, 2) : formatOldBackfill(result));
    return result.ok === true ? 0 : 1;
  }

  if (options.command === 'old-restore') {
    const resolved = resolveDir(options, env);
    if (resolved.ok !== true) {
      writeErr(`${resolved.error.code}: ${resolved.error.detail}`);
      return 1;
    }
    const sessions = options.selected.filter((sessionId) => typeof sessionId === 'string' && sessionId !== '');
    const selections = (options.recordFile === null ? 0 : 1) + (options.latestFor === null ? 0 : 1) + (sessions.length > 0 ? 1 : 0);
    if (selections !== 1) {
      writeErr(
        'error: old-restore needs exactly one of --record <path>, --session <id> [--rel <rel>] or --latest-for <session-id>\n\n' +
          usage(),
      );
      return 2;
    }
    if (sessions.length > 1) {
      writeErr('error: old-restore takes one --session id; use --record to name one exact version record\n\n' + usage());
      return 2;
    }
    if (options.rel !== null && sessions.length !== 1) {
      writeErr('error: --rel only applies together with --session\n\n' + usage());
      return 2;
    }
    if (options.overwrite === true && options.keepBoth === true) {
      writeErr('error: --overwrite and --keep-both are opposite choices; pass one\n\n' + usage());
      return 2;
    }
    const plan = planOldRestore({
      root: resolved.dir,
      dshHome: options.dshHome,
      recordFile: options.recordFile,
      sessionId: sessions[0] ?? null,
      rel: options.rel,
      latestFor: options.latestFor,
      outFile: options.outFile,
      overwrite: options.overwrite,
      keepBoth: options.keepBoth,
      forceInvalid: options.forceInvalid,
      password: passwordFor(options, io),
      accountId: options.accountId ?? undefined,
      machineKey: options.noMachineKey === true || env.W2M_BACKUP_NO_MACHINE_KEY === '1' ? false : undefined,
      now: io.now?.() ?? new Date(),
    });
    // `old-restore` is a dry run unless `--apply` is given; `--dry-run` is honoured defensively so
    // `--apply --dry-run` can never write (the conservative reading of a contradictory pair).
    if (plan.ok !== true || options.apply !== true || options.dryRun === true) {
      write(options.json ? JSON.stringify(plan, null, 2) : formatOldRestore(plan));
      return plan.ok === true ? 0 : 1;
    }
    const applied = applyOldRestore({ plan, now: io.now?.() ?? new Date() });
    write(options.json ? JSON.stringify(applied, null, 2) : formatOldRestore(plan, applied));
    return applied.ok === true ? 0 : 1;
  }

  if (options.command === 'unlock') {
    const resolved = resolveDir(options, env);
    if (resolved.ok !== true) {
      writeErr(`${resolved.error.code}: ${resolved.error.detail}`);
      return 1;
    }
    // These two flags exist only for rotation; naming them without --rotate-password is a usage error rather than a
    // silently ignored request (an ignored "clear the hint" is exactly the kind of surprise the CLI avoids).
    if (options.clearHint === true && options.rotatePassword !== true) {
      writeErr('error: --clear-hint only applies to --rotate-password\n\n' + usage());
      return 2;
    }
    if (options.oldPasswordStdin === true && options.rotatePassword !== true) {
      writeErr('error: --old-password-stdin only applies to --rotate-password\n\n' + usage());
      return 2;
    }
    if (options.disableProtection === true) {
      if (options.setPassword === true || options.enableProtection === true || options.rotatePassword === true) {
        writeErr('error: --disable-protection cannot be combined with --set-password/--enable-protection/--rotate-password\n\n' + usage());
        return 2;
      }
      // Turning protection off weakens the repository: it needs an explicit token, exactly like a write route.
      if (options.confirm !== 'disable-protection') {
        writeErr('error: --disable-protection removes the account/machine/PIN protection and lets anyone with the repository directory restore it');
        writeErr(`re-run with --confirm disable-protection to do it\n\n${usage()}`);
        return 2;
      }
      const result = setEncryptionMode({
        root: resolved.dir,
        dshHome: options.dshHome,
        mode: 'none',
        password: passwordFor(options, io),
        accountId: options.accountId ?? undefined,
        platform: process.platform,
        machineKey: options.noMachineKey === true ? false : undefined,
      });
      if (options.json) {
        write(JSON.stringify(result, null, 2));
      } else if (result.ok !== true) {
        writeErr(`${result.reason_code}: ${result.detail}`);
      } else {
        write('w2m-backup unlock --disable-protection');
        write('');
        if (result.changed !== true) {
          write(`protection        : already ${result.mode_after} (nothing written)`);
          write(`envelopes         : ${result.envelopes.join(', ')}`);
        } else {
          write(`protection        : ${result.mode_before} -> ${result.mode_after}`);
          write('data key          : unchanged (the same key now sits in clear in keys.json)');
          write(`envelopes         : ${result.envelopes.join(', ')}`);
          write(`keys backup       : ${result.backup_file}`);
          write(`file              : ${result.file}`);
        }
        write(`warning           : ${result.warning ?? UNENCRYPTED_WARNING}`);
      }
      return result.ok === true ? 0 : 1;
    }
    if (options.rotatePassword === true) {
      if (options.setPassword === true || options.enableProtection === true) {
        writeErr('error: --rotate-password cannot be combined with --set-password/--enable-protection (rotation changes an existing PIN; --set-password adds one)\n\n' + usage());
        return 2;
      }
      if (options.clearHint === true && options.hint !== null) {
        writeErr('error: --clear-hint cannot be combined with --hint (omit --hint to drop the old hint)\n\n' + usage());
        return 2;
      }
      if (options.passwordStdin === true && options.oldPasswordStdin === true) {
        writeErr('error: --password-stdin and --old-password-stdin both read stdin; for --rotate-password pass both secrets with --password-stdin as two lines (old, then new)\n\n' + usage());
        return 2;
      }
      const secrets = rotateSecretsFor(options, io);
      const result = rotatePassword({
        root: resolved.dir,
        dshHome: options.dshHome,
        newPassword: secrets.newPassword ?? '',
        oldPassword: secrets.oldPassword,
        hint: options.clearHint === true ? null : (options.hint ?? undefined),
        accountId: options.accountId ?? undefined,
        platform: process.platform,
        machineKey: options.noMachineKey === true ? false : undefined,
        now: io.now?.() ?? new Date(),
      });
      if (options.json) {
        write(JSON.stringify(result, null, 2));
      } else if (result.ok !== true) {
        writeErr(`${result.reason_code}: ${result.detail}`);
      } else {
        write('w2m-backup unlock --rotate-password');
        write('');
        write('rotated : yes');
        write(`mode : ${result.mode_after}`);
        write(`envelopes : ${result.envelopes.join(', ')}`);
        write(`hint : ${result.hint.set === true ? result.hint.text : '(cleared)'}`);
        write(`keys backup : ${result.backup_file}`);
        write(`file : ${result.file}`);
        write('old PIN no longer opens : confirmed');
        if (result.weak === true) write(`warning : ${result.warning ?? WEAK_PIN_WARNING}`);
      }
      return result.ok === true ? 0 : 1;
    }
    // `--enable-protection` is an alias of the set-password path: turning protection on requires a PIN/password.
    if (options.enableProtection === true) options.setPassword = true;
    if (options.setPassword) {
      const result = setRepositoryPassword({
        root: resolved.dir,
        dshHome: options.dshHome,
        password: passwordFor(options, io),
        hint: options.hint ?? undefined,
        platform: process.platform,
        machineKey: options.noMachineKey === true ? false : undefined,
      });
      if (options.json) {
        write(JSON.stringify(result, null, 2));
      } else {
        if (result.ok !== true) {
          writeErr(`${result.reason_code}: ${result.detail}`);
        } else if (result.added !== true) {
          write(`password envelope : already present (nothing written) — ${result.detail ?? ''}`.trimEnd());
          write(`envelopes         : ${result.envelopes.join(', ')}`);
          write(`protection        : ${result.mode_after}`);
        } else {
          write('w2m-backup unlock --set-password');
          write('');
          write(`password envelope : added (another envelope, same data key)`);
          write(`envelopes         : ${result.envelopes.join(', ')}`);
          write(`protection        : ${result.mode_after} (credential-less opens now refused)`);
          write(`keys backup       : ${result.backup_file}`);
          write(`file              : ${result.file}`);
        }
        // The hint is public metadata, printed verbatim; it never contains the PIN (the writer refuses that).
        if (result.ok === true && result.hint !== undefined && result.hint !== null && result.hint.set === true && typeof result.hint.text === 'string') {
          write(`密码提示：${result.hint.text}`);
        }
        if (result.weak === true) write(`warning           : ${result.warning ?? WEAK_PIN_WARNING}`);
      }
      return result.ok === true ? 0 : 1;
    }
    const described = describeUnlock({
      root: resolved.dir,
      dshHome: options.dshHome,
      machineKey: options.noMachineKey === true ? false : undefined,
      accountId: options.accountId,
    });
    const payload = {
      ok: described.ok,
      repository: resolved.dir,
      initialized: described.initialized,
      envelopes: described.envelopes,
      machine_available: described.machine_available,
      machine_reason: described.machine_reason,
      password_required: described.password_required,
      // The public "备注提示词" (plain text in keys.json by design); never the PIN.
      password_hint: described.password_hint,
      // Compare-only identity binding: the masked id hint is the only form of the account id that is printed.
      account: described.account,
      account_supported: described.account_supported,
      encryption: described.encryption,
      available_paths: described.available_paths,
      warning: described.warning,
      reason_code: described.reason_code,
      detail: described.detail,
    };
    if (options.check) {
      payload.check = unlockRepo({
        root: resolved.dir,
        dshHome: options.dshHome,
        password: passwordFor(options, io),
        machineKey: options.noMachineKey === true ? false : undefined,
        accountId: options.accountId,
      });
    }
    write(options.json ? JSON.stringify(payload, null, 2) : formatUnlock(payload));
    const failed = options.check === true && payload.check?.ok !== true;
    return payload.ok !== true || failed ? 1 : 0;
  }

  if (options.command === 'verify') {
    const resolved = resolveDir(options, env);
    if (resolved.ok !== true) {
      writeErr(`${resolved.error.code}: ${resolved.error.detail}`);
      return 1;
    }
    const result = verifyRepo({
      root: resolved.dir,
      dshHome: options.dshHome,
      password: passwordFor(options, io),
      machineKey: options.noMachineKey === true ? false : undefined,
      futureAppend: true,
      runtime: options.runtime,
    });
    write(options.json ? JSON.stringify(result, null, 2) : formatVerify(result));
    return result.ok === true ? 0 : 1;
  }

  if (options.command === 'archive') {
    const resolved = resolveDir(options, env);
    if (resolved.ok !== true) {
      writeErr(`${resolved.error.code}: ${resolved.error.detail}`);
      return 1;
    }
    const scope = options.scope ?? 'archived';
    if (!['archived', 'all', 'selected'].includes(scope)) {
      writeErr('error: --scope for archive must be archived, all or selected');
      return 2;
    }
    const result = buildArchive({
      root: resolved.dir,
      dshHome: options.dshHome,
      snapshotId: options.snapshot,
      scope,
      sessionIds: options.selected,
      password: passwordFor(options, io),
      machineKey: options.noMachineKey === true ? false : undefined,
    });
    write(options.json ? JSON.stringify(result, null, 2) : formatArchive(result));
    return result.ok === true ? 0 : 1;
  }

  if (options.command === 'restore') {
    const resolved = resolveDir(options, env);
    if (resolved.ok !== true) {
      writeErr(`${resolved.error.code}: ${resolved.error.detail}`);
      return 1;
    }
    const plan = options.archiveFile === null
      ? planRestore({
          root: resolved.dir,
          dshHome: options.dshHome,
          snapshotId: options.snapshot,
          sessionIds: options.selected,
          password: passwordFor(options, io),
          machineKey: options.noMachineKey === true ? false : undefined,
          allowStaticValidation: options.allowStaticValidation,
          keepBoth: options.keepBoth,
          workspacePath: options.workspacePath,
          allowLiveHome: options.allowLiveHome,
          clientCheck: io.clientCheck ?? (() => detectClientRunning({})),
        })
      : planRestoreFromArchive({
          file: path.resolve(options.archiveFile),
          dshHome: options.dshHome,
          sessionIds: options.selected,
          allowStaticValidation: options.allowStaticValidation,
          keepBoth: options.keepBoth,
          workspacePath: options.workspacePath,
          allowLiveHome: options.allowLiveHome,
          clientCheck: io.clientCheck ?? (() => detectClientRunning({})),
        });
    if (plan.ok !== true || options.apply !== true) {
      write(options.json ? JSON.stringify(plan, null, 2) : formatRestore(plan));
      return plan.ok === true ? 0 : 1;
    }
    const applied = applyRestore({ plan, dshHome: options.dshHome, dryRun: options.dryRun });
    if (applied.ok === true && applied.dry_run !== true && applied.registry?.some?.((row) => row.changed === true) && options.registryRecheckMs > 0) {
      // Sync wait: the CLI is offline, so there is no event loop to keep the process alive for a deferred check.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.registryRecheckMs);
      applied.registry_recheck = recheckRegistry({ dshHome: options.dshHome, plan });
    }
    write(options.json ? JSON.stringify(applied, null, 2) : formatRestore(plan, applied));
    return applied.ok === true ? 0 : 1;
  }

  if (options.command === 'register') {
    const requested = options.selected.filter((sessionId) => typeof sessionId === 'string' && sessionId !== '');
    if (requested.length === 0) {
      writeErr(`error: register needs at least one --session <id>\n\n${usage()}`);
      return 2;
    }
    const plan = planRegister({
      dshHome: options.dshHome,
      sessionIds: requested,
      workspacePath: options.workspacePath,
      allowLiveHome: options.allowLiveHome,
      // The same injectable gate the restore command uses: tests answer it, production asks the process list.
      clientCheck: io.clientCheck ?? (() => detectClientRunning({})),
      now: io.now?.() ?? new Date(),
    });
    if (plan.ok !== true || options.dryRun === true) {
      write(options.json ? JSON.stringify(plan, null, 2) : formatRegister(plan));
      return plan.ok === true ? 0 : 1;
    }
    const applied = applyRegister({ dshHome: options.dshHome, plan });
    if (applied.ok === true && applied.changed === true && options.registryRecheckMs > 0) {
      // Sync wait: the CLI is offline, so there is no event loop to keep the process alive for a deferred check.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.registryRecheckMs);
      applied.recheck = recheckRegistry({ dshHome: options.dshHome, plan: plan.registry });
    }
    if (applied.ok === true && applied.changed === true && options.watch > 0) {
      // Bounded watch: the same 2/8/20/60 s schedule the host route runs, sampled synchronously because this
      // process exits after printing. `io.sleep` / `io.watchNow` exist so a test can run the budget without
      // spending the wall time; production sleeps for real and the budget is measured on the real clock.
      const sleep = typeof io.sleep === 'function'
        ? io.sleep
        : (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const clock = typeof io.watchNow === 'function' ? io.watchNow : null;
      const now = clock === null
        ? Date.now
        : () => {
            const value = clock();
            return value instanceof Date ? value.getTime() : Number(value);
          };
      applied.watch = watchRegistrationSync({
        dshHome: options.dshHome,
        plan: plan.registry,
        minutes: options.watch,
        sleep,
        now,
        ...(typeof io.watchRecheck === 'function' ? { recheck: io.watchRecheck } : {}),
      });
    }
    if (applied.ok === true && applied.changed === true) applied.residual_risk = REGISTER_RESIDUAL_RISK_LINE;
    write(options.json ? JSON.stringify(applied, null, 2) : formatRegister(plan, applied));
    return applied.ok === true ? 0 : 1;
  }

  if (options.command === 'selftest') {
    const result = selftest({ now: io.now?.() ?? new Date() });
    write(options.json ? JSON.stringify(result, null, 2) : formatSelftest(result));
    return result.ok ? 0 : 1;
  }

  writeErr(`error: unknown command: ${options.command}\n\n${usage()}`);
  return 2;
}
