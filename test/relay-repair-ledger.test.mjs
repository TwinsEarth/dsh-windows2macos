/**
 * Regression for the ledger repair tool (Vultr `ledger.jsonl` line 277 was a torn JSON line).
 *
 * The properties that matter:
 *   - a corrupt line is reported and NEVER guessed at
 *   - dry-run does not touch the file
 *   - `apply` keeps every valid line in order and byte-for-byte, backs the original up, quarantines
 *     the invalid raw lines, and verifies the rewritten file parses
 *   - a relay that appended during the read is detected (LEDGER_BUSY), not silently truncated
 *   - the operation is idempotent
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { repairLedger } from '../src/relay/repair-ledger.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'w2m-ledger-'));
const ledger = (lines) => {
  const d = dir();
  const file = join(d, 'ledger.jsonl');
  writeFileSync(file, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8');
  return { d, file };
};
const valid = (n) => JSON.stringify({ type: 'task.created', seq: n, task_id: 't' + n });

describe('ledger repair: clean file', () => {
  it('reports nothing to do and does not write', () => {
    const { file } = ledger([valid(1), valid(2)]);
    const before = readFileSync(file);
    const report = repairLedger(file);
    assert.equal(report.ok, true);
    assert.equal(report.changed, false);
    assert.equal(report.invalid_count, 0);
    assert.equal(report.valid_lines, 2);
    assert.deepEqual(readFileSync(file), before);
  });

  it('apply on a clean file is a no-op (no backup invented)', () => {
    const { d, file } = ledger([valid(1)]);
    const report = repairLedger(file, { apply: true });
    assert.equal(report.written, false);
    assert.equal(readdirSync(d).filter((name) => name.includes('.bak-')).length, 0);
  });

  it('a missing file is a named refusal', () => {
    const report = repairLedger(join(dir(), 'nope.jsonl'));
    assert.equal(report.ok, false);
    assert.equal(report.code, 'LEDGER_MISSING');
  });
});

describe('ledger repair: corrupt line', () => {
  it('dry-run reports the corrupt line and leaves the bytes untouched', () => {
    const { file } = ledger([valid(1), '{"type":"task.created","seq":', valid(3)]);
    const before = readFileSync(file);
    const report = repairLedger(file);
    assert.equal(report.ok, true);
    assert.equal(report.changed, true);
    assert.equal(report.invalid_count, 1);
    assert.equal(report.invalid[0].line, 2);
    assert.equal(report.written, false);
    assert.deepEqual(readFileSync(file), before);
  });

  it('apply backs up, quarantines and keeps valid lines in order', () => {
    const { file } = ledger([valid(1), '{"broken":', valid(3), valid(4)]);
    const before = readFileSync(file, 'utf8');
    const report = repairLedger(file, { apply: true });
    assert.equal(report.ok, true);
    assert.equal(report.written, true);
    assert.equal(report.verified, true);
    assert.equal(existsSync(report.backup), true);
    assert.equal(readFileSync(report.backup, 'utf8'), before, 'backup is the original bytes');
    assert.equal(existsSync(report.quarantine), true);
    assert.ok(readFileSync(report.quarantine, 'utf8').includes('{"broken":'));
    const kept = readFileSync(file, 'utf8').trim().split('\n');
    assert.deepEqual(kept, [valid(1), valid(3), valid(4)]);
    for (const line of kept) assert.doesNotThrow(() => JSON.parse(line));
    assert.notEqual(report.sha256_after, report.sha256_before);
  });

  it('a torn final line without a newline is corrupt too', () => {
    const d = dir();
    const file = join(d, 'ledger.jsonl');
    writeFileSync(file, valid(1) + '\n' + '{"type":"task.creat', 'utf8');
    const report = repairLedger(file, { apply: true });
    assert.equal(report.written, true);
    assert.equal(report.invalid_count, 1);
    assert.equal(report.invalid[0].line, 2);
    assert.equal(readFileSync(file, 'utf8'), valid(1));
  });

  it('is idempotent: the second apply finds nothing', () => {
    const { file } = ledger([valid(1), 'not json', valid(2)]);
    assert.equal(repairLedger(file, { apply: true }).written, true);
    const second = repairLedger(file, { apply: true });
    assert.equal(second.changed, false);
    assert.equal(second.written, false);
  });

  it('keeps the file mode (service account must still read it)', { skip: process.platform === 'win32' ? 'POSIX file mode is not measurable on Windows' : false }, () => {
    const d = dir();
    const file = join(d, 'ledger.jsonl');
    writeFileSync(file, valid(1) + '\\n' + 'broken' + '\\n', { encoding: 'utf8', mode: 0o640 });
    chmodSync(file, 0o640);
    assert.equal(repairLedger(file, { apply: true }).written, true);
    assert.equal(statSync(file).mode & 0o777, 0o640);
  });

  it('CRLF line endings are preserved for valid lines', () => {
    const d = dir();
    const file = join(d, 'ledger.jsonl');
    writeFileSync(file, valid(1) + '\r\n' + 'broken' + '\r\n' + valid(2) + '\r\n', 'utf8');
    const report = repairLedger(file, { apply: true });
    assert.equal(report.written, true);
    const text = readFileSync(file, 'utf8');
    assert.equal(text, valid(1) + '\r\n' + valid(2) + '\r\n');
  });
});
