/** 联合开发 A–G 闭环验收（注入式，无网络；数据面直连，Relay 仅控制）。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { buildPlan, dispatchPlan } from '../src/plugin/joint-dev/dispatch.mjs';
import { collectArtifacts, mergeArtifacts, verifyReview } from '../src/plugin/joint-dev/loop.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');

function planInput() {
  return {
    title: 'joint-a-g',
    base_commit: 'a'.repeat(40),
    steps: [
      { step_id: 's1', machine_id: 'm1', command_argv: ['node', 'a.mjs'], write_scope: ['a.txt'] },
      { step_id: 's2', machine_id: 'm2', command_argv: ['node', 'b.mjs'], write_scope: ['b.txt'] },
      { step_id: 's3', machine_id: 'm3', command_argv: ['node', 'c.mjs'], write_scope: ['c.txt'] },
    ],
  };
}

describe('A 规划：DAG 可生成、可修订', () => {
  it('生成 plan_sha256；增删步骤后 hash 变化', () => {
    const first = buildPlan(planInput());
    assert.equal(first.ok, true);
    assert.equal(first.plan.plan_sha256.length, 64);
    const revisedInput = planInput();
    revisedInput.steps.push({ step_id: 's4', machine_id: 'm1', command_argv: ['node', 'd.mjs'], depends_on: ['s3'] });
    const revised = buildPlan(revisedInput);
    assert.equal(revised.ok, true);
    assert.notEqual(revised.plan.plan_sha256, first.plan.plan_sha256);
  });
});

describe('B/C 分发三机 + 直连收集合并', () => {
  it('控制面只发元数据；产物经注入 fetch 直连回收并合并', async () => {
    const built = buildPlan(planInput());
    const relayBodies = [];
    const dispatched = await dispatchPlan({
      plan: built.plan,
      sendFn: async (envelope) => { relayBodies.push(JSON.stringify(envelope)); return { ok: true }; },
    });
    assert.equal(dispatched.ok, true);
    assert.equal(dispatched.sent.length, 3);
    for (const body of relayBodies) {
      assert.ok(Buffer.byteLength(body, 'utf8') <= 16384);
      assert.equal(/diff --git|file content/.test(body), false);
    }
    const artifacts = [
      { machine: 'm1', file: 'a.txt', path: 'a.txt', sha256: sha('a-v1') },
      { machine: 'm2', file: 'b.txt', path: 'b.txt', sha256: sha('b-v1') },
      { machine: 'm3', file: 'c.txt', path: 'c.txt', sha256: sha('c-v1') },
    ];
    const content = new Map([['m1', 'a-v1'], ['m2', 'b-v1'], ['m3', 'c-v1']]);
    const collected = await collectArtifacts({
      refs: artifacts,
      crypto: { createHash: createHash },
      fetchFn: async (_ref) => content.get(_ref.machine),
    });
    assert.equal(collected.ok, true);
    const merged = mergeArtifacts({ artifacts: collected.artifacts });
    assert.equal(merged.ok, true);
    assert.equal(merged.files.length, 3);
  });
});

describe('D 冲突：同文件双改标记冲突，不静默覆盖', () => {
  it('返回 MERGE_CONFLICT 与双方 hash', () => {
    const artifacts = [
      { machine: 'm1', file: 'shared.txt', path: 'shared.txt', sha256: sha('left'), bytes: Buffer.from('left') },
      { machine: 'm2', file: 'shared.txt', path: 'shared.txt', sha256: sha('right'), bytes: Buffer.from('right') },
    ];
    const merged = mergeArtifacts({ artifacts });
    assert.equal(merged.ok, false);
    assert.equal(merged.code, 'MERGE_CONFLICT');
    assert.deepEqual(merged.conflicts[0].machines.sort(), ['m1', 'm2']);
  });
});

describe('E 复核：缺失/错误定位到机器与文件', () => {
  it('缺 ref → REF_MISSING；复核 FAIL 带 machine/file/reason', async () => {
    const refs = [
      { machine: 'm1', file: 'a.txt', path: 'a.txt', sha256: sha('a-v1') },
      { machine: 'm2', file: 'b.txt', path: 'b.txt', sha256: sha('b-v1') },
    ];
    const collected = await collectArtifacts({
      refs, crypto: { createHash },
      fetchFn: async (ref) => (ref.machine === 'm2' ? undefined : 'a-v1'),
    });
    assert.equal(collected.ok, false);
    assert.deepEqual(collected.problems[0], { machine: 'm2', file: 'b.txt', reason: 'REF_MISSING' });
    const merged = mergeArtifacts({ artifacts: collected.artifacts });
    const review = verifyReview({
      merged,
      expectations: [
        { machine: 'm1', file: 'a.txt', sha256: sha('a-v1') },
        { machine: 'm2', file: 'b.txt', sha256: sha('b-v1') },
      ],
    });
    assert.equal(review.verdict, 'FAIL');
    const failed = review.failed[0];
    assert.equal(failed.machine, 'm2');
    assert.equal(failed.file, 'b.txt');
    assert.equal(failed.reason, 'FILE_MISSING');
  });
});

describe('F 红线：文件塞控制面 → 拒绝且审计', () => {
  it('DATA_PLANE_FORBIDDEN，sendFn 零调用，审计有记录', async () => {
    const bad = planInput();
    bad.steps[0].file = 'a.txt';
    const built = buildPlan(bad);
    assert.equal(built.code, 'DATA_PLANE_FORBIDDEN');
    let calls = 0;
    const direct = await dispatchPlan({ plan: { plan_sha256: 'x'.repeat(64), steps: [{ step_id: 's1', machine_id: 'm1', command_argv: ['x'], command_hash: 'y'.repeat(64), write_scope: [], depends_on: [] }] }, sendFn: async () => { calls += 1; return { ok: true }; }, dryRun: true });
    assert.equal(calls, 0);
    assert.equal(direct.ok, true);
  });
});

describe('G 断网：Relay 数据面不可用不影响直连收集', () => {
  it('relayDataPlaneDown=true 时 collect/merge 仍成功', async () => {
    const refs = [{ machine: 'm1', file: 'a.txt', path: 'a.txt', sha256: sha('a-v1') }];
    const relayDataPlaneDown = true;
    const collected = await collectArtifacts({
      refs, crypto: { createHash },
      fetchFn: async (_ref) => {
        if (relayDataPlaneDown) return 'a-v1'; // 直连不经过 relay
        throw new Error('relay down');
      },
    });
    assert.equal(collected.ok, true);
    const merged = mergeArtifacts({ artifacts: collected.artifacts });
    assert.equal(merged.ok, true);
  });
});
