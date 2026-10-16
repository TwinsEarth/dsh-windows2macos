#!/usr/bin/env node
/**
 * Bound the DSH session store (v0.60.0).
 *
 * ## Why this is out-of-band, in DSH's own words
 *
 * `@deepseek-ai/dsh-session-persistence`'s README, under "Known Limitations":
 *
 * > **No deletion or retention API** -- pruning stored sessions is **out-of-band backend maintenance**.
 *
 * So this is not a workaround for a missing feature. **The host states that retention is the operator's job, and
 * this is that job done with a visible plan instead of an `rm`.**
 *
 * ## The measurement that motivated it
 *
 * One session -- a single long conversation -- reached **18.03 MB of a 18.07 MB store**. Nothing bounds it, and
 * every start reads the store. **A store that grows without limit is a startup cost that grows without limit**,
 * and on a 200 MB client the operator has no way to see that happening.
 *
 * ## What it refuses to do
 *
 * * **Never touch the live session.** DSH is writing to it; deleting it corrupts an open handle. The newest
 *   session per workspace is kept unconditionally, and `--keep` can raise that floor but not lower it.
 * * **Never delete without being asked.** `--apply` is required; the default prints the plan. **A tool that
 *   removes conversation history must show what it will remove before it removes it.**
 * * **Never guess at the layout.** The store is `<home>/sessions/<workspace-slug>/<session-id>/`, read from the
 *   filesystem here rather than assumed, and a directory that does not match that shape is reported, not touched.
 *
 * ## Exit codes
 *
 *   0  nothing to do, or the plan applied cleanly
 *   1  the scan failed
 *   2  bad arguments
 *   3  --apply was given but the plan could not be carried out
 */
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const DEFAULT_HOME = join(homedir(), '.dsh');
export const MiB = 1024 * 1024;

/** Directory size, recursively, without following symlinks. */
export function dirSize(path) {
  let total = 0;
  let files = 0;
  const walk = (p) => {
    let entries;
    try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(p, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;
      try { total += statSync(full).size; files += 1; } catch { /* a file that vanished mid-scan is not a failure */ }
    }
  };
  walk(path);
  return { bytes: total, files };
}

/**
 * Read the store: one record per session, newest first within each workspace.
 *
 * @param {string} home the DSH home directory
 * @returns {{sessions: object[], foreign: string[], problem: string|null}}
 */
export function scanStore(home = DEFAULT_HOME) {
  const root = join(home, 'sessions');
  if (!existsSync(root)) return { sessions: [], foreign: [], problem: `no session store at ${root}` };

  const sessions = [];
  const foreign = [];
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) { foreign.push(workspace.name); continue; }
    const wsPath = join(root, workspace.name);
    for (const session of readdirSync(wsPath, { withFileTypes: true })) {
      if (!session.isDirectory()) { foreign.push(`${workspace.name}/${session.name}`); continue; }
      const path = join(wsPath, session.name);
      const { bytes, files } = dirSize(path);
      let mtimeMs = 0;
      try { mtimeMs = statSync(path).mtimeMs; } catch { /* keep 0 */ }
      sessions.push({ workspace: workspace.name, id: session.name, path, bytes, files, mtimeMs });
    }
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { sessions, foreign, problem: null };
}

/**
 * Decide what to remove to bring the store under `capBytes`.
 *
 * **The newest session of each workspace is pinned.** That is what keeps the live session safe without needing
 * to know which process is running: DSH writes to the most recent one, and no other rule can be checked reliably
 * from outside the process.
 *
 * @param {object[]} sessions from `scanStore`
 * @param {{capBytes: number, keepPerWorkspace?: number}} options
 * @returns {{keep: object[], remove: object[], totalBytes: number, freedBytes: number}}
 */
