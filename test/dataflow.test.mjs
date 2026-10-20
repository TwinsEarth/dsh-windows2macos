/**
 * The two decisions in a map->blob->reduce pipeline: how a stage output travels, and whether every shard a reduce depends
 * on is actually there. Both are tested because both fail silently when they are wrong.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HARD_CAP_BYTES, MAX_INLINE_BYTES, buildReducePlan, planStageOutput } from '../src/util/dataflow.mjs';

describe('how one stage output travels', () => {
  it('keeps a small output inline and sends a large one as a blob', () => {
    assert.equal(planStageOutput({ machineId: 'm-1', stdoutBytes: 100 }).mode, 'inline');
    assert.equal(planStageOutput({ machineId: 'm-1', stdoutBytes: MAX_INLINE_BYTES }).mode, 'inline');
    assert.equal(planStageOutput({ machineId: 'm-1', stdoutBytes: MAX_INLINE_BYTES + 1 }).mode, 'blob');
  });

  it('refuses an output past the hard cap instead of trying to move it', () => {
    const refused = planStageOutput({ machineId: 'm-1', stdoutBytes: HARD_CAP_BYTES + 1 });
    assert.equal(refused.code, 'STAGE_OUTPUT_TOO_LARGE');
  });

  it('refuses to plan without a machine', () => {
    assert.equal(planStageOutput({ stdoutBytes: 1 }).code, 'STAGE_MACHINE_MISSING');
  });
});

describe('the reduce plan', () => {
  it('carries inline text and blob hashes to the reducer', () => {
    const plan = buildReducePlan({
      reducerMachineId: 'm-1',
      results: [
        { machine_id: 'm-1', mode: 'inline', stdout: 'ok' },
        { machine_id: 'm-2', mode: 'blob', blob_sha256: 'a'.repeat(64) },
      ],
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.inputs.length, 2);
    assert.equal(plan.inputs[1].sha256, 'a'.repeat(64));
  });

  it('refuses a blob result with no hash, because a missing shard must not look like a complete answer', () => {
    const refused = buildReducePlan({ reducerMachineId: 'm-1', results: [{ machine_id: 'm-2', mode: 'blob' }] });
    assert.equal(refused.code, 'BLOB_MISSING');
  });

  it('refuses a duplicate machine and an empty map', () => {
    assert.equal(buildReducePlan({ reducerMachineId: 'm-1', results: [{ machine_id: 'm-2' }, { machine_id: 'm-2' }] }).code, 'MAP_MACHINE_DUPLICATE');
    assert.equal(buildReducePlan({ reducerMachineId: 'm-1', results: [] }).code, 'NO_MAP_RESULTS');
  });

  it('refuses without a reducer', () => {
    assert.equal(buildReducePlan({ results: [{ machine_id: 'm-2' }] }).code, 'REDUCER_MISSING');
  });
});
