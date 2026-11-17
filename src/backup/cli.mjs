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
import { OLD_FORMATS } from './rotation.mjs';
import { backfillOldFullCopies } from './old-backfill.mjs';
import { gc } from './gc.mjs';
import { openRepo } from './repo.mjs';
import { buildArchive } from './archive.mjs';
import { applyRestore, planRestore, planRestoreFromArchive } from './restore.mjs';
import { detectClientRunning } from './client.mjs';
import { recheckRegistry } from './registry-watch.mjs';
import { applyRegister, planRegister } from './register.mjs';
import { REGISTER_RESIDUAL_RISK_LINE, watchRegistrationSync } from './register-watch.mjs';
import { buildRuntimeVerdictRecord, writeBackupState } from './runtime-verdict.mjs';
import { describeUnlock, unlockRepo } from './unlock.mjs';
import {
  MIN_PASSWORD_BYTES,
  UNENCRYPTED_WARNING,
  WEAK_PIN_WARNING,
  setEncryptionMode,
  setRepositoryPassword,
} from './keystore.mjs';
import { verifyRepo } from './verify.mjs';

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
  lines.push(`current ptrs  : ${result.counts.current}`);
  lines.push(`future append : ${result.future_append.checked - result.future_append.failed}/${result.future_append.checked} passed`);
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
    '  unlock              which credential opens this repository (read-only; --check tries it)',
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
    '  --session <id>      run --scope selected / register: a session id (repeatable)',
    '  --keep-old <n>      old versions kept per session (default: 10)',
    '  --old-format <f>    run: how a superseded version is kept: records (default, deduped record only)',
    '                      or full (also one sealed whole-file copy under old/, doubling that version\'s bytes)',
    '  --encrypt <mode>    run: repository protection for a NEW repository: none (default, unencrypted) or sealed',
    '                      (account/machine/PIN envelopes). An existing repository keeps its mode.',
    '  --no-encryption     run: shorthand for --encrypt none',
    '  --max-old-days <n>  run/gc: also prune old version records older than N days (0 = per-session count only)',
    '  --limit <n>         old-backfill: write at most N sealed copies this run (0 = plan only, writes nothing)',
    '  --mirror <dir>      run: copy the sealed blocks and snapshot metadata to this offsite directory',
    '  --dry-run           run/gc/old-backfill/restore/register: report what would happen, write nothing',
    '  --snapshot <id>     verify/archive/restore: a specific snapshot (default: the latest)',
    '  --archive <file>    restore: read the session bytes from a .tar.zst archive instead of the repository',
    '  --apply             restore: actually write (without it, restore only prints the plan)',
    '  --keep-both         restore: keep an existing different file and write the restored one beside it',
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
    '                      back into a sealed one.',
    '  --enable-protection alias of --set-password (turning protection on needs a PIN/password)',
    '  --disable-protection unlock: turn protection OFF: open with existing credentials, write an open envelope',
    '                      carrying the same data key; the repository then unlocks with no credential at all.',
    '                      Requires --confirm disable-protection because it weakens the repository.',
    '  --confirm <token>   unlock --disable-protection: the explicit confirmation token (disable-protection)',
    '  --password-stdin    run/restore/unlock --check/--set-password/old-backfill: read the PIN/password from',
    '                      stdin (never argv) (environment fallback: W2M_BACKUP_PASSWORD, same "never argv" rule)',
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
    maxOldDays: null,
    limit: null,
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
    disableProtection: false,
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
    else if (arg === '--allow-static-validation') options.allowStaticValidation = true;
    else if (arg === '--allow-live-home') options.allowLiveHome = true;
    else if (arg === '--runtime') options.runtime = true;
    else if (arg === '--runtime-verify') options.runtimeVerify = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--set-password') options.setPassword = true;
    else if (arg === '--enable-protection') options.enableProtection = true;
    else if (arg === '--disable-protection') options.disableProtection = true;
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
  if (result.old_format === 'full') {
    const copies = Array.isArray(result.full_old_versions) ? result.full_old_versions.length : 0;
    lines.push(`old format    : full (${copies} sealed whole-file copy(-ies); storage doubles per superseded version)`);
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
    const result = runBackup({
      root: resolved.dir,
      dshHome: options.dshHome,
      scope: options.scope ?? 'all',
      selected: options.selected,
      keepOldPerSession: options.keepOld ?? undefined,
      maxOldVersionDays: options.maxOldDays ?? undefined,
      oldFormat: options.oldFormat ?? undefined,
      encryption: options.encryption ?? undefined,
      mirrorRoot: options.mirror ?? undefined,
      dryRun: options.dryRun,
      futureAppend: options.noFutureAppend === true ? false : undefined,
      runtimeFutureAppend: options.runtime === true,
      accountId: options.accountId ?? undefined,
      password: passwordFor(options, io),
      machineKey,
    });
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

  if (options.command === 'unlock') {
    const resolved = resolveDir(options, env);
    if (resolved.ok !== true) {
      writeErr(`${resolved.error.code}: ${resolved.error.detail}`);
      return 1;
    }
    if (options.disableProtection === true) {
      if (options.setPassword === true || options.enableProtection === true) {
        writeErr('error: --disable-protection cannot be combined with --set-password/--enable-protection\n\n' + usage());
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
    // `--enable-protection` is an alias of the set-password path: turning protection on requires a PIN/password.
    if (options.enableProtection === true) options.setPassword = true;
    if (options.setPassword) {
      const result = setRepositoryPassword({
        root: resolved.dir,
        dshHome: options.dshHome,
        password: passwordFor(options, io),
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
