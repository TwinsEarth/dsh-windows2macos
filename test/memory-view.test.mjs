/**
 * The memory view: the counts a person asks for first, and the rule that a row is never silently dropped.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMemoryView } from '../src/plugin/memory-view.mjs';

const task = (machine, status, at = '2026-10-20T01:00:00.000Z') => ({
  at, kind: 'task', machine_name: machine, status, command: 'node --test',
});

describe('counts answer "have we done this before"', () => {
  it('groups by machine and by status', () => {
    const view = renderMemoryView([task('win-desktop', 'ok'), task('win-desktop', 'failed'), task('macmini', 'ok')]);
    assert.deepEqual(view.by_machine, { 'win-desktop': 2, macmini: 1 });
    assert.deepEqual(view.by_status, { ok: 2, failed: 1 });
  });

  it('shows at most the limit and says it truncated', () => {
    const view = renderMemoryView([task('m', 'ok'), task('m', 'ok'), task('m', 'ok')], { limit: 2 });
    assert.equal(view.count, 3);
    assert.equal(view.shown, 2);
    assert.equal(view.truncated, true);
    assert.equal(view.lines.length, 2);
  });
});

describe('a line is built from what the record carries', () => {
  it('includes time, machine and the first informative field', () => {
    const view = renderMemoryView([task('win-desktop', 'ok')]);
    assert.ok(view.lines[0].text.startsWith('2026-10-20 01:00:00'), 'the time leads the line');
    assert.ok(view.lines[0].text.includes('win-desktop status=ok'));
    assert.ok(view.lines[0].text.includes('node --test'));
    assert.match(view.lines[0].text, /node --test/);
  });

  it('falls back to a short machine id when there is no name', () => {
    const view = renderMemoryView([{ at: '2026-10-20T01:00:00.000Z', machine_id: 'd89d5817-953d', status: 'ok' }]);
    assert.equal(view.lines[0].machine, 'd89d5817');
  });

  it('shows a row it does not understand instead of dropping it', () => {
    const view = renderMemoryView([{ totally: 'different' }, null, 'stray string']);
    assert.equal(view.count, 3);
    assert.equal(view.lines.length, 3);
    assert.match(view.lines[0].text, /(no time)/);
  });

  it('truncates a long line and keeps the marker', () => {
    const view = renderMemoryView([{ at: '2026-10-20T01:00:00.000Z', machine_name: 'm', command: 'x'.repeat(400) }]);
    assert.ok(view.lines[0].text.length <= 160);
    assert.ok(view.lines[0].text.endsWith('...'));
  });
});
