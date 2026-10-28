/** S3: GET /v1/tasks/{id} carries a read-only progress view with no command text. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createRelayServer } from '../src/relay/server.mjs';

const TOKEN = 'op-token-0123456789abcdef';
const open = [];
after(async () => { for (const server of open.splice(0)) { server.closeAllConnections?.(); await server.close(); } });

async function start(stateDir) {
  const relay = createRelayServer({ logger: null, operatorToken: TOKEN, stateDir });
  await relay.listen({ host: '127.0.0.1', port: 0 });
  open.push(relay);
  return relay;
}
const post = async (base, path, token, body) => {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json().catch(() => null) };
};

describe('task progress view', () => {
  it('reports machine state, command hash and length, never the command', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-progress-'));
    const relay = await start(stateDir);
    const paired = await post(relay.url, '/v1/pair', null, { pairing_code: relay.state.createPairingCode(), machine_id: 'm-1', machine_name: 'm1', platform: { os: 'linux', arch: 'x64' } });
    assert.equal(paired.status, 200, JSON.stringify(paired.json));
    const deviceToken = paired.json.device_token ?? paired.json.token;
    const created = await post(relay.url, '/v1/task', TOKEN, { mode: 'replicate', command_argv: ['node', '-v'], include_offline: true, plan_sha256: 'b'.repeat(64), step_id: 's1' });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const taskId = created.json.task_id;

    const response = await fetch(`${relay.url}/v1/tasks/${taskId}`, { headers: { authorization: `Bearer ${deviceToken}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    const progress = body.progress;
    assert.ok(progress, 'the progress block must exist');
    assert.equal(progress.task_id, taskId);
    assert.equal(progress.command_argv_len, 2);
    assert.equal(typeof progress.command_hash, 'string');
    assert.equal(progress.plan_sha256, 'b'.repeat(64));
    assert.equal(progress.step_id, 's1');
    assert.equal(progress.machines.length, 1);
    assert.equal(progress.machines[0].machine_id, 'm-1');
    assert.equal(progress.machines[0].phase, null, 'live-only fields are null without a heartbeat');
    assert.equal(progress.terminal, false);
    assert.equal(JSON.stringify(progress).includes('"command_argv":'), false);
    assert.equal(JSON.stringify(progress).includes('[' + '"node"'), false);

    relay.closeAllConnections?.();
    await relay.close();
    open.splice(open.indexOf(relay), 1);

    const revived = await start(stateDir);
    const again = await fetch(`${revived.url}/v1/tasks/${taskId}`, { headers: { authorization: `Bearer ${deviceToken}` } });
    assert.equal(again.status, 200);
    const afterBody = await again.json();
    assert.equal(afterBody.progress.command_hash, progress.command_hash);
    assert.equal(afterBody.progress.machines[0].phase, null);
  });
});
