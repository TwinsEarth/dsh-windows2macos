/**
 * 3.7.6 joint-dev defect regressions.
 *
 * Covers the five failures the 2026-11-26 three-machine run found, at the layer each belongs to:
 *   - F-1: a pre-send gate refusal (version gate in `enforce`) must not spend the approval;
 *   - F-3: a settled-but-failed prerequisite is not a success, and must not release dependents;
 *   - F-5: dry-run order is the dispatch order (Kahn), and a spent approval is not printable;
 *   - F-6: a missing `git` is `MERGE_GIT_UNAVAILABLE`, not `MERGE_BASE_MISMATCH`;
 *   - F-2's default state directory is covered by the CLI suite next to it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildPlan } from '../src/plugin/joint-dev/dispatch.mjs';
import { dispatchPlanToRelay, orderSteps } from '../src/plugin/joint-dev/relay-dispatch.mjs';
import { mergePatches } from '../src/plugin/joint-dev/merge-engine.mjs';
import { approvalWasConsumed, consumeApproval } from '../src/plugin/joint-dev/plan-store.mjs';
import { taskOutcomeOf } from '../src/relay/state/tasks.mjs';

const TOKEN = 'op-token-0123456789abcdef';
const APPROVAL = { approval_sha256: 'b'.repeat(64) };

function planFor(steps) {
  const built = buildPlan({ base_commit: 'a'.repeat(40), steps });
  assert.equal(built.ok, true, built.code);
  return built.plan;
}

function relayStub({ devices = [], taskCalls = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = String(init.method ?? 'GET').toUpperCase();
    calls.push({ method, path, headers: init.headers ?? {} });
    if (path === '/healthz') {
      return Response.json({ relay_version: 'test', protocol_version: 1, features: ['target-machines', 'result-projection'], operator_token_required: true, signing: { required: false } });
    }
    if (path === '/v1/devices') return Response.json({ protocol_version: 1, devices });
    if (path === '/v1/task' && method === 'POST') {
      taskCalls.push(JSON.parse(init.body ?? '{}'));
      const body = JSON.parse(init.body ?? '{}');
      return Response.json({ task_id: body.task_id, seq: 1, leases: [{ machine_id: body.executor_machine_id, state: 'queued' }] });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

describe('F-1: a pre-send refusal does not spend the approval', () => {
  it('version gate in enforce returns VERSION_SKEW without calling reserveApproval', async () => {
    const plan = planFor([{ step_id: 's1', machine_id: 'm-old', command_argv: ['node', '-v'] }]);
    const stub = relayStub({ devices: [{ machine_id: 'm-old', online: true, caps: { plugin_version: '3.5.0' } }] });
    let reserves = 0;
    const outcome = await dispatchPlanToRelay({
      rabbitUrl: 'http://relay.test', token: TOKEN, plan, approval: APPROVAL,
      deviceToken: 'device-token', expectedVersion: '3.7.6', versionGate: 'enforce',
      fetchImpl: stub.fetchImpl, reserveApproval: () => { reserves += 1; return { ok: true }; },
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'VERSION_SKEW');
    assert.equal(reserves, 0, 'a refusal before the first POST must leave the approval unspent');
    assert.equal(stub.calls.filter((call) => call.path === '/v1/task').length, 0);
  });

  it('an unwritable pre-send audit line does not spend the approval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-audit-bad-'));
    const auditFile = join(dir, 'audit.jsonl');
    writeFileSync(auditFile, '{"broken"\n', 'utf8');
    const plan = planFor([{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }]);
    const stub = relayStub({ devices: [{ machine_id: 'm-1', online: true, caps: { plugin_version: '3.7.6' } }] });
    let reserves = 0;
    const outcome = await dispatchPlanToRelay({
      rabbitUrl: 'http://relay.test', token: TOKEN, plan, approval: APPROVAL,
      deviceToken: 'device-token', expectedVersion: '3.7.6', versionGate: 'enforce',
      fetchImpl: stub.fetchImpl, auditFile,
      reserveApproval: () => { reserves += 1; return { ok: true }; },
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'AUDIT_UNAVAILABLE');
    assert.equal(reserves, 0, 'no approval may be spent before the audit line is durable');
    assert.equal(stub.calls.filter((call) => call.path === '/v1/task').length, 0);
  });

  it('reserves exactly once, after the gates and immediately before the first POST', async () => {
    const plan = planFor([{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }]);
    const taskCalls = [];
    const stub = relayStub({ devices: [{ machine_id: 'm-1', online: true, caps: { plugin_version: '3.7.6' } }], taskCalls });
    const order = [];
    const outcome = await dispatchPlanToRelay({
      rabbitUrl: 'http://relay.test', token: TOKEN, plan, approval: APPROVAL,
      deviceToken: 'device-token', expectedVersion: '3.7.6', versionGate: 'enforce',
      fetchImpl: async (url, init = {}) => {
        if (new URL(url).pathname === '/v1/task') order.push('post');
        return stub.fetchImpl(url, init);
      },
      reserveApproval: () => { order.push('reserve'); return { ok: true }; },
    });
    assert.equal(outcome.ok, true, outcome.code);
    assert.deepEqual(order, ['reserve', 'post']);
    assert.equal(taskCalls.length, 1);
  });

  it('reports a spent approval instead of sending anything', async () => {
    const plan = planFor([{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }]);
    const stub = relayStub({ devices: [{ machine_id: 'm-1', online: true, caps: { plugin_version: '3.7.6' } }] });
    const outcome = await dispatchPlanToRelay({
      rabbitUrl: 'http://relay.test', token: TOKEN, plan, approval: APPROVAL,
      deviceToken: 'device-token', expectedVersion: '3.7.6', versionGate: 'enforce',
      fetchImpl: stub.fetchImpl, reserveApproval: () => ({ ok: false, code: 'APPROVAL_ALREADY_USED' }),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'APPROVAL_ALREADY_USED');
    assert.equal(stub.calls.filter((call) => call.path === '/v1/task').length, 0);
  });
});

describe('F-5: dry-run sees the same graph and the same spent approval', () => {
  it('orders reversed declarations by dependency, not by declaration order', () => {
    const ordered = orderSteps([
      { step_id: 'b', machine_id: 'm2', command_argv: ['node', 'b'], depends_on: ['a'] },
      { step_id: 'a', machine_id: 'm1', command_argv: ['node', 'a'], depends_on: [] },
    ]);
    assert.equal(ordered.ok, true);
    assert.deepEqual(ordered.steps.map((step) => step.step_id), ['a', 'b']);
  });

  it('approvalWasConsumed is the read-only fact the CLI dry-run refuses on', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-joint-376-'));
    const approvalSha = 'c'.repeat(64);
    assert.equal(approvalWasConsumed({ stateDir, approvalSha }), false);
    const consumed = consumeApproval({ stateDir, planSha: 'd'.repeat(64), approvalSha });
    assert.equal(consumed.ok, true);
    assert.equal(approvalWasConsumed({ stateDir, approvalSha }), true);
  });
});

describe('F-3: settled is not success', () => {
    const task = {
      task_id: 't-1', executor_machine_id: 'm-1', cancelled: false,
      leases: new Map([['m-1', { machine_id: 'm-1', state: 'refused' }]]),
    };
    const state = { _taskSettled: () => true, results: new Map() };
  it('a refused lease is a failure even though no work can still arrive', () => {
    assert.equal(taskOutcomeOf(state, task), 'failed');
  });

  it('a done lease with a nonzero_exit envelope is a failure', () => {
    const done = { ...task, leases: new Map([['m-1', { machine_id: 'm-1', state: 'done' }]]) };
    const withResult = {
      ...state,
      results: new Map([['r1', { machine_id: 'm-1', received_at_ms: 1, envelope: { task_id: 't-1', status: 'nonzero_exit' } }]]),
    };
    assert.equal(taskOutcomeOf(withResult, done), 'failed');
    const okState = {
      ...state,
      results: new Map([['r1', { machine_id: 'm-1', received_at_ms: 1, envelope: { task_id: 't-1', status: 'ok' } }]]),
    };
    assert.equal(taskOutcomeOf(okState, done), 'ok');
  });

  it('an unfinished task is waiting, not failed', () => {
    assert.equal(taskOutcomeOf({ _taskSettled: () => false, results: new Map() }, { ...task, leases: new Map([['m-1', { machine_id: 'm-1', state: 'running' }]]) }), 'waiting');
  });
});

describe('F-6: missing git is named as missing git', () => {
  it('maps spawn ENOENT to MERGE_GIT_UNAVAILABLE', () => {
    const error = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    const outcome = mergePatches({
      repoDir: join(tmpdir(), 'w2m-no-git'), baseCommit: 'a'.repeat(40), patches: [{ patch: 'x' }],
      runGit: () => { throw error; },
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'MERGE_GIT_UNAVAILABLE');
  });

  it('keeps a real base mismatch as MERGE_BASE_MISMATCH', () => {
    const outcome = mergePatches({
      repoDir: join(tmpdir(), 'w2m-bad-base'), baseCommit: 'b'.repeat(40), patches: [{ patch: 'x' }],
      runGit: () => { throw new Error('fatal: Not a valid object name'); },
    });
    assert.equal(outcome.code, 'MERGE_BASE_MISMATCH');
  });
});
