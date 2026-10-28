/**
 * B2: a joint plan's command_hash must be the relay's own definition.
 *
 * The relay rejects a task when `command_hash !== sha256(jcs(argv)|shell|cwd)`, so a plan that
 * computes the hash another way can never be dispatched. This suite pins both halves together:
 * the util equality and a real in-process relay accepting the built body.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { buildPlan } from '../src/plugin/joint-dev/dispatch.mjs';
import { computeCommandHash, normalizeCwdRel, SHELL_ID_DIRECT } from '../src/relay/state.mjs';
import { commandHash as agentCommandHash } from '../src/agent/git.mjs';
import { createRelayServer } from '../src/relay/server.mjs';

const open = [];
after(async () => {
  for (const server of open.splice(0)) {
    server.closeAllConnections?.();
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});

describe('joint command hash matches the relay definition', () => {
  it('buildPlan uses computeCommandHash(argv, direct-exec, .)', () => {
    const built = buildPlan({ base_commit: 'a'.repeat(40), steps: [{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }] });
    assert.equal(built.ok, true, built.code);
    assert.equal(built.plan.steps[0].command_hash, computeCommandHash(['node', '-v'], SHELL_ID_DIRECT, '.'));
  });

  it('a real relay accepts a built plan body (no 400 command_hash mismatch)', async () => {
    const relay = createRelayServer({ logger: null, operatorToken: 'op-token-0123456789abcdef', stateDir: null });
    await relay.listen({ host: '127.0.0.1', port: 0 });
    open.push(relay);
    const pair = await fetch(`${relay.url}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: relay.state.createPairingCode(), machine_id: 'm-1', machine_name: 'm-1', platform: { os: 'linux', arch: 'x64' } }),
    });
    assert.equal(pair.status, 200);
    const built = buildPlan({ base_commit: 'a'.repeat(40), steps: [{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }] });
    const step = built.plan.steps[0];
    const response = await fetch(`${relay.url}/v1/task`, {
      method: 'POST',
      headers: { authorization: 'Bearer op-token-0123456789abcdef', 'content-type': 'application/json' },
      body: JSON.stringify({
        task_id: 'jd-test-' + Date.now().toString(36) + Math.random().toString(16).slice(2, 10),
        mode: 'broadcast',
        target_machines: ['m-1'],
        executor_machine_id: 'm-1',
        command_argv: step.command_argv,
        command_hash: step.command_hash,
        plan_sha256: built.plan.plan_sha256,
        approval_sha256: 'c'.repeat(64),
        include_offline: true,
        step_id: 's1',
      }),
    });
    const doc = await response.json();
    assert.equal(response.status, 200, JSON.stringify(doc));
    assert.equal(typeof doc.task_id, 'string');
  });

  it('rejects a body whose hash does not match (negative control)', async () => {
    const relay = createRelayServer({ logger: null, operatorToken: 'op-token-0123456789abcdef', stateDir: null });
    await relay.listen({ host: '127.0.0.1', port: 0 });
    open.push(relay);
    const response = await fetch(`${relay.url}/v1/task`, {
      method: 'POST',
      headers: { authorization: 'Bearer op-token-0123456789abcdef', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'replicate', command_argv: ['node', '-v'], command_hash: 'd'.repeat(64) }),
    });
    assert.equal(response.status, 400);
  });
});

describe('cwd_rel normalization', () => {
  it('normalizes ./ pkg/ and backslashes identically to the agent implementation', () => {
    for (const cwd of ['.', 'pkg', './pkg', 'pkg/', 'pkg\\sub', './pkg/sub/']) {
      assert.equal(computeCommandHash(['node', '-v'], SHELL_ID_DIRECT, cwd), agentCommandHash(['node', '-v'], SHELL_ID_DIRECT, cwd), cwd);
    }
    assert.equal(normalizeCwdRel('./pkg'), 'pkg');
    assert.equal(normalizeCwdRel('pkg/'), 'pkg');
    assert.equal(normalizeCwdRel('pkg\\sub'), 'pkg/sub');
    assert.equal(normalizeCwdRel(''), '.');
  });

  it('accepts a plan step with a non-default cwd_rel over a real relay', async () => {
    const relay = createRelayServer({ logger: null, operatorToken: 'op-token-0123456789abcdef', stateDir: null });
    await relay.listen({ host: '127.0.0.1', port: 0 });
    open.push(relay);
    const pair = await fetch(`${relay.url}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: relay.state.createPairingCode(), machine_id: 'm-cwd', machine_name: 'm-cwd', platform: { os: 'linux', arch: 'x64' } }),
    });
    assert.equal(pair.status, 200);
    const built = buildPlan({ base_commit: 'a'.repeat(40), steps: [{ step_id: 's1', machine_id: 'm-cwd', command_argv: ['node', '-v'], cwd_rel: './pkg' }] });
    assert.equal(built.ok, true, built.code);
    const step = built.plan.steps[0];
    assert.equal(step.cwd_rel, 'pkg');
    const response = await fetch(`${relay.url}/v1/task`, {
      method: 'POST',
      headers: { authorization: 'Bearer op-token-0123456789abcdef', 'content-type': 'application/json' },
      body: JSON.stringify({
        task_id: 'jd-cwd-' + Date.now().toString(36),
        mode: 'broadcast',
        target_machines: ['m-cwd'],
        executor_machine_id: 'm-cwd',
        command_argv: step.command_argv,
        command_hash: step.command_hash,
        cwd_rel: step.cwd_rel,
        plan_sha256: built.plan.plan_sha256,
        approval_sha256: 'c'.repeat(64),
        include_offline: true,
        step_id: 's1',
      }),
    });
    const doc = await response.json();
    assert.equal(response.status, 200, JSON.stringify(doc));
  });
});
