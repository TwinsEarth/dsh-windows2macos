/**
 * Unit tests for the W2M DSH plugin (`src/plugin/tools.mjs`).
 *
 * # What these tests do and do not cover
 *
 * They drive `apply()` against a fake `ctx.tools` registry, so they cover **registration shape**,
 * **argument handling**, **the HTTP calls the plugin makes**, and the **fail-closed paths** —
 * missing configuration, missing capability, a Rabbit refusal, a cancel, an oversized answer.
 *
 * They do **not** cover what DSH's own `dsh-tools` does with these definitions: argument coercion,
 * `required` enforcement, timeouts, cancellation, permissions, or rendering. In this repository
 * `@deepseek-ai/dsh-tools` does not resolve, so `apply()` uses the plugin's offline shim; that is
 * exactly what the "registration shape" group is exercising. See the header of `tools.mjs`.
 *
 * `fetch` is replaced per test, and any call to an endpoint a test did not declare fails loudly
 * rather than being quietly swallowed — a wrong endpoint must not look like a pass.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import * as plugin from '../src/plugin/tools.mjs';

const RABBIT = 'http://127.0.0.1:8787';

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

const cleanup = [];
after(async () => {
  for (const entry of cleanup) await fs.rm(entry, { recursive: true, force: true }).catch(() => {});
});

/**
 * Create a throwaway state directory.
 *
 * @param {object|null} [device] Contents to write as `device.json`; `null` writes nothing.
 * @returns {Promise<string>}
 */
async function makeStateDir(device) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'w2m-plugin-test-'));
  cleanup.push(dir);
  if (device) await fs.writeFile(path.join(dir, 'device.json'), JSON.stringify(device, null, 2), 'utf8');
  return dir;
}

/**
 * Create a throwaway directory that is **not** a git work tree, for the anchor-degradation paths.
 *
 * @returns {Promise<string>}
 */
async function makeNonRepoDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'w2m-nonrepo-'));
  cleanup.push(dir);
  return dir;
}

/**
 * A fake `ctx` carrying the `tools` service this plugin injects.
 *
 * @returns {{ctx: object, tools: Map<string, object>, warnings: string[]}}
 */
function makeCtx() {
  const tools = new Map();
  const warnings = [];
  const ctx = {
    tools: {
      register(definition) {
        assert.ok(definition && typeof definition.name === 'string', 'register() needs a named definition');
        assert.ok(!tools.has(definition.name), `tool \`${definition.name}\` registered twice`);
        tools.set(definition.name, definition);
        return definition;
      },
    },
    logger: { warn: (message) => warnings.push(String(message)), info: () => {} },
  };
  return { ctx, tools, warnings };
}

/**
 * Register the plugin and hand back its tools.
 *
 * @param {object} [config]
 * @returns {Promise<{tools: Map<string, object>, warnings: string[]}>}
 */
async function register(config = {}) {
  const { ctx, tools, warnings } = makeCtx();
  await plugin.apply(ctx, config);
  return { tools, warnings };
}

/**
 * Install a routing `fetch` for one test, and a stub `Response` when the runtime under test has
 * none (the plugin's fallback path reads `response.body` through `arrayBuffer()` in that case).
 *
 * @param {Array<{method?: string, path: string, status?: number, body?: unknown, text?: string,
 *                contentType?: string, headers?: object}>} routes
 * @returns {{calls: Array<{method: string, url: string, headers: object, body: unknown}>, restore: () => void}}
 */
function installFetch(routes) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  const previousResponse = globalThis.Response;
  const hasResponse = typeof previousResponse === 'function';

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const method = String(init.method ?? 'GET').toUpperCase();
    const parsed = new URL(url);
    const headers = init.headers ?? {};
    const rawBody = init.body === undefined || init.body === null ? null : JSON.parse(String(init.body));
    calls.push({ method, url, path: parsed.pathname, search: parsed.search, headers, body: rawBody });

    const route = routes.find(
      (candidate) => candidate.path === parsed.pathname && String(candidate.method ?? 'GET').toUpperCase() === method,
    );
    if (!route) {
      throw new Error(`test route missing: ${method} ${parsed.pathname}`);
    }

    const status = route.status ?? 200;
    const text = route.text ?? JSON.stringify(route.body ?? {});
    const contentType = route.contentType ?? 'application/json';
    const responseHeaders = { 'content-type': contentType, ...(route.headers ?? {}) };

    if (hasResponse) {
      return new previousResponse(text, { status, headers: responseHeaders });
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) => {
          const found = Object.keys(responseHeaders).find((key) => key.toLowerCase() === String(name).toLowerCase());
          return found ? responseHeaders[found] : null;
        },
      },
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      text: async () => text,
    };
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = previousFetch;
      if (hasResponse) globalThis.Response = previousResponse;
      else delete globalThis.Response;
    },
  };
}

/** A device.json that satisfies the paired-device path. */
const PAIRED_DEVICE = {
  machine_id: '3f2a9c14-6d1e-4a77-9f10-2c8b1d5e7a30',
  machine_name: 'win-desktop',
  device_token: 'tok-test-abc',
  rabbit_url: RABBIT,
};

