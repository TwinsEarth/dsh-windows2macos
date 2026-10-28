/** G0-3/R8: the scrub projects legacy task records to hash + length, so an old ledger stops carrying commands. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { scanForContent, scrubLedger } from '../src/relay/scrub.mjs';

const taskLine = JSON.stringify({
  type: 'task.created',
  ts: '2026-10-01T00:00:00Z',
  task: {
    task_id: 't-1', mode: 'replicate', command_argv: ['node', '--test'], command_hash: 'a'.repeat(64),
    command_argv_len: undefined, cwd_rel: '.', index_total: 1,
  },
});
const resultLine = JSON.stringify({
  type: 'result.stored',
  result: { envelope: { task_id: 't-1', machine_id: 'm-1', command_hash: 'a'.repeat(64), stdout_head: 'secret', stderr_tail: 'secret2' } },
});

describe('scrub projects legacy task records', () => {
  it('drops command_argv, keeps command_hash and writes the length', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-task-scrub-'));
    const ledger = join(dir, 'ledger.jsonl');
    writeFileSync(ledger, taskLine + '\n' + resultLine + '\n', 'utf8');
    const dry = scrubLedger(ledger, { dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.changed, 2);
    const applied = scrubLedger(ledger, { dryRun: false });
    assert.equal(applied.ok, true);
    assert.equal(applied.changed, 2);
    const text = readFileSync(ledger, 'utf8');
    assert.equal(/"command_argv"\s*:/.test(text), false);
    assert.equal(/"stdout_head"\s*:/.test(text), false);
    const task = JSON.parse(text.split('\n')[0]).task;
    assert.equal(task.command_argv_len, 2);
    assert.equal(task.command_hash, 'a'.repeat(64));
    assert.equal(scanForContent(dir).ok, true);
    assert.equal(scrubLedger(ledger).changed, 0, 'the scrub is idempotent');
  });
});
