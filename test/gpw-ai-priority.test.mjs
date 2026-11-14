/**
 * GPW 优先级不变式（v3.2.7）：黑名单是红线硬规则，AI 分级只处理"本来就要等人"的调用——
 * AI 配置打开后，黑名单仍然立即拒绝、白名单仍然立即放行，两者都不会进入 pending 队列，
 * 也不会被倒计时/自动动作影响；只有既不在黑名单也不在白名单的调用才会被 AI 分级与倒计时接管。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { apply } from '../src/plugin/gpw.mjs';

const fixtures = [];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpw-ai-priority-'));
  fixtures.push(dir);
  return dir;
};
after(() => {
  for (const dir of fixtures) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked on Windows */ }
  }
});

let seq = 0;
function mount(options = {}) {
  const routes = new Map();
  const listeners = new Map();
  const ctx = {
    effect: () => {},
    logger: { info: () => {}, warn: () => {} },
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    inject: (_services, callback) => callback({ connection: { fetch: { register: (route) => routes.set(route.path, route) } } }),
    permissionPresets: { current: () => 'danger-full-access' },
    workingDirectory: null,
  };
  const config = {
    foldersFile: join(fixture(), 'gpw-folders.json'),
    foldersKey: 'test-key',
    gpwMode: 'advanced',
    // 离线端点：分类请求快速失败，测试不依赖外网
    gpwAi: { apiKey: 'sk-test-0123456789', baseUrl: 'http://127.0.0.1:9/v1', model: 'deepseek-flash' },
    gpwAiTimeouts: { yellow: 30, blue: 30, green: 30 },
    ...options,
  };
  apply(ctx, config);
  return { routes, listeners };
}
async function call(route, method = 'GET', body = undefined) {
  seq += 1;
  const request = new Request('http://local' + route.path + '?' + seq, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await route.fetch(request);
  return { status: response.status, body: await response.json() };
}
const execFor = (path) => ({ agent: { session: {} }, name: 'write', parameters: { path } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GPW hard rules keep priority over AI grading', () => {
  it('a blacklisted path is denied outright even with AI configured: it never becomes pending', async () => {
    const { routes, listeners } = mount({ blacklist: ['E:/secrets'] });
    const preExecute = listeners.get('tools/pre-execute');
    assert.ok(preExecute !== undefined);
    const outcome = await preExecute(execFor('E:/secrets/token.txt'), () => undefined);
    assert.equal(outcome.kind, 'deny');
    const state = await call(routes.get('/api/w2m/gpw/state'));
    assert.deepEqual(state.body.pending, []);
    assert.equal(state.body.ai.configured, true);
  });

  it('a whitelisted path is allowed outright: AI grading does not delay it either', async () => {
    const { routes, listeners } = mount({ whitelist: ['E:/project'] });
    const preExecute = listeners.get('tools/pre-execute');
    const outcome = await preExecute(execFor('E:/project/readme.md'), () => undefined);
    assert.equal(outcome.kind, 'allow');
    const state = await call(routes.get('/api/w2m/gpw/state'));
    assert.deepEqual(state.body.pending, []);
  });

  it('only the unlisted call is graded; a pending call and a blacklist denial run in parallel', async () => {
    const { routes, listeners } = mount({ blacklist: ['E:/secrets'], whitelist: ['E:/project'] });
    const preExecute = listeners.get('tools/pre-execute');
    const pendingPromise = preExecute(execFor('E:/misc/data.bin'), () => undefined);
    let pending = [];
    for (let attempt = 0; attempt < 40 && pending.length === 0; attempt += 1) {
      await sleep(10);
      pending = (await call(routes.get('/api/w2m/gpw/state'))).body.pending;
    }
    assert.equal(pending.length, 1);
    const entry = pending[0];
    assert.ok(['red', 'yellow', 'blue', 'green'].includes(entry.level));
    assert.ok(entry.deadline_at > 0 || entry.level === 'red');
    assert.ok(entry.countdown_ms > 0 || entry.level === 'red');

    // 并行的硬规则不受 pending/AI 影响
    const denied = await preExecute(execFor('E:/secrets/key.pem'), () => undefined);
    assert.equal(denied.kind, 'deny');
    const allowed = await preExecute(execFor('E:/project/a.txt'), () => undefined);
    assert.equal(allowed.kind, 'allow');

    const decided = await call(routes.get('/api/w2m/gpw/decide'), 'POST', { id: entry.id, decision: 'deny' });
    assert.equal(decided.status, 200);
    const outcome = await pendingPromise;
    assert.equal(outcome.kind, 'deny');
  });
});
