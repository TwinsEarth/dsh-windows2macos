/**
 * B3: cancelling fleet work is an operator act.
 *
 * The tool description always required the operator token, but the implementation read the device
 * token, so every cancel got 401 OPERATOR_REQUIRED from the relay. This pins the credential: no
 * device-token fallback, and the request that reaches the relay carries the operator token.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

process.env.W2M_OPERATOR_TOKEN_FILE = join(tmpdir(), 'w2m-cancel-auth-no-token-' + process.pid);

import * as plugin from '../src/plugin/tools.mjs';

const calls = [];
const previousFetch = globalThis.fetch;
after(() => { globalThis.fetch = previousFetch; });

function makeCtx() {
  const tools = new Map();
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return definition; } },
    logger: { warn: () => {}, info: () => {} },
    inject: (_names, callback) => callback(ctx),
  };
  return { ctx, tools };
}

async function register(config) {
  const { ctx, tools } = makeCtx();
  await plugin.apply(ctx, { p2pMode: 'relay', autoStartAgent: false, ...config });
  return tools;
}

function recordFetch(status, body) {
  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: String(init.method ?? 'GET').toUpperCase(), headers: init.headers ?? {}, body: init.body });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify(body ?? {}),
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body ?? {})).buffer,
    };
  };
}

describe('w2m_cancel credentials', () => {
  it('refuses without an operator token and never calls the relay', async () => {
    const tools = await register({ rabbitUrl: 'http://relay.test', stateDir: mkdtempSync(join(tmpdir(), 'w2m-cancel-')) });
    const cancel = tools.get('w2m_cancel');
    recordFetch(200, {});
    await assert.rejects(
      () => cancel.execute({ task_id: 'task-1' }),
      (error) => String(error?.code ?? '').includes('CONFIG') || /operator token/i.test(String(error?.message ?? '')),
    );
    assert.equal(calls.length, 0, 'a missing operator token must fail before any HTTP');
  });

  it('sends the operator token, not the device token', async () => {
    const tools = await register({ rabbitUrl: 'http://relay.test', operatorToken: 'op-token', token: 'device-token', stateDir: mkdtempSync(join(tmpdir(), 'w2m-cancel-')) });
    const cancel = tools.get('w2m_cancel');
    recordFetch(200, { task: { task_id: 'task-1', cancelled: true } });
    const result = await cancel.execute({ task_id: 'task-1', reason: 'drill' });
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.equal(calls[0].method, 'POST');
    assert.match(String(calls[0].url), /\/v1\/tasks\/task-1\/cancel$/);
    assert.equal(calls[0].headers.authorization, 'Bearer op-token');
    assert.equal(JSON.stringify(result).includes('device-token'), false);
  });
});
