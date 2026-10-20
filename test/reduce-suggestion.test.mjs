/**
 * The reduce suggestion: complete-or-not must be a value, the reducer must be the caller's decision, and nothing here dispatches.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REDUCE_NEXT_STEP, machineReported, reduceInputOf, suggestReduce } from '../src/util/reduce-suggestion.mjs';

const blobMachine = (machineId, index) => ({
  machine_id: machineId, index, outcome: 'ok', status: 'ok', blob_sha256: 'b'.repeat(64), output_mode: 'blob', stdout_bytes: 70_000, exit_code: 0,
});
const inlineMachine = (machineId, index, head = 'ok') => ({
  machine_id: machineId, index, outcome: 'ok', status: 'ok', stdout_head: head, stdout_bytes: 2, exit_code: 0,
});
const expiredMachine = (machineId, index) => ({ machine_id: machineId, index, outcome: 'expired', lease_state: 'expired' });

describe('machineReported / reduceInputOf', () => {
  it('tells a reported machine from an expired lease', () => {
    assert.equal(machineReported(blobMachine('m1', 0)), true);
    assert.equal(machineReported(inlineMachine('m2', 1)), true);
    assert.equal(machineReported(expiredMachine('m3', 2)), false, 'an expired lease produced nothing');
    assert.equal(machineReported(null), false);
  });

  it('reads the compact aggregate shape, blob first', () => {
    assert.deepEqual(reduceInputOf(blobMachine('m1', 0)), { machine_id: 'm1', index: 0, mode: 'blob', blob_sha256: 'b'.repeat(64) });
    assert.deepEqual(reduceInputOf(inlineMachine('m2', 2, 'hello')), { machine_id: 'm2', index: 2, mode: 'inline', stdout: 'hello' });
  });
});

describe('suggestReduce', () => {
  it('is ready only when every declared shard reported and a reducer was named', () => {
    const all = suggestReduce({ machines: [blobMachine('m1', 0), blobMachine('m2', 1)], reducerMachineId: 'm1', expectedIndexTotal: 2 });
    assert.equal(all.ready, true);
    assert.equal(all.plan.ok, true);
    assert.equal(all.next, REDUCE_NEXT_STEP);
    assert.deepEqual(all.candidates.map((candidate) => candidate.machine_id), ['m1', 'm2']);
  });

  it('refuses a partial fleet with the missing indexes', () => {
    const partial = suggestReduce({
      machines: [blobMachine('m1', 0), expiredMachine('m9', 1), blobMachine('m2', 2)],
      reducerMachineId: 'm1', expectedIndexTotal: 3,
    });
    assert.equal(partial.ready, false);
    assert.equal(partial.plan.code, 'MISSING_SHARD');
    assert.deepEqual(partial.missing, [1], 'the expired machine is not counted and its index is missing');
  });

  it('does not invent a reducer when the caller named none', () => {
    const unnamed = suggestReduce({ machines: [blobMachine('m1', 0)], expectedIndexTotal: 1 });
    assert.equal(unnamed.ready, false);
    assert.equal(unnamed.plan.code, 'REDUCER_MISSING');
    assert.equal(unnamed.next, REDUCE_NEXT_STEP, 'the tool still does not run it');
  });

  it('refuses a named reducer that never reported, instead of silently picking another', () => {
    const unreported = suggestReduce({ machines: [blobMachine('m1', 0)], reducerMachineId: 'm2', expectedIndexTotal: 1 });
    assert.equal(unreported.ready, false);
    assert.equal(unreported.plan.code, 'REDUCER_UNREPORTED');
    assert.deepEqual(unreported.plan.detail, { reducerMachineId: 'm2' });
  });

  it('accepts mixed inline and blob inputs', () => {
    const mixed = suggestReduce({
      machines: [blobMachine('m1', 0), inlineMachine('m2', 1)],
      reducerMachineId: 'm2', expectedIndexTotal: 2,
    });
    assert.equal(mixed.ready, true);
    assert.equal(mixed.plan.inputs[0].mode, 'blob');
    assert.equal(mixed.plan.inputs[1].mode, 'inline');
  });
});
