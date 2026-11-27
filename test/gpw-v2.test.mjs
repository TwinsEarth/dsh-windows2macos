/**
 * GPW-V2: the five-level ladder and its mode gates.
 *
 * The product requirement is deliberately narrow: the original `dsh-gpw` stays untouched as the
 * fallback, and GPW-V2 is a separate subplugin that is disabled by default in the bundle patch. When
 * enabled it answers only in 完全权限 + GPW 小白模式:
 *
 *   green  G0   allow now
 *   blue   G1-1 wait 1 minute, then allow
 *   gray   G1-2 wait 10 minutes, then allow
 *   yellow G2   show a warning and wait for the operator; never auto-allow
 *   red    G3   deny outright
 *
 * Timers are shortened through config in these tests; the production defaults are asserted from the
 * pure module, not by making the suite sleep for ten minutes.
 */
import assert from 'assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { apply, applyV2 } from '../src/plugin/gpw.mjs';
import {
  classifyGpwV2Call,
  GPW_V2_DEFAULT_TIMING,
  GPW_V2_G_LEVELS,
  GPW_V2_LEVELS,
} from '../src/plugin/gpw-v2-risk.mjs';

const fixtures = [];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpw-v2-'));
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
  const services = options.services ?? new Map();
  const workspace = options.workspace ?? fixture();
  const preset = options.preset ?? 'danger-full-access';
  const cleanups = [];
  const ctx = {
    effect: (callback) => {
      const dispose = callback();
      if (typeof dispose === 'function') cleanups.push(dispose);
    },
    logger: { info: () => {}, warn: () => {} },
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    inject: (_services, callback) => callback({ connection: { fetch: { register: (route) => routes.set(route.path, route) } } }),
    permissionPresets: { current: () => preset },
    workingDirectory: { ensure: async () => workspace },
    get: (name) => services.get(name) ?? null,
    provide: (name, service) => { services.set(name, service); },
  };
  const config = {
    foldersFile: join(fixture(), 'gpw-folders.json'),
    foldersKey: 'test-key',
    ...options,
  };
  if (options.variant === 'gpw') apply(ctx, config);
  else applyV2(ctx, config);
  const dispose = () => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  };
  return { routes, listeners, workspace, services, dispose };
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
const execFor = (name, parameters) => ({ agent: { session: {} }, name, parameters });
const tick = (ms = 12) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('GPW-V2 risk ladder (pure)', () => {
  it('publishes the five rungs and the operator G labels', () => {
    assert.deepEqual([...GPW_V2_LEVELS], ['green', 'blue', 'gray', 'yellow', 'red']);
    assert.equal(GPW_V2_G_LEVELS.green, 'G0');
    assert.equal(GPW_V2_G_LEVELS.blue, 'G1-1');
    assert.equal(GPW_V2_G_LEVELS.gray, 'G1-2');
    assert.equal(GPW_V2_G_LEVELS.yellow, 'G2');
    assert.equal(GPW_V2_G_LEVELS.red, 'G3');
    assert.equal(GPW_V2_DEFAULT_TIMING.blueDelayMs, 60_000);
    assert.equal(GPW_V2_DEFAULT_TIMING.grayDelayMs, 600_000);
    assert.equal(GPW_V2_DEFAULT_TIMING.yellowTimeoutMs, 0);
  });

  it('classifies every rung deterministically', () => {
    const workspace = 'E:\\DB\\W2M';
    const inside = workspace + '\\src\\a.mjs';
    const outside = 'D:\\shared\\a.mjs';
    assert.equal(classifyGpwV2Call({ name: 'Read', paths: [inside], workspace }).level, 'green');
    assert.equal(classifyGpwV2Call({ name: 'copy', paths: [inside], workspace }).level, 'blue');
    assert.equal(classifyGpwV2Call({ name: 'create_agent', paths: [], workspace }).level, 'gray');
    assert.equal(classifyGpwV2Call({ name: 'unknown_tool', paths: [], workspace }).level, 'yellow');
    assert.equal(classifyGpwV2Call({ name: 'Write', paths: [outside], workspace }).level, 'yellow');
    assert.equal(classifyGpwV2Call({ name: 'Bash', arguments: { command: 'rm -rf /' }, paths: [], workspace }).level, 'red');
  });

  it('normalises an extended UNC prefix before containment checks', () => {
    const workspace = '\\\\srv\\share\\project';
    const inside = '\\\\?\\UNC\\srv\\share\\project\\a.mjs';
    assert.equal(classifyGpwV2Call({ name: 'Read', paths: [inside], workspace }).level, 'green');
    assert.equal(classifyGpwV2Call({ name: 'Write', paths: [inside], workspace }).level, 'green');
  });

  it('treats system and credential paths as G3', () => {
    assert.equal(classifyGpwV2Call({ name: 'Read', paths: ['C:\\Windows\\win.ini'] }).level, 'red');
    assert.equal(classifyGpwV2Call({ name: 'Read', paths: ['C:\\Users\\x\\.env'] }).level, 'red');
    assert.equal(classifyGpwV2Call({ name: 'Read', paths: ['C:\\Users\\x\\.ssh\\id_rsa'] }).level, 'red');
    assert.equal(classifyGpwV2Call({ name: 'Read', paths: ['C:\\Users\\x\\.aws\\credentials'] }).level, 'red');
    assert.equal(classifyGpwV2Call({ name: 'Read', paths: ['/var/lib/w2m/rabbit'] }).level, 'red');
    assert.equal(classifyGpwV2Call({ name: 'Read', paths: ['/var/log/auth.log'] }).level, 'red');
    assert.equal(classifyGpwV2Call({ name: 'Read', paths: ['/root/.ssh/id_ed25519'] }).level, 'red');
    assert.equal(classifyGpwV2Call({
      name: 'Bash',
      arguments: { command: 'Get-Content C:\\Windows\\win.ini' },
      workspace: 'E:\\DB\\W2M',
    }).level, 'red');
    assert.equal(classifyGpwV2Call({
      name: 'Bash',
      arguments: { command: 'Get-Content .env' },
      workspace: 'E:\\DB\\W2M',
    }).level, 'red');
  });

  it('normalises dot segments before deciding inside or outside the workspace', () => {
    const workspace = 'E:\\DB\\W2M';
    assert.equal(classifyGpwV2Call({
      name: 'Write',
      paths: ['E:\\DB\\W2M\\src\\..\\..\\outside\\x.txt'],
      workspace,
    }).level, 'yellow', 'a path that climbs out with .. must not be treated as workspace-internal');
    assert.equal(classifyGpwV2Call({
      name: 'Write',
      paths: ['E:\\DB\\W2M\\src\\nested\\..\\a.mjs'],
      workspace,
    }).level, 'green');
    assert.equal(classifyGpwV2Call({
      name: 'Write',
      paths: ['E:\\DB\\W2M\\..\\shared\\x.txt'],
      workspace,
      blacklist: ['E:\\DB\\shared'],
    }).level, 'red', 'a blacklisted folder reached through .. must still be red');
  });

  it('keeps global git configuration and folder authorization at G2', () => {
    assert.equal(classifyGpwV2Call({
      name: 'Bash',
      arguments: { command: 'git config --global user.name operator' },
      workspace: 'E:\\DB\\W2M',
    }).level, 'yellow');
    assert.equal(classifyGpwV2Call({
      name: 'interaction_authorize_folder',
      arguments: { path_list: ['E:\\DB\\shared'] },
      workspace: 'E:\\DB\\W2M',
    }).level, 'yellow');
  });

  it('does not mistake shell output, interpreter pipes or branch creation for read-only work', () => {
    const workspace = 'E:\\DB\\W2M';
    assert.equal(classifyGpwV2Call({
      name: 'Bash',
      arguments: { command: 'echo hi > out.txt' },
      workspace,
    }).level, 'yellow', 'redirection to a file is a write, not a read');
    assert.equal(classifyGpwV2Call({
      name: 'Bash',
      arguments: { command: 'cat script.mjs | bash' },
      workspace,
    }).level, 'red', 'piping text into an interpreter executes it');
    assert.equal(classifyGpwV2Call({
      name: 'Bash',
      arguments: { command: 'find . -exec sh -c "echo x" \\;' },
      workspace,
    }).level, 'yellow', 'find -exec is not a pure read');
    assert.equal(classifyGpwV2Call({
      name: 'Bash',
      arguments: { command: 'git branch feature-x' },
      workspace,
    }).level, 'yellow', 'creating a branch mutates the repository');
    assert.equal(classifyGpwV2Call({
      name: 'Bash',
      arguments: { command: 'rm -rf /*' },
      workspace,
    }).level, 'red', 'root wildcard deletion is still G3');
    assert.equal(classifyGpwV2Call({
      name: 'Bash',
      arguments: { command: 'format C:' },
      workspace,
    }).level, 'red', 'formatting a drive is a disk-level boundary');
    assert.equal(classifyGpwV2Call({
      name: 'Bash',
      arguments: { command: 'git diff --output=out.patch' },
      workspace,
    }).level, 'yellow', 'git --output writes a file');
  });

  it('fails closed when a compound command cannot be proven read-only segment by segment', () => {
    const workspace = 'E:\\DB\\W2M';
    for (const command of [
      'echo hi; New-GpwProbe',
      'echo hi\nNew-GpwProbe',
      'echo hi\r\nNew-GpwProbe',
      'echo hi & New-GpwProbe',
      'cat package.json | New-GpwProbe',
      'echo $(whoami)',
      'echo hi <(New-GpwProbe)',
      'echo hi >(New-GpwProbe)',
      'echo "a;b"',
    ]) {
      assert.equal(classifyGpwV2Call({
        name: 'Bash',
        arguments: { command },
        workspace,
      }).level, 'yellow', `an unrecognised compound/substitution command must not inherit the first segment's green verdict: ${command}`);
    }
    for (const command of ['git status && git log -1', 'cat package.json | grep name', 'echo hi\necho bye', 'echo hi & echo bye', 'echo hi 2>&1']) {
      assert.equal(classifyGpwV2Call({
        name: 'Bash',
        arguments: { command },
        workspace,
      }).level, 'green', `simple chains made only of read-only segments remain G0: ${command}`);
    }
  });

  it('resolves a relative blacklist entry against the workspace', () => {
    assert.equal(classifyGpwV2Call({
      name: 'Write',
      paths: ['E:\\DB\\W2M\\secrets\\x.txt'],
      workspace: 'E:\\DB\\W2M',
      blacklist: ['secrets'],
    }).level, 'red');
  });
});

