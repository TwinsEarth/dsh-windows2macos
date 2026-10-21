/**
 * Result outbox tests (M6, v1.3.10-beta.21 slice).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResultOutbox, OUTBOX_LIMITS } from '../src/agent/outbox.mjs';

function setup(overrides = {}) {
  let t = Date.parse('2026-10-22T00:00:00Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; return t; } };
  const dir = mkdtempSync(join(tmpdir(), 'w2m-outbox-'));
  const outbox = createResultOutbox({ dir, now: clock.now, ...overrides });
  return { outbox, dir, clock };
}

const envelope = (id) => ({ envelope_version: 3, task_id: 't-' + id, attempt: 1, status: 'ok', stdout_head: 'done ' + id });

describe('result outbox', () => {
  it('persists a result atomically and reports depth', () => {
    const { outbox, dir } = setup();
    const stored = outbox.enqueue({ taskId: 't-1', attempt: 1, dedupeKey: 'dk-1', envelope: envelope(1) });
    assert.equal(stored.ok, true);
    assert.equal(stored.duplicate, undefined);
    assert.equal(outbox.stats().depth, 1);
    assert.notEqual(stored.item.payload_sha256, undefined);
    assert.ok(readdirSync(dir).some((name) => name.endsWith('.json')));
    assert.ok(!readdirSync(dir).some((name) => name.endsWith('.tmp')));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  });

  it('treats a repeated enqueue of the same task/attempt as one entry', () => {
    const { outbox } = setup();
    outbox.enqueue({ taskId: 't-1', attempt: 1, envelope: envelope(1) });
    const again = outbox.enqueue({ taskId: 't-1', attempt: 1, envelope: { changed: true } });
    assert.equal(again.duplicate, true);
    assert.equal(outbox.stats().depth, 1);
    assert.equal(again.item.envelope.stdout_head, 'done 1');
  });

  it('recovers pending entries after a restart with their attempt count', () => {
    const { outbox, dir, clock } = setup();
    const stored = outbox.enqueue({ taskId: 't-2', attempt: 1, envelope: envelope(2) });
    outbox.fail({ resultId: stored.item.result_id, error: 'offline' });
    clock.advance(1_000);
    const afterRestart = createResultOutbox({ dir, now: clock.now });
    const pending = afterRestart.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].attempts, 1);
    assert.equal(pending[0].task_id, 't-2');
  });

  it('backs off exponentially, caps the delay, and quarantines after max attempts', () => {
    const { outbox, clock } = setup({ limits: { ...OUTBOX_LIMITS, maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 4000 } });
    const stored = outbox.enqueue({ taskId: 't-3', attempt: 1, envelope: envelope(3) });
    const first = outbox.fail({ resultId: stored.item.result_id, error: 'x' });
    assert.equal(first.retry_in_ms, 1000);
    assert.equal(outbox.pending().length, 0, 'backoff keeps it out of pending until due');
    clock.advance(1000);
    assert.equal(outbox.pending().length, 1);
    const second = outbox.fail({ resultId: stored.item.result_id });
    assert.equal(second.retry_in_ms, 2000);
    const third = outbox.fail({ resultId: stored.item.result_id });
    assert.equal(third.exhausted, true);
    assert.equal(outbox.pending().length, 0);
    assert.equal(outbox.stats().depth, 0);
  });

  it('removes an entry only after ack', () => {
    const { outbox } = setup();
    const stored = outbox.enqueue({ taskId: 't-4', attempt: 1, envelope: envelope(4) });
    assert.equal(outbox.pending().length, 1);
    assert.equal(outbox.ack({ resultId: stored.item.result_id }).ok, true);
    assert.equal(outbox.stats().depth, 0);
    assert.equal(outbox.ack({ resultId: stored.item.result_id }).code, 'OUTBOX_NOT_FOUND');
  });

  it('drops the oldest entries when the item count limit is reached and warns', () => {
    const { outbox } = setup({ limits: { ...OUTBOX_LIMITS, maxItems: 2 } });
    outbox.enqueue({ taskId: 't-5', attempt: 1, envelope: envelope(5) });
    outbox.enqueue({ taskId: 't-6', attempt: 1, envelope: envelope(6) });
    const third = outbox.enqueue({ taskId: 't-7', attempt: 1, envelope: envelope(7) });
    assert.equal(third.outbox_full, true);
    assert.equal(third.dropped, 1);
    assert.equal(outbox.stats().depth, 2);
    assert.deepEqual(outbox.list().map((item) => item.task_id), ['t-6', 't-7']);
  });

  it('quarantines a corrupt entry instead of failing to start', () => {
    const { outbox, dir } = setup();
    outbox.enqueue({ taskId: 't-8', attempt: 1, envelope: envelope(8) });
    writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8');
    assert.equal(outbox.stats().depth, 1);
    assert.ok(readdirSync(join(dir, 'dead')).some((name) => name.endsWith('.corrupt')));
  });

  it('refuses a single result larger than the byte limit', () => {
    const { outbox } = setup({ limits: { ...OUTBOX_LIMITS, maxBytes: 64 } });
    const result = outbox.enqueue({ taskId: 't-9', attempt: 1, envelope: { blob: 'x'.repeat(200) } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OUTBOX_FULL');
    assert.equal(outbox.stats().depth, 0);
  });
});
