/**
 * Temp-residue toolkit for the zero-residue test requirement.
 *
 * The audit found ~1,000 test-created directories per full-suite run left behind under the user's TEMP (prefixes such as
 * `w2m-ws-`, `w2m-wt-`, `w2m-reduce-`, `gpw-`). This module gives the suite two things it lacked:
 *
 *   1. a per-test-file baseline + cleanup (`withTempCleanup`) that removes only the directories that file created, so
 *      concurrently running test files cannot delete each other's live fixtures;
 *   2. a snapshot/report/clean CLI used by the audit and by `npm run test:residue`.
 *
 * Usage inside a test file:
 *
 *   import { withTempCleanup } from './helpers/temp-cleanup.mjs';
 *   const temp = withTempCleanup();
 *   // ... create fixtures with mkdtempSync(join(tmpdir(), 'w2m-x-'))
 *   // the `after` hook removes exactly the new `w2m-*`/`gpw-*` directories this file created
 *
 * CLI:
 *
 *   node scripts/temp-residue.mjs snapshot --out .tmp-residue-baseline.json
 *   node scripts/temp-residue.mjs report --baseline .tmp-residue-baseline.json
 *   node scripts/temp-residue.mjs clean --older-than-minutes 30
 */
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const RESIDUE_PATTERN = /^(w2m|gpw)-/;

/** Directories currently under TEMP that look like test fixtures. */
export function listResidueDirs() {
  const dir = tmpdir();
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!RESIDUE_PATTERN.test(name)) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isDirectory()) continue;
      out.push({ name, full, mtimeMs: statSync(full).mtimeMs });
    } catch {
      /* vanished between readdir and stat: not residue */
    }
  }
  return out;
}

/**
 * Register an `after` hook that removes only the residue dirs created after this helper was installed.
 *
 * The baseline is a set of names, not a timeout: a concurrent test file's directory is new to *that* file's baseline and
 * therefore never touched here. That is what makes it safe under `node --test`'s default file-level concurrency.
 */
export function withTempCleanup() {
  const before = new Set(listResidueDirs().map((entry) => entry.name));
  const removeNew = () => {
    const removed = [];
    for (const entry of listResidueDirs()) {
      if (before.has(entry.name)) continue;
      try {
        rmSync(entry.full, { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        /* a Windows file handle may still be open; the next audit run reports it */
      }
    }
    return removed;
  };
  return { before, removeNew, register() { return removeNew; } };
}

/** CLI: snapshot | report | clean. */
export function runCli(argv) {
  const action = argv[0] ?? 'report';
  const flag = (name, fallback) => {
    const index = argv.indexOf('--' + name);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  if (action === 'snapshot') {
    const file = flag('out', '.tmp-residue-baseline.json');
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), dirs: listResidueDirs().map((e) => e.name) }, null, 2) + '\n');
    console.log('baseline written: ' + file + ' (' + listResidueDirs().length + ' dirs)');
    return 0;
  }
  if (action === 'report') {
    const baselineFile = flag('baseline', '.tmp-residue-baseline.json');
    let baseline = [];
    try {
      baseline = JSON.parse(readFileSync(baselineFile, 'utf8')).dirs ?? [];
    } catch {
      /* no baseline: report the total */
    }
    const before = new Set(baseline);
    const now = listResidueDirs();
    const leaked = now.filter((entry) => !before.has(entry.name));
    const byPrefix = {};
    for (const entry of leaked) {
      const prefix = entry.name.slice(0, entry.name.lastIndexOf('-') + 1);
      byPrefix[prefix] = (byPrefix[prefix] ?? 0) + 1;
    }
    console.log(JSON.stringify({ at: new Date().toISOString(), before: before.size, now: now.length, leaked: leaked.length, by_prefix: byPrefix }, null, 2));
    return leaked.length === 0 ? 0 : 1;
  }
  if (action === 'clean') {
    const minutes = Number(flag('older-than-minutes', '60'));
    const cutoff = Date.now() - minutes * 60_000;
    let removed = 0;
    for (const entry of listResidueDirs()) {
      if (entry.mtimeMs > cutoff) continue;
      try {
        rmSync(entry.full, { recursive: true, force: true });
        removed += 1;
      } catch {
        /* locked entries stay for the next run */
      }
    }
    console.log('removed ' + removed + ' residue director' + (removed === 1 ? 'y' : 'ies') + ' older than ' + minutes + ' min');
    return 0;
  }
  console.error('unknown action: ' + action + ' (snapshot|report|clean)');
  return 2;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('temp-residue.mjs')) {
  process.exitCode = runCli(process.argv.slice(2));
}