describe('GPW-V2 mode gates', () => {
  it('only answers in the full-access preset', async () => {
    const { listeners } = mount({ preset: 'workspace-write' });
    let nextCalled = false;
    const outcome = await listeners.get('tools/pre-execute')(execFor('Read', { path: 'E:\\DB\\W2M\\a.txt' }), () => {
      nextCalled = true;
    });
    assert.equal(outcome, undefined);
    assert.equal(nextCalled, true);
  });

  it('keeps the original four-colour gate in GPW advanced mode', async () => {
    const { listeners, workspace } = mount({ gpwMode: 'advanced' });
    let nextCalled = false;
    const outcome = await listeners.get('tools/pre-execute')(execFor('Read', { path: join(workspace, 'a.txt') }), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false, 'V2 must not leave advanced mode ungated');
    assert.equal(outcome.kind, 'allow');
  });

  it('reports its own row on the shared health route', async () => {
    const { routes } = mount();
    const health = await call(routes.get('/api/w2m/gpw/health'));
    assert.equal(health.status, 200);
    assert.equal(health.body.row, 'dsh-gpw-v2');
    const state = await call(routes.get('/api/w2m/gpw/state'));
    assert.equal(state.body.engine, 'gpw-v2');
    assert.deepEqual(state.body.levels, [...GPW_V2_LEVELS]);
    assert.equal(state.body.mode, 'novice');
  });

  it('takes the gate from the original GPW when both rows are enabled, in patch order', () => {
    const services = new Map();
    const v2 = mount({ services });
    assert.equal(v2.services.has('dshGpwV2'), true);
    const gpw = mount({ services, variant: 'gpw' });
    assert.equal(gpw.listeners.has('tools/pre-execute'), false, 'the fallback row must stand down');
    assert.equal(gpw.routes.size, 0, 'the fallback row must not duplicate the panel routes');
  });
});

