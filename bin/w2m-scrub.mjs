#!/usr/bin/env node
/**
 * Relay state scrub CLI (G0-3).
 *
 * Moves the data-plane residue out of a relay's live state: ledger lines are projected (content
 * fields dropped), the content-addressed blob tree (the real layout is blobs/<aa>/<sha>) is deleted,
 * and the result is scanned for any surviving content marker.
 *
 * Dry-run is the default. `--apply` requires `--backup-dir` OUTSIDE the state directory: the bytes
 * the scrub removes must still exist somewhere the operator controls, or this is deletion, not
 * cleanup with a floor.
 *
 * Usage:
 *   node bin/w2m-scrub.mjs --state /var/lib/w2m/rabbit
 *   node bin/w2m-scrub.mjs --state /var/lib/w2m/rabbit --apply --backup-dir /root/w2m-backups
 *
 * Exit codes: 0 ok, 1 refusal, 2 usage.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { scanForContent, scrubBlobs, scrubLedger } from '../src/relay/scrub.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const has = (name) => args.includes(name);
const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

const stateDir = flag('--state');
if (typeof stateDir !== 'string') {
  print({ ok: false, code: 'STATE_REQUIRED', usage: '--state <dir> [--apply --backup-dir <dir>]' });
  process.exit(2);
}
const apply = has('--apply');
const backupDir = flag('--backup-dir');
const now = Date.now();

if (apply === true) {
  if (typeof backupDir !== 'string' || backupDir === '') {
    print({ ok: false, code: 'BACKUP_DIR_REQUIRED', detail: '--apply requires --backup-dir outside the state directory' });
    process.exit(2);
  }
  if (resolve(backupDir).startsWith(resolve(stateDir) + '/') || resolve(backupDir) === resolve(stateDir)) {
    print({ ok: false, code: 'BACKUP_DIR_INSIDE_STATE', detail: 'the backup must live outside the relay state directory' });
    process.exit(2);
  }
}

const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
let backupRoot = null;
if (apply === true) {
  backupRoot = join(backupDir, 'relay-' + stamp);
  try {
    mkdirSync(backupRoot, { recursive: true });
    for (const name of ['ledger.jsonl', 'blobs', 'results', 'devices.json']) {
      const source = join(stateDir, name);
      if (existsSync(source)) cpSync(source, join(backupRoot, name), { recursive: true });
    }
  } catch (error) {
    print({ ok: false, code: 'BACKUP_FAILED', detail: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

const ledger = scrubLedger(join(stateDir, 'ledger.jsonl'), { dryRun: apply !== true, now });
const blobs = scrubBlobs(join(stateDir, 'blobs'), { dryRun: apply !== true, now });
const scan = apply === true ? scanForContent(stateDir) : { ok: null, hits: [] };

print({
  ok: ledger.ok === true && blobs.ok === true && (apply !== true || scan.ok === true),
  apply,
  state: stateDir,
  backup_dir: backupRoot,
  ledger: { exists: ledger.exists, changed: ledger.changed, lines: ledger.lines, backup: ledger.backup },
  blobs: { exists: blobs.exists, files: blobs.files?.length ?? 0, bytes: blobs.bytes, deleted: blobs.deleted },
  scan: { ok: scan.ok, hits: scan.hits?.length ?? 0 },
});
process.exit(ledger.ok === true && blobs.ok === true && (apply !== true || scan.ok === true) ? 0 : 1);
