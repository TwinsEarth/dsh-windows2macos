#!/usr/bin/env node
/**
 * Purge a relay blob store (legacy data plane). Stop the relay first.
 *
 *   node scripts/purge-blobs.mjs --dir <state>/blobs                 # dry run
 *   node scripts/purge-blobs.mjs --dir <state>/blobs --apply         # delete
 *   node scripts/purge-blobs.mjs --dir <state>/blobs --apply --quarantine /backup/w2m-blobs
 *
 * Exit codes: 0 ok, 2 missing/not a directory, 1 purge/verify failure.
 */
import { purgeBlobs, PURGE_CODES } from '../src/relay/purge-blobs.mjs';

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
};
const dir = value('--dir') ?? value('-d');
const apply = args.includes('--apply') === true;
const quarantineDir = value('--quarantine') ?? null;

if (dir === null) {
  process.stderr.write('usage: node scripts/purge-blobs.mjs --dir <state>/blobs [--apply] [--quarantine <dir>]\n');
  process.exit(2);
}

let report;
try {
  report = purgeBlobs(dir, { apply, quarantineDir });
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n');
  process.exit(1);
}

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (report.ok !== true) {
  process.exit(report.code === PURGE_CODES.MISSING || report.code === PURGE_CODES.NOT_A_DIR ? 2 : 1);
}