/** Valid `w2m_run` arguments, minus the fields a test wants to vary. */
function runArgs(overrides = {}) {
  return { command_argv: ['node', '--test'], ...overrides };
}

/** Read the parameter map out of a registered definition. */
function paramsOf(tool) {
  return tool.parameters ?? {};
}

/**
 * A `GET /v1/tasks/{id}` response in the shape the Rabbit actually sends.
 *
 * The wrap matters: the verdict lives at `aggregate.status`, not at the top level, and the
 * per-machine view is `aggregate.machines` with an `outcome` field. A fixture that put `status` at
 * the top level would let a reader that looks in the wrong place pass.
 */
function taskResponse(aggregate) {
  return {
    protocol_version: 1,
    rabbit_time: '2026-10-07T12:00:00Z',
    task: { task_id: aggregate.task_id ?? '01JABCDEF', mode: 'replicate', index_total: 1 },
    leases: [],
    aggregate,
  };
}

/** One machine entry as `aggregate()` emits it. */
function machine(machineId, machineName, status, envelope, overrides = {}) {
  return {
    machine_id: machineId,
    machine_name: machineName,
    index: 0,
    attempt: 1,
    lease_state: status === 'refused' ? 'refused' : 'reported',
    outcome: status,
    status: envelope?.status ?? null,
    refusal_reason: envelope?.refusal_reason ?? null,
    exit_code: envelope?.exit_code ?? null,
    reasons: [],
    envelope,
    ...overrides,
  };
}