export function planPrune(sessions, { capBytes, keepPerWorkspace = 1 }) {
  const pinned = new Map();
  // Newest first, so the first N seen per workspace are the ones preserved.
  for (const s of sessions) {
    const n = pinned.get(s.workspace) ?? 0;
    if (n < keepPerWorkspace) pinned.set(s.workspace, n + 1);
  }

  const keep = [];
  const remove = [];
  let running = 0;
  for (const s of sessions) {
    // Pinned by identity, not by index: an earlier pass may already have consumed the quota.
    const isPinned = keep.filter((k) => k.workspace === s.workspace).length < keepPerWorkspace;
    if (isPinned) { keep.push(s); running += s.bytes; continue; }
    // Once under the cap, everything remaining is kept as well -- the cap bounds the total, not the count.
    if (running + s.bytes <= capBytes) { keep.push(s); running += s.bytes; continue; }
    remove.push(s);
  }

  const totalBytes = sessions.reduce((a, s) => a + s.bytes, 0);
  return { keep, remove, totalBytes, freedBytes: remove.reduce((a, s) => a + s.bytes, 0) };
}

const mb = (n) => `${(n / MiB).toFixed(2)} MiB`;

function main(argv) {
  const flag = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
  const apply = argv.includes('--apply');
  const capMb = Number(flag('--cap-mb', '256'));
  const keepPerWorkspace = Number(flag('--keep', '1'));
  const home = flag('--home', DEFAULT_HOME);

  if (!Number.isFinite(capMb) || capMb <= 0) { process.stderr.write('--cap-mb must be a positive number\n'); process.exit(2); }
  if (!Number.isInteger(keepPerWorkspace) || keepPerWorkspace < 1) { process.stderr.write('--keep must be a positive integer\n'); process.exit(2); }

  const { sessions, foreign, problem } = scanStore(home);
  if (problem !== null) { process.stderr.write(`${problem}\n`); process.exit(1); }

  const capBytes = capMb * MiB;
  const { keep, remove, totalBytes, freedBytes } = planPrune(sessions, { capBytes, keepPerWorkspace });

  process.stdout.write(`  store        ${home}\\sessions\n`);
  process.stdout.write(`  sessions     ${sessions.length}\n`);
  process.stdout.write(`  total        ${mb(totalBytes)}\n`);
  process.stdout.write(`  cap          ${mb(capBytes)}\n`);
  if (foreign.length > 0) process.stdout.write(`  not a session directory (untouched): ${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? `, +${foreign.length - 5}` : ''}\n`);
  process.stdout.write('\n');

  if (remove.length === 0) {
    process.stdout.write(`  under the cap -- nothing to remove\n`);
    process.exit(0);
  }

  process.stdout.write(`  would remove ${remove.length} session(s), freeing ${mb(freedBytes)}:\n`);
  for (const s of remove.slice(0, 20)) {
    process.stdout.write(`    ${mb(s.bytes).padStart(10)}  ${new Date(s.mtimeMs).toISOString().slice(0, 16)}  ${s.workspace}/${s.id}\n`);
  }
  if (remove.length > 20) process.stdout.write(`    ... and ${remove.length - 20} more\n`);
  process.stdout.write(`\n  keeping ${keep.length}, including the newest session of every workspace (never removed while DSH may be writing to it)\n`);

  if (!apply) {
    process.stdout.write('\n  DRY RUN -- nothing was deleted. Re-run with --apply to carry this out.\n');
    process.exit(0);
  }

  let failed = 0;
  for (const s of remove) {
    try { rmSync(s.path, { recursive: true, force: true }); } catch (error) { failed += 1; process.stderr.write(`  could not remove ${s.path}: ${error.message}\n`); }
  }
  process.stdout.write(`\n  removed ${remove.length - failed} of ${remove.length}\n`);
  process.exit(failed === 0 ? 0 : 3);
}

/**
 * Run only when executed, never when imported.
 *
 * The same guard every other script in this directory carries, and for the same reason: `src/chatops/vision.mjs`
 * and three bins were each found executing on import, and **a tool that prunes conversation history must not be
 * one `import` away from running.** `pathToFileURL` rather than a hand-built `file://` string, which does not
 * resolve on Windows.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
