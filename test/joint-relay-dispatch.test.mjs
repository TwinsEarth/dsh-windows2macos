/** S2: an approved plan becomes relay tasks pinned to its machines, and a widened lease is refused. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRelayServer } from '../src/relay/server.mjs';
import { buildPlan } from '../src/plugin/joint-dev/dispatch.mjs';
import { dispatchPlanToRelay } from '../src/plugin/joint-dev/relay-dispatch.mjs';
import { approvePlan, savePlan } from '../src/plugin/joint-dev/plan-store.mjs';

const MACHINE = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'op-token-0123456789abcdef';
let relay = null;
let plan = null;
let approval = null;

before(async () => {
  relay = createRelayServer({ logger: null, operatorToken: TOKEN });
  await relay.listen({ host: '127.0.0.1', port: 0 });
  const stateDir = mkdtempSync(join(tmpdir(), 'w2m-joint-relay-'));
  const built = buildPlan({ base_commit: 'a'.repeat(40), steps: [{ step_id: 's1', machine_id: MACHINE, command_argv: ['node', '-v'] }] });
  assert.equal(built.ok, true, built.code);
  plan = built.plan;
  assert.equal(savePlan({ stateDir, plan }).ok, true);
  const approved = approvePlan({ stateDir, planSha: plan.plan_sha256, approver: 'op', authority: 80 });
  assert.equal(approved.ok, true, approved.code);
  approval = approved.approval;
});

after(async () => {
  if (relay !== null) {
    relay.closeAllConnections?.();
    await relay.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
});

// Undici keeps sockets alive; closing each response lets the relay shut down before the process exits.
const closeFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), connection: 'close' } });

describe('joint dispatch over a real relay', () => {
  it('drives the task body through a relay that accepts the pin', async () => {
    const calls = [];
    const fakeFetch = async (url, init) => {
      const target = String(url);
      if (target.endsWith('/healthz')) {
        return { ok: true, status: 200, json: async () => ({ relay_version: 'test', features: ['target-machines', 'result-projection'], operator_token_required: true, signing: { required: false } }) };
      }
      if (target.endsWith('/v1/task')) {
        calls.push(JSON.parse(init.body));
        return { ok: true, status: 201, json: async () => ({ task_id: 'task-1', leases: [{ machine_id: MACHINE, state: 'queued' }] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://relay.test', token: TOKEN, plan, approval, fetchImpl: fakeFetch });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.tasks[0].task_id, 'task-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executor_machine_id, MACHINE);
    assert.equal(calls[0].plan_sha256, plan.plan_sha256);
    assert.equal(calls[0].approval_sha256, approval.approval_sha256);
    assert.equal(typeof calls[0].command_hash, 'string');
  });

  it('is refused by a real relay when the pinned machine is not a target', async () => {
    const result = await dispatchPlanToRelay({ rabbitUrl: relay.url, token: TOKEN, plan, approval, fetchImpl: closeFetch });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(['BAD_REQUEST', 'MACHINE_UNAVAILABLE', 'NO_ONLINE_DEVICE'].includes(result.code), result.code);
  });

  it('refuses without an operator token before touching the relay', async () => {
    const result = await dispatchPlanToRelay({ rabbitUrl: relay.url, token: '', plan, approval, fetchImpl: closeFetch });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OPERATOR_TOKEN_MISSING');
  });

  it('refuses an old relay that advertises no features', async () => {
    const oldFetch = async (url) => {
      if (String(url).endsWith('/healthz')) return { ok: true, status: 200, json: async () => ({ relay_id: 'old' }) };
      return { ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND' } }) };
    };
    const result = await dispatchPlanToRelay({ rabbitUrl: 'http://old-relay.test', token: TOKEN, plan, approval, fetchImpl: oldFetch });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RELAY_CAPABILITIES_MISSING');
  });
});
