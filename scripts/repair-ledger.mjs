#!/usr/bin/env node
/**
 * CLI for the ledger repair: dry-run by default, `--apply` to quarantine corrupt lines and rewrite.
 *
 *   node scripts/repair-ledger.mjs --file <state>/ledger.jsonl            # report only
 *   node scripts/repair-ledger.mjs --file <state>/ledger.jsonl --apply    # backup + rewrite
 *
 * Exit codes: 0 ok (including "nothing to do"), 1 write/verification failure, 2 missing/busy file.
 */
import { repairLedger, LEDGER_REPAIR_CODES } from '../src/relay/repair-ledger.mjs';

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
};
const file = value('--file') ?? value('-f');
const apply = args.includes('--apply') === true;
const quarantineDir = value('--quarantine-dir') ?? undefined;

if (file === null) {
  process.stderr.write('usage: node scripts/repair-ledger.mjs --file <ledger.jsonl> [--apply] [--quarantine-dir <dir>]\n');
  process.exit(2);
}

let report;
try {
  report = repairLedger(file, { apply, quarantineDir });
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n');
  process.exit(1);
}

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (report.ok !== true) {
  process.exit(report.code === LEDGER_REPAIR_CODES.MISSING || report.code === LEDGER_REPAIR_CODES.BUSY || report.code === LEDGER_REPAIR_CODES.NOT_A_FILE ? 2 : 1);
}
