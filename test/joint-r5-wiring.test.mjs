/** R5 wiring: deterministic ids, idempotent retries, dependency order, audit and the control guard. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildPlan } from '../src/plugin/joint-dev/dispatch.mjs';
import { dispatchPlanToRelay } from '../src/plugin/joint-dev/relay-dispatch.mjs';

const HEALTH = { relay_version: 'test', features: ['target-machines', 'result-projection'], operator_token_required: true, signing: { required: false } };
const APPROVAL = { approval_sha256: 'c'.repeat(64) };
const planOf = (steps) => buildPlan({ base_commit: 'a'.repeat(40), steps }).plan;
const jsonResponse = (status, doc) => ({ ok: status >= 200 && status < 300, status, json: async () => doc });

describe('R5 dispatch wiring', () => {
  it('uses a deterministic task id and reports TASK_EXISTS as already dispatched', async () => {
    const plan = planOf([{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }]);
    const seen = [];
    const existsRelay = async (url, init) => {
      if (String(url).endsWith('/healthz')) return jsonResponse(200, HEALTH);
      if (String(url).includes('/v1/tasks/')) return jsonResponse(200, { task: { task_id: 'jd-task' }, leases: [{ machine_id: 'm-1', state: 'offered' }] });
      seen.push(JSON.parse(init.body));
      return jsonResponse(409, { error: { code: 'TASK_EXISTS' } });
    };
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 't', plan, approval: APPROVAL, fetchImpl: existsRelay });
    assert.equal(result.ok, true);
    assert.equal(result.tasks[0].already, true);
    assert.match(seen[0].task_id, /^jd-[0-9a-f]{26}$/);
  });

  it('sends the same task id when the same plan is dispatched again', async () => {
    const plan = planOf([{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }]);
    const ids = [];
    const relay = async (url, init) => {
      if (String(url).endsWith('/healthz')) return jsonResponse(200, HEALTH);
      const body = JSON.parse(init.body);
      ids.push(body.task_id);
      return jsonResponse(200, { task_id: body.task_id, leases: [{ machine_id: 'm-1', state: 'queued' }] });
    };
    await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 't', plan, approval: APPROVAL, fetchImpl: relay });
    await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 't', plan, approval: APPROVAL, fetchImpl: relay });
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
  });

  it('dispatches dependencies first and maps depends_on to the earlier task ids', async () => {
    const plan = planOf([
      { step_id: 's2', machine_id: 'm-2', command_argv: ['node', '-e', 'two'], depends_on: ['s1'], write_scope: ['src/'] },
      { step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-e', 'one'] },
    ]);
    const bodies = [];
    const relay = async (url, init) => {
      if (String(url).endsWith('/healthz')) return jsonResponse(200, HEALTH);
      const body = JSON.parse(init.body);
      bodies.push(body);
      return jsonResponse(200, { task_id: body.task_id, leases: [{ machine_id: body.executor_machine_id, state: 'queued' }] });
    };
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 't', plan, approval: APPROVAL, fetchImpl: relay });
    assert.equal(result.ok, true);
    assert.equal(bodies[0].step_id, 's1', 'dependency order, not the array order');
    assert.equal(bodies[1].step_id, 's2');
    assert.deepEqual(bodies[1].depends_on, [bodies[0].task_id]);
    assert.equal(bodies[1].write, true);
    assert.deepEqual(bodies[1].write_scope, ['src/']);
  });

  it('writes sending/sent audit records when an audit file is given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-audit-'));
    const auditFile = join(dir, 'audit.jsonl');
    const plan = planOf([{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }]);
    const relay = async (url, init) => {
      if (String(url).endsWith('/healthz')) return jsonResponse(200, HEALTH);
      const body = JSON.parse(init.body);
      return jsonResponse(200, { task_id: body.task_id, leases: [{ machine_id: 'm-1', state: 'queued' }] });
    };
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 't', plan, approval: APPROVAL, fetchImpl: relay, auditFile });
    assert.equal(result.ok, true);
    const text = readFileSync(auditFile, 'utf8');
    assert.match(text, /joint\.dispatch\.sent/);
    assert.equal(text.includes('node'), false, 'the audit carries metadata, not the command');
  });

  it('refuses an oversized control body before any task is sent', async () => {
    let taskCalls = 0;
    const plan = planOf([{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-e', 'x'.repeat(20 * 1024)] }]);
    const relay = async (url) => {
      if (String(url).endsWith('/healthz')) return jsonResponse(200, HEALTH);
      taskCalls += 1;
      return jsonResponse(200, {});
    };
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: 't', plan, approval: APPROVAL, fetchImpl: relay });
    assert.equal(result.ok, false);
    assert.equal(typeof result.code, 'string');
    assert.equal(taskCalls, 0);
  });
});