describe('GPW-V2 decisions', () => {
  it('allows green immediately', async () => {
    const { routes, listeners, workspace } = mount();
    const outcome = await listeners.get('tools/pre-execute')(execFor('Read', { path: join(workspace, 'a.txt') }), () => undefined);
    assert.equal(outcome.kind, 'allow');
    assert.match(String(outcome.reason), /G0/);
    assert.equal((await call(routes.get('/api/w2m/gpw/state'))).body.pending.length, 0);
  });

  it('holds blue, shows its countdown, then auto-allows', async () => {
    const { routes, listeners, workspace } = mount({ blueDelayMs: 5000 });
    const pending = listeners.get('tools/pre-execute')(execFor('copy', { path: join(workspace, 'b.txt') }), () => undefined);
    await tick(20);
    const state = await call(routes.get('/api/w2m/gpw/state'));
    assert.equal(state.body.pending.length, 1);
    assert.equal(state.body.pending[0].level, 'blue');
    assert.equal(state.body.pending[0].g_level, 'G1-1');
    assert.ok(state.body.pending[0].deadline_at > 0);
    assert.ok(state.body.pending[0].remaining_ms > 0);
    const outcome = await pending;
    assert.equal(outcome.kind, 'allow');
    assert.match(String(outcome.reason), /G1-1/);
  });

  it('holds gray for the longer delay, then auto-allows', async () => {
    const { routes, listeners } = mount({ grayDelayMs: 5000 });
    const pending = listeners.get('tools/pre-execute')(execFor('Bash', { command: 'npm install' }), () => undefined);
    await tick(20);
    const state = await call(routes.get('/api/w2m/gpw/state'));
    assert.equal(state.body.pending[0].level, 'gray');
    assert.equal(state.body.pending[0].g_level, 'G1-2');
    assert.equal(state.body.pending[0].deadline_at > 0, true);
    assert.equal(state.body.pending[0].remaining_ms > 0, true);
    const outcome = await pending;
    assert.equal(outcome.kind, 'allow');
    assert.match(String(outcome.reason), /G1-2/);
  });

  it('holds yellow for an explicit second confirmation and never auto-allows', async () => {
    const { routes, listeners } = mount({ blueDelayMs: 5, grayDelayMs: 5 });
    const outside = join(fixture(), 'outside.txt');
    const pending = listeners.get('tools/pre-execute')(execFor('Write', { file_path: outside }), () => undefined);
    await tick(8);
    const state = await call(routes.get('/api/w2m/gpw/state'));
    assert.equal(state.body.pending.length, 1);
    assert.equal(state.body.pending[0].level, 'yellow');
    assert.equal(state.body.pending[0].g_level, 'G2');
    assert.equal(state.body.pending[0].deadline_at, 0);
    await tick(20);
    const still = await call(routes.get('/api/w2m/gpw/state'));
    assert.equal(still.body.pending.length, 1, 'yellow has no auto-approval timer');
    const decided = await call(routes.get('/api/w2m/gpw/decide'), 'POST', { id: state.body.pending[0].id, decision: 'allow' });
    assert.equal(decided.status, 200);
    const outcome = await pending;
    assert.equal(outcome.kind, 'allow');
    assert.equal((await call(routes.get('/api/w2m/gpw/state'))).body.pending.length, 0);
  });

  it('denies a held call when the gate is unmounted instead of leaving it hanging', async () => {
    const { listeners, dispose } = mount();
    const outside = join(fixture(), 'outside.txt');
    const pending = listeners.get('tools/pre-execute')(execFor('Write', { file_path: outside }), () => undefined);
    await tick(8);
    dispose();
    const outcome = await pending;
    assert.equal(outcome.kind, 'deny');
    assert.match(String(outcome.reason), /unmounted/);
  });

  it('denies red outright', async () => {
    const { routes, listeners } = mount();
    const outcome = await listeners.get('tools/pre-execute')(execFor('Write', { file_path: 'C:\\Windows\\x.txt' }), () => undefined);
    assert.equal(outcome.kind, 'deny');
    assert.match(String(outcome.reason), /G3/);
    assert.equal((await call(routes.get('/api/w2m/gpw/state'))).body.pending.length, 0);
  });

  it('denies a blacklisted folder outright', async () => {
    const { routes, listeners } = mount();
    const blocked = fixture();
    const added = await call(routes.get('/api/w2m/gpw/folders'), 'POST', { action: 'add', list: 'blacklist', path: blocked });
    assert.equal(added.status, 200);
    const outcome = await listeners.get('tools/pre-execute')(execFor('Write', { file_path: join(blocked, 'x.txt') }), () => undefined);
    assert.equal(outcome.kind, 'deny');
  });
});

describe('GPW-V2 packaging', () => {
  it('exports its own name while reusing the gate implementation', async () => {
    const entry = await import('../lib/gpw-v2.js');
    assert.equal(entry.name, 'dsh-gpw-v2');
    assert.equal(typeof entry.apply, 'function');
    assert.deepEqual(entry.inject, ['permissionPresets']);
  });

  it('ships the subplugin row disabled by default', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
    const row = patch.match(/- id: dsh-gpw-v2[\s\S]*?config:/);
    assert.ok(row, 'the dsh-gpw-v2 row must exist');
    assert.match(row[0], /disabled: true/);
  });
});
