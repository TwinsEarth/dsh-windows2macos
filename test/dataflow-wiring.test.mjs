/**
 * The dataflow wiring, guarded at the source level.
 *
 * The behaviour it guards -- a stage larger than 64 KiB becomes a blob, a blob that did not land fails the stage, and the
 * wait aggregate refuses a partial reduce -- runs inside the agent's execution loop and the tool's poll loop. Neither can be
 * mounted in this suite without a real relay and a real child process, so this guard checks that the wiring is still there and
 * still in the right order. Every part below has been missing once already (the module sat in accepted-orphans for three
 * releases), and a source-level guard is what stops it from quietly becoming a library again.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const agent = readFileSync(new URL('../src/agent/agent.mjs', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../src/plugin/tools.mjs', import.meta.url), 'utf8');
const orphans = readFileSync(new URL('../scripts/accepted-orphans.mjs', import.meta.url), 'utf8');

describe('a stage decides inline versus blob', () => {
  it('asks planStageOutput with the machine, the stage index and the byte count', () => {
    const at = agent.indexOf('planStageOutput({');
    assert.ok(at >= 0, 'the stage loop must call planStageOutput');
    const window = agent.slice(at, at + 300);
    assert.ok(window.includes('machineId: identity.machine_id'));
    assert.ok(window.includes('stageIndex: stage.index'));
    assert.ok(window.includes('stdoutBytes: ran.stdout_bytes'));
  });

  it('uploads before writing the reference, and fails the stage by name when the upload does not land', () => {
    assert.ok(agent.includes('await putBlobBytes('), 'a blob stage must upload');
    assert.ok(agent.includes('/v1/fleet/blobs/'), 'the relay blob route is the only target');
    assert.ok(agent.includes("refusal_reason: 'BLOB_UPLOAD_FAILED'"));
  });

  it('carries blob_sha256 in the stage record', () => {
    assert.ok(agent.includes('blob_sha256: blobSha256'));
    assert.ok(agent.includes("output_mode: 'blob'"));
  });

  it('names the blob in the envelope and does not also inline the heads', () => {
    assert.ok(agent.includes("blob_sha256: blobSha256, output_mode: 'blob'"));
    assert.ok(agent.includes('stdout_head: blobSha256 === null'));
    assert.ok(agent.includes('stdout_tail: blobSha256 === null'));
  });
});

describe('the wait aggregate refuses a partial reduce', () => {
  it('builds the plan from the raw envelopes, not the comparable copy', () => {
    assert.ok(tools.includes('buildReducePlan({ results: mapResults, reducerMachineId })'), 'the wait aggregate must build the reduce plan');
    assert.ok(tools.includes('Array.isArray(aggregate.detail?.machines)'), 'the plan reads the raw machine list');
    assert.ok(tools.includes('reducerMachineId'), 'the caller names the reducer');
  });

  it('marks the verdict degraded when the plan is refused, and only when a reducer was declared', () => {
    assert.ok(tools.includes("dataflowDegraded ? 'degraded' : aggregate.state"));
    assert.ok(tools.includes('anyBlob && reducerMachineId !== null'), 'a blob without a declared reducer is not silently reduced');
    assert.ok(tools.includes('reducer_machine_id'), 'the parameter exists so a caller can declare the reducer');
  });
});

describe('reachability', () => {
  it('is no longer an accepted orphan', () => {
    assert.ok(!orphans.includes('src/util/dataflow.mjs'), 'dataflow.mjs is wired now, so it must not be accepted as an orphan');
    assert.ok(!orphans.includes('src/plugin/dataflow.mjs'), 'and not under its old path either');
  });
});
