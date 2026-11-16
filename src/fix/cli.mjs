/**
 * Offline CLI for the session-attachment repair.
 *
 *   w2m-fix scan                       only report: which sessions are broken, how many places need a repair
 *   w2m-fix fix [--apply]              append one image/offload event (needs --apply; requires DSH to be stopped)
 *   w2m-fix backups --session <id>     list the backups next to one session's artifact
 *   w2m-fix restore --session <id> --apply   roll back from a backup
 *
 * Exit codes: 0 ok, 1 failed, 2 this Node has no synchronous zstd API, 3 refused
 * (DSH running / restore without --apply). 0 and non-zero are the contract; the
 * numbers exist so a wrapper can tell "refused" from "broke".
 *
 * Two safety rules are enforced here rather than left to the caller:
 *   * writing is refused while DeepSeek Harness is running, because its live
 *     session holds its own next sequence number and a concurrent append would
 *     collide with it;
 *   * `fix` and `restore` are dry runs unless `--apply` is given.
 *
 * Ported from `dsh-fix-attachments` (MIT, Copyright (c) 2026 xuzhunzhi). The
 * console helpers are process.stdout/stderr calls so this module also satisfies
 * the package's lint rule for non-CLI sources.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

import { hasZstd } from './zstd.mjs';
import { listSessionDirs, pickSessionFile, readSession } from './session.mjs';
import { applyFix, groupTargets, listBackups, pendingFixes, restoreBackup, BACKUP_MARK } from './repair.mjs';

const EXIT = { OK: 0, FAILED: 1, UNSUPPORTED_NODE: 2, REFUSED: 3 };

const USAGE = `w2m-fix - repair "attachment object deleted -> every turn fails with transport failed"

Symptom: a session fails every turn with "DeepSeek Messages transport failed",
each attempt failing in 20-60 ms without sending an HTTP request, because an
image attachment object referenced by its history has been deleted.

用法 / Usage
  node bin/w2m-fix.mjs scan                         only report (the default)
  node bin/w2m-fix.mjs fix [--apply]                append one image/offload event per broken session
  node bin/w2m-fix.mjs backups --session <part>     list the backups of one session
  node bin/w2m-fix.mjs restore --session <part> --apply   roll back from a backup

Options
  --session <part>        only sessions whose directory name contains this part
  --dsh-home <path>       DSH home (default: $DSH_HOME or ~/.dsh)
  --stamp <stamp>         restore: which backup to use (default: the newest)
  --apply                 actually write (fix and restore are dry runs without it)
  --force                 write even though DeepSeek Harness appears to be running
  --json                  machine-readable output
  -h, --help              this text

Standard flow
  1. quit DeepSeek Harness;
  2. node bin/w2m-fix.mjs scan
  3. node bin/w2m-fix.mjs fix --apply --session <part>
  4. start DeepSeek Harness again.
`;

/** Write one line to stdout. Kept as a named helper so the CLI's output channel is explicit. */
function writeOut(text) {
  process.stdout.write(`${text}\n`);
}

/** Write one line to stderr. */
function writeErr(text) {
  process.stderr.write(`${text}\n`);
}

/**
 * @param {string[]} argv
 * @returns {{command: string, session: string|null, dshHome: string, stamp: string|null, apply: boolean, force: boolean, json: boolean, help: boolean}}
 */
