/**
 * Offline CLI for the session-attachment repair, for the one legal way to
 * delete or insert events in a v4 session log (retrospective gate G4), and for
 * the frame-shape repair (`session-reframe`).
 *
 *   w2m-fix scan                       only report: which sessions are broken, how many places need a repair
 *   w2m-fix fix [--apply]              append one image/offload event (needs --apply; requires DSH to be stopped)
 *   w2m-fix backups --session <id>     list the backups next to one session's artifact
 *   w2m-fix restore --session <id> --apply   roll back from a backup
 *   w2m-fix renumber --file <log> [--delete-seq <n>]... [--insert-file <json>] [--dry-run]
 *                                      delete/insert events, renumber seq densely, rewrite every seq reference,
 *                                      then validate the result (doctor + future append + installed Harness) and
 *                                      only then write (`--dry-run` plans without writing; the original is always
 *                                      copied to `<file>.bak-<timestamp>` first)
 *   w2m-fix session-reframe --file <log> --out <path> [--dry-run] [--json] [--allow-static] [--in-place]
 *                                      rebuild a log whose first zstd frame holds the header together with events
 *                                      (the installed client refuses it as "first frame is not exactly one header
 *                                      line"); writes a COPY at --out, never the source, unless --in-place --force
 *
 * Exit codes: 0 ok, 1 refused/failed, 2 usage error (or this Node has no synchronous
 * zstd API), 3 refused (DSH running / shell safety precondition). 0 and non-zero are
 * the contract; the numbers exist so a wrapper can tell "refused" from "broke".
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
import { applySessionReframe, planSessionReframe, REFRAME_CODES } from './session-reframe.mjs';
// Gate G4 lives in `src/backup/renumber.mjs`: the renumber tool is gated by the backup validator (static doctor +
// future append + the installed Harness), so its one implementation sits with those gates instead of growing a
// second validator here. The layer edge (`fix -> backup`) is declared in `scripts/layer-model.mjs`.
import { applyRenumber, DEFAULT_KEEP_RENUMBER_BACKUPS, planRenumber } from '../backup/renumber.mjs';
import { inspectWorkspaceRegistry, repairWorkspaceRegistry } from '../backup/workspace-registry-guard.mjs';

const EXIT = { OK: 0, FAILED: 1, USAGE: 2, UNSUPPORTED_NODE: 2, REFUSED: 3 };

const USAGE = `w2m-fix - repair "attachment object deleted -> every turn fails with transport failed"
         and the one legal way to delete/insert events in a v4 session log (gate G4)

Symptom: a session fails every turn with "DeepSeek Messages transport failed",
each attempt failing in 20-60 ms without sending an HTTP request, because an
image attachment object referenced by its history has been deleted.

用法 / Usage
  node bin/w2m-fix.mjs scan                         only report (the default)
  node bin/w2m-fix.mjs fix [--apply]                append one image/offload event per broken session
  node bin/w2m-fix.mjs backups --session <part>     list the backups of one session
  node bin/w2m-fix.mjs restore --session <part> --apply   roll back from a backup
  node bin/w2m-fix.mjs renumber --file <log> [--delete-seq <n>]... [--insert-file <json>] [--keep-backups <n>] [--dry-run]
                                                    delete/insert events, renumber seq densely, rewrite
                                                    every *Seq reference, validate, then write
  node bin/w2m-fix.mjs session-reframe --file <log> [--out <path>] [--dry-run] [--json] [--allow-static] [--in-place]
                                                    rebuild a log whose first zstd frame holds the header
                                                    together with events; writes a copy, never the source
  node bin/w2m-fix.mjs workspace-registry [--check|--repair]
                                                    inspect/repair storages/workspace.json invariants:
                                                    ids<->rows, default, and row sessionIds that exist

Options
  --session <part>        only sessions whose directory name contains this part
  --dsh-home <path>       DSH home (default: $DSH_HOME or ~/.dsh)
  --stamp <stamp>         restore: which backup to use (default: the newest)
  --apply                 actually write (fix and restore are dry runs without it)
  --force                 write even though DeepSeek Harness appears to be running
  --json                  machine-readable output
  -h, --help              this text

Renumber options (gate G4; the ONLY legal way to delete or insert an event)
  --file <path>           the v4 session log to edit (required)
  --delete-seq <n>        delete the event at dense zero-based seq <n> (repeatable)
  --insert-file <json>    JSON file holding an array of {atSeq, event}; {atSeq} places the event
                          BEFORE the event currently at that seq (atSeq === event count appends)
  --dry-run               plan only: validate and report, write nothing
  --keep-backups <n>      how many sibling .bak-<timestamp> copies to keep (default 5; 0 = keep all;
                          the copy of the current run is never deleted)
  --allow-static-validation  accept static-only evidence when no Harness installation is found
                          (the report then says runtime_verified:false; the runtime verdict is the gate)

Renumber notes
  * seq becomes the dense index 0..N-1 and every key ending in Seq/Seqs whose value is an
    integer (or an array of integers) is rewritten old -> new. A reference to a deleted
    event is a refusal, never a guess.
  * every successful run first copies the log to <file>.bak-<timestamp>; that copy is the way back.
  * the sibling copies are bounded by --keep-backups only after a successful write; this run's
    copy is never pruned, and 0 disables pruning entirely.
  * the renumbered log is validated with the static doctor, the "next append still loads"
    simulation, and the installed Harness's own validator before anything is written.
  * PREFER RESTORE: if a backup holds the original log, restore it (w2m-backup restore) instead of
    renumbering. Renumber is the fallback when there is no way to recover the original bytes; it
    edits history on purpose, and the .bak copy is only the last resort, not a substitute for a backup.

Session-reframe options (repair an illegal FIRST FRAME, not the event graph)
  --file <path>           the v4 session log to repair (required; only read)
  --out <path>            write the repaired copy HERE (a new file). Refused if it already exists
                          unless --force. The source's bytes and mtime are not touched.
  --in-place              replace the log itself; requires --force, refuses while DeepSeek Harness is
                          running, and writes a verified <file>.bak-<stamp> copy first (the way back)
  --dry-run               plan and validate only: report the numbers, write nothing
  --allow-static          accept static-only evidence when no installed Harness is found (the report
                          then says runtime_verified:false; the runtime verdict is the evidence)
  --json                  one JSON object: {command, ok, dry_run, plan, applied}

Session-reframe notes
  * the defect: the installed client requires the first zstd frame to be EXACTLY one header line
    (its assertZstdHeaderFrame). A log whose frame 0 also carries events is refused and never loads.
  * the repair is byte-conserving by construction: frame 0 is decompressed once, split at the first
    newline, and rebuilt as (header alone) + (those events, verbatim, as one batch frame); every
    later frame is copied byte-identically. The row-stream sha256 must stay equal, before and after
    the write, or the command refuses.
  * frame 0 already legal -> NOOP_ALREADY_LEGAL and nothing is written (not even a copy).
  * gate order: transcribed first-frame rule -> static doctor -> future-append simulation ->
    installed Harness (the evidence). The static doctor alone is a pre-filter; --allow-static is
    the documented downgrade. The client's own open() is the authoritative gate and this command
    cannot call it (it lives inside app.asar), so open the repaired session once in the app.
  * refusals are named: FIX_REFUSED_TORN_TAIL, _CONTAINER, _HEADER, _ROW, _ROW_MISMATCH, _BUSY,
    _NO_RUNTIME, _WRITE; exit codes: 0 ok/noop, 1 refused, 2 usage, 3 write precondition busy.

Workspace-registry options (registry invariants; no session log is read or written)
  --check                 inspect only (default): dangling workspaceIds, unlisted rows, row sessionIds with
                          no log on disk, invalid defaultWorkspaceId
  --repair                back the document up to workspace.json.bak-guard-<stamp>, drop dangling ids, keep
                          unlisted rows by appending them to workspaceIds, prune sessionIds with no log,
                          reassign an invalid default; atomic write + read-back + re-inspect (idempotent)
  --dsh-home <path>       the home whose storages/workspace.json is inspected (default: $DSH_HOME or ~/.dsh)
  --json                  one JSON object: {command, ok, changed, before, after, ...}

Workspace-registry notes
  * QUIT DeepSeek Harness before --repair: the client holds the document in memory and writes it on its own
    schedule, so a repair underneath a running client is overwritten.
  * a dangling id is fatal (the client's workspaceController refuses to mount, and every workspace operation
    reports "active Service workspaceController is unavailable"); an unlisted row is invisible; a missing
    session reference hides history. Nothing here deletes a workspace row or a session log.
  * this is the ONLY supported repair path. Programmatic registry changes go through
    src/backup/registry.mjs (plan -> atomic write -> read-back), never a hand-written JSON edit;
    test/registry-write-policy.test.mjs enforces that for this repository's scripts.

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
 * @returns {{command: string, session: string|null, dshHome: string, stamp: string|null, apply: boolean,
 *   force: boolean, json: boolean, help: boolean, file: string|null, deleteSeqs: number[], insertFile: string|null,
 *   dryRun: boolean, allowStaticValidation: boolean, allowStatic: boolean, inPlace: boolean, out: string|null,
 *   keepBackups: number, error: string|null}}
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
    file: null,
    deleteSeqs: [],
    insertFile: null,
    dryRun: false,
    allowStaticValidation: false,
    allowStatic: false,
    inPlace: false,
    out: null,
    keepBackups: DEFAULT_KEEP_RENUMBER_BACKUPS,
    workspaceRepair: false,
    error: null,
  };
  const commands = new Set(['scan', 'fix', 'backups', 'restore', 'renumber', 'session-reframe', 'workspace-registry']);
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
    else if (arg === '--file') opts.file = rest.shift() ?? null;
    else if (arg.startsWith('--file=')) opts.file = arg.slice('--file='.length);
    else if (arg === '--out') opts.out = rest.shift() ?? null;
    else if (arg.startsWith('--out=')) opts.out = arg.slice('--out='.length);
    else if (arg === '--in-place') opts.inPlace = true;
    else if (arg === '--allow-static') opts.allowStatic = true;
    else if (arg === '--delete-seq') {
      const raw = rest.shift() ?? '';
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0) {
        return { ...opts, error: `--delete-seq needs a non-negative integer, got ${JSON.stringify(raw)}` };
      }
      opts.deleteSeqs.push(value);
    } else if (arg.startsWith('--delete-seq=')) {
      const raw = arg.slice('--delete-seq='.length);
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0) {
        return { ...opts, error: `--delete-seq needs a non-negative integer, got ${JSON.stringify(raw)}` };
      }
      opts.deleteSeqs.push(value);
    } else if (arg === '--insert-file') opts.insertFile = rest.shift() ?? null;
    else if (arg.startsWith('--insert-file=')) opts.insertFile = arg.slice('--insert-file='.length);
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--repair') opts.workspaceRepair = true;
    else if (arg === '--check') opts.workspaceRepair = false;
    else if (arg === '--allow-static-validation') opts.allowStaticValidation = true;
    else if (arg === '--keep-backups') {
      const raw = rest.shift() ?? '';
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isSafeInteger(value) || value < 0) {
        return { ...opts, error: `--keep-backups needs a non-negative integer, got ${JSON.stringify(raw)}` };
      }
      opts.keepBackups = value;
    } else if (arg.startsWith('--keep-backups=')) {
      const raw = arg.slice('--keep-backups='.length);
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isSafeInteger(value) || value < 0) {
        return { ...opts, error: `--keep-backups needs a non-negative integer, got ${JSON.stringify(raw)}` };
      }
      opts.keepBackups = value;
    } else return { ...opts, error: `unknown argument: ${arg}` };
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
 * Load `--insert-file`: a JSON array of `{atSeq, event}`.
 *
 * Malformed JSON or a non-array is a usage error, not a refusal of the session log: the file the operator
 * pointed at is not what the option promises.
 *
 * @param {string} file
 * @returns {{ok: true, insert: object[]} | {ok: false, detail: string}}
 */
function readInsertFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, detail: `--insert-file ${file} could not be read (${error?.code ?? error?.message ?? error})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, detail: `--insert-file ${file} is not valid JSON: ${error.message}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, detail: `--insert-file ${file} must contain a JSON array of {atSeq, event}` };
  }
  return { ok: true, insert: parsed };
}

/** `3->2, 4->3`, bounded so one pathological edit set cannot print hundreds of lines. */
function formatMapping(mapping, limit = 20) {
  const entries = Object.entries(mapping ?? {});
  if (entries.length === 0) return 'none';
  const shown = entries.slice(0, limit).map(([oldSeq, newSeq]) => `${oldSeq}->${newSeq}`);
  const rest = entries.length - shown.length;
  return `${shown.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

/**
 * The serializable half of a plan: a plan carries Buffers for apply, which a `--json` report must not print.
 *
 * @param {object} plan
 * @returns {object}
 */
function summarizePlan(plan) {
  return {
    ok: plan.ok === true,
    file: plan.file ?? null,
    session_id: plan.session_id ?? null,
    reason_code: plan.reason_code ?? null,
    detail: plan.detail ?? '',
    changed: plan.changed === true,
    events_before: plan.events_before ?? 0,
    events_after: plan.events_after ?? 0,
    deleted: plan.deleted ?? 0,
    inserted: plan.inserted ?? 0,
    mapping: plan.mapping ?? {},
    rewritten_references: plan.rewritten_references ?? 0,
    inherited_event_count: plan.inherited_event_count ?? 0,
    original_size: plan.original_size ?? 0,
    new_size: plan.new_size ?? 0,
    original_sha256: plan.original_sha256 ?? null,
    new_sha256: plan.new_sha256 ?? null,
    backup_file: plan.backup_file ?? null,
    validation: plan.validation ?? null,
    codes: plan.codes ?? [],
  };
}

/**
 * Render the plan (and, when it was applied, the result) for a terminal.
 *
 * @param {object} plan
 * @param {object|null} applied
 * @returns {string}
 */
function formatRenumber(plan, applied) {
  const lines = ['w2m-fix renumber', ''];
  lines.push(`file          : ${plan.file ?? '(none)'}`);
  if (plan.session_id !== null && plan.session_id !== undefined) lines.push(`session id    : ${plan.session_id}`);
  if (plan.ok !== true) {
    lines.push(`refused       : ${plan.reason_code ?? 'unknown'} ${plan.detail ?? ''}`.trimEnd());
    lines.push('');
    lines.push('nothing was written.');
    return lines.join('\n');
  }
  const validation = plan.validation ?? {};
  lines.push(`events        : ${plan.events_before} -> ${plan.events_after}`);
  lines.push(`edits         : -${plan.deleted ?? 0} deleted, +${plan.inserted ?? 0} inserted`);
  lines.push(`changed seqs  : ${formatMapping(plan.mapping)}`);
  lines.push(`references    : ${plan.rewritten_references} rewritten`);
  lines.push(`inherited     : ${plan.inherited_event_count}`);
  lines.push(`static        : ${validation.static?.ok === true ? 'ok (static pre-filter, not evidence)' : `REFUSED (${(validation.static?.codes ?? []).join(', ')})`}`);
  lines.push(`runtime       : ${validation.runtime_verified === true ? 'verified by the installed Harness' : 'static-only evidence (runtime_verified:false)'}`);
  lines.push(`future append : ${validation.future_append === true ? 'ok' : 'not confirmed'} [${validation.future_append_evidence ?? 'static-prefilter'}]`);
  lines.push('prefer restore: if a backup holds the original log, restore it instead of renumbering');
  if (!plan.changed) {
    lines.push('');
    lines.push('no change: the log is already dense; nothing was written.');
    return lines.join('\n');
  }
  if (applied === null) return lines.join('\n');
  if (applied.ok !== true) {
    lines.push(`failed        : ${applied.reason_code} ${applied.detail ?? ''}`.trimEnd());
    if (applied.backup_file !== null && applied.backup_file !== undefined) lines.push(`backup        : ${applied.backup_file} (the way back)`);
    return lines.join('\n');
  }
  if (applied.dry_run === true) {
    lines.push(`backup        : ${applied.backup_file ?? '(planned)'} (dry run: not created)`);
    lines.push('');
    lines.push('dry run: nothing was written. Re-run without --dry-run to apply.');
    return lines.join('\n');
  }
  lines.push(`backup        : ${applied.backup_file}`);
  if (applied.pruned_backups !== null && applied.pruned_backups !== undefined) {
    const pruned = applied.pruned_backups;
    lines.push(`backups kept  : ${pruned.kept.length} of ${pruned.scanned} (pruned ${pruned.removed_count}; --keep-backups ${pruned.keep === 0 ? '0 = keep all' : pruned.keep})`);
  }
  lines.push(`result        : wrote ${applied.bytes} byte(s) to the log`);
  lines.push(`sha256        : ${applied.sha256}`);
  return lines.join('\n');
}

/**
 * `renumber`: gate G4's command -- delete/insert events only through this path.
 *
 * The default is to apply (`--dry-run` only plans), because the plan has already validation-gated the result and
 * every apply makes its own `.bak-<timestamp>` copy before writing.
 *
 * @param {object} opts parsed options
 * @returns {number} exit code
 */
function runRenumber(opts) {
  if (opts.file === null || opts.file === '') {
    writeErr('renumber needs --file <path>');
    writeErr('usage: node bin/w2m-fix.mjs renumber --file <session.v4.jsonl.zstd> [--delete-seq <n>]... [--insert-file <json>] [--keep-backups <n>] [--dry-run]');
    return EXIT.USAGE;
  }
  let insert = [];
  if (opts.insertFile !== null) {
    const loaded = readInsertFile(opts.insertFile);
    if (loaded.ok !== true) {
      writeErr(`error: ${loaded.detail}`);
      writeErr('run with --help to see usage');
      return EXIT.USAGE;
    }
    insert = loaded.insert;
  }

  let plan;
  try {
    plan = planRenumber({
      file: opts.file,
      deleteSeqs: opts.deleteSeqs,
      insert,
      allowStaticValidation: opts.allowStaticValidation === true,
    });
  } catch (error) {
    writeErr(`error: renumber planning crashed: ${error?.message ?? String(error)}`);
    return EXIT.FAILED;
  }
  const applied = plan.ok === true ? applyRenumber({ plan, dryRun: opts.dryRun === true, keepBackups: opts.keepBackups }) : null;
  const outcome = applied ?? plan;

  if (opts.json) {
    writeOut(
      JSON.stringify(
        {
          command: 'renumber',
          ok: outcome.ok === true,
          dry_run: opts.dryRun === true,
          plan: summarizePlan(plan),
          applied: applied === null ? null : { ...applied },
        },
        null,
        2,
      ),
    );
  } else {
    writeOut(formatRenumber(plan, applied));
  }
  return outcome.ok === true ? EXIT.OK : EXIT.FAILED;
}

/**
 * The serializable half of a `session-reframe` plan (a plan carries `newBytes` for apply).
 *
 * @param {object} plan
 * @returns {object}
 */
function summarizeReframePlan(plan) {
  return {
    ok: plan.ok === true,
    refused: plan.refused === true,
    noop: plan.noop === true,
    code: plan.code ?? null,
    detail: plan.detail ?? '',
    stage: plan.stage ?? null,
    file: plan.file ?? null,
    out_path: plan.outPath ?? null,
    dry_run: plan.dryRun === true,
    in_place: plan.inPlace === true,
    file_bytes: plan.fileBytes ?? 0,
    file_bytes_after: plan.fileBytesAfter ?? 0,
    frames: plan.frames ?? 0,
    frames_after: plan.framesAfter ?? 0,
    rows: plan.rows ?? 0,
    events: plan.events ?? 0,
    last_seq: plan.lastSeq,
    next_seq: plan.nextSeq,
    header_frame_rows: plan.headerFrameRows ?? 0,
    header_bytes: plan.headerBytes ?? 0,
    event_bytes: plan.eventBytes ?? 0,
    tail_bytes: plan.tailBytes ?? 0,
    tail_frames: plan.tailFrames ?? 0,
    header_frame_bytes_after: plan.headerFrameBytesAfter ?? 0,
    event_frame_bytes_after: plan.eventFrameBytesAfter ?? 0,
    sha256_before: plan.sha256Before ?? null,
    sha256_after: plan.sha256After ?? null,
    file_sha256_before: plan.fileSha256Before ?? null,
    file_sha256_after: plan.fileSha256After ?? null,
    tail_sha256: plan.tailSha256 ?? null,
    backup_path: plan.backupPath ?? null,
    codes: plan.codes ?? [],
    mismatches: plan.mismatches ?? [],
    validation: plan.validation ?? null,
    peak_rss_mb: plan.peakRssMb ?? 0,
    duration_ms: plan.durationMs ?? 0,
  };
}

/**
 * Render one `session-reframe` plan (and, when it was applied, the result).
 *
 * @param {object} plan
 * @param {object|null} applied
 * @returns {string}
 */
function formatReframe(plan, applied) {
  const lines = ['w2m-fix session-reframe', ''];
  lines.push(`file          : ${plan.file ?? '(none)'}`);
  if (plan.noop === true) {
    lines.push(`frames        : ${plan.frames}`);
    lines.push(`rows          : ${plan.rows} (${plan.events} event(s))`);
    lines.push('already legal : frame 0 holds exactly one header line; nothing was written (not even a copy)');
    return lines.join('\n');
  }
  if (plan.ok !== true) {
    lines.push(`refused       : ${plan.code ?? 'unknown'} ${plan.detail ?? ''}`.trimEnd());
    if (plan.stage !== null && plan.stage !== undefined) lines.push(`stage         : ${plan.stage}`);
    if (Array.isArray(plan.codes) && plan.codes.length > 0) lines.push(`codes         : ${plan.codes.join(', ')}`);
    if (Array.isArray(plan.mismatches) && plan.mismatches.length > 0) {
      lines.push('mismatches    :');
      for (const mismatch of plan.mismatches) lines.push(`  - ${mismatch}`);
    }
    lines.push('');
    lines.push('nothing was written.');
    return lines.join('\n');
  }
  const validation = plan.validation ?? {};
  lines.push(`size          : ${human(plan.fileBytes)} (${plan.fileBytes} B) -> ${human(plan.fileBytesAfter)} (${plan.fileBytesAfter} B)`);
  lines.push(`frames        : ${plan.frames} -> ${plan.framesAfter}`);
  lines.push(`frame 0       : ${plan.headerFrameRows} row(s) today (${plan.headerBytes} B header + ${plan.eventBytes} B of event rows) -> 1 row (${plan.headerFrameBytesAfter} B) + ${plan.eventFrameBytesAfter} B event batch`);
  lines.push(`rows          : ${plan.rows} total, ${plan.events} event(s), last seq ${plan.lastSeq === null ? '?' : plan.lastSeq}, next append ${plan.nextSeq === null ? '?' : plan.nextSeq}`);
  lines.push(`tail          : ${plan.tailFrames} frame(s), ${plan.tailBytes} B, copied byte-identically`);
  lines.push(`row stream    : sha256 ${plan.sha256Before === plan.sha256After ? plan.sha256Before : `${plan.sha256Before} != ${plan.sha256After}`}`);
  lines.push(`file sha256   : ${plan.fileSha256Before} -> ${plan.fileSha256After}`);
  lines.push(`static doctor : ${validation.static?.ok === true ? 'ok (static pre-filter, not evidence)' : 'REFUSED'}${(validation.static?.codes ?? []).length > 0 ? ` [${validation.static.codes.join(', ')}]` : ''}`);
  lines.push(`future append : ${validation.future_append?.ok === true ? 'ok' : 'not confirmed'} (next seq ${validation.future_append?.next_seq ?? '?'}, evidence ${validation.future_append?.evidence ?? 'static-prefilter'})`);
  lines.push(`container gate: ${validation.container_gate ?? 'transcribed'} (the client's open() is the authoritative gate and is not callable here)`);
  lines.push(`runtime       : ${validation.runtime_verified === true ? `verified by the installed Harness (${validation.runtime?.events ?? '?'} event(s))` : validation.runtime_required === true ? 'not run' : 'not run (--allow-static; static-only evidence)'}`);
  if (applied === null) {
    lines.push('out           : (not applied)');
    if (plan.dryRun === true) {
      lines.push('');
      lines.push('dry run: nothing was written. Re-run without --dry-run and with --out to write the copy.');
    }
    return lines.join('\n');
  }
  if (applied.ok !== true) {
    lines.push(`failed        : ${applied.code ?? 'unknown'} ${applied.detail ?? ''}`.trimEnd());
    if (applied.backupPath !== null && applied.backupPath !== undefined) lines.push(`backup        : ${applied.backupPath}`);
    return lines.join('\n');
  }
  if (applied.dry_run === true) {
    lines.push('out           : (dry run: nothing was written)');
    return lines.join('\n');
  }
  lines.push(`out           : ${applied.outPath} (${applied.bytes} B written)`);
  if (applied.backupPath !== null && applied.backupPath !== undefined) lines.push(`backup        : ${applied.backupPath} (the way back)`);
  if (applied.restored_from_backup === true) lines.push('restored      : the original bytes were put back after a failed verification');
  lines.push('');
  lines.push('verify        : the written file re-decodes to the same row stream, row count, last seq and tail bytes.');
  lines.push('next step     : open the repaired session once in the app. The client rule is transcribed here, not executed:');
  lines.push('                its own open() is the authoritative gate and lives inside app.asar.');
  return lines.join('\n');
}

/**
 * `session-reframe`: repair a log whose first zstd frame carries the header plus events.
 *
 * Default is a COPY at `--out`; `--dry-run` only plans; `--in-place` (with `--force`) is the one
 * deliberate way to replace the source, and it keeps a verified `<file>.bak-<stamp>`.
 *
 * @param {object} opts parsed options
 * @returns {number} exit code
 */
function runSessionReframe(opts) {
  if (opts.file === null || opts.file === '') {
    writeErr('session-reframe needs --file <path>');
    writeErr('usage: node bin/w2m-fix.mjs session-reframe --file <session.v4.jsonl.zstd> [--out <path>] [--dry-run] [--json] [--allow-static] [--in-place]');
    return EXIT.USAGE;
  }
  if (opts.out !== null && opts.out !== '' && opts.inPlace) {
    writeErr('error: --out and --in-place are mutually exclusive');
    writeErr('run with --help to see usage');
    return EXIT.USAGE;
  }
  if (!opts.dryRun && (opts.out === null || opts.out === '') && !opts.inPlace) {
    writeErr('error: session-reframe writes a copy: pass --out <path>, or --in-place --force, or --dry-run to only report');
    writeErr('run with --help to see usage');
    return EXIT.USAGE;
  }
  if (opts.inPlace && !opts.force) {
    writeErr('error: --in-place needs --force as well (it replaces the log; a verified .bak copy is made first)');
    writeErr('run with --help to see usage');
    return EXIT.USAGE;
  }

  const running = dshRunning();
  let plan;
  try {
    plan = planSessionReframe({
      file: opts.file,
      out: opts.out,
      dryRun: opts.dryRun === true,
      inPlace: opts.inPlace === true,
      force: opts.force === true,
      allowStatic: opts.allowStatic === true,
      dshRunning: running,
    });
  } catch (error) {
    writeErr(`error: session-reframe planning crashed: ${error?.message ?? String(error)}`);
    return EXIT.FAILED;
  }
  const applied = plan.ok === true && plan.outPath !== null && plan.dryRun !== true ? applySessionReframe(plan) : null;
  const outcome = applied ?? plan;

  if (opts.json) {
    writeOut(
      JSON.stringify(
        {
          command: 'session-reframe',
          ok: outcome.ok === true,
          dry_run: opts.dryRun === true,
          dsh_running: running,
          plan: summarizeReframePlan(plan),
          applied: applied === null ? null : { ...applied },
        },
        null,
        2,
      ),
    );
  } else {
    writeOut(formatReframe(plan, applied));
  }
  if (outcome.ok === true) return EXIT.OK;
  return outcome.code === REFRAME_CODES.BUSY ? EXIT.REFUSED : EXIT.FAILED;
}

/**
 * `workspace-registry`: inspect or repair `storages/workspace.json`.
 *
 * The invariant this command exists for: `global.workspaceIds` must name rows that exist. One dangling id
 * makes the DSH `workspaceController` fail to mount, so every workspace operation stops. `--repair` keeps
 * every visible row, drops only dangling ids, prunes session references that no longer resolve, fixes the
 * default, and backs the document up first.
 *
 * @param {ReturnType<typeof parseArgs>} opts
 * @returns {number} process exit code
 */
function runWorkspaceRegistry(opts) {
  const report = opts.workspaceRepair === true ? repairWorkspaceRegistry(opts.dshHome) : inspectWorkspaceRegistry(opts.dshHome);
  const after = report.after ?? report;
  if (opts.json) {
    writeOut(JSON.stringify({ command: 'workspace-registry', repair: opts.workspaceRepair === true, ...report }, null, 2));
  } else {
    writeOut(`file: ${report.file}`);
    if (report.error) writeOut(`error: ${report.error}`);
    writeOut(
      `workspaceIds=${after.ids?.length ?? 0} rows=${after.rows?.length ?? 0} ` +
        `default_ok=${after.defaultOk === true} sessions_missing=${after.missingSessions?.length ?? 0}`,
    );
    for (const problem of after.problems ?? []) writeOut(`  ${problem.code}: ${problem.detail}`);
    if (opts.workspaceRepair === true) {
      writeOut(report.changed === true ? `repaired; backup: ${report.backup}` : 'nothing to repair');
      if (report.ok === true) writeOut('restart DeepSeek Harness to reload the registry.');
    } else {
      writeOut(report.ok === true ? 'consistent' : 'inconsistent - run with --repair (quit DeepSeek Harness first)');
    }
  }
  if (report.ok === true) return EXIT.OK;
  return after.error === 'registry file is missing' ? EXIT.USAGE : EXIT.FAILED;
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
  if (opts.error !== null && opts.error !== undefined) {
    writeErr(`error: ${opts.error}`);
    writeErr('run with --help to see usage');
    return EXIT.USAGE;
  }
  // workspace-registry is pure JSON + directory inspection: it must work on a Node without the zstd API.
  if (opts.command === 'workspace-registry') return runWorkspaceRegistry(opts);
  if (!hasZstd()) {
    writeErr(`this Node has no synchronous zstd API (needs >= 22.15 or >= 23); current ${process.version}`);
    return EXIT.UNSUPPORTED_NODE;
  }
  // Renumber needs only `--file`: it must not require a full `$DSH_HOME` layout the way scan/fix do.
  if (opts.command === 'renumber') return runRenumber(opts);
  // session-reframe reads/writes explicit paths only, for the same reason.
  if (opts.command === 'session-reframe') return runSessionReframe(opts);
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
