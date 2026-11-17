#!/usr/bin/env node
/**
 * `w2m-backup` command line: `status`, `scan`, `selftest`.
 *
 * ## What this CLI is (and is not) in v3.4.6
 *
 * It is the operator's read-only window onto the backup substrate: where the repository would be, whether it
 * exists, what a backup would copy, and whether the cryptography on *this* machine actually round-trips. It is
 * **not** a backup command yet -- `run` arrives in v3.4.7 with the engine. Every command here is safe to run
 * on a live machine: nothing is created, nothing is modified, and `selftest` only touches memory.
 *
 * Exit codes: 0 success; 1 a named refusal (the code is printed); 2 usage error.
 */

import os from 'node:os';
import path from 'node:path';

import { BackupLayoutError, LAYOUT_CODES } from './layout.mjs';
import { scanHome } from './scan.mjs';
import { selftest } from './crypto.mjs';
import { buildManifest, manifestDigest, manifestSummary } from './manifest.mjs';
import { buildStatus } from './routes.mjs';

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

function usage() {
  return [
    'usage: w2m-backup <command> [options]',
    '',
    'commands:',
    '  status              where the repository is, whether it exists, free space (read-only)',
    '  scan                what a backup would copy: sessions, registry flags, attachments (read-only)',
    '  selftest            wrap/unwrap and tamper self-test of the backup cryptography (memory only)',
    '  help                this text',
    '',
    'options:',
    '  --dsh-home <path>   DSH home (default: $DSH_HOME, then ~/.dsh)',
    '  --backup-dir <path> repository root (default: $W2M_BACKUP_DIR, then D:\\DeepSeekHarness\\BackUP)',
    '  --json              machine-readable output',
    '  --deep              decompress every session log (event counts; slower)',
    '  --hash              hash every file (sha256; slower)',
    '  --manifest          build the in-memory manifest and print its digest (no writes)',
    '',
    'read-only: v3.4.6 ships no command that writes a repository.',
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
  };
  const rest = [...argv];
  if (rest.length > 0 && !rest[0].startsWith('-')) options.command = rest.shift();
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === '--json') options.json = true;
    else if (arg === '--deep') options.deep = true;
    else if (arg === '--hash') options.hash = true;
    else if (arg === '--manifest') options.manifest = true;
    else if (arg === '--help' || arg === '-h') options.command = 'help';
    else if (arg === '--dsh-home') options.dshHome = path.resolve(rest.shift() ?? options.dshHome);
    else if (arg === '--backup-dir') options.backupDir = path.resolve(rest.shift() ?? '');
    else if (arg.startsWith('--dsh-home=')) options.dshHome = path.resolve(arg.slice('--dsh-home='.length));
    else if (arg.startsWith('--backup-dir=')) options.backupDir = path.resolve(arg.slice('--backup-dir='.length));
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

  if (options.command === 'selftest') {
    const result = selftest({ now: io.now?.() ?? new Date() });
    write(options.json ? JSON.stringify(result, null, 2) : formatSelftest(result));
    return result.ok ? 0 : 1;
  }

  writeErr(`error: unknown command: ${options.command}\n\n${usage()}`);
  return 2;
}