function parseArgs(argv) {
  const opts = {
    command: 'scan',
    session: null,
    dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    stamp: null,
    apply: false,
    force: false,
    json: false,
    help: false,
  };
  const commands = new Set(['scan', 'fix', 'backups', 'restore']);
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (commands.has(arg)) opts.command = arg;
    else if (arg === '--session') opts.session = rest.shift() ?? null;
    else if (arg === '--dsh-home') opts.dshHome = rest.shift() ?? opts.dshHome;
    else if (arg === '--stamp') opts.stamp = rest.shift() ?? null;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/**
 * Whether DeepSeek Harness looks like it is running.
 *
 * Best effort on purpose: this is a guard against the ordinary case (the user
 * forgot to quit the app), not a lock. `--force` exists for a machine where the
 * process name cannot answer the question.
 *
 * @returns {boolean}
 */
function dshRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /DeepSeek Harness\.exe/i.test(out);
    }
    const out = execSync("pgrep -fl 'DeepSeek Harness|dsh web' || true", { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {{dshHome: string}} opts
 * @returns {{sessionsRoot: string, storeRoot: string}}
 */
function resolvePaths(opts) {
  const sessionsRoot = path.join(opts.dshHome, 'sessions');
  const storeRoot = path.join(opts.dshHome, 'attachments', 'v1', 'objects');
  if (!fs.existsSync(sessionsRoot)) throw new Error(`sessions directory not found: ${sessionsRoot}`);
  if (!fs.existsSync(storeRoot)) {
    throw new Error(`attachment object directory not found: ${storeRoot} (wrong --dsh-home?)`);
  }
  return { sessionsRoot, storeRoot };
}

/**
 * @param {string} sessionsRoot
 * @param {string|null} needle
 * @returns {string[]}
 */
function selectSessions(sessionsRoot, needle) {
  let dirs = listSessionDirs(sessionsRoot);
  if (needle) {
    const n = needle.toLowerCase();
    dirs = dirs.filter((d) => path.basename(d).toLowerCase().includes(n));
    if (dirs.length === 0) throw new Error(`no session directory name matches --session ${needle}`);
  }
  return dirs;
}

/**
 * Read one session and work out whether it needs a repair and where.
 *
 * @param {string} file
 * @param {string} storeRoot
 * @returns {object}
 */
function analyse(file, storeRoot) {
  const session = readSession(file);
  const pending = session.formatSupported ? pendingFixes(session, storeRoot) : [];
  return {
    session,
    file,
    id: session.id,
    size: session.size,
    formatVersion: session.formatVersion,
    formatSupported: session.formatSupported,
    lastSeq: session.lastSeq,
    refs: session.refs.length,
    shadowedRefs: session.refs.filter((r) => session.shadowed.has(r.seq)).length,
    pending,
    targets: groupTargets(pending),
    missingIds: [...new Set(pending.map((r) => r.attachmentId))],
    torn: session.tornStart !== undefined,
  };
}

/**
 * @param {object} opts parsed options
 * @param {{sessionsRoot: string, storeRoot: string, dirs: string[]}} shared
 * @returns {number}
 */
function runScan(opts, shared) {
  const files = shared.dirs.map((d) => pickSessionFile(d)).filter(Boolean);
  const rows = [];
  const unreadable = [];
  for (const file of files) {
    try {
      const row = analyse(file, shared.storeRoot);
      if (row.pending.length > 0 || opts.session) rows.push(row);
    } catch (error) {
      unreadable.push({ file, error: error.message });
    }
  }

  if (opts.json) {
    writeOut(JSON.stringify({
      dshHome: opts.dshHome,
      scanned: files.length,
      broken: rows.map((r) => ({
        sessionId: r.id,
        file: r.file,
        bytes: r.size,
        formatVersion: r.formatVersion,
        lastSeq: r.lastSeq,
        imageRefs: r.refs,
        shadowedRefs: r.shadowedRefs,
        pending: r.pending.length,
        targets: r.targets,
        missingObjectIds: r.missingIds,
        torn: r.torn,
      })),
      unreadable,
    }, null, 2));
    return EXIT.OK;
  }

  writeOut(`DSH home   : ${opts.dshHome}`);
  writeOut(`scanned   : ${files.length} session log(s)`);
  for (const u of unreadable) writeOut(`  ! unreadable ${u.file}: ${u.error}`);

  const broken = rows.filter((r) => r.pending.length > 0);
  if (broken.length === 0) {
    writeOut('verdict   : no session needs a repair');
    return EXIT.OK;
  }
  for (const row of broken) {
    writeOut('');
    writeOut(`* ${row.id}  ${human(row.size)}  format v${row.formatVersion}  last seq ${row.lastSeq}`);
    writeOut(`  image refs ${row.refs} (shadowed ${row.shadowedRefs}) -> ${row.pending.length} occurrence(s) need offload, ${row.missingIds.length} missing object(s)`);
    for (const t of row.targets) writeOut(`    seq ${t.seq}  imageIndexes ${JSON.stringify(t.imageIndexes)}`);
    if (!row.formatSupported) writeOut('  ! unknown session format; fix will refuse it');
    if (row.torn) writeOut('  ! the log ends with a torn frame; fix will refuse it');
  }
  writeOut('');
  writeOut(`verdict   : ${broken.length} session(s) need a repair; add --apply to write (quit DSH first)`);
  return EXIT.OK;
}

/**
 * @param {object} opts parsed options
 * @param {{sessionsRoot: string, storeRoot: string, dirs: string[]}} shared
 * @returns {number}
 */
function runFix(opts, shared) {
  const running = dshRunning();
  if (opts.apply && running && !opts.force) {
    writeErr('refusing to write: DeepSeek Harness is running.');
    writeErr('  Its live sessions hold their own next sequence number, so a concurrent append would collide.');
    writeErr('  Quit it, then run again; add --force only when no one is using the target sessions.');
    return EXIT.REFUSED;
  }

  const files = shared.dirs.map((d) => pickSessionFile(d)).filter(Boolean);
  const results = [];
  for (const file of files) {
    let row;
    try {
      row = analyse(file, shared.storeRoot);
    } catch (error) {
      results.push({ sessionId: path.basename(path.dirname(file)), file, error: error.message });
      continue;
    }
    if (row.pending.length === 0) continue;
    const entry = {
      sessionId: row.id,
      file,
      bytes: row.size,
      lastSeq: row.lastSeq,
      pending: row.pending.length,
      targets: row.targets,
      missingObjectIds: row.missingIds,
    };
    if (opts.apply) {
      try {
        const res = applyFix(row.session, row.pending, { storeRoot: shared.storeRoot });
        Object.assign(entry, { applied: res.changed, newSeq: res.newSeq, backup: res.backup, frameBytes: res.frameBytes });
      } catch (error) {
        entry.applyError = error.message;
      }
    }
    results.push(entry);
  }

  if (opts.json) {
    writeOut(JSON.stringify({ dshHome: opts.dshHome, apply: opts.apply, dshRunning: running, results }, null, 2));
    return results.some((r) => r.applyError || r.error) ? EXIT.FAILED : EXIT.OK;
  }

  if (results.length === 0) {
    writeOut('no session needs a repair');
    return EXIT.OK;
  }
  for (const r of results) {
    writeOut('');
    if (r.error) {
      writeOut(`! ${r.sessionId}: ${r.error}`);
      continue;
    }
    writeOut(`* ${r.sessionId}  ${human(r.bytes)}  last seq ${r.lastSeq}`);
    writeOut(`  ${r.pending} occurrence(s) can be offloaded, merged into ${r.targets.length} target(s)`);
    if (r.applyError) writeOut(`  ! write failed: ${r.applyError}`);
    else if (r.applied) writeOut(`  ok appended image/offload seq ${r.newSeq} (+${r.frameBytes} bytes), backup ${path.basename(r.backup)}`);
  }
  writeOut('');
  if (!opts.apply) {
    writeOut('dry run: nothing was written. Quit DeepSeek Harness, then add --apply.');
  } else {
    writeOut('done. Restart DeepSeek Harness; do not post a message in a repaired session before the restart');
    writeOut('(the appended event has to be loaded before it takes effect).');
  }
  return EXIT.OK;
}

/**
 * @param {object} opts parsed options
 * @param {{sessionsRoot: string, storeRoot: string, dirs: string[]}} shared
 * @returns {number}
 */
function runBackups(opts, shared) {
  const dirs = selectSessions(shared.sessionsRoot, opts.session);
  const out = [];
  for (const dir of dirs) {
    const file = pickSessionFile(dir);
    if (!file) continue;
    out.push({ sessionId: path.basename(dir), file, backups: listBackups(file) });
  }
  if (opts.json) {
    writeOut(JSON.stringify(out, null, 2));
    return EXIT.OK;
  }
  if (out.length === 0) {
    writeOut('no matching session');
    return EXIT.OK;
  }
  for (const entry of out) {
    writeOut(`* ${entry.sessionId}`);
    if (entry.backups.length === 0) writeOut('  (no backups)');
    for (const b of entry.backups) writeOut(`  ${b.stamp}  ${human(b.size)}  ${b.name}`);
  }
  return EXIT.OK;
}

/**
 * @param {object} opts parsed options
 * @param {{sessionsRoot: string, storeRoot: string, dirs: string[]}} shared
 * @returns {number}
 */
function runRestore(opts, shared) {
  if (!opts.session) throw new Error('restore needs --session <part>');
  if (!opts.apply) {
    writeErr('restore overwrites the session log; add --apply to confirm');
    return EXIT.REFUSED;
  }
  const running = dshRunning();
  if (running && !opts.force) {
    writeErr('refusing to write: DeepSeek Harness is running (add --force only when it is safe)');
    return EXIT.REFUSED;
  }
  const dirs = selectSessions(shared.sessionsRoot, opts.session);
  if (dirs.length !== 1) throw new Error(`--session must match exactly one session (matched ${dirs.length})`);
  const file = pickSessionFile(dirs[0]);
  if (!file) throw new Error('that directory has no session log');
  const backups = listBackups(file);
  const chosen = opts.stamp ? backups.find((b) => b.stamp === opts.stamp) : backups[0];
  if (!chosen) throw new Error(`no backup found (existing: ${backups.length})`);

  const session = readSession(file);
  const res = restoreBackup(session, chosen.path);
  const after = readSession(file);
  const residual = after.formatSupported ? pendingFixes(after, shared.storeRoot) : [];
  writeOut(`restored ${path.basename(file)} from ${chosen.name}`);
  if (res.safety) writeOut(`  previous state kept as ${path.basename(res.safety)}`);
  writeOut(`  log is back to ${human(after.size)}; ${residual.length} image occurrence(s) are unreadable again (the pre-repair state)`);
  return EXIT.OK;
}

/**
 * CLI entry point: parse arguments, resolve paths, dispatch one command.
 *
 * @param {string[]} argv arguments after the script name
 * @returns {number} process exit code
 */
export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  if (!hasZstd()) {
    writeErr(`this Node has no synchronous zstd API (needs >= 22.15 or >= 23); current ${process.version}`);
    return EXIT.UNSUPPORTED_NODE;
  }
  const { sessionsRoot, storeRoot } = resolvePaths(opts);
  const dirs = selectSessions(sessionsRoot, opts.session);
  const shared = { sessionsRoot, storeRoot, dirs };

  switch (opts.command) {
    case 'scan':
      return runScan(opts, shared);
    case 'fix':
      return runFix(opts, shared);
    case 'backups':
      return runBackups(opts, shared);
    case 'restore':
      return runRestore(opts, shared);
    default:
      writeErr(`unknown command: ${opts.command}`);
      return EXIT.FAILED;
  }
}

export { BACKUP_MARK };
