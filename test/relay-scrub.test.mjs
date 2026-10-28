/**
 * Regression for scrubLedger (relay ledger purge) + the merge onto the single projection.
 *
 * The bug the merge fixes: scrub carried its own shallow projection, so a REAL ledger line
 * (`{type:'result.stored', result:{envelope:{...}}}` with nested pipeline argv) was reported as
 * "nothing to change". The tests below use that real shape and assert the p0 projection runs.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { scrubLedger, scanForContent } from '../src/relay/scrub.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'w2m-scrub-'));
function ledger(lines) {
  const d = dir();
  const file = join(d, 'ledger.jsonl');
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return { d, file };
}
const nested = (extra = {}) => JSON.stringify({
  type: 'result.stored',
  task_id: 't1',
  result: {
    envelope: {
      stdout_head: 'SECRET-HEAD',
      stdout_tail: 'SECRET-TAIL',
      command_argv: ['node', '--token=SECRET'],
      blob_sha256: 'a'.repeat(64),
      pipeline: { stages: [{ command_argv: ['x'] }] },
      stdout_sha256: 'b'.repeat(64),
      stdout_bytes: 10,
      ...extra,
    },
  },
});

describe('ledger scrub: real nested shape', () => {
  it('dry-run reports the change and leaves the bytes untouched', () => {
    const { file } = ledger([nested()]);
    const before = readFileSync(file);
    const report = scrubLedger(file);
    assert.equal(report.ok, true);
    assert.equal(report.changed, 1);
    assert.equal(report.backup, null);
    assert.deepEqual(readFileSync(file), before);
  });

  it('apply projects the nested result, keeps size metadata and writes a backup', () => {
    const { file } = ledger([nested(), JSON.stringify({ type: 'task.created', task: { id: 't1' } })]);
    const before = readFileSync(file, 'utf8');
    const report = scrubLedger(file, { dryRun: false });
    assert.equal(report.ok, true);
    assert.equal(report.changed, 1);
    assert.ok(existsSync(report.backup));
    assert.equal(readFileSync(report.backup, 'utf8'), before);
    const text = readFileSync(file, 'utf8');
    assert.equal(text.includes('SECRET-HEAD'), false);
    assert.equal(text.includes('SECRET-TAIL'), false);
    assert.equal(text.includes('SECRET'), false);
    const projected = JSON.parse(text.split('\n')[0]);
    assert.equal(projected.result.envelope.stdout_bytes, 10);
    assert.equal(projected.result.envelope.stdout_sha256, 'b'.repeat(64));
    assert.ok(Array.isArray(projected.projection.dropped));
  });

  it('a clean ledger reports zero and does not invent a backup', () => {
    const { file } = ledger([JSON.stringify({ type: 'task.created', task: { id: 't' } })]);
    const report = scrubLedger(file, { dryRun: false });
    assert.equal(report.changed, 0);
    assert.equal(report.backup, null);
  });

  it('a top-level envelope record is projected as well', () => {
    const { file } = ledger([JSON.stringify({ type: 'result.stored', envelope: { stdout_head: 'SECRET', stdout_bytes: 3 } })]);
    const report = scrubLedger(file, { dryRun: false });
    assert.equal(report.changed, 1);
    assert.equal(readFileSync(file, 'utf8').includes('SECRET'), false);
  });

  it('scanForContent agrees with the scrub result', () => {
    const { d, file } = ledger([nested()]);
    assert.equal(scanForContent(d).ok, false, 'content fields are visible before the scrub');
    scrubLedger(file, { dryRun: false });
    assert.equal(scanForContent(d).ok, true, 'no content fields after the scrub');
  });
});
