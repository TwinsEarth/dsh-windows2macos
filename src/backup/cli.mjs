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

import { BackupLayoutError, LAYOUT_CODES, resolveBackupDir } from './layout.mjs';
import { scanHome } from './scan.mjs';
import { selftest } from './crypto.mjs';
import { buildManifest, manifestDigest, manifestSummary } from './manifest.mjs';
import { buildStatus } from './routes.mjs';
import { runBackup, SCOPES } from './engine.mjs';
import { gc } from './gc.mjs';
import { openRepo } from './repo.mjs';
import { buildArchive } from './archive.mjs';
import { applyRestore, planRestore, planRestoreFromArchive } from './restore.mjs';
import { detectClientRunning } from './client.mjs';
import { recheckRegistry } from './registry-watch.mjs';
import { describeUnlock, unlockRepo } from './unlock.mjs';
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
  if (payload.initialized) {
    lines.push(`envelopes     : ${payload.envelopes.join(', ') || 'none'}`);
    lines.push(`machine path  : ${payload.machine_available ? 'available on this machine' : `unavailable (${payload.machine_reason ?? 'unknown'})`}`);
    lines.push(`password path : ${payload.password_required ? 'available (the only path on a new machine)' : 'not configured'}`);
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
    '  unlock              which credential opens this repository (read-only; --check tries it)',
    '  verify              re-hash every snapshot: blocks, bytes, manifests, index, old records',
    '  archive             pack archived sessions (or --scope all) into one .tar.zst (writes)',
    '  restore             plan a restore; --apply writes sessions, attachments and the workspace registry',
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
    '  --session <id>      run --scope selected: a session id to include (repeatable)',
    '  --keep-old <n>      old versions kept per session (default: 10)',
    '  --max-old-days <n>  run/gc: also prune old version records older than N days (0 = per-session count only)',
    '  --mirror <dir>      run: copy the sealed blocks and snapshot metadata to this offsite directory',
    '  --dry-run           run/gc: report what would happen, write nothing',
    '  --snapshot <id>     verify/archive/restore: a specific snapshot (default: the latest)',
    '  --archive <file>    restore: read the session bytes from a .tar.zst archive instead of the repository',
    '  --apply             restore: actually write (without it, restore only prints the plan)',
    '  --keep-both         restore: keep an existing different file and write the restored one beside it',
    '  --allow-static-validation  restore: accept static-only evidence when no Harness is installed',
    '  --allow-live-home   restore: write even though the DSH client is running (read-back + recheck protocol)',
    '  --registry-recheck <ms>  restore --apply: wait this long, then re-check the registry once (client save)',
    '  --workspace-path <p> restore: attach a restored session to this directory if the workspace is absent',
    '  --runtime           verify/run: confirm with the installed Harness validator (G5), not only the pre-filter',
    '  --check             unlock: attempt the unlock instead of only describing it',
    '  --password-stdin    run/restore/unlock --check: read the password from stdin (never argv)',
    '                      (environment fallback: W2M_BACKUP_PASSWORD, same "never argv" rule)',
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
    maxOldDays: null,
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
    workspacePath: null,
    runtime: false,
    check: false,
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
    else if (arg === '--check') options.check = true;
    else if (arg === '--snapshot') options.snapshot = rest.shift() ?? null;
    else if (arg === '--archive') options.archiveFile = rest.shift() ?? null;
    else if (arg === '--workspace-path') options.workspacePath = path.resolve(rest.shift() ?? '');
    else if (arg === '--registry-recheck') {
      const raw = rest.shift() ?? '';
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0) return { ...options, error: `--registry-recheck needs a non-negative integer, got ${JSON.stringify(raw)}` };
      options.registryRecheckMs = value;
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
    } else if (arg === '--max-old-days') {
      const raw = rest.shift() ?? '';
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isSafeInteger(value) || value < 0) {
        return { ...options, error: `--max-old-days needs a non-negative integer, got ${JSON.stringify(raw)}` };
      }
      options.maxOldDays = value;
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
  if (result.mirror !== undefined) {
    if (result.mirror.ok === true) {
      lines.push(
        `mirror        : ${result.mirror.root} (${result.mirror.copied.files} file(s), ${humanBytes(result.mirror.copied.bytes)} copied, ` +
          `${result.mirror.skipped.files} already present${result.mirror.index_appended === true ? ', index line appended' : ''})`,
      );
    } else {
      lines.push(`mirror        : FAILED ${result.mirror.reason_code} — ${result.mirror.reason ?? 'the copy failed'} (the primary repository is committed)`);
    }
  }
  if (result.unlocked_via !== undefined) {
    lines.push(`unlocked via  : ${result.unlocked_via}${result.key_created === true ? ' (repository key created)' : ''}`);
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
  if (result.tmp !== undefined) lines.push(`tmp leftovers : ${result.tmp.scanned} scanned, ${result.tmp.removed} removed (crashed writers)`);
  if (result.empty_prefixes_removed !== undefined && result.empty_prefixes_removed > 0) {
    lines.push(`empty prefixes: ${result.empty_prefixes_removed} removed`);
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
    const result = runBackup({
      root: resolved.dir,
      dshHome: options.dshHome,
      scope: options.scope ?? 'all',
      selected: options.selected,
      keepOldPerSession: options.keepOld ?? undefined,
      maxOldVersionDays: options.maxOldDays ?? undefined,
      mirrorRoot: options.mirror ?? undefined,
      dryRun: options.dryRun,
      futureAppend: options.noFutureAppend === true ? false : undefined,
      runtimeFutureAppend: options.runtime === true,
      password: passwordFor(options, io),
      machineKey: options.noMachineKey === true || (io.env ?? process.env).W2M_BACKUP_NO_MACHINE_KEY === '1' ? false : undefined,
    });
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

  if (options.command === 'unlock') {
    const resolved = resolveDir(options, env);
    if (resolved.ok !== true) {
      writeErr(`${resolved.error.code}: ${resolved.error.detail}`);
      return 1;
    }
    const described = describeUnlock({
      root: resolved.dir,
      dshHome: options.dshHome,
      machineKey: options.noMachineKey === true ? false : undefined,
    });
    const payload = {
      ok: described.ok,
      repository: resolved.dir,
      initialized: described.initialized,
      envelopes: described.envelopes,
      machine_available: described.machine_available,
      machine_reason: described.machine_reason,
      password_required: described.password_required,
      reason_code: described.reason_code,
      detail: described.detail,
    };
    if (options.check) {
      payload.check = unlockRepo({
        root: resolved.dir,
        dshHome: options.dshHome,
        password: passwordFor(options, io),
        machineKey: options.noMachineKey === true ? false : undefined,
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

  if (options.command === 'selftest') {
    const result = selftest({ now: io.now?.() ?? new Date() });
    write(options.json ? JSON.stringify(result, null, 2) : formatSelftest(result));
    return result.ok ? 0 : 1;
  }

  writeErr(`error: unknown command: ${options.command}\n\n${usage()}`);
  return 2;
}