/** A consistent two-machine aggregate: every comparable field agrees. */
function finalTask(overrides = {}) {
  const envelope = () => ({
    status: 'ok',
    exit_code: 0,
    stdout_sha256: 'a'.repeat(64),
    stdout_bytes: 12,
    base_commit: 'c'.repeat(40),
    base_tree: 'd'.repeat(40),
    pre_tree_fingerprint: 'd'.repeat(40),
    command_hash: 'e'.repeat(64),
  });
  return {
    task_id: '01JABCDEF',
    status: 'consistent',
    counts: { refused: 0, unverifiable: 0, ok: 2, failed: 0, expired: 0, pending: 0 },
    differences: [],
    notes: [],
    machines: [
      machine('aaa', 'win-desktop', 'ok', envelope()),
      machine('bbb', 'mac-studio', 'ok', envelope()),
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. Registration shape
// ---------------------------------------------------------------------------------------------

describe('registration shape', () => {
  it('declares the tools service and registers exactly five tools', async () => {
    assert.deepEqual(plugin.inject, ['tools']);
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
    assert.equal(tools.size, 5);
    assert.deepEqual(
      [...tools.keys()].sort(),
      ['w2m_devices', 'w2m_report', 'w2m_run', 'w2m_status', 'w2m_wait'],
    );
  });

  it('gives every tool a non-empty description and a callable execute', async () => {
    const { tools } = await register({ rabbitUrl: RABBIT });
    for (const [name, tool] of tools) {
      assert.equal(typeof tool.description, 'string', `${name} description`);
      assert.ok(tool.description.length > 40, `${name} description should say what it does`);
      assert.equal(typeof tool.execute, 'function', `${name} execute`);
      assert.equal(typeof tool.presentCall, 'function', `${name} presentCall`);
      assert.equal(typeof tool.parameters, 'object', `${name} parameters`);
    }
  });

  it('declares only types, required flags, and defaults the shim can check', async () => {
    const { tools } = await register({ rabbitUrl: RABBIT });
    for (const [name, tool] of tools) {
      for (const [key, decl] of Object.entries(paramsOf(tool))) {
        assert.ok(
          ['string', 'number', 'boolean', 'array', 'object'].includes(decl.type),
          `${name}.${key} has an undeclared type`,
        );
        if (decl.type === 'array') {
          assert.equal(decl.items?.type, 'string', `${name}.${key} should declare string items`);
        }
        assert.ok(typeof decl.description === 'string' && decl.description.length > 0, `${name}.${key} needs a description`);
        if (decl.default !== undefined) {
          assert.notEqual(decl.required, true, `${name}.${key} cannot be both defaulted and required`);
        }
      }
    }
  });

  it('marks the write-capable parameter of w2m_run as optional and defaulted to false', async () => {
    const { tools } = await register({ rabbitUrl: RABBIT });
    const write = paramsOf(tools.get('w2m_run')).write;
    assert.equal(write.type, 'boolean');
    assert.equal(write.default, false);
    assert.notEqual(write.required, true);
  });

  it('makes command_argv a required string array and never a shell string', async () => {
    const { tools } = await register({ rabbitUrl: RABBIT });
    const argv = paramsOf(tools.get('w2m_run')).command_argv;
    assert.equal(argv.type, 'array');
    assert.equal(argv.items.type, 'string');
    assert.equal(argv.required, true);
  });

  it('requires task_id for both w2m_wait and w2m_report', async () => {
    const { tools } = await register({ rabbitUrl: RABBIT });
    for (const name of ['w2m_wait', 'w2m_report']) {
      assert.equal(paramsOf(tools.get(name)).task_id.required, true, `${name}.task_id`);
    }
  });

  it('keeps the read-only tools parameter-free', async () => {
    const { tools } = await register({ rabbitUrl: RABBIT });
    assert.deepEqual(Object.keys(paramsOf(tools.get('w2m_status'))), []);
  });

  it('exposes no parameter that could carry a shell string or an endpoint', async () => {
    const { tools } = await register({ rabbitUrl: RABBIT });
    const banned = /^(shell|cmd|command_line|url|endpoint|host|token|password|credentials)$/i;
    for (const [name, tool] of tools) {
      for (const key of Object.keys(paramsOf(tool))) {
        assert.ok(!banned.test(key), `${name}.${key} looks like it would bypass the argv/endpoint rules`);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Fail-closed configuration
// ---------------------------------------------------------------------------------------------

describe('missing configuration', () => {
  it('refuses every Rabbit tool with the setting named, and does not claim success', async () => {
    const { tools } = await register({ stateDir: await makeStateDir(PAIRED_DEVICE) });
    const cases = [
      ['w2m_devices', {}],
      ['w2m_run', runArgs()],
      ['w2m_wait', { task_id: '01J' }],
      ['w2m_report', { task_id: '01J' }],
    ];
    for (const [name, args] of cases) {
      await assert.rejects(
        () => tools.get(name).execute(args, {}),
        (error) => {
          assert.match(error.message, /rabbitUrl/, `${name} must name the missing setting`);
          assert.match(error.message, /W2M_CONFIG/, `${name} must carry a typed code`);
          return true;
        },
        `${name} must fail closed without rabbitUrl`,
      );
    }
  });

  it('still answers w2m_status with no URL anywhere, saying nothing was probed', async () => {
    const fetchStub = installFetch([]);
    try {
      // No paired device either, so there is genuinely no URL to probe — the case this test is
      // named for. A paired device.json carries its own rabbit_url, and probing that is the
      // fallback `w2m_status falls back to device.json rabbit_url` covers.
      const { tools } = await register({ stateDir: await makeStateDir(null) });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(value.ok, true);
      assert.equal(value.relay.configured_url, null);
      assert.equal(value.relay.reachable, null);
      assert.equal(value.relay.probed_url, null);
      assert.equal(fetchStub.calls.length, 0, 'nothing should be probed when no URL is configured');
    } finally {
      fetchStub.restore();
    }
  });

  it('names rabbitUrl when the configured value is not a usable URL', async () => {
    await assert.rejects(
      () => register({ rabbitUrl: 'not-a-url' }),
      (error) => {
        assert.match(error.message, /rabbitUrl/);
        assert.match(error.message, /not-a-url/);
        return true;
      },
    );
    await assert.rejects(
      () => register({ rabbitUrl: 'ftp://example.invalid' }),
      (error) => {
        assert.match(error.message, /scheme/);
        return true;
      },
    );
  });

  it('names stateDir and the missing token when device.json is absent', async () => {
    const emptyDir = await makeStateDir(null);
    const fetchStub = installFetch([]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: emptyDir });
      await assert.rejects(
        () => tools.get('w2m_devices').execute({}, {}),
        (error) => {
          assert.match(error.message, /W2M_NO_TOKEN/);
          assert.match(error.message, /device\.json/);
          return true;
        },
      );
    } finally {
      fetchStub.restore();
    }
  });

  it('says which file lacked the token when device.json exists but is unpaired', async () => {
    const dir = await makeStateDir({ machine_id: 'm-1', machine_name: 'win-desktop', rabbit_url: RABBIT });
    const fetchStub = installFetch([]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: dir });
      await assert.rejects(
        () => tools.get('w2m_devices').execute({}, {}),
        (error) => {
          assert.match(error.message, /device_token/);
          assert.match(error.message, /device\.json/);
          return true;
        },
      );
    } finally {
      fetchStub.restore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Argument gating
// ---------------------------------------------------------------------------------------------

describe('argument gating', () => {
  it('rejects a missing task_id rather than asking the Rabbit about "undefined"', async () => {
    const fetchStub = installFetch([]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      for (const name of ['w2m_wait', 'w2m_report']) {
        await assert.rejects(() => tools.get(name).execute({}, {}), /task_id/, name);
      }
      assert.equal(fetchStub.calls.length, 0, 'no HTTP call should be made for a missing task_id');
    } finally {
      fetchStub.restore();
    }
  });

  it('rejects an empty or non-string argv array before calling the Rabbit', async () => {
    const fetchStub = installFetch([]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const run = tools.get('w2m_run');
      for (const bad of [undefined, [], ['node', 7], ['node', ''], 'node --test']) {
        await assert.rejects(
          () => run.execute({ command_argv: bad }, {}),
          /command_argv/,
          `argv ${JSON.stringify(bad)} must be refused`,
        );
      }
      assert.equal(fetchStub.calls.length, 0);
    } finally {
      fetchStub.restore();
    }
  });

  it('rejects an unknown mode and an impossible index_total', async () => {
    const fetchStub = installFetch([]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const run = tools.get('w2m_run');
      await assert.rejects(() => run.execute(runArgs({ mode: 'broadcast' }), {}), /`replicate` or `split`/);
      await assert.rejects(() => run.execute(runArgs({ mode: 'split', index_total: 0 }), {}), /index_total/);
      await assert.rejects(
        () => run.execute(runArgs({ mode: 'replicate', index_total: 3 }), {}),
        /`index_total` must be 1/,
      );
      assert.equal(fetchStub.calls.length, 0);
    } finally {
      fetchStub.restore();
    }
  });

  it('refuses a write with no write_scope instead of silently running read-only', async () => {
    const fetchStub = installFetch([]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      await assert.rejects(
        () => tools.get('w2m_run').execute(runArgs({ write: true }), {}),
        (error) => {
          assert.match(error.message, /write_scope/);
          assert.match(error.message, /W2M_WRITE_SCOPE/);
          return true;
        },
      );
      assert.equal(fetchStub.calls.length, 0);
    } finally {
      fetchStub.restore();
    }
  });

  it('refuses a command outside a configured allowedCommands, naming the list', async () => {
    const fetchStub = installFetch([]);
    try {
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        allowedCommands: ['node', 'git'],
      });
      const value = JSON.parse(await tools.get('w2m_run').execute(runArgs({ command_argv: ['rm', '-rf', '/'] }), {}));
      assert.equal(value.ok, false);
      assert.equal(value.state, 'refused');
      assert.equal(value.refusal_reason, 'COMMAND_NOT_ALLOWED');
      assert.deepEqual(value.allowed, ['git', 'node']);
      assert.equal(fetchStub.calls.length, 0, 'a refused command must not reach the Rabbit');
    } finally {
      fetchStub.restore();
    }
  });

  it('accepts a configured command regardless of .exe suffix and path', async () => {
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } }]);
    try {
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        allowedCommands: ['Node.exe'],
        projectDir: await makeNonRepoDir(),
      });
      const value = JSON.parse(await tools.get('w2m_run').execute(runArgs({ command_argv: ['C:\\Program Files\\nodejs\\node.exe', '--test'] }), {}));
      assert.equal(value.ok, true);
      assert.equal(fetchStub.calls.length, 1);
    } finally {
      fetchStub.restore();
    }
  });

  it('does not refuse when no allowedCommands is configured, because the agent owns that gate', async () => {
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } }]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), projectDir: nonRepo });
      const value = JSON.parse(await tools.get('w2m_run').execute(runArgs({ command_argv: ['echo', 'hi'] }), {}));
      assert.equal(value.ok, true);
      assert.equal(fetchStub.calls.length, 1);
    } finally {
      fetchStub.restore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Happy paths and their endpoints
// ---------------------------------------------------------------------------------------------

describe('happy paths', () => {
  it('w2m_devices GETs /v1/devices with a bearer token and lists the online machines', async () => {
    const fetchStub = installFetch([
      {
        path: '/v1/devices',
        body: {
          devices: [
            {
              machine_id: 'aaa',
              machine_name: 'win-desktop',
              platform: { os: 'windows', os_version: '10.0.26100', arch: 'x64', shell: 'pwsh' },
              caps: { case_sensitive_fs: false, symlinks: false, exec_bit: false },
              last_seen: '2026-10-07T12:00:00Z',
              state: 'online',
            },
            {
              machine_id: 'bbb',
              machine_name: 'mac-studio',
              platform: { os: 'macos', os_version: '15.1', arch: 'arm64', shell: 'zsh' },
              caps: { case_sensitive_fs: false, symlinks: true, exec_bit: true },
              last_seen: '2026-10-07T12:00:02Z',
              state: 'expired',
            },
          ],
        },
      },
    ]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const value = JSON.parse(await tools.get('w2m_devices').execute({}, {}));

      assert.equal(fetchStub.calls.length, 1);
      assert.equal(fetchStub.calls[0].method, 'GET');
      assert.equal(fetchStub.calls[0].path, '/v1/devices');
      assert.equal(fetchStub.calls[0].headers.authorization, 'Bearer tok-test-abc');

      assert.equal(value.ok, true);
      assert.equal(value.count, 1, 'expired leases are hidden by default');
      assert.equal(value.excluded_stale, 1);
      assert.deepEqual(value.devices[0], {
        machine_id: 'aaa',
        name: 'win-desktop',
        os: 'windows',
        os_version: '10.0.26100',
        arch: 'x64',
        shell: 'pwsh',
        caps: { case_sensitive_fs: false, symlinks: false, exec_bit: false },
        last_seen: '2026-10-07T12:00:00Z',
        state: 'online',
      });
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_devices can include expired leases on request', async () => {
    const fetchStub = installFetch([
      { path: '/v1/devices', body: { devices: [{ machine_id: 'bbb', state: 'expired' }] } },
    ]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const value = JSON.parse(await tools.get('w2m_devices').execute({ include_stale: true }, {}));
      assert.equal(value.count, 1);
      assert.equal(value.excluded_stale, 0);
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_run POSTs /v1/task with the protocol body and returns the leases', async () => {
    const fetchStub = installFetch([
      {
        method: 'POST',
        path: '/v1/task',
        body: {
          task_id: '01JZZZ',
          seq: 42,
          leases: [
            { machine_id: 'aaa', index: 0, state: 'queued' },
            { machine_id: 'bbb', index: 0, state: 'queued' },
          ],
        },
      },
    ]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        projectDir: nonRepo,
        machineName: 'win-desktop',
      });
      const value = JSON.parse(
        await tools.get('w2m_run').execute(runArgs({ cwd_rel: 'src', timeout_ms: 60_000 }), {}),
      );

      assert.equal(fetchStub.calls.length, 1);
      const call = fetchStub.calls[0];
      assert.equal(call.method, 'POST');
      assert.equal(call.path, '/v1/task');
      assert.equal(call.headers.authorization, 'Bearer tok-test-abc');
      assert.equal(call.headers['content-type'], 'application/json');

      const body = call.body;
      assert.equal(body.mode, 'replicate');
      assert.deepEqual(body.command_argv, ['node', '--test']);
      assert.equal(body.cwd_rel, 'src');
      assert.equal(body.index_total, 1);
      assert.equal(body.timeout_ms, 60_000);
      assert.equal(body.write, false);
      assert.deepEqual(body.write_scope, []);
      assert.equal(body.require_exclusive_write, false);
      assert.equal(body.halt, 'never');
      assert.equal(body.created_by, 'win-desktop');
      assert.equal(body.base_commit, null, 'a non-repo has no HEAD to anchor against');
      assert.equal(body.base_tree, null);
      assert.deepEqual(body.compare_policy, {
        strip_ansi: true,
        normalize_crlf: true,
        strip_trailing_blank_lines: true,
        redact: [],
      });
      assert.equal(body.base_commit, value.anchors.base_commit);
      assert.equal(body.base_tree, value.anchors.base_tree);

      assert.equal(value.ok, true);
      assert.equal(value.task_id, '01JZZZ');
      assert.equal(value.seq, 42);
      assert.equal(value.leases.length, 2);
      assert.match(value.note, /unverifiable/, 'a machine with no fingerprint must say so up front');
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_run computes base_commit and base_tree from a real git work tree', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'w2m-repo-'));
    cleanup.push(repo);
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, 'src', 'index.js'), 'export const a = 1;\n', 'utf8');

    const { execFile } = await import('node:child_process');
    const git = (argv) =>
      new Promise((resolve, reject) => {
        execFile('git', argv, { cwd: repo, windowsHide: true }, (error, stdout) =>
          error ? reject(error) : resolve(String(stdout).trim()),
        );
      });
    await git(['init', '-q']);
    await git(['config', 'user.email', 'test@example.invalid']);
    await git(['config', 'user.name', 'w2m test']);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'init']);
    const head = await git(['rev-parse', 'HEAD']);
    // A tracked-file edit must move base_tree without moving base_commit: that is the whole point
    // of fingerprinting the working tree rather than HEAD's tree.
    await fs.writeFile(path.join(repo, 'src', 'index.js'), 'export const a = 2;\n', 'utf8');

    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } }]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), projectDir: repo });
      const value = JSON.parse(await tools.get('w2m_run').execute(runArgs(), {}));

      assert.equal(value.anchors.base_commit, head);
      assert.match(value.anchors.base_tree, /^[0-9a-f]{40}$/);
      assert.notEqual(value.anchors.base_tree, head, 'base_tree must be a tree hash, not a commit hash');
      assert.equal(value.anchors.dirty, true);
      assert.equal(value.anchors.error, null);
      assert.match(value.note, /base_commit \+ base_tree/);

      // The throwaway index must not have touched the repository's own index.
      const status = await git(['status', '--porcelain']);
      assert.equal(status.includes('index.js'), true);
      const staged = await git(['diff', '--cached', '--name-only']);
      assert.equal(staged, '', 'the fingerprint must not stage anything in the real index');
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_wait polls /v1/tasks/{id} until the aggregate is terminal', async () => {
    let polls = 0;
    const previousFetch = globalThis.fetch;
    // First answer: a verdict that has not settled yet. `pending` is the Rabbit's own word for
    // "no verdict", and the machine's lease is still live, so nothing here is finished.
    const notYet = taskResponse(finalTask({
      status: 'pending',
      counts: { refused: 0, unverifiable: 0, ok: 0, failed: 0, expired: 0, pending: 2 },
      machines: [machine('aaa', 'win-desktop', 'pending', null), machine('bbb', 'mac-studio', 'pending', null)],
    }));
    const settled = taskResponse(finalTask());
    globalThis.fetch = async (input, init) => {
      polls += 1;
      const url = new URL(String(input));
      assert.equal(url.pathname, '/v1/tasks/01JABCDEF');
      assert.equal(String(init.method ?? 'GET').toUpperCase(), 'GET');
      assert.equal(init.headers.authorization, 'Bearer tok-test-abc');
      const body = polls === 1 ? notYet : settled;
      return new globalThis.Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const value = JSON.parse(
        await tools.get('w2m_wait').execute({ task_id: '01JABCDEF', wait_ms: 5000, poll_ms: 25 }, {}),
      );

      assert.equal(polls, 2, 'it should stop as soon as the aggregate is terminal');
      assert.equal(value.ok, true);
      assert.equal(value.complete, true);
      assert.equal(value.state, 'consistent');
      assert.equal(value.state_known, true);
      assert.deepEqual(value.states, ['ok', 'ok']);
      assert.equal(value.polls, 2);
      assert.equal(value.machines.length, 2);
      assert.equal(value.machines[0].machine_name, 'win-desktop');
      assert.equal(value.machines[0].outcome, 'ok');
      assert.equal(value.machines[0].envelope.exit_code, 0);
      assert.equal(value.machines[0].envelope.stdout_sha256, 'a'.repeat(64));
      assert.deepEqual(value.counts, { refused: 0, unverifiable: 0, ok: 2, failed: 0, expired: 0, pending: 0 });
      assert.deepEqual(value.unknown_fields, []);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('w2m_wait reports an unknown aggregate state instead of pretending it agreed', async () => {
    const fetchStub = installFetch([
      { path: '/v1/tasks/01JX', body: taskResponse(finalTask({ status: 'probably-fine' })) },
    ]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const value = JSON.parse(await tools.get('w2m_wait').execute({ task_id: '01JX', wait_ms: 1000 }, {}));
      assert.equal(value.ok, true);
      assert.equal(value.state, 'probably-fine');
      assert.equal(value.state_known, false, 'a status outside the known set must be flagged, not trusted');
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_wait surfaces envelope fields it does not know about', async () => {
    const unknown = finalTask();
    unknown.machines[0].envelope.something_new_from_the_rabbit = 1;
    const fetchStub = installFetch([{ path: '/v1/tasks/01JY', body: taskResponse(unknown) }]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const value = JSON.parse(await tools.get('w2m_wait').execute({ task_id: '01JY', wait_ms: 1000 }, {}));
      assert.deepEqual(value.unknown_fields, ['something_new_from_the_rabbit']);
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_wait truncates a huge stdout_head rather than flooding the session', async () => {
    const big = finalTask();
    big.machines[0].envelope.stdout_head = 'x'.repeat(50_000);
    const fetchStub = installFetch([{ path: '/v1/tasks/01JBIG', body: taskResponse(big) }]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const value = JSON.parse(await tools.get('w2m_wait').execute({ task_id: '01JBIG', wait_ms: 1000 }, {}));
      const head = value.machines[0].envelope.stdout_head;
      assert.ok(head.length < 50_000);
      assert.match(head, /truncated at 4096 bytes/);
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_wait reports a non-zero exit as a value, not as a tool failure', async () => {
    const failing = finalTask({
      status: 'failed',
      counts: { refused: 0, unverifiable: 0, ok: 0, failed: 2, expired: 0, pending: 0 },
      machines: [
        machine('aaa', 'win-desktop', 'failed', { status: 'nonzero_exit', exit_code: 1, stderr_sha256: 'b'.repeat(64) }),
        machine('bbb', 'mac-studio', 'failed', { status: 'nonzero_exit', exit_code: 1, stderr_sha256: 'b'.repeat(64) }),
      ],
    });
    const fetchStub = installFetch([{ path: '/v1/tasks/01JFAIL', body: taskResponse(failing) }]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const value = JSON.parse(await tools.get('w2m_wait').execute({ task_id: '01JFAIL', wait_ms: 1000 }, {}));
      assert.equal(value.ok, true);
      assert.equal(value.state, 'failed');
      assert.deepEqual(value.states, ['failed', 'failed']);
      assert.equal(value.machines[0].envelope.exit_code, 1);
      assert.equal(value.machines[0].status, 'nonzero_exit');
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_wait treats a refused machine as terminal and does not poll forever', async () => {
    const refused = finalTask({
      status: 'refused',
      counts: { refused: 2, unverifiable: 0, ok: 0, failed: 0, expired: 0, pending: 0 },
      machines: [
        machine('aaa', 'win-desktop', 'refused', { status: 'refused', refusal_reason: 'PLATFORM_MISMATCH', exit_code: null }),
        machine('bbb', 'mac-studio', 'refused', { status: 'refused', refusal_reason: 'MISSING_NODE', exit_code: null }),
      ],
    });
    const fetchStub = installFetch([{ path: '/v1/tasks/01JREF', body: taskResponse(refused) }]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const value = JSON.parse(await tools.get('w2m_wait').execute({ task_id: '01JREF', wait_ms: 5000, poll_ms: 25 }, {}));
      assert.equal(fetchStub.calls.length, 1, 'refused is a terminal verdict, not a reason to keep polling');
      assert.equal(value.complete, true);
      assert.equal(value.state, 'refused');
      assert.equal(value.machines[1].refusal_reason, 'MISSING_NODE');
      assert.equal(value.machines[1].envelope.status, 'refused');
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_wait reports a partial outcome with one machine refused, one ok', async () => {
    const partial = finalTask({
      status: 'partial',
      counts: { refused: 1, unverifiable: 0, ok: 1, failed: 0, expired: 0, pending: 0 },
      machines: [
        machine('aaa', 'win-desktop', 'ok', { status: 'ok', exit_code: 0 }),
        machine('bbb', 'mac-studio', 'refused', { status: 'refused', refusal_reason: 'READ_ONLY_MACHINE', exit_code: null }),
      ],
    });
    const fetchStub = installFetch([{ path: '/v1/tasks/01JPART', body: taskResponse(partial) }]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const value = JSON.parse(await tools.get('w2m_wait').execute({ task_id: '01JPART', wait_ms: 1000 }, {}));
      assert.equal(value.state, 'partial');
      assert.deepEqual(value.states, ['ok', 'refused']);
      assert.equal(value.machines[1].refusal_reason, 'READ_ONLY_MACHINE');
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_wait keeps waiting while a machine lease is still pending', async () => {
    let polls = 0;
    const previousFetch = globalThis.fetch;
    // `status: partial` looks settled, but one machine's lease is unexpired and has not reported.
    // Stopping here would report a verdict the Rabbit explicitly has not reached.
    const waiting = taskResponse(finalTask({
      status: 'partial',
      machines: [
        machine('aaa', 'win-desktop', 'ok', { status: 'ok', exit_code: 0 }),
        machine('bbb', 'mac-studio', 'pending', null, { lease_state: 'running' }),
      ],
    }));
    globalThis.fetch = async () => {
      polls += 1;
      return new globalThis.Response(JSON.stringify(waiting), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const value = JSON.parse(await tools.get('w2m_wait').execute({ task_id: '01JWAIT', wait_ms: 120, poll_ms: 25 }, {}));
      assert.ok(polls >= 2, 'a machine still running is not a terminal state');
      assert.equal(value.complete, false);
      assert.equal(value.state, 'timeout');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('w2m_wait gives up with a local timeout envelope and leaves the task runnable', async () => {
    const fetchStub = installFetch([
      {
        path: '/v1/tasks/01JSLOW',
        body: taskResponse(finalTask({
          status: 'pending',
          machines: [machine('aaa', 'win-desktop', 'pending', null), machine('bbb', 'mac-studio', 'pending', null)],
        })),
      },
    ]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const value = JSON.parse(await tools.get('w2m_wait').execute({ task_id: '01JSLOW', wait_ms: 120, poll_ms: 25 }, {}));
      assert.equal(value.ok, true);
      assert.equal(value.complete, false);
      assert.equal(value.state, 'timeout');
      assert.deepEqual(value.states, ['pending', 'pending']);
      assert.match(value.note, /local observation only/);
      assert.match(value.hint, /w2m_wait again/);
      assert.ok(fetchStub.calls.length >= 2, 'it should have polled more than once inside the window');
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_wait keeps polling through a retryable Rabbit error and says so if it times out', async () => {
    const fetchStub = installFetch([{ path: '/v1/tasks/01J503', status: 503, body: { error: { code: 'INTERNAL', message: 'busy' } } }]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const value = JSON.parse(await tools.get('w2m_wait').execute({ task_id: '01J503', wait_ms: 100, poll_ms: 25 }, {}));
      assert.equal(value.state, 'timeout');
      assert.equal(value.last_error, 'HTTP 503 (INTERNAL)');
      assert.match(value.note, /did not land/);
      assert.deepEqual(value.states, ['unknown'], 'an unread task must not claim a machine state');
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_wait throws a named error for a non-retryable refusal', async () => {
    const fetchStub = installFetch([
      { path: '/v1/tasks/nope', status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such task' } } },
    ]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      await assert.rejects(
        () => tools.get('w2m_wait').execute({ task_id: 'nope', wait_ms: 1000 }, {}),
        (error) => {
          assert.match(error.message, /W2M_RABBIT_REFUSED/);
          assert.match(error.message, /NOT_FOUND/);
          assert.match(error.message, /check the task_id/);
          return true;
        },
      );
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_report GETs the report endpoint with the requested format', async () => {
    const markdown = '# W2M report\n\n| machine | state |\n|---|---|\n| win-desktop | ok |\n';
    const fetchStub = installFetch([
      { path: '/v1/tasks/01JREP/report', text: markdown, contentType: 'text/markdown' },
      { path: '/v1/tasks/01JREP2/report', body: { task_id: '01JREP2', state: 'consistent' } },
    ]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });

      const md = JSON.parse(await tools.get('w2m_report').execute({ task_id: '01JREP' }, {}));
      assert.equal(fetchStub.calls[0].method, 'GET');
      assert.equal(fetchStub.calls[0].path, '/v1/tasks/01JREP/report');
      assert.equal(fetchStub.calls[0].search, '?format=md');
      assert.equal(fetchStub.calls[0].headers.authorization, 'Bearer tok-test-abc');
      assert.equal(md.ok, true);
      assert.equal(md.format, 'md');
      assert.equal(md.report, markdown);
      assert.equal(md.bytes, Buffer.byteLength(markdown, 'utf8'));

      const json = JSON.parse(await tools.get('w2m_report').execute({ task_id: '01JREP2', format: 'json' }, {}));
      assert.equal(fetchStub.calls[1].search, '?format=json');
      assert.equal(json.format, 'json');
      assert.deepEqual(json.report, { task_id: '01JREP2', state: 'consistent' });
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_report defaults to md and refuses an unknown format by falling back to md', async () => {
    const fetchStub = installFetch([{ path: '/v1/tasks/01JDEF/report', text: 'x', contentType: 'text/markdown' }]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const value = JSON.parse(await tools.get('w2m_report').execute({ task_id: '01JDEF', format: 'pdf' }, {}));
      assert.equal(value.format, 'md');
      assert.equal(fetchStub.calls[0].search, '?format=md');
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_status probes /healthz and reports identity, relay health, and the project anchors', async () => {
    const dir = await makeStateDir(PAIRED_DEVICE);
    const fetchStub = installFetch([{ path: '/healthz', body: { ok: true, protocol_version: 1, rabbit_time: '2026-10-07T12:00:00Z' } }]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: dir, projectDir: nonRepo, machineName: 'win-desktop' });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));

      assert.equal(fetchStub.calls.length, 1);
      assert.equal(fetchStub.calls[0].path, '/healthz');
      assert.equal(fetchStub.calls[0].method, 'GET');
      assert.equal(fetchStub.calls[0].headers.authorization, undefined, 'healthz needs no token');

      assert.equal(value.ok, true);
      assert.equal(value.protocol_version, 1);
      assert.equal(value.identity.machine_id, PAIRED_DEVICE.machine_id);
      assert.equal(value.identity.paired, true);
      assert.equal(value.identity.device_json, path.join(dir, 'device.json'));
      assert.equal(value.relay.reachable, true);
      assert.equal(value.relay.http_status, 200);
      assert.equal(value.relay.protocol_version, 1);
      assert.equal(value.config.rabbitUrl, RABBIT);
      assert.equal(value.config.autoStartAgent, false);
      assert.equal(value.config.pairingCode_configured, false);
      assert.equal(value.project.base_commit, null);
      assert.match(value.project.error, /not a git work tree/);
      assert.equal(value.project.fingerprint_algo, 'git-temp-index-tree/v1');
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_status reports an unreachable Rabbit without throwing', async () => {
    const dir = await makeStateDir(PAIRED_DEVICE);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: dir, projectDir: nonRepo });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(value.ok, true);
      assert.equal(value.relay.reachable, false);
      assert.ok(value.relay.error.length > 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('w2m_status falls back to device.json rabbit_url when rabbitUrl is unset', async () => {
    const dir = await makeStateDir(PAIRED_DEVICE);
    const fetchStub = installFetch([{ path: '/healthz', body: { ok: true, protocol_version: 1 } }]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ stateDir: dir, projectDir: nonRepo });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(value.relay.probed_url, RABBIT);
      assert.equal(value.relay.configured_url, null);
      assert.equal(value.relay.reachable, true);
    } finally {
      fetchStub.restore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Bounds, cancellation, and degradation
// ---------------------------------------------------------------------------------------------

describe('bounds and cancellation', () => {
  it('stops reading a report that exceeds its byte cap', async () => {
    const fetchStub = installFetch([
      {
        path: '/v1/tasks/01JHUGE/report',
        text: 'y'.repeat(4096),
        contentType: 'text/markdown',
        headers: { 'content-length': String(8 * 1024 * 1024) },
      },
    ]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      await assert.rejects(
        () => tools.get('w2m_report').execute({ task_id: '01JHUGE' }, {}),
        (error) => {
          assert.match(error.message, /W2M_TOO_LARGE/);
          assert.match(error.message, /8388608/);
          return true;
        },
      );
    } finally {
      fetchStub.restore();
    }
  });

  it('honours exec.signal before any network call', async () => {
    const fetchStub = installFetch([]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const controller = new AbortController();
      controller.abort(new Error('caller cancelled'));
      await assert.rejects(
        () => tools.get('w2m_devices').execute({}, { signal: controller.signal }),
        /caller cancelled/,
      );
      assert.equal(fetchStub.calls.length, 0, 'a cancelled call must not reach the wire');
    } finally {
      fetchStub.restore();
    }
  });

  it('aborts an in-flight request when exec.signal fires', async () => {
    const previousFetch = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      const pending = tools.get('w2m_devices').execute({}, { signal: controller.signal });
      controller.abort(new Error('stop now'));
      await assert.rejects(() => pending, /W2M_ABORTED/);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('reports an unreachable Rabbit as a typed error naming the endpoint', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError('connect ECONNREFUSED 127.0.0.1:8787');
    };
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      await assert.rejects(
        () => tools.get('w2m_devices').execute({}, {}),
        (error) => {
          assert.match(error.message, /W2M_UNREACHABLE/);
          assert.match(error.message, /\/v1\/devices/);
          // The remediation ("check rabbitUrl") belongs in the hint, not in the
          // message: the message states what failed, the hint says what to do.
          assert.match(String(error.hint ?? ''), /rabbitUrl/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('degrades to a local defineTool shim and says so when dsh-tools is absent', async () => {
    // Reset first, so this asserts the resolution outcome rather than inheriting whichever path an
    // earlier test happened to populate the cache with.
    plugin.resetDefineToolCacheForTests();
    const { tools, warnings } = await register({ rabbitUrl: RABBIT });
    assert.equal(tools.size, 5, 'the plugin must register all five tools on either path');

    if (warnings.length === 0) {
      // The package resolved: the real defineTool accepted all five definitions, which is the
      // stronger outcome. Nothing degraded, so there is nothing more to assert here.
      return;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /@deepseek-ai\/dsh-tools did not resolve/);
    assert.match(warnings[0], /offline shim/);
    assert.match(warnings[0], /production/i);
  });
});
