/** relay P0 投影正式测试（V5/V6/V7/V8/V12 纯函数层）。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  blobRefusal,
  projectLedgerLine,
  projectResultEnvelope,
  stripReportAggregate,
} from '../src/relay/p0-projection.mjs';

const envelope = () => ({
  task_id: 't1',
  stdout_head: 'SECRET-OUT',
  stderr_tail: 'SECRET-ERR',
  command_argv: ['node', '--token=SECRET-ARGV'],
  blob_sha256: 'b'.repeat(64),
  output_mode: 'blob',
  changed_files: ['b.txt', 'a.txt'],
  workspace: { changed_files: ['y.txt', 'x.txt'], patch_sha256: 'a'.repeat(64) },
  stdout_sha256: 'c'.repeat(64),
  stdout_bytes: 1234,
});

describe('V5/V6/V7 结果信封投影', () => {
  it('去 head/tail/argv，argv→hash，路径→count+hash', () => {
    const { projected, dropped } = projectResultEnvelope(envelope());
    const text = JSON.stringify(projected);
    assert.equal(text.includes('SECRET'), false);
    assert.deepEqual(dropped.sort(), ['blob_sha256', 'changed_files', 'command_argv', 'output_mode', 'stderr_tail', 'stdout_head', 'workspace.changed_files'].sort());
    assert.equal(projected.command_argv_sha256.length, 64);
    assert.equal(projected.blob_sha256, null);
    assert.equal(projected.files.count, 2);
    assert.equal(projected.workspace.files.count, 2);
    assert.equal(projected.workspace.patch_sha256, null);
    assert.equal(projected.stdout_sha256, 'c'.repeat(64));
    assert.equal(projected.stdout_bytes, 1234);
  });

  it('不改入参（纯函数）', () => {
    const input = envelope();
    projectResultEnvelope(input);
    assert.equal(input.stdout_head, 'SECRET-OUT');
  });
});

describe('V5/V6 ledger 投影', () => {
  it('result.stored 行被投影并记录 dropped', () => {
    const line = JSON.stringify({ type: 'result.stored', result: envelope() });
    const { changed, line: projected } = projectLedgerLine(line);
    assert.equal(changed, true);
    assert.equal(projected.includes('SECRET'), false);
    const record = JSON.parse(projected);
    assert.ok(record.projection.dropped.includes('stdout_head'));
    assert.equal(record.result.command_argv_sha256.length, 64);
  });
  it('无内容字段的行保持不变', () => {
    const line = JSON.stringify({ type: 'task.created', task: { id: 't1' } });
    assert.equal(projectLedgerLine(line).changed, false);
  });
});

describe('V8 报表投影', () => {
  it('删除 stdout_head，blob_sha256 置 null', () => {
    const report = stripReportAggregate({ machines: [{ machine_id: 'm', stdout_head: 'SECRET', blob_sha256: 'c'.repeat(64) }], stdout_head: 'SECRET' });
    assert.equal(JSON.stringify(report).includes('SECRET'), false);
    assert.equal(report.machines[0].blob_sha256, null);
  });
});

describe('V12 blob 端点拒绝', () => {
  it('PUT/GET/POST 一律 403 DATA_PLANE_REFUSED', () => {
    for (const method of ['PUT', 'GET', 'POST']) {
      const result = blobRefusal(method);
      assert.equal(result.status, 403);
      assert.equal(result.body.code, 'DATA_PLANE_REFUSED');
      assert.equal(result.body.detail.method, method);
    }
  });
});
