/** 联合开发 dispatch 单测：R1/R3/R4 —— 控制面只发元数据，违规拒绝并审计。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildControlEnvelopes, buildPlan, dispatchPlan } from '../src/plugin/joint-dev/dispatch.mjs';

const basePlan = () => ({
  title: 'two-step',
  base_commit: 'a'.repeat(40),
  steps: [
    { step_id: 's1', machine_id: 'm1', command_argv: ['node', 'edit-a.mjs'], write_scope: ['a.txt'] },
    { step_id: 's2', machine_id: 'm2', command_argv: ['node', 'edit-b.mjs'], write_scope: ['b.txt'], depends_on: ['s1'] },
  ],
});

describe('R1 计划不得含数据', () => {
  it('拒绝 patch/stdout/file 字段', () => {
    const withPatch = basePlan();
    withPatch.steps[0].patch = 'diff --git a/x b/x';
    assert.equal(buildPlan(withPatch).code, 'DATA_PLANE_FORBIDDEN');
    const withData = basePlan();
    withData.steps[1].file = 'b.txt';
    assert.equal(buildPlan(withData).code, 'DATA_PLANE_FORBIDDEN');
  });
  it('接受纯元数据计划并生成 plan_sha256', () => {
    const built = buildPlan(basePlan());
    assert.equal(built.ok, true);
    assert.equal(built.plan.plan_sha256.length, 64);
    assert.equal(built.plan.steps[0].command_hash.length, 64);
  });
  it('拒绝重复步骤、未知依赖、环', () => {
    const dup = basePlan();
    dup.steps[1].step_id = 's1';
    assert.equal(buildPlan(dup).code, 'PLAN_STEP_DUPLICATE');
    const unknown = basePlan();
    unknown.steps[0].depends_on = ['nope'];
    assert.equal(buildPlan(unknown).code, 'PLAN_DEP_UNKNOWN');
    const cycle = basePlan();
    cycle.steps[0].depends_on = ['s2'];
    assert.equal(buildPlan(cycle).code, 'PLAN_CYCLE');
  });
});

describe('R3 控制消息白名单与 16KiB', () => {
  it('每条信封只含元数据且 ≤16KiB', () => {
    const built = buildPlan(basePlan());
    for (const envelope of buildControlEnvelopes(built.plan)) {
      const json = JSON.stringify(envelope);
      assert.ok(Buffer.byteLength(json, 'utf8') <= 16384);
      assert.equal(json.includes('diff --git'), false);
      assert.equal('data' in envelope.body, false);
    }
  });
});

describe('分发与审计（R4）', () => {
  it('dry-run 不发送但返回字节数', async () => {
    const built = buildPlan(basePlan());
    let calls = 0;
    const result = await dispatchPlan({ plan: built.plan, dryRun: true, sendFn: async () => { calls += 1; return { ok: true }; } });
    assert.equal(calls, 0);
    assert.equal(result.ok, true);
    assert.ok(result.sent.every((entry) => entry.bytes > 0 && entry.dispatched === false));
  });
  it('正常发送：审计只含元数据、链可验证', async () => {
    const built = buildPlan(basePlan());
    const result = await dispatchPlan({ plan: built.plan, sendFn: async () => ({ ok: true }) });
    assert.equal(result.ok, true);
    assert.equal(result.sent.length, 2);
    const record = result.audits[0];
    assert.equal(record.event, 'joint.dispatch.sent');
    assert.equal(record.machine_id, 'm1');
    assert.equal(typeof record.control_bytes, 'number');
    assert.equal(record.control_sha256.length, 64);
    for (const key of ['patch', 'stdout', 'content', 'data']) assert.equal(key in record, false);
  });
  it('发送失败即停并审计', async () => {
    const built = buildPlan(basePlan());
    const result = await dispatchPlan({ plan: built.plan, sendFn: async () => { throw new Error('network down'); } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SEND_FAILED');
    assert.equal(result.audits.length, 1);
  });
  it('未构建的计划被拒绝', async () => {
    const result = await dispatchPlan({ plan: { steps: [] }, sendFn: async () => ({ ok: true }) });
    assert.equal(result.code, 'PLAN_NOT_BUILT');
  });
});
