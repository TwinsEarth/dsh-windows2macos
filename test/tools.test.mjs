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

/**
 * v1.1.6: `autoStartAgent` defaults to true. Cases in this file are about something else, so the harness pins it off
 * once; call sites were renamed first, so this wrapper's own `plugin.apply` is still a real call.
 */
function applyPinned(ctx, config = {}) {
  return plugin.apply(ctx, { autoStartAgent: false, ...config });
}
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import * as plugin from '../src/plugin/tools.mjs';
import { MATCH_REFUSAL } from '../src/agent/allowed-commands.mjs';
import { hasPathSeparator, resolveCommand } from '../src/agent/resolve.mjs';
import { SHARED_SERVER } from '../src/agent/p2p-node.mjs';
// The composer's selection store, driven directly by the refusal-code tests: the browser route is the
// production writer, and asserting what a *stored* selection reports does not need a route registry.
import { defaultSelectionStore } from '../src/plugin/fleet-target.mjs';

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
 * `inject` is the Cordis-shaped half of the fake: the plugin reaches the optional `connection`
 * service only through `ctx.inject(names, callback)` (a plain property read throws inside a real
 * fiber), so a fake without it would be modelling a host that cannot exist. This host provides no
 * Connection, so the callback's read stays `undefined` and no route is mounted — the headless case.
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
    inject(_names, callback) {
      callback(ctx);
    },
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
  // v0.4.0: the direct path is on by default, and a node that starts fires an unawaited
  // `POST /v1/peer/announce` through the same `request()` helper every other call uses. In a suite
  // whose subject is *the exact HTTP call list*, that extra call lands in whichever `installFetch`
  // stub is live and shifts `calls[0]`. This suite therefore pins `p2pMode: 'relay'` — the mode that
  // binds no socket and makes no announcement — unless a test asks for something else. The direct
  // path itself is covered against real sockets in `test/p2p-plugin.test.mjs`.
  // autoStartAgent is pinned off here for the same reason p2pMode is: this suite asserts the exact HTTP call
  // list, and a started agent adds its own traffic. A test that wants the product default passes `undefined`.
  await applyPinned(ctx, { p2pMode: 'relay', autoStartAgent: false, ...config });
  return { tools, warnings };
}

/**
 * Install a routing `fetch` for one test, and a stub `Response` when the runtime under test has
 * none (the plugin's fallback path reads `response.body` through `arrayBuffer()` in that case).
 *
 * A route may also carry `responses: [...]`, which answers the 1st, 2nd, … call with the successive
 * entries and repeats the last one after that. That is how a test drives "the relay restarted
 * between two calls" without inventing two different URLs for the same endpoint.
 *
 * @param {Array<{method?: string, path: string, status?: number, body?: unknown, text?: string,
 *                contentType?: string, headers?: object, responses?: object[]}>} routes
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

    let answer = route;
    if (Array.isArray(route.responses) && route.responses.length > 0) {
      const seen = calls.filter(
        (call) => call.path === parsed.pathname && call.method === method,
      ).length;
      answer = route.responses[Math.min(seen - 1, route.responses.length - 1)];
    }

    const status = answer.status ?? 200;
    const text = answer.text ?? JSON.stringify(answer.body ?? {});
    const contentType = answer.contentType ?? 'application/json';
    const responseHeaders = { 'content-type': contentType, ...(answer.headers ?? {}) };

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

/** The operator credential (PROTOCOL-v0.1.2 §5). Only w2m_run may use it. */
const OPERATOR_TOKEN = 'opr-test-xyz';

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
  it('declares the tools service and registers exactly thirteen tools', async () => {
    assert.deepEqual(plugin.inject, ['tools']);
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
    assert.equal(tools.size, 13);
    assert.deepEqual(
      [...tools.keys()].sort(),
      ['w2m_approvals', 'w2m_chat', 'w2m_council', 'w2m_devices', 'w2m_history', 'w2m_intent', 'w2m_memory', 'w2m_report', 'w2m_run', 'w2m_stats', 'w2m_status', 'w2m_update', 'w2m_wait'],
    );
  });

  it('exposes apply(ctx) from the PACKAGE ROOT, not only from the /tools subpath', async () => {
    // Measured before this test existed: `import('@twinsearth/w2m-dsh-plugin')` yielded
    // `Object.keys() === []` and `typeof apply === 'undefined'`. The plugin mounted fine through the
    // patch (which names the subpath), but every ecosystem checklist -- including dsh-plugin.org's
    // listing requirements, which name a missing `apply(ctx)` export as a common rejection reason --
    // inspects the package root. A plugin that looks empty to an inspector is a listing risk for no
    // benefit, so the root re-exports and this asserts it stays that way.
    const root = await import('../lib/index.js');
    assert.equal(typeof root.apply, 'function', 'the package root must export apply(ctx)');
    assert.deepEqual(root.inject, ['tools'], 'the root must carry the same inject as the subpath');
    assert.ok(Object.keys(root).length >= 2, 'the root entry must not be an empty module');
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

  it('every tool returns a STRING, because that is what the host accepts', async () => {
    // Measured against the DSH host: a tool returning a plain object is rejected with
    // `returned invalid output: "value" must be a string`, so `w2m_update` was unusable in v0.4.0 and
    // v0.4.1 for exactly this reason. `output: jsonOutput` is a renderer, not a serialiser -- the
    // tool still owns producing text. This asserts the contract for all eight, so the next tool
    // cannot repeat it.
    const fetchStub = installFetch([
      { path: '/healthz', body: { ok: true, protocol_version: 1 } },
      { path: '/v1/devices', body: { protocol_version: 1, devices: [] } },
      { path: '/v1/tasks', body: { protocol_version: 1, tasks: [] } },
      { path: '/v1/tasks/01J', body: taskResponse({ status: 'consistent', machines: [] }) },
      { path: '/v1/tasks/01J/report', text: '# report', contentType: 'text/markdown' },
      { method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } },
      // The updater's network lookup: refuse it, so `check` records an error instead of installing
      // anything -- and still returns a string, which is the point.
      { path: '/repos/TwinsEarth/dsh-windows2macos/releases/latest', status: 500, body: { message: 'stubbed' } },
    ]);
    try {
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        operatorToken: OPERATOR_TOKEN,
      });
      const calls = [
        ['w2m_devices', {}],
        ['w2m_history', {}],
        ['w2m_stats', {}],
        ['w2m_status', {}],
        ['w2m_run', runArgs()],
        ['w2m_wait', { task_id: '01J', wait_ms: 50 }],
        ['w2m_report', { task_id: '01J' }],
        ['w2m_update', {}],
        ['w2m_update', { action: 'status' }],
      ];
      for (const [name, args] of calls) {
        const value = await tools.get(name).execute(args, {});
        assert.equal(typeof value, 'string', `${name} must return a string, not ${typeof value}`);
        assert.doesNotThrow(() => JSON.parse(value), `${name} must return JSON text`);
      }
    } finally {
      fetchStub.restore();
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

  it('makes command_argv a string array, and not a shell string', async () => {
    const { tools } = await register({ rabbitUrl: RABBIT });
    const argv = paramsOf(tools.get('w2m_run')).command_argv;
    assert.equal(argv.type, 'array');
    assert.equal(argv.items.type, 'string');
    // No longer `required: true`. As of v0.3.3 a pipeline states its commands in `stages` and the
    // relay derives this from stage 0, so an unconditional `required` would make a pipeline task
    // impossible to express. The obligation moved into the executor rather than disappearing -- the
    // test below is what holds that in place.
    assert.notEqual(argv.required, true);
    assert.match(argv.description, /Omit under mode=pipeline/);
  });

  it('still refuses a missing command outside pipeline mode', async () => {
    // The obligation moved, it did not disappear: without this, dropping `required` would have made a
    // task with no command at all expressible.
    const fetchStub = installFetch([]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
      const run = tools.get('w2m_run');
      await assert.rejects(() => run.execute(runArgs({ command_argv: undefined }), {}), /command_argv/);
      await assert.rejects(
        () => run.execute(runArgs({ mode: 'pipeline', command_argv: undefined }), {}),
        /without `stages`/,
      );
      assert.equal(fetchStub.calls.length, 0, 'neither may reach the relay');
    } finally {
      fetchStub.restore();
    }
  });

  it('refuses a pipeline with no stages, too many stages, an empty stage, or stages outside pipeline', async () => {
    const fetchStub = installFetch([]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
      const run = tools.get('w2m_run');
      await assert.rejects(
        () => run.execute(runArgs({ mode: 'pipeline', command_argv: undefined, stages: [] }), {}),
        /missing or empty/,
      );
      await assert.rejects(
        () => run.execute(
          runArgs({ mode: 'pipeline', command_argv: undefined, stages: Array.from({ length: 17 }, () => 'node --test') }),
          {},
        ),
        /at most 16/,
      );
      await assert.rejects(
        () => run.execute(runArgs({ mode: 'pipeline', command_argv: undefined, stages: ['node --test', '   '] }), {}),
        /stages\[1\]/,
      );
      await assert.rejects(
        () => run.execute(runArgs({ mode: 'replicate', stages: ['node --test'] }), {}),
        /only applies to mode=pipeline/,
      );
      await assert.rejects(
        () => run.execute(
          runArgs({ mode: 'pipeline', command_argv: undefined, stages: ['node --test'], index_total: 2 }),
          {},
        ),
        /index_total` must be 1/,
      );
      assert.equal(fetchStub.calls.length, 0);
    } finally {
      fetchStub.restore();
    }
  });

  it('sends each pipeline stage as a relay stage, and checks every stage against the allow-list', async () => {
    // The allow-list is default-deny. Checking only stage 0 would let a pipeline smuggle a disallowed
    // command into a later stage while the first stage satisfied the list.
    const fetchStub = installFetch([
      { path: '/v1/task', method: 'POST', body: { task_id: 'T1', seq: 1, leases: [] } },
    ]);
    try {
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        operatorToken: OPERATOR_TOKEN,
        allowedCommands: ['node'],
      });
      const run = tools.get('w2m_run');

      await run.execute(
        runArgs({ mode: 'pipeline', command_argv: undefined, stages: ['node --test', 'node scripts/pack.mjs'] }),
        {},
      );
      const sent = fetchStub.calls.at(-1).body;
      assert.equal(sent.mode, 'pipeline');
      assert.deepEqual(sent.stages, [
        { command_argv: ['node', '--test'] },
        { command_argv: ['node', 'scripts/pack.mjs'] },
      ]);
      assert.equal('command_argv' in sent, false, 'the relay derives stage 0, so it must not be sent');

      // A disallowed command in the *second* stage is refused, and the refusal names the stage.
      const refused = JSON.parse(
        await run.execute(
          runArgs({ mode: 'pipeline', command_argv: undefined, stages: ['node --test', 'rm -rf /'] }),
          {},
        ),
      );
      assert.equal(refused.state, 'refused');
      assert.equal(refused.stage_index, 1, 'the refusal must name which stage was rejected');
      assert.match(refused.message, /stage 1/);
      assert.equal(fetchStub.calls.length, 1, 'nothing may reach the relay once a stage is refused');
    } finally {
      fetchStub.restore();
    }
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
  it('refuses to load at all when rabbitUrl is unusable, naming the setting', async () => {
    // v0.4.0: an *unset* rabbitUrl is the shared server, not an error (see the test below). What
    // must still fail closed is a configured value that cannot be used, and it must fail at load
    // rather than on the first dispatch.
    const stateDir = await makeStateDir(PAIRED_DEVICE);
    await assert.rejects(
      () => register({ rabbitUrl: 'ftp://relay.example', stateDir }),
      (error) => {
        assert.match(error.message, /rabbitUrl/, 'the message must name the setting');
        assert.match(error.message, /W2M_CONFIG/, 'the message must carry a typed code');
        return true;
      },
    );
  });

  it('an unset rabbitUrl is the shared server, and the tools really dial it', async () => {
    const fetchStub = installFetch([
      { method: 'GET', path: '/v1/devices', body: { protocol_version: 1, devices: [] } },
    ]);
    try {
      // No rabbitUrl anywhere: v0.4.0 resolves to SHARED_SERVER.rabbitUrl, so the call must go
      // there rather than throwing the way v0.3.9 did.
      const { tools } = await register({ stateDir: await makeStateDir(PAIRED_DEVICE) });
      await tools.get('w2m_devices').execute({}, {});
      const deviceCall = fetchStub.calls.find((call) => call.path === '/v1/devices');
      assert.ok(deviceCall, 'w2m_devices must have called the relay');
      assert.ok(
        deviceCall.url.startsWith(SHARED_SERVER.rabbitUrl),
        `expected the shared server ${SHARED_SERVER.rabbitUrl}, got ${deviceCall.url}`,
      );
    } finally {
      fetchStub.restore();
    }
  });

  it('still answers w2m_status with nothing configured, and says the endpoint was not chosen', async () => {
    const fetchStub = installFetch([
      { path: '/healthz', body: { ok: true, protocol_version: 1 } },
    ]);
    try {
      // v0.3.9 asserted "nothing was probed" here. v0.4.0 probes the shared server instead — which
      // is a deliberate behaviour change, so what this test pins is the *provenance*: the address
      // came from nobody, and the status says so rather than looking like a configured fleet.
      const { tools } = await register({ stateDir: await makeStateDir(null) });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(value.ok, true);
      assert.equal(value.relay.configured_url, SHARED_SERVER.rabbitUrl);
      assert.equal(value.relay.probed_url, SHARED_SERVER.rabbitUrl);
      assert.equal(value.rabbit_source, 'shared-default');
      assert.match(value.notes.join(' '), /shared W2M server/);
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
          // The *code* stays W2M_NO_TOKEN for the whole class ("this machine cannot authenticate"),
          // while the refusal names which of the three it is -- because "pair the agent", "repair the
          // file" and "finish the pairing" are three different things to do about it.
          assert.equal(error.code, 'W2M_NO_TOKEN');
          assert.equal(error.reason_code, 'DEVICE_NOT_PAIRED');
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
          assert.equal(error.code, 'W2M_NO_TOKEN');
          assert.equal(error.reason_code, 'DEVICE_TOKEN_ABSENT', 'a file that exists is a different fix');
          return true;
        },
      );
    } finally {
      fetchStub.restore();
    }
  });

  it('names an unreadable device.json as its own refusal, not as "not paired"', async () => {
    // Three ways to have no usable token, three remedies: the file is absent (pair the agent), the file
    // is corrupt (repair it), the file parsed but never finished pairing (run the agent once). Sharing
    // one code across all three would send two of the three readers to the wrong fix.
    const dir = await makeStateDir(null);
    await fs.writeFile(path.join(dir, 'device.json'), '{ this is not json', 'utf8');
    const fetchStub = installFetch([]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: dir });
      await assert.rejects(
        () => tools.get('w2m_devices').execute({}, {}),
        (error) => {
          assert.match(error.message, /not valid JSON/);
          assert.equal(error.code, 'W2M_NO_TOKEN');
          assert.equal(error.reason_code, 'DEVICE_UNREADABLE');
          return true;
        },
      );
      assert.equal(fetchStub.calls.length, 0, 'an unreadable identity must not reach the relay');
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
      const run = tools.get('w2m_run');
      // `broadcast` used to be the unknown-mode example here. It is a real mode as of v0.3.3, so the
      // example had to move to something genuinely unknown.
      // `pipeline` used to be the unknown-mode example; it is a real mode as of v0.3.3, so the example
      // moved to something genuinely unknown. A pipeline without stages is still refused, by its own
      // check -- asserted separately below.
      await assert.rejects(
        () => run.execute(runArgs({ mode: 'teleport' }), {}),
        /`replicate`, `split`, `broadcast` or `pipeline`/,
      );
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

  it('refuses an executor_machine_id outside broadcast instead of accepting a no-op restriction', async () => {
    // The relay reads this field only for broadcast. Accepting it under replicate would look like
    // "only this machine runs it" while the command in fact runs everywhere -- a promise that is not
    // enforced is worse than no parameter at all.
    const fetchStub = installFetch([]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
      const run = tools.get('w2m_run');
      await assert.rejects(
        () => run.execute(runArgs({ mode: 'replicate', executor_machine_id: 'm1' }), {}),
        /only applies to mode=broadcast/,
      );
      await assert.rejects(
        () => run.execute(runArgs({ mode: 'split', index_total: 2, executor_machine_id: 'm1' }), {}),
        /only applies to mode=broadcast/,
      );
      // A broadcast with more than one shard is refused rather than coerced: running one shard while
      // recording a split task would put work in the report that never happened.
      await assert.rejects(
        () => run.execute(runArgs({ mode: 'broadcast', index_total: 2 }), {}),
        /mode=broadcast runs the command on one machine/,
      );
      assert.equal(fetchStub.calls.length, 0, 'none of these may reach the relay');
    } finally {
      fetchStub.restore();
    }
  });

  it('sends executor_machine_id only for broadcast', async () => {
    const fetchStub = installFetch([
      { path: '/v1/task', method: 'POST', body: { task_id: 'T1', seq: 1, leases: [] } },
    ]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
      const run = tools.get('w2m_run');

      await run.execute(runArgs({ mode: 'broadcast', executor_machine_id: 'm2' }), {});
      const broadcastBody = fetchStub.calls.at(-1).body;
      assert.equal(broadcastBody.mode, 'broadcast');
      assert.equal(broadcastBody.executor_machine_id, 'm2');

      await run.execute(runArgs({}), {});
      const replicateBody = fetchStub.calls.at(-1).body;
      assert.equal(replicateBody.mode, 'replicate');
      assert.equal(
        'executor_machine_id' in replicateBody,
        false,
        'the relay must not receive a field it ignores',
      );
    } finally {
      fetchStub.restore();
    }
  });

  it('refuses a write with no write_scope instead of silently running read-only', async () => {
    const fetchStub = installFetch([]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
        operatorToken: OPERATOR_TOKEN,
      });
      const value = JSON.parse(await tools.get('w2m_run').execute(runArgs({ command_argv: ['rm', '-rf', '/'] }), {}));
      assert.equal(value.ok, false);
      assert.equal(value.state, 'refused');
      assert.equal(value.refusal_reason, 'COMMAND_NOT_ALLOWED');
      // The same code under the name the gates share, and a detail that names what would change it --
      // a refusal a caller cannot act on has told them nothing.
      assert.equal(value.reason_code, 'COMMAND_NOT_ALLOWED');
      assert.match(value.detail, /allowedCommands|allow-list/, 'the detail must name what to change');
      assert.deepEqual(value.allowed, ['git', 'node']);
      assert.equal(fetchStub.calls.length, 0, 'a refused command must not reach the Rabbit');
    } finally {
      fetchStub.restore();
    }
  });

  it('allows a multi-token entry to match the argv it describes, exactly like the agent', async () => {
    // The defect this pins: the pre-flight compared `argv[0]` -- a basename -- against each entry as
    // a whole string, so `'git rev-parse'` could never match `['git','rev-parse','HEAD']`. It was
    // *stricter* than the agent's own gate, and the dispatch simply never happened.
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } }]);
    try {
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        allowedCommands: ['git rev-parse'],
        projectDir: await makeNonRepoDir(),
        operatorToken: OPERATOR_TOKEN,
      });

      const allowed = JSON.parse(
        await tools.get('w2m_run').execute(runArgs({ command_argv: ['git', 'rev-parse', 'HEAD'] }), {}),
      );
      assert.equal(
        allowed.ok,
        true,
        `the command the agent would run must be dispatched: ${JSON.stringify(allowed)}`,
      );
      assert.equal(fetchStub.calls.length, 1, 'it must reach the Rabbit');

      const refused = JSON.parse(
        await tools.get('w2m_run').execute(runArgs({ command_argv: ['git', 'push'] }), {}),
      );
      assert.equal(refused.ok, false);
      assert.equal(refused.state, 'refused');
      assert.equal(refused.refusal_reason, 'COMMAND_NOT_ALLOWED');
      assert.equal(refused.reason_code, 'COMMAND_NOT_ALLOWED');
      assert.deepEqual(refused.allowed, ['git rev-parse'], 'the entries are listed as written');
      assert.match(refused.message, /git push/, 'the message names the refused command');
      assert.match(refused.message, /git rev-parse/, 'and the configured entries');
      assert.equal(fetchStub.calls.length, 1, 'a refused command must not reach the Rabbit');
    } finally {
      fetchStub.restore();
    }
  });

  it('allows a multi-token entry over a longer argv, and refuses a different one', async () => {
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } }]);
    try {
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        allowedCommands: ['node --test'],
        projectDir: await makeNonRepoDir(),
        operatorToken: OPERATOR_TOKEN,
      });

      const allowed = JSON.parse(
        await tools.get('w2m_run').execute(runArgs({ command_argv: ['node', '--test', '--reporter=tap'] }), {}),
      );
      assert.equal(allowed.ok, true, `a longer argv must match the prefix: ${JSON.stringify(allowed)}`);
      assert.equal(fetchStub.calls.length, 1);

      const refused = JSON.parse(
        await tools.get('w2m_run').execute(runArgs({ command_argv: ['node', '-e', '1'] }), {}),
      );
      assert.equal(refused.ok, false);
      assert.equal(refused.refusal_reason, 'COMMAND_NOT_ALLOWED');
      assert.equal(refused.reason_code, 'COMMAND_NOT_ALLOWED');
      assert.deepEqual(refused.allowed, ['node --test']);
      assert.equal(fetchStub.calls.length, 1, 'a different flag must not be waved through');
    } finally {
      fetchStub.restore();
    }
  });

  it('accepts a configured command regardless of .exe suffix, but not regardless of path', async () => {
    // The suffix half is the documented tolerance: `Node.exe` and `node` are the same name, so the
    // entry admits it. The path half used to be tolerated too -- `C:\Program Files\nodejs\node.exe`
    // was admitted for that entry because its *basename* matched -- and that is the v0.5.10 defect:
    // a copy of some other program at `E:\Temp\evil\node.exe` was admitted the same way, and `spawn`
    // ran the copy. A path is now admitted only when it is the file the entry's executable resolves
    // to, which is the file the agent would run.
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } }]);
    try {
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        allowedCommands: ['node.exe --test'],
        projectDir: await makeNonRepoDir(),
        operatorToken: OPERATOR_TOKEN,
      });
      const value = JSON.parse(await tools.get('w2m_run').execute(runArgs({ command_argv: ['node', '--test'] }), {}));
      assert.equal(value.ok, true, `a bare name must match an entry that spells the suffix: ${JSON.stringify(value)}`);
      assert.equal(fetchStub.calls.length, 1);
    } finally {
      fetchStub.restore();
    }
  });

  it('refuses an executable path that is not the file the entry names, under the matcher\'s code', async () => {
    const fetchStub = installFetch([]);
    try {
      const dir = await makeNonRepoDir();
      const other = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
      await fs.writeFile(other, '', 'utf8');
      if (process.platform !== 'win32') await fs.chmod(other, 0o755);

      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        allowedCommands: ['node --test'],
        projectDir: dir,
        operatorToken: OPERATOR_TOKEN,
      });

      // The entry names `node`; this path names a different file that happens to share the basename.
      // Identity is the file, so the pre-flight refuses before any request is made.
      const refused = JSON.parse(
        await tools.get('w2m_run').execute(runArgs({ command_argv: [other, '--test'] }), {}),
      );
      assert.equal(refused.ok, false);
      assert.equal(refused.state, 'refused');
      assert.equal(refused.refusal_reason, MATCH_REFUSAL.EXECUTABLE_PATH_MISMATCH);
      assert.equal(refused.reason_code, MATCH_REFUSAL.EXECUTABLE_PATH_MISMATCH);
      assert.ok(refused.detail.includes(other), 'the detail names the refused path');
      assert.equal(fetchStub.calls.length, 0, 'a refused command must not reach the Rabbit');

      // A relative executable is refused outright: the working directory is the offer's to choose.
      const relative = process.platform === 'win32' ? '.\\node.exe' : './node';
      const relativeRefusal = JSON.parse(
        await tools.get('w2m_run').execute(runArgs({ command_argv: [relative, '--test'] }), {}),
      );
      assert.equal(relativeRefusal.reason_code, MATCH_REFUSAL.EXECUTABLE_RELATIVE_PATH);
      assert.equal(fetchStub.calls.length, 0);

      // The direction that must keep working: the absolute path of the executable the entry resolves
      // to is that same file, so it is the entry's command. Guarded, because a dispatcher with no
      // `node` on PATH has nothing for the name to resolve to -- and then no path can be admitted.
      const resolved = resolveCommand('node');
      if (hasPathSeparator(resolved)) {
        const fetchStubAllowed = installFetch([
          { method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } },
        ]);
        try {
          const allowed = JSON.parse(
            await tools.get('w2m_run').execute(runArgs({ command_argv: [resolved, '--test'] }), {}),
          );
          assert.equal(allowed.ok, true, `${resolved} is the file the entry resolves to`);
          assert.equal(fetchStubAllowed.calls.length, 1);
        } finally {
          fetchStubAllowed.restore();
        }
      }
    } finally {
      fetchStub.restore();
    }
  });

  it('refuses a trailing argument that would make the allowed tool load code', async () => {
    // HIGH-2 at the dispatch end: the plugin's pre-flight and the agent's gate are one matcher, so a
    // refusal the machine would give is given here, under the same code, before any request is made.
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } }]);
    try {
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        allowedCommands: ['node --test'],
        projectDir: await makeNonRepoDir(),
        operatorToken: OPERATOR_TOKEN,
      });
      const run = tools.get('w2m_run');

      const refused = JSON.parse(
        await run.execute(
          runArgs({ command_argv: ['node', '--test', '--test-reporter=file:///E:/evil-reporter.mjs'] }),
          {},
        ),
      );
      assert.equal(refused.ok, false);
      assert.equal(refused.refusal_reason, MATCH_REFUSAL.REPARSING_ARGUMENT);
      assert.equal(refused.reason_code, MATCH_REFUSAL.REPARSING_ARGUMENT);
      assert.match(refused.detail, /--test-reporter/);
      assert.equal(fetchStub.calls.length, 0, 'a refused command must not reach the Rabbit');

      // The direction that must keep working: a legitimate trailing argument of the same entry.
      const allowed = JSON.parse(
        await run.execute(
          runArgs({ command_argv: ['node', '--test', '--test-name-pattern=adds'] }),
          {},
        ),
      );
      assert.equal(allowed.ok, true, `a legitimate trailing argument must dispatch: ${JSON.stringify(allowed)}`);
      assert.equal(fetchStub.calls.length, 1, 'it must reach the Rabbit');

      // And a pipeline stage that carries the argument is refused by name, naming the stage.
      const stageRefusal = JSON.parse(
        await run.execute(
          runArgs({
            mode: 'pipeline',
            command_argv: undefined,
            stages: ['node --test', 'node --test --test-reporter=file:///E:/evil-reporter.mjs'],
          }),
          {},
        ),
      );
      assert.equal(stageRefusal.refusal_reason, MATCH_REFUSAL.REPARSING_ARGUMENT);
      assert.equal(stageRefusal.stage_index, 1, 'the refusal must name which stage was rejected');
      assert.match(stageRefusal.message, /stage 1/);
      assert.equal(fetchStub.calls.length, 1, 'nothing may reach the relay once a stage is refused');
    } finally {
      fetchStub.restore();
    }
  });

  it('does not refuse when no allowedCommands is configured, because the agent owns that gate', async () => {
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } }]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), projectDir: nonRepo, operatorToken: OPERATOR_TOKEN });
      const value = JSON.parse(await tools.get('w2m_run').execute(runArgs({ command_argv: ['echo', 'hi'] }), {}));
      assert.equal(value.ok, true);
      assert.equal(fetchStub.calls.length, 1);

      // "Unset" and "an explicit empty list" are the same statement here, and neither is the
      // plugin's to enforce: the machine that runs the command owns that gate, and it refuses with
      // its own `COMMAND_NOT_ALLOWED` if its list is empty.
      const { tools: emptyListTools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        projectDir: nonRepo,
        allowedCommands: [],
        operatorToken: OPERATOR_TOKEN,
      });
      const empty = JSON.parse(
        await emptyListTools.get('w2m_run').execute(runArgs({ command_argv: ['rm', '-rf', '/'] }), {}),
      );
      assert.equal(empty.ok, true, 'an empty list must not be read as "refuse everything" here');
      assert.equal(fetchStub.calls.length, 2);
    } finally {
      fetchStub.restore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3b. Refusal codes: a gate that says no says why
// ---------------------------------------------------------------------------------------------
//
// The nine aggregate verdicts never reduce an outcome to a boolean; these are the gates that run
// *before* any comparison, and each refusal now names itself. Every test below asserts the **code**,
// not merely that something was refused: "it failed" passes for the wrong reason, and a refusal a
// caller cannot act on is the failure these codes exist to remove.

describe('refusal codes: the machine selection says which of four things happened', () => {
  /** A dispatch narrowed by the composer, keyed by the session the tool context names. */
  const SESSION = 'w2m-refusal-code-session';

  it('reports SELECTION_NONE when nothing is selected, rather than a bare applied:false', async () => {
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } }]);
    try {
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        projectDir: await makeNonRepoDir(),
        operatorToken: OPERATOR_TOKEN,
      });
      const value = JSON.parse(await tools.get('w2m_run').execute(runArgs(), {}));
      assert.equal(value.selection.applied, false, 'the boolean keeps meaning what it always meant');
      assert.equal(value.selection.reason_code, 'SELECTION_NONE');
      assert.match(value.selection.detail, /not narrowed/, 'and the detail says what that means');
    } finally {
      fetchStub.restore();
    }
  });

  it('reports SELECTION_APPLIED and names the field the selection travelled in', async () => {
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } }]);
    defaultSelectionStore.set(SESSION, { machine_id: 'm-target', machine_name: 'mac-studio' });
    try {
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        projectDir: await makeNonRepoDir(),
        operatorToken: OPERATOR_TOKEN,
      });
      const value = JSON.parse(
        await tools.get('w2m_run').execute(runArgs(), { agent: { session: { id: SESSION } } }),
      );
      assert.equal(value.selection.applied, true);
      assert.equal(value.selection.reason_code, 'SELECTION_APPLIED');
      assert.equal(value.selection.field, 'target_machines');
      assert.deepEqual(fetchStub.calls.at(-1).body.target_machines, ['m-target']);
    } finally {
      defaultSelectionStore.clear(SESSION);
      fetchStub.restore();
    }
  });

  it('reports SELECTION_OVERRIDDEN_BY_CALLER when the call named its own machine', async () => {
    // The precedence rule — a caller's own fields always win — is documented, and this is the code
    // that makes it visible in the answer instead of the operator finding out from a ledger entry.
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } }]);
    defaultSelectionStore.set(SESSION, { machine_id: 'm-target', machine_name: 'mac-studio' });
    try {
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        projectDir: await makeNonRepoDir(),
        operatorToken: OPERATOR_TOKEN,
      });
      const value = JSON.parse(
        await tools
          .get('w2m_run')
          .execute(runArgs({ mode: 'broadcast', executor_machine_id: 'm-caller' }), { agent: { session: { id: SESSION } } }),
      );
      assert.equal(value.selection.applied, false);
      assert.equal(value.selection.reason_code, 'SELECTION_OVERRIDDEN_BY_CALLER');
      assert.match(value.selection.detail, /m-caller/, 'the detail names the value that won');
      const sent = fetchStub.calls.at(-1).body;
      assert.equal(sent.executor_machine_id, 'm-caller');
      assert.equal('target_machines' in sent, false, 'the selection must not also be sent');
    } finally {
      defaultSelectionStore.clear(SESSION);
      fetchStub.restore();
    }
  });

  it('reports SELECTION_UNUSABLE when a stored selection names no machine at all', async () => {
    // Unreachable through the browser route, which clears on a null `machine_id` and refuses an empty
    // one — but the store is a plain map that host code and tests write, and a selection that routes
    // nothing used to be indistinguishable from "the whole fleet ran it".
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } }]);
    defaultSelectionStore.set(SESSION, { machine_id: '' });
    try {
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        projectDir: await makeNonRepoDir(),
        operatorToken: OPERATOR_TOKEN,
      });
      const value = JSON.parse(
        await tools.get('w2m_run').execute(runArgs(), { agent: { session: { id: SESSION } } }),
      );
      assert.equal(value.selection.applied, false);
      assert.equal(value.selection.reason_code, 'SELECTION_UNUSABLE');
      assert.match(value.selection.detail, /composer/, 'the detail says what would fix it');
    } finally {
      defaultSelectionStore.clear(SESSION);
      fetchStub.restore();
    }
  });
});

describe('refusal codes: the direct path names every machine it did not push to', () => {
  /**
   * A `P2PNode` stand-in, injected through the documented `p2pBlock` seam.
   *
   * `p2pBlock.P2PNode` is a *class*, and the plugin constructs its own instance — so the state the
   * test inspects lives on the class, not on an object the test made. It records the machines it was
   * asked to dial, so "the gate refused" can be told apart from "it tried and failed" — the
   * distinction the codes exist to make.
   */
  class FakeP2PNode {
    /** Every instance the plugin built, so the test can read the one that served the dispatch. */
    static instances = [];
    /** Answers keyed by machine id; anything else is "no candidates", the ordinary case. */
    static answers = new Map();

    constructor() {
      FakeP2PNode.instances.push(this);
      this.dials = [];
      this.status = { mode: 'auto', running: true, candidates: [] };
      this.handlers = new Map();
    }

    on(name, handler) {
      this.handlers.set(name, handler);
      return this;
    }

    async start() {
      return { ok: true, enabled: true };
    }

    async dial(machineId, options) {
      this.dials.push({ machineId, options });
      const answer = FakeP2PNode.answers.get(machineId);
      if (answer) return answer();
      return { ok: false, error: `P2P_NO_CANDIDATES: the relay holds no live announcement for ${machineId}` };
    }

    close() {}
  }

  it('codes an unaddressable lease and an unrunnable lease differently, and does not dial the second', async () => {
    FakeP2PNode.instances.length = 0;
    FakeP2PNode.answers = new Map([
      [
        'm-offered',
        () => ({
          ok: true,
          channel: { send: async () => {}, close: () => {}, encryption: { encrypted: false } },
          session: 7,
          reused: false,
        }),
      ],
    ]);

    const fetchStub = installFetch([
      {
        method: 'POST',
        path: '/v1/task',
        body: {
          task_id: '01JCODES',
          seq: 1,
          leases: [
            { machine_id: 'm-offered', index: 0, state: 'offered' },
            { index: 0, state: 'queued' },
            { machine_id: 'm-observing', index: 1, state: 'observing' },
            { machine_id: 'm-nobody-home', index: 2, state: 'queued' },
          ],
        },
      },
    ]);

    try {
      const { tools } = await register({
        p2pMode: 'auto',
        p2pBlock: { P2PNode: FakeP2PNode },
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        projectDir: await makeNonRepoDir(),
        operatorToken: OPERATOR_TOKEN,
      });

      const value = JSON.parse(await tools.get('w2m_run').execute(runArgs(), {}));
      assert.equal(value.ok, true);

      // The plugin builds the node, so the test reads the instance that served this dispatch rather
      // than one of its own that nothing talked to.
      const node = FakeP2PNode.instances.at(-1);
      assert.ok(node, 'the dispatch must have built the injected node');
      assert.equal(FakeP2PNode.instances.length, 1, 'one node per plugin, however many dispatches');

      const byMachine = new Map(value.direct_pushes.pushes.map((entry) => [entry.machine_id, entry]));
      assert.equal(value.direct_pushes.pushes.length, 4, 'every lease is accounted for');

      // The lease the relay did not address to anyone. It has no machine_id, so it is keyed by null.
      const unaddressed = value.direct_pushes.pushes.find((entry) => entry.machine_id === null);
      assert.equal(unaddressed.ok, false);
      assert.equal(unaddressed.reason_code, 'P2P_LEASE_NO_MACHINE_ID');
      assert.match(unaddressed.error, /machine_id/);

      // The lease the relay decided must not run the command: a refusal with its own code and a detail
      // that says whose decision it was.
      const observing = byMachine.get('m-observing');
      assert.equal(observing.ok, false);
      assert.equal(observing.reason_code, 'P2P_LEASE_NOT_RUNNABLE');
      assert.match(observing.detail, /relay/, 'the detail must say the relay decided, not this plugin');
      assert.equal(
        node.dials.some((entry) => entry.machineId === 'm-observing'),
        false,
        'a machine that was never handed the command must not be asked to run it',
      );

      // A dial that failed keeps the node's own code, lifted out of its message rather than replaced.
      const unreachable = byMachine.get('m-nobody-home');
      assert.equal(unreachable.ok, false);
      assert.equal(unreachable.reason_code, 'P2P_NO_CANDIDATES', 'the node names its own refusal');
      assert.equal(unreachable.ok, false);

      // The one that landed, so the codes above are not simply "everything fails".
      const delivered = byMachine.get('m-offered');
      assert.equal(delivered.ok, true);
      assert.equal(delivered.reason_code, null, 'a delivered push has no refusal to name');

      // One entry per lease *considered* — the meaning `attempted` has always had — against two dials
      // actually made. The difference is the point: the unrunnable lease was refused, not attempted.
      assert.equal(value.direct_pushes.attempted, 4);
      assert.equal(value.direct_pushes.delivered, 1);
      assert.equal(value.direct_pushes.failed, 3);
      assert.deepEqual(
        node.dials.map((entry) => entry.machineId),
        ['m-offered', 'm-nobody-home'],
        'only addressable, runnable leases are dialled',
      );
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
        operatorToken: OPERATOR_TOKEN,
      });
      const value = JSON.parse(
        await tools.get('w2m_run').execute(runArgs({ cwd_rel: 'src', timeout_ms: 60_000 }), {}),
      );

      assert.equal(fetchStub.calls.length, 1);
      const call = fetchStub.calls[0];
      assert.equal(call.method, 'POST');
      assert.equal(call.path, '/v1/task');
      // §5: dispatching carries the OPERATOR credential, not this machine's device token.
      assert.equal(call.headers.authorization, `Bearer ${OPERATOR_TOKEN}`);
      assert.notEqual(call.headers.authorization, `Bearer ${PAIRED_DEVICE.device_token}`);
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

      /**
       * A machine with no fingerprint must say so up front — but it must not claim a verdict.
       *
       * This asserted `/unverifiable/` until v0.9.4, which encoded a promise the relay no longer keeps:
       * the relay used to compare an absent anchor against the literal `null`, so an unanchored dispatch
       * really could never aggregate. v0.9.3 made it skip a check nobody declared, so the same dispatch
       * now reaches a real verdict and the old wording told operators to doubt a correct `ok`.
       *
       * So the assertion is on the *claim*, not the phrasing: the note must warn that no anchor was
       * declared (the operator cannot tell "these machines agreed" from "they ran the tree I named"
       * otherwise), and must not assert what the verdict will be. The negative case is the one that
       * matters — it is what stops the stale promise from being written back in.
       */
      assert.match(value.note, /no anchor was declared/, 'the absence of an anchor must be stated up front');
      assert.match(value.note, /compared with each other|not against a named tree/i, 'and what that costs must be stated too');
      assert.doesNotMatch(
        value.note,
        /unverifiable/,
        'the note must not promise a verdict: the relay decides that, and an unanchored dispatch is now '
          + 'aggregated normally',
      );
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), projectDir: repo, operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });

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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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

  it('w2m_status prefers the shared default over a device.json rabbit_url, and says which it dropped', async () => {
    const dir = await makeStateDir(PAIRED_DEVICE);
    const fetchStub = installFetch([{ path: '/healthz', body: { ok: true, protocol_version: 1 } }]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ stateDir: dir, projectDir: nonRepo });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      // v0.3.9 probed device.json's rabbit_url here. v0.4.0 makes the precedence explicit —
      // config > env > shared default — so a stale address in device.json can no longer silently
      // win, and the status names the override it ignored instead of hiding it.
      assert.equal(value.relay.probed_url, SHARED_SERVER.rabbitUrl);
      assert.equal(value.relay.configured_url, SHARED_SERVER.rabbitUrl);
      assert.equal(value.rabbit_source, 'shared-default');
      assert.equal(value.config.rabbit_url_override_ignored, 'device.rabbit_url');
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
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
    assert.equal(tools.size, 13, 'the plugin must register all twelve tools on either path');

    /**
     * Match the warning this test is about, rather than counting warnings.
     *
     * A first version asserted `warnings.length === 1`, which is a claim about *every* warning the
     * plugin will ever emit — so an unrelated new one (v0.8.5's "no agent is running") broke a test
     * about `dsh-tools` resolution. The count was never the property; the message was.
     */
    const shim = warnings.filter((w) => /did not resolve/.test(w));
    if (shim.length === 0) {
      // The package resolved: the real defineTool accepted all eight definitions, which is the
      // stronger outcome. Nothing degraded, so there is nothing more to assert here.
      return;
    }
    assert.equal(shim.length, 1, `exactly one shim warning, saw: ${JSON.stringify(warnings)}`);
    assert.match(shim[0], /@deepseek-ai\/dsh-tools did not resolve/);
    assert.match(shim[0], /offline shim/);
    assert.match(shim[0], /production/i);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. v0.1.2 — operator token (§5)
// ---------------------------------------------------------------------------------------------

describe('v0.1.2 operator token', () => {
  it('w2m_run refuses without an operatorToken and names the setting, before touching the wire', async () => {
    const fetchStub = installFetch([]);
    try {
      // A paired device with a perfectly good device token: §5 says that is still not enough.
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      await assert.rejects(
        () => tools.get('w2m_run').execute(runArgs(), {}),
        (error) => {
          assert.equal(error.code, 'W2M_CONFIG');
          // The refusal has its own code: `W2M_CONFIG` says a setting is wrong, this says *which gate*
          // refused and that the remedy is the operator credential. It is the one credential this
          // plugin holds, so a caller must not have to parse a message to find that out.
          assert.equal(error.reason_code, 'OPERATOR_TOKEN_MISSING');
          assert.match(error.message, /operatorToken/, 'must name the missing setting');
          assert.match(error.message, /device token cannot dispatch tasks/i, 'must say why the device token will not do');
          assert.match(error.message, /W2M_OPERATOR_TOKEN/, 'must name the environment fallback');
          assert.match(error.message, /operator-token\.txt/, 'must say where the relay keeps the value');
          return true;
        },
      );
      assert.equal(fetchStub.calls.length, 0, 'a missing operator token must not reach the relay');
    } finally {
      fetchStub.restore();
    }
  });

  it('never silently falls back to the device token', async () => {
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01J', leases: [], seq: 1 } }]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE) });
      await assert.rejects(() => tools.get('w2m_run').execute(runArgs(), {}), /operatorToken/);
      assert.equal(
        fetchStub.calls.length,
        0,
        'trying the device token first would turn a missing setting into a confusing remote 401',
      );
    } finally {
      fetchStub.restore();
    }
  });

  it('reads W2M_OPERATOR_TOKEN from the environment when the config omits it', async () => {
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01JENV', leases: [], seq: 2 } }]);
    const previous = process.env.W2M_OPERATOR_TOKEN;
    process.env.W2M_OPERATOR_TOKEN = 'opr-from-env';
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), projectDir: nonRepo });
      const value = JSON.parse(await tools.get('w2m_run').execute(runArgs(), {}));
      assert.equal(value.ok, true);
      assert.equal(fetchStub.calls[0].headers.authorization, 'Bearer opr-from-env');
    } finally {
      if (previous === undefined) delete process.env.W2M_OPERATOR_TOKEN;
      else process.env.W2M_OPERATOR_TOKEN = previous;
      fetchStub.restore();
    }
  });

  it('prefers the configured operatorToken over the environment', async () => {
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: '01JCFG', leases: [], seq: 3 } }]);
    const previous = process.env.W2M_OPERATOR_TOKEN;
    process.env.W2M_OPERATOR_TOKEN = 'opr-from-env';
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        projectDir: nonRepo,
        operatorToken: 'opr-from-config',
      });
      await tools.get('w2m_run').execute(runArgs(), {});
      assert.equal(fetchStub.calls[0].headers.authorization, 'Bearer opr-from-config');
    } finally {
      if (previous === undefined) delete process.env.W2M_OPERATOR_TOKEN;
      else process.env.W2M_OPERATOR_TOKEN = previous;
      fetchStub.restore();
    }
  });

  it('keeps the other four tools on the device token', async () => {
    const fetchStub = installFetch([
      { path: '/v1/devices', body: { devices: [] } },
      { path: '/v1/tasks/01JDEV', body: taskResponse(finalTask()) },
      { path: '/v1/tasks/01JDEV/report', text: '# r', contentType: 'text/markdown' },
    ]);
    try {
      // An operator token IS configured here, and must still not leak into the device endpoints.
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        operatorToken: OPERATOR_TOKEN,
      });
      await tools.get('w2m_devices').execute({}, {});
      await tools.get('w2m_wait').execute({ task_id: '01JDEV', wait_ms: 1000 }, {});
      await tools.get('w2m_report').execute({ task_id: '01JDEV' }, {});

      assert.equal(fetchStub.calls.length, 3);
      for (const call of fetchStub.calls) {
        assert.equal(
          call.headers.authorization,
          `Bearer ${PAIRED_DEVICE.device_token}`,
          `${call.path} must authorise with the device token, not the operator token`,
        );
      }
    } finally {
      fetchStub.restore();
    }
  });

  it('explains OPERATOR_REQUIRED when the relay rejects the dispatch', async () => {
    const fetchStub = installFetch([
      {
        method: 'POST',
        path: '/v1/task',
        status: 401,
        body: { error: { code: 'OPERATOR_REQUIRED', message: 'this is a device token; dispatching needs the operator token' } },
      },
    ]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        projectDir: nonRepo,
        operatorToken: 'opr-wrong',
      });
      await assert.rejects(
        () => tools.get('w2m_run').execute(runArgs(), {}),
        (error) => {
          assert.match(error.message, /OPERATOR_REQUIRED/);
          assert.match(error.message, /operatorToken/);
          assert.match(error.message, /device token cannot dispatch tasks/i);
          assert.match(String(error.hint ?? ''), /operator-token\.txt/);
          return true;
        },
      );
    } finally {
      fetchStub.restore();
    }
  });

  it('reports operator-token state in w2m_status without claiming to have validated it', async () => {
    const fetchStub = installFetch([
      { path: '/healthz', body: { ok: true, protocol_version: 1, operator_token_required: true } },
    ]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        projectDir: nonRepo,
        operatorToken: OPERATOR_TOKEN,
      });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(value.config.operatorToken_configured, true);
      assert.equal(value.config.operatorToken_source, 'config');
      assert.equal(value.config.operatorToken_required_by_relay, true);
      assert.equal(value.config.operatorToken, undefined, 'the token itself must never be echoed');
      assert.ok(value.notes.some((note) => /relay requires an operator token/.test(note)) === false);
    } finally {
      fetchStub.restore();
    }
  });

  it('warns in w2m_status when the relay wants an operator token and none is configured', async () => {
    const fetchStub = installFetch([
      { path: '/healthz', body: { ok: true, protocol_version: 1, operator_token_required: true } },
    ]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), projectDir: nonRepo });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(value.config.operatorToken_configured, false);
      assert.equal(value.config.operatorToken_required_by_relay, true);
      assert.ok(
        value.notes.some((note) => /requires an operator token for POST \/v1\/task and none is configured/.test(note)),
        'the mismatch is the single most useful thing this tool can say',
      );
    } finally {
      fetchStub.restore();
    }
  });

  it('flags a relay that explicitly does not require an operator token', async () => {
    const fetchStub = installFetch([
      { path: '/healthz', body: { ok: true, protocol_version: 1, operator_token_required: false } },
    ]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), projectDir: nonRepo });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(value.config.operatorToken_required_by_relay, false);
      assert.ok(value.notes.some((note) => /does not require an operator token/.test(note)));
    } finally {
      fetchStub.restore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 7. v0.1.2 — sub-path base addresses (§2)
// ---------------------------------------------------------------------------------------------

describe('v0.1.2 sub-path rabbitUrl', () => {
  it('keeps the deployment sub-path on every endpoint', async () => {
    const fetchStub = installFetch([
      { path: '/team-a/w2m/v1/devices', body: { devices: [] } },
      { method: 'POST', path: '/team-a/w2m/v1/task', body: { task_id: '01JSUB', leases: [], seq: 9 } },
      { path: '/team-a/w2m/v1/tasks/01JSUB', body: taskResponse(finalTask({ task_id: '01JSUB' })) },
      { path: '/team-a/w2m/v1/tasks/01JSUB/report', text: '# r', contentType: 'text/markdown' },
      { path: '/team-a/w2m/healthz', body: { ok: true, protocol_version: 1 } },
    ]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({
        rabbitUrl: 'https://w2m.example.com/team-a/w2m',
        stateDir: await makeStateDir(PAIRED_DEVICE),
        projectDir: nonRepo,
        operatorToken: OPERATOR_TOKEN,
      });

      await tools.get('w2m_devices').execute({}, {});
      await tools.get('w2m_run').execute(runArgs(), {});
      await tools.get('w2m_wait').execute({ task_id: '01JSUB', wait_ms: 1000 }, {});
      await tools.get('w2m_report').execute({ task_id: '01JSUB' }, {});
      await tools.get('w2m_status').execute({}, {});

      assert.deepEqual(
        fetchStub.calls.map((call) => call.path),
        [
          '/team-a/w2m/v1/devices',
          '/team-a/w2m/v1/task',
          '/team-a/w2m/v1/tasks/01JSUB',
          '/team-a/w2m/v1/tasks/01JSUB/report',
          '/team-a/w2m/healthz',
        ],
        'new URL(path, base) would have dropped /team-a/w2m and 404ed on all five',
      );
      for (const call of fetchStub.calls) {
        assert.ok(call.url.startsWith('https://w2m.example.com/team-a/w2m/'), call.url);
      }
    } finally {
      fetchStub.restore();
    }
  });

  it('treats a trailing slash on the base as the same base', async () => {
    const fetchStub = installFetch([{ path: '/w2m/v1/devices', body: { devices: [] } }]);
    try {
      const { tools } = await register({
        rabbitUrl: 'https://h.example.com/w2m/',
        stateDir: await makeStateDir(PAIRED_DEVICE),
      });
      await tools.get('w2m_devices').execute({}, {});
      assert.equal(fetchStub.calls[0].path, '/w2m/v1/devices');
      assert.ok(!fetchStub.calls[0].url.includes('/w2m//'), 'a trailing slash must not produce a doubled slash');
    } finally {
      fetchStub.restore();
    }
  });

  it('accepts a Tailscale base and a ported base unchanged', async () => {
    const fetchStub = installFetch([
      { path: '/v1/devices', body: { devices: [] } },
      // A base with a sub-path: the routes are keyed by the real request path, prefix included.
      { path: '/w2m/v1/devices', body: { devices: [] } },
    ]);
    try {
      const dir = await makeStateDir(PAIRED_DEVICE);
      const tailscale = await register({ rabbitUrl: 'http://100.64.0.5:8787', stateDir: dir });
      await tailscale.tools.get('w2m_devices').execute({}, {});
      assert.equal(fetchStub.calls[0].url, 'http://100.64.0.5:8787/v1/devices');

      const ported = await register({ rabbitUrl: 'https://w2m.example.com:8443/w2m', stateDir: dir });
      await ported.tools.get('w2m_devices').execute({}, {});
      assert.equal(fetchStub.calls[1].url, 'https://w2m.example.com:8443/w2m/v1/devices');
    } finally {
      fetchStub.restore();
    }
  });

  it('refuses a base with a query string or fragment, naming rabbitUrl and the reason', async () => {
    await assert.rejects(
      () => register({ rabbitUrl: 'https://w2m.example.com?prefix=/w2m' }),
      (error) => {
        assert.match(error.message, /rabbitUrl/);
        assert.match(error.message, /query/i);
        return true;
      },
    );
    await assert.rejects(
      () => register({ rabbitUrl: 'https://w2m.example.com/w2m#top' }),
      (error) => {
        assert.match(error.message, /rabbitUrl/);
        assert.match(error.message, /fragment/i);
        return true;
      },
    );
  });

  it('refuses a non-http scheme with a message that names the scheme', async () => {
    await assert.rejects(
      () => register({ rabbitUrl: 'ftp://example.invalid' }),
      (error) => {
        assert.match(error.message, /rabbitUrl/);
        assert.match(error.message, /scheme/i);
        return true;
      },
    );
  });

  it('does not use new URL(path, base), which is the defect §2 exists to fix', async () => {
    // Pins the exact failure mode: if the two-argument constructor came back, this expectation
    // would be the thing that breaks.
    const broken = new URL('/v1/devices', 'https://h/w2m').href;
    assert.equal(broken, 'https://h/v1/devices', 'the broken spelling really does drop the prefix');

    const { joinUrl } = await import('../src/agent/url.mjs');
    assert.equal(joinUrl('https://h/w2m', '/v1/devices'), 'https://h/w2m/v1/devices');
  });

  it('agrees with the agent-side url.mjs helper it imports', async () => {
    const agentUrl = await import('../src/agent/url.mjs');
    const bases = ['https://h', 'https://h/', 'https://h/w2m', 'https://h/w2m/', 'http://100.64.0.5:8787', 'https://h:8443/a/b/'];
    const paths = ['/v1/devices', 'v1/devices', '/v1/tasks/01J/report', '/healthz'];
    for (const base of bases) {
      for (const p of paths) {
        const expected = `${agentUrl.resolveBaseUrl(base)}${p.startsWith('/') ? p : `/${p}`}`;
        assert.equal(agentUrl.joinUrl(agentUrl.resolveBaseUrl(base), p), expected);
      }
    }
    // The plugin must reject exactly what the agent rejects.
    for (const bad of ['not-a-url', 'ftp://h/x', 'https://h?q=1', 'https://h#f']) {
      assert.throws(() => agentUrl.resolveBaseUrl(bad), `agent must reject ${bad}`);
      await assert.rejects(() => register({ rabbitUrl: bad }), `plugin must reject ${bad}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 8. v0.1.2 — cross-region diagnostics in w2m_status (§4, §8.2)
// ---------------------------------------------------------------------------------------------

/** A `/healthz` body carrying every v0.1.2 diagnostic field. */
function healthz(overrides = {}) {
  return {
    ok: true,
    protocol_version: 1,
    rabbit_time: '2026-10-07T12:00:00Z',
    uptime_ms: 3_724_000,
    relay_id: 'relay-7f3a91',
    started_at: '2026-10-07T10:58:00Z',
    effective_scheme: 'https',
    base_path: '/w2m',
    operator_token_required: true,
    pair_rate_limit: 5,
    persistence: { enabled: true, dir: '/var/lib/w2m', revived_devices: 2, revived_tasks: 7 },
    ...overrides,
  };
}

describe('v0.1.2 cross-region diagnostics', () => {
  it('surfaces every §4 relay field', async () => {
    // The base carries /w2m, so the probe lands on /w2m/healthz — the route keys on the real path.
    const fetchStub = installFetch([{ path: '/w2m/healthz', body: healthz() }]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({
        rabbitUrl: 'https://w2m.example.com/w2m',
        stateDir: await makeStateDir(PAIRED_DEVICE),
        projectDir: nonRepo,
      });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));

      assert.equal(value.relay.reachable, true);
      assert.equal(value.relay.relay_id, 'relay-7f3a91');
      assert.equal(value.relay.uptime_ms, 3_724_000);
      assert.equal(value.relay.started_at, '2026-10-07T10:58:00Z');
      assert.equal(value.relay.base_path, '/w2m');
      assert.equal(value.relay.effective_scheme, 'https');
      assert.equal(value.relay.operator_token_required, true);
      assert.equal(value.relay.pair_rate_limit, 5);
      assert.equal(value.relay.persistence.revived_devices, 2);
      assert.deepEqual(value.relay.diagnostics_present, [
        'relay_id',
        'uptime_ms',
        'base_path',
        'effective_scheme',
        'operator_token_required',
      ]);
    } finally {
      fetchStub.restore();
    }
  });

  it('lets a reader tell a restarted relay from the same one', async () => {
    const fetchStub = installFetch([
      {
        path: '/healthz',
        responses: [
          { body: healthz({ relay_id: 'relay-7f3a91', uptime_ms: 3_724_000 }) },
          { body: healthz({ relay_id: 'relay-0c11be', uptime_ms: 1_200 }) },
        ],
      },
    ]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), projectDir: nonRepo });

      const before = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      const after = JSON.parse(await tools.get('w2m_status').execute({}, {}));

      assert.equal(before.relay.relay_id, 'relay-7f3a91');
      assert.equal(after.relay.relay_id, 'relay-0c11be');
      assert.notEqual(before.relay.relay_id, after.relay.relay_id);
      assert.ok(after.relay.uptime_ms < before.relay.uptime_ms, 'a restart resets uptime');
      assert.ok(before.notes.some((note) => /record this id/.test(note)), 'the id must come with an instruction');
      assert.ok(before.notes.some((note) => /relay-7f3a91/.test(note)));
    } finally {
      fetchStub.restore();
    }
  });

  it('degrades field by field when a pre-v0.1.2 relay sends none of them', async () => {
    // The v1 healthz body, verbatim: no relay_id, no base_path, nothing from §4.
    const fetchStub = installFetch([
      { path: '/healthz', body: { ok: true, protocol_version: 1, rabbit_time: '2026-10-07T12:00:00Z', uptime_ms: 12 } },
    ]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), projectDir: nonRepo });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));

      assert.equal(value.ok, true, 'a missing diagnostic is not an error');
      assert.equal(value.relay.reachable, true);
      assert.equal(value.relay.uptime_ms, 12, 'the v1 field that does exist is still reported');
      assert.equal(value.relay.relay_id, null);
      assert.equal(value.relay.base_path, null);
      assert.equal(value.relay.effective_scheme, null);
      assert.equal(value.relay.operator_token_required, null, 'unknown is not the same as false');
      // `uptime_ms` is a v1 field, so it is expected to be present even on an old relay; the §4
      // additions are what must be absent.
      assert.deepEqual(
        value.relay.diagnostics_present,
        ['uptime_ms'],
        'only the fields the relay actually sent may be listed',
      );
      assert.ok(
        value.notes.some((note) => /predates v0\.1\.2/.test(note)),
        'the reader must be told the relay is older, not left to infer it from nulls',
      );
    } finally {
      fetchStub.restore();
    }
  });

  it('degrades when the healthz body is empty or not JSON', async () => {
    const fetchStub = installFetch([{ path: '/healthz', status: 200, text: '', contentType: 'text/plain' }]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), projectDir: nonRepo });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(value.relay.reachable, true);
      assert.equal(value.relay.relay_id, null);
      assert.equal(value.relay.operator_token_required, null);
    } finally {
      fetchStub.restore();
    }
  });

  it('still answers when the relay is unreachable, with the diagnostics left unknown', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError('connect ECONNREFUSED');
    };
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), projectDir: nonRepo });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(value.ok, true);
      assert.equal(value.relay.reachable, false);
      assert.equal(value.relay.relay_id, null);
      assert.equal(value.relay.operator_token_required, null);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('reports RTT from a state file the agent published, with last/avg/samples', async () => {
    const dir = await makeStateDir(PAIRED_DEVICE);
    await fs.writeFile(
      path.join(dir, 'agent-state.json'),
      JSON.stringify({ rttMs: { last: 87, avg: 91.5, samples: [70, 95, 110, 87, 95] } }),
      'utf8',
    );
    const fetchStub = installFetch([{ path: '/healthz', body: healthz() }]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: dir, projectDir: nonRepo });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));

      assert.equal(value.rtt.available, true);
      assert.equal(value.rtt.last, 87);
      assert.equal(value.rtt.avg, 91.5);
      assert.deepEqual(value.rtt.samples, [70, 95, 110, 87, 95]);
      assert.equal(value.rtt.source, 'state-file');
      assert.ok(value.notes.some((note) => /round trip to the relay: last 87 ms/.test(note)));
    } finally {
      fetchStub.restore();
    }
  });

  it('finds the state file the CLI agent writes in its default layout', async () => {
    // `stateDir` is documented as the directory holding device.json, while the
    // agent keeps its own state one level below it (`.../xclient/localside`).
    // Without the `localside/` probe the default deployment can never report
    // RTT, and it degrades silently, so this is asserted against the real
    // layout rather than against a file dropped in `stateDir` itself.
    const dir = await makeStateDir(PAIRED_DEVICE);
    const localside = path.join(dir, 'localside');
    await fs.mkdir(localside, { recursive: true });
    await fs.writeFile(
      path.join(localside, 'agent-state.json'),
      JSON.stringify({
        schema_version: 1,
        machine_id: PAIRED_DEVICE.machine_id,
        updated_at: '2026-10-07T12:00:00.000Z',
        connected: true,
        relay_id: 'relay-7f3a91',
        rttMs: { last: 33, avg: 30, samples: [33, 30] },
        reconnect_attempts: 0,
        replay_truncated: false,
      }),
      'utf8',
    );
    const fetchStub = installFetch([{ path: '/healthz', body: healthz() }]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: dir, projectDir: nonRepo });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));

      assert.equal(value.rtt.available, true, JSON.stringify(value.rtt));
      assert.equal(value.rtt.source, 'state-file');
      assert.equal(value.rtt.last, 33);
      assert.equal(value.rtt.avg, 30);
      assert.deepEqual(value.rtt.samples, [33, 30]);
    } finally {
      fetchStub.restore();
    }
  });

  it('normalises the looser RTT shapes an agent might publish', async () => {
    const cases = [
      [{ rttMs: 42 }, { last: 42, avg: 42, samples: [42] }],
      [{ rttMs: [10, 20, 30] }, { last: 30, avg: 20, samples: [10, 20, 30] }],
      [{ rttMs: { lastMs: 55, average: 60 } }, { last: 55, avg: 60, samples: [55] }],
      [{ rtt: { last_ms: 12 } }, { last: 12, avg: 12, samples: [12] }],
    ];
    for (const [published, expected] of cases) {
      const dir = await makeStateDir(PAIRED_DEVICE);
      await fs.writeFile(path.join(dir, 'agent-state.json'), JSON.stringify(published), 'utf8');
      const fetchStub = installFetch([{ path: '/healthz', body: healthz() }]);
      try {
        const nonRepo = await makeNonRepoDir();
        const { tools } = await register({ rabbitUrl: RABBIT, stateDir: dir, projectDir: nonRepo });
        const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
        assert.equal(value.rtt.available, true, JSON.stringify(published));
        assert.equal(value.rtt.last, expected.last, JSON.stringify(published));
        assert.equal(value.rtt.avg, expected.avg, JSON.stringify(published));
        assert.deepEqual(value.rtt.samples, expected.samples, JSON.stringify(published));
      } finally {
        fetchStub.restore();
      }
    }
  });

  it('degrades RTT to unavailable, with a reason, when the agent is not running here', async () => {
    const fetchStub = installFetch([{ path: '/healthz', body: healthz() }]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), projectDir: nonRepo });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));

      assert.equal(value.ok, true, 'a missing RTT must not be an error');
      assert.equal(value.rtt.available, false);
      assert.equal(value.rtt.last, null);
      assert.deepEqual(value.rtt.samples, []);
      assert.match(value.rtt.reason, /no agent round-trip time is available/);
      assert.ok(value.notes.some((note) => /round-trip time unavailable/.test(note)));
      // The relay half is still fully reported: partial knowledge, not a failed call.
      assert.equal(value.relay.relay_id, 'relay-7f3a91');
    } finally {
      fetchStub.restore();
    }
  });

  it('ignores an unparseable agent state file instead of throwing', async () => {
    const dir = await makeStateDir(PAIRED_DEVICE);
    await fs.writeFile(path.join(dir, 'agent-state.json'), '{ this is not json', 'utf8');
    const fetchStub = installFetch([{ path: '/healthz', body: healthz() }]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: dir, projectDir: nonRepo });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(value.ok, true);
      assert.equal(value.rtt.available, false);
    } finally {
      fetchStub.restore();
    }
  });

  it('says which base_path the relay reports next to the rabbitUrl in use', async () => {
    const fetchStub = installFetch([{ path: '/w2m/healthz', body: healthz({ base_path: '/w2m' }) }]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({
        rabbitUrl: 'https://w2m.example.com/w2m',
        stateDir: await makeStateDir(PAIRED_DEVICE),
        projectDir: nonRepo,
      });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(value.relay.base_path, '/w2m');
      assert.ok(value.notes.some((note) => /base_path `\/w2m`/.test(note)));
      assert.ok(value.notes.some((note) => /rabbitUrl` in use is `https:\/\/w2m\.example\.com\/w2m`/.test(note)));
    } finally {
      fetchStub.restore();
    }
  });

  it('does not leak the operator token into w2m_status output', async () => {
    const fetchStub = installFetch([{ path: '/healthz', body: healthz() }]);
    try {
      const nonRepo = await makeNonRepoDir();
      const { tools } = await register({
        rabbitUrl: RABBIT,
        stateDir: await makeStateDir(PAIRED_DEVICE),
        projectDir: nonRepo,
        operatorToken: 'opr-super-secret',
      });
      const raw = await tools.get('w2m_status').execute({}, {});
      assert.ok(!raw.includes('opr-super-secret'), 'the credential must never be echoed back');
      assert.ok(!raw.includes('tok-test-abc'), 'nor the device token');
    } finally {
      fetchStub.restore();
    }
  });
});

describe('w2m_run: the authority level is chosen by name', () => {
  it('accepts a band name where a number used to be required, and the gate follows it', async () => {
    // The user-facing point of the selector: nobody has to remember what 50 means.
    const { tools } = await register({
      rabbitUrl: RABBIT,
      stateDir: await makeStateDir(PAIRED_DEVICE),
      operatorToken: OPERATOR_TOKEN,
      actorAuthorityLevel: 'captain',
    });
    const status = JSON.parse(await tools.get('w2m_status').execute({}, {}));
    assert.equal(status.actor_authority.ok, true);
    assert.equal(status.actor_authority.level, 50);
    assert.equal(status.actor_authority.source, 'name');
    assert.equal(Object.prototype.hasOwnProperty.call(status.actor_authority, 'choices'), false, 'a resolved level needs no menu');

    // captain is the floor `dispatch_writing` needs, so a writing dispatch is ALLOWED rather than escalated.
    // Asserted by the KIND of failure rather than by success: this test installs no fetch stub, so the
    // dispatch reaches the network layer and fails as unreachable. That is exactly the proof wanted -- a
    // refused dispatch would have thrown W2M_PERMISSION_*, and it did not.
    let thrown = null;
    await assert.rejects(
      () => tools.get('w2m_run').execute(runArgs({ write: true, write_scope: ['src/'] }), {}),
      (error) => {
        thrown = error;
        return true;
      },
    );
    assert.doesNotMatch(thrown.message, /W2M_PERMISSION_/, 'the gate refused a dispatch a captain may make');
    assert.match(thrown.message, /W2M_UNREACHABLE/, 'it should have got as far as trying to reach the relay');
  });

  it('reports a level it could not resolve instead of quietly dispatching unenforced', async () => {
    // The failure this prevents: an unreadable level degrading to null, which reads exactly like a machine
    // that never chose one -- and those need opposite responses.
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN, actorAuthorityLevel: 'king' });
    const status = JSON.parse(await tools.get('w2m_status').execute({}, {}));
    assert.equal(status.actor_authority.ok, false);
    assert.equal(status.actor_authority.level, null);
    assert.match(status.actor_authority.detail, /neither a choice nor a level/);
    assert.ok(Array.isArray(status.actor_authority.choices), 'a refusal carries the menu, so it is fixable in place');
    assert.deepEqual(status.actor_authority.choices.map((c) => c.value), ['ordinary', 'captain', 'org_admin', 'system_admin']);
  });

  it('still accepts a plain integer, so a profile patch from an older version keeps loading', async () => {
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN, actorAuthorityLevel: 70 });
    const status = JSON.parse(await tools.get('w2m_status').execute({}, {}));
    assert.equal(status.actor_authority.ok, true);
    assert.equal(status.actor_authority.level, 70);
    assert.equal(status.actor_authority.source, 'number');
    assert.equal(Object.prototype.hasOwnProperty.call(status.actor_authority, 'choices'), false);
  });
});
describe('w2m_run: requiring a level is a policy, not a default', () => {
  it('starts without a level when the policy is off, and says the gate is unenforced', async () => {
    // The behaviour every existing machine has. It has to keep working, or an upgrade becomes an outage.
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
    const status = JSON.parse(await tools.get('w2m_status').execute({}, {}));
    assert.equal(status.actor_authority.ok, false);
    assert.equal(status.actor_authority.required, false);
    assert.match(status.actor_authority.detail, /gate is not enforced/);
  });

  it('refuses to start when the policy is on and no level was chosen', async () => {
    // The gap 1.0.0-ACCEPTANCE.md §3.11 records, closed for a machine that asks for it to be closed.
    const stateDir = await makeStateDir(PAIRED_DEVICE);
    await assert.rejects(
      () => register({ rabbitUrl: RABBIT, stateDir, operatorToken: OPERATOR_TOKEN, requireAuthorityLevel: true }),
      (error) => {
        assert.equal(error.reason_code, 'AUTHORITY_CHOICE_NOT_CHOSEN');
        assert.match(error.message, /is required on this machine/);
        assert.match(error.hint, /ordinary, captain, org_admin, system_admin/, 'the refusal names what would work');
        return true;
      },
    );
  });

  it('refuses to start when the policy is on and the level is unusable', async () => {
    const stateDir = await makeStateDir(PAIRED_DEVICE);
    // The refusal code is on `reason_code`, not in the message: that field is what a consumer branches on,
    // so it is what the test pins. The first version matched the code against the message and failed.
    for (const bad of ['king', 101, 'Captain']) {
      await assert.rejects(
        () => register({ rabbitUrl: RABBIT, stateDir, operatorToken: OPERATOR_TOKEN, requireAuthorityLevel: true, actorAuthorityLevel: bad }),
        (error) => {
          assert.equal(error.reason_code, 'AUTHORITY_CHOICE_UNKNOWN', JSON.stringify(bad));
          assert.match(error.message, /is required on this machine/);
          return true;
        },
      );
    }
  });

  it('starts with the policy on once a level is chosen, and reports that it is required', async () => {
    const { tools } = await register({
      rabbitUrl: RABBIT,
      stateDir: await makeStateDir(PAIRED_DEVICE),
      operatorToken: OPERATOR_TOKEN,
      requireAuthorityLevel: true,
      actorAuthorityLevel: 'captain',
    });
    const status = JSON.parse(await tools.get('w2m_status').execute({}, {}));
    assert.equal(status.actor_authority.ok, true);
    assert.equal(status.actor_authority.level, 50);
    assert.equal(status.actor_authority.required, true, 'a reader can tell this machine opted in');
  });

  it('does not let the environment turn the policy ON by being set to a falsy-looking string', async () => {
    // `W2M_REQUIRE_AUTHORITY_LEVEL=0` means off. A truthiness test would read "0" as set-and-therefore-on,
    // which would refuse to start a machine whose operator explicitly wrote zero.
    const previous = process.env.W2M_REQUIRE_AUTHORITY_LEVEL;
    try {
      process.env.W2M_REQUIRE_AUTHORITY_LEVEL = '0';
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
      const status = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(status.actor_authority.required, false, '"0" must mean off');

      process.env.W2M_REQUIRE_AUTHORITY_LEVEL = 'yes';
      const rejecting = await makeStateDir(PAIRED_DEVICE);
      await assert.rejects(
        () => register({ rabbitUrl: RABBIT, stateDir: rejecting, operatorToken: OPERATOR_TOKEN }),
        (error) => {
          assert.equal(error.reason_code, 'AUTHORITY_CHOICE_NOT_CHOSEN');
          return true;
        },
      );
    } finally {
      if (previous === undefined) delete process.env.W2M_REQUIRE_AUTHORITY_LEVEL;
      else process.env.W2M_REQUIRE_AUTHORITY_LEVEL = previous;
    }
  });
});

describe('w2m_run: the approval gate is on the raise path, not merely available', () => {
  it('refuses a second raise in the window, and does not create the request it refused', async () => {
    // The whole reason for wiring the gate: a mechanism with no caller cannot be told from a finished
    // feature. This drives the real dispatch twice and reads the real queue.
    const { tools } = await register({
      rabbitUrl: RABBIT,
      stateDir: await makeStateDir(PAIRED_DEVICE),
      operatorToken: OPERATOR_TOKEN,
      actorAuthorityLevel: 49,
      approvalRaiseLimitPerMinute: 1,
    });
    const args = runArgs({ write: true, write_scope: ['src/'] });

    // The first raise succeeds and is queued.
    await assert.rejects(() => tools.get('w2m_run').execute(args, {}), /W2M_PERMISSION_NEEDS_APPROVAL/);
    const afterFirst = JSON.parse(await tools.get('w2m_approvals').execute({ action: 'list' }, {}));
    assert.equal(afterFirst.count, 1, 'the first raise reached the queue');

    // The second is refused by the FRONT DOOR, before a request exists.
    let refused = null;
    await assert.rejects(() => tools.get('w2m_run').execute(args, {}), (error) => {
      refused = error;
      assert.match(error.message, /W2M_PERMISSION_APPROVAL_RATE_LIMITED/);
      return true;
    });
    assert.equal(refused.detail.reason_code, 'APPROVAL_RAISE_RATE_LIMITED');
    assert.ok(refused.detail.retry_after_seconds >= 1);
    assert.match(refused.hint, /the queue was not cleared/, 'a refusal must say what was NOT lost');

    const afterSecond = JSON.parse(await tools.get('w2m_approvals').execute({ action: 'list' }, {}));
    assert.equal(afterSecond.count, 1, 'a refused raise must not have created the request it was refused for');
  });

  it('does not meter reading the queue or settling a request', async () => {
    // The asymmetry is the design. A gate that also limited these would pass a flooding test and quietly
    // break the queue -- so it is asserted rather than left to the reader.
    const { tools } = await register({
      rabbitUrl: RABBIT,
      stateDir: await makeStateDir(PAIRED_DEVICE),
      operatorToken: OPERATOR_TOKEN,
      actorAuthorityLevel: 49,
      approvalRaiseLimitPerMinute: 1,
    });
    await assert.rejects(() => tools.get('w2m_run').execute(runArgs({ write: true, write_scope: ['src/'] }), {}), /NEEDS_APPROVAL/);

    // Read it many times, past what any raise budget would allow.
    for (let i = 0; i < 5; i += 1) {
      const listed = JSON.parse(await tools.get('w2m_approvals').execute({ action: 'list', actor_level: 50 }, {}));
      assert.equal(listed.ok, true, `read ${i} was refused, which would limit knowing what is waiting`);
    }
    // And settle it, which must also be unmetered.
    const id = JSON.parse(await tools.get('w2m_approvals').execute({ action: 'list' }, {})).rows[0].approval_id;
    const settled = JSON.parse(
      await tools.get('w2m_approvals').execute({ action: 'approve', approval_id: id, actor_level: 50, actor_id: 'supervisor' }, {}),
    );
    assert.equal(settled.ok, true, settled.detail);
  });
});
describe('w2m_memory: a received block is accepted field by field, by authority', () => {
  /** A CAT7 block as another machine would send it. */
  const received = async () => {
    const { makeBlock } = await import('../src/agent/blocks.mjs');
    return makeBlock({ origin: 'machine-b', subject: 's', body: 'a claim from elsewhere', evidence: 'because', observed_at: '2026-10-15T00:00:00Z', lineage: [] });
  };

  it('refuses to accept anything without a level, rather than taking the block whole', async () => {
    // Accepting whole is the behaviour field-level acceptance exists to replace, and it would look like success.
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
    const value = JSON.parse(await tools.get('w2m_memory').execute({ scope: 'local', accept_block: await received() }, {}));
    assert.equal(value.ok, false);
    assert.equal(value.reason_code, 'MEMORY_BLOCK_NO_AUTHORITY');
    assert.match(value.detail, /no actor to judge/);
  });

  it('accepts the fields an ordinary actor can afford and OMITS the rest rather than nulling them', async () => {
    // v4.8.0's first falsifying test, now reachable through the tool: a refused field is ABSENT.
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
    const value = JSON.parse(await tools.get('w2m_memory').execute({ scope: 'local', accept_block: await received(), actor_authority: 0 }, {}));
    assert.equal(value.recorded, true, value.detail);
    assert.ok(value.accepted_fields.includes('body'));
    assert.equal(value.accepted_fields.includes('evidence'), false, 'evidence costs more than an ordinary actor has');
    assert.equal(Object.prototype.hasOwnProperty.call(value.accepted, 'evidence'), false, 'omitted, not null');
    assert.ok(value.refused_fields.some((r) => r.field === 'evidence'), 'and the refusal is reported');
  });

  it('accepts more when the actor can afford more, from the same block', async () => {
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
    const value = JSON.parse(await tools.get('w2m_memory').execute({ scope: 'local', accept_block: await received(), actor_authority: 70 }, {}));
    assert.equal(value.recorded, true, value.detail);
    assert.ok(value.accepted_fields.includes('evidence'), 'a higher level reaches the dearer field');
  });

  it('refuses a block whose own hash does not match, before judging any field', async () => {
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
    const tampered = { ...(await received()), body: 'changed after the hash was taken' };
    const value = JSON.parse(await tools.get('w2m_memory').execute({ scope: 'local', accept_block: tampered, actor_authority: 100 }, {}));
    assert.equal(value.ok, false);
    assert.equal(value.verified, false);
  });

  it('refuses a block naming an ancestor the caller cannot produce, rather than re-rooting it', async () => {
    // Re-rooting turns an unverifiable history into no history, which reads as a fresh independent assertion.
    const { makeBlock } = await import('../src/agent/blocks.mjs');
    const parent = makeBlock({ origin: 'machine-b', subject: 's', body: 'parent', observed_at: '2026-10-15T00:00:00Z', lineage: [] });
    const child = makeBlock({ origin: 'machine-b', subject: 's', body: 'child', observed_at: '2026-10-15T00:00:00Z', lineage: [parent] });
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
    const refused = JSON.parse(await tools.get('w2m_memory').execute({ scope: 'local', accept_block: child, actor_authority: 100, lineage: [] }, {}));
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /re-rooting/);
    const accepted = JSON.parse(await tools.get('w2m_memory').execute({ scope: 'local', accept_block: child, actor_authority: 100, lineage: [parent.hash] }, {}));
    assert.equal(accepted.recorded, true, accepted.detail);
  });

  it('writes the block as a row in the same memory file, with its refusals kept', async () => {
    // One store, one rotation, one answer to 'what does this machine remember'.
    const stateDir = await makeStateDir(PAIRED_DEVICE);
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir, operatorToken: OPERATOR_TOKEN });
    const value = JSON.parse(await tools.get('w2m_memory').execute({ scope: 'local', accept_block: await received(), actor_authority: 0 }, {}));
    assert.equal(value.recorded, true, value.detail);
    const read = JSON.parse(await tools.get('w2m_memory').execute({ scope: 'local' }, {}));
    const row = read.records.find((r) => r.kind === 'block');
    assert.ok(row, 'the block is a row in the local memory');
    assert.equal(row.block_hash, value.block_hash);
    assert.deepEqual(row.accepted_fields, value.accepted_fields);
    assert.ok(row.refused_fields.length > 0, 'what it declined to believe is stored too');
  });
});
describe('w2m_approvals: the tool an approver reaches for', () => {
  it('takes a real dispatch from a refusal, through the queue, to a status that announces it', async () => {
    // The whole point of putting the count in `w2m_status`: a fleet blocked on approval looks exactly like an
    // idle fleet unless the blocked state reports itself. This drives the real sequence across three tools
    // rather than asserting on `statusNotes` in isolation.
    const { tools } = await register({
      rabbitUrl: RABBIT,
      stateDir: await makeStateDir(PAIRED_DEVICE),
      operatorToken: OPERATOR_TOKEN,
      // An ordinary actor: one band below the captain that `dispatch_writing` requires.
      actorAuthorityLevel: 49,
    });

    // Before anything is asked, the status must not describe an empty queue as though it were a measurement.
    const before = JSON.parse(await tools.get('w2m_status').execute({}, {}));
    assert.equal(before.approvals.constructed, false);
    assert.equal(before.approvals.pending, null);
    assert.match(before.approvals.detail, /not the same as an empty queue/);
    assert.equal(
      before.notes.some((n) => /WAITING FOR AN APPROVER/.test(n)),
      false,
      'a machine nobody has asked anything of must not claim to be blocked',
    );

    // The writing dispatch is refused -- and refused WITH the id of a queued request.
    let raised = null;
    await assert.rejects(
      () => tools.get('w2m_run').execute(runArgs({ write: true, write_scope: ['src/'] }), {}),
      (error) => {
        raised = error;
        assert.match(error.message, /W2M_PERMISSION_NEEDS_APPROVAL/);
        return true;
      },
    );
    // The payload lives in `detail`: `W2MError` accepts only code, message, hint, detail, cause and
    // reason_code, so a top-level `approval_id` would be dropped silently.
    assert.equal(raised.detail.request.capability, 'dispatch_writing');
    assert.equal(raised.detail.request.subject_level, 49, 'the subject level is recorded at raise time');
    assert.ok(
      typeof raised.detail.approval_id === 'string' && raised.detail.approval_id.length > 0,
      'the refusal must name the queued request, or a caller cannot tell what it is waiting for',
    );

    // …and the status now says the fleet is stopped, without anyone asking about approvals specifically.
    const after = JSON.parse(await tools.get('w2m_status').execute({}, {}));
    assert.equal(after.approvals.constructed, true);
    assert.equal(after.approvals.pending, 1);
    assert.equal(after.approvals.overdue, 0);
    const blocking = after.notes.filter((n) => /WAITING FOR AN APPROVER/.test(n));
    assert.equal(blocking.length, 1, 'exactly one note, and it is the actionable one');
    assert.match(blocking[0], /will not run until one answers/);
    assert.match(blocking[0], /w2m_approvals/);

    // The queue the note points at holds the request, and it is the same id.
    //
    // NOTE THE `actor_id`. The request recorded its subject as this machine's name, because nothing else was
    // supplied at dispatch time; an approver who defaults to that same name IS the subject, and the index
    // refuses a self-approval by name. That is correct behaviour and a real consequence of the defaults, so
    // this names a different approver rather than working around the refusal.
    const asSelf = JSON.parse(await tools.get('w2m_approvals').execute({ action: 'list', actor_level: 50 }, {}));
    assert.equal(asSelf.rows[0].may_act, false, 'the default approver is the requester, and the index knows it');
    assert.equal(asSelf.rows[0].why_not.reason_code, 'APPROVAL_SELF_APPROVAL');

    const listed = JSON.parse(await tools.get('w2m_approvals').execute({ action: 'list', actor_level: 50, actor_id: 'supervisor' }, {}));
    assert.equal(listed.count, 1);
    assert.equal(listed.rows[0].approval_id, raised.detail.approval_id);
    assert.equal(listed.rows[0].may_act, true, 'a captain is the level this escalation was addressed to');

    // Settling it clears the signal, so a reader is not left with a warning about work already answered.
    const settled = JSON.parse(
      await tools
        .get('w2m_approvals')
        .execute({ action: 'approve', approval_id: raised.detail.approval_id, actor_level: 50, actor_id: 'supervisor' }, {}),
    );
    assert.equal(settled.ok, true, settled.detail);
    const cleared = JSON.parse(await tools.get('w2m_status').execute({}, {}));
    assert.equal(cleared.approvals.pending, 0);
    assert.equal(cleared.notes.some((n) => /WAITING FOR AN APPROVER/.test(n)), false);
  });

  it('lists an empty queue rather than failing on it', async () => {
    // A queue with nothing waiting is the normal state, not an error. The tool has to say so without making
    // it indistinguishable from "the queue is broken".
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
    const value = JSON.parse(await tools.get('w2m_approvals').execute({ action: 'list' }, {}));
    assert.equal(value.ok, true);
    assert.equal(value.count, 0);
    assert.deepEqual(value.rows, []);
  });

  it('says the level is unknown rather than assuming one when actor_level is absent', async () => {
    // The distinction the whole queue rests on. Defaulting to a high level would let anyone approve;
    // defaulting to a low one would report work as unanswerable.
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
    const value = JSON.parse(await tools.get('w2m_approvals').execute({}, {}));
    assert.equal(value.level_known, false);
    assert.equal(value.as.level, null);
    assert.match(value.note, /no actor_level was supplied/);
    assert.match(value.note, /not known/);
  });

  it('records the level and the id when they are supplied', async () => {
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
    const value = JSON.parse(await tools.get('w2m_approvals').execute({ actor_level: 50, actor_id: 'supervisor' }, {}));
    assert.equal(value.level_known, true);
    assert.equal(value.as.level, 50);
    assert.equal(value.as.id, 'supervisor');
  });

  it('refuses to settle without an id, and says where to find one', async () => {
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
    await assert.rejects(
      () => tools.get('w2m_approvals').execute({ action: 'approve', actor_level: 70 }, {}),
      /W2M_APPROVAL_ID/,
    );
  });

  it('refuses to settle without a level, rather than attributing a decision to nobody', async () => {
    // A decision whose actor level was never supplied cannot be audited, so it is refused here rather than
    // handed to the index to guess at.
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
    for (const bad of [undefined, 'captain', 50.5, -1, 101]) {
      await assert.rejects(
        () => tools.get('w2m_approvals').execute({ action: 'approve', approval_id: 'AP-1', actor_level: bad }, {}),
        /W2M_APPROVAL_LEVEL/,
        `actor_level ${JSON.stringify(bad)} should be refused`,
      );
    }
  });

  it('answers for an id nobody raised, naming the reason rather than throwing', async () => {
    // Settling an unknown request is a normal mistake, not a crash: the caller gets a value back.
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
    const value = JSON.parse(await tools.get('w2m_approvals').execute({ action: 'approve', approval_id: 'AP-NOPE', actor_level: 70 }, {}));
    assert.equal(value.ok, false);
    assert.equal(value.settled, null);
    assert.ok(typeof value.reason_code === 'string' && value.reason_code.length > 0, 'the refusal must be named');
    assert.match(value.note, /still waiting|unchanged/);
  });

  it('labels a list as a read and a settle as a write', async () => {
    // The card is what a host renders; calling a queue inspection a write would misrepresent it.
    const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
    const tool = tools.get('w2m_approvals');
    assert.equal(tool.presentCall({ action: 'list' }).kind, 'read');
    assert.equal(tool.presentCall({}).kind, 'read', 'the default action is a list');
    assert.equal(tool.presentCall({ action: 'approve' }).kind, 'write');
    assert.equal(tool.presentCall({ action: 'reject' }).kind, 'write');
  });
});

/**
 * v1.1.16: a machine waiting to be admitted is a request waiting for a human, so it appears in `w2m_approvals` -- but
 * it is NOT a permission escalation and the two live in different stores. These five assertions are that seam.
 */
describe('w2m_approvals and fleet admission', () => {
  const RELAY_NOW = '2026-10-17T12:00:00.000Z';
  const REQUESTED_AT = Date.parse(RELAY_NOW) - 4_000;
  const pendingRow = {
    request_id: 'adm-0001', machine_id: 'new-pc-1', machine_name: 'new-pc',
    requested_at_ms: REQUESTED_AT, state: 'pending',
  };
  const pendingBody = { protocol_version: 1, rabbit_time: RELAY_NOW, pending: [pendingRow] };

  async function withAdmission(routes) {
    const { tools } = await register({ rabbitUrl: 'http://relay.test', stateDir: await makeStateDir(PAIRED_DEVICE) });
    const stub = installFetch(routes);
    return { tools, stub };
  }

  it('fleet_admission rows appear in the approval list with the fields a person needs', async () => {
    const { tools, stub } = await withAdmission([
      { method: 'GET', path: '/v1/fleet/admission/pending', status: 200, body: pendingBody },
    ]);
    const out = JSON.parse(await tools.get('w2m_approvals').execute({ action: 'list' }));
    const urls = stub.calls.map((c) => c.method + ' ' + c.url);
    stub.restore();
    assert.ok(urls.some((u) => u.includes('/v1/fleet/admission/pending')), 'the list never asked the relay: ' + JSON.stringify(urls));
    const row = out.rows.find((r) => r.kind === 'fleet_admission');
    assert.ok(row, 'the pending admission is missing from the list');
    assert.equal(row.approval_id, 'adm-0001');
    assert.equal(row.machine_name, 'new-pc');
    assert.equal(row.requested_at_ms, REQUESTED_AT);
    assert.equal(out.count, out.rows.length);
  });

  it('the countdown comes from the relay clock, not this machine clock', async () => {
    const { tools, stub } = await withAdmission([
      { method: 'GET', path: '/v1/fleet/admission/pending', status: 200, body: pendingBody },
    ]);
    const out = JSON.parse(await tools.get('w2m_approvals').execute({ action: 'list' }));
    stub.restore();
    assert.equal(out.rows.find((r) => r.kind === 'fleet_admission').countdown_ms, 6_000);
  });

  it('an unreachable relay leaves the local queue readable', async () => {
    const { tools, stub } = await withAdmission([
      { method: 'GET', path: '/v1/fleet/admission/pending', status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } },
    ]);
    const out = JSON.parse(await tools.get('w2m_approvals').execute({ action: 'list' }));
    stub.restore();
    assert.equal(out.ok, true);
    assert.equal(out.rows.filter((r) => r.kind === 'fleet_admission').length, 0);
  });

  it('settling an admission id calls the relay, not the local index', async () => {
    const { tools, stub } = await withAdmission([
      { method: 'POST', path: '/v1/fleet/admission/adm-0001/decide', status: 200, body: { protocol_version: 1, request_id: 'adm-0001', state: 'approved' } },
    ]);
    const out = JSON.parse(await tools.get('w2m_approvals').execute({ action: 'approve', approval_id: 'adm-0001', actor_id: 'operator', actor_level: 50 }));
    const decided = stub.calls.find((c) => c.url.includes('/v1/fleet/admission/adm-0001/decide'));
    stub.restore();
    assert.ok(decided, 'the decision never reached the relay');
    assert.equal(decided.body.decision, 'approve');
    assert.equal(out.ok, true);
    assert.equal(out.kind, 'fleet_admission');
  });

  it('a decision that arrived after the ten-second window is reported, not thrown', async () => {
    const { tools, stub } = await withAdmission([
      { method: 'POST', path: '/v1/fleet/admission/adm-0001/decide', status: 400, body: { error: { code: 'ALREADY_DECIDED', message: 'already decided' } } },
    ]);
    const out = JSON.parse(await tools.get('w2m_approvals').execute({ action: 'reject', approval_id: 'adm-0001', actor_id: 'operator', actor_level: 50 }));
    stub.restore();
    assert.equal(out.ok, false);
    assert.equal(out.reason_code, 'ALREADY_DECIDED');
  });
});

/**
 * v1.1.18: the channel report is opt-in, and a failed lookup is reported as "nothing on that channel" rather than as a
 * crash or as a substituted stable version.
 *
 * The first assertion is the one that protects every other call: a plain w2m_update status is LOCAL, and a version that
 * quietly reached GitHub on every status call would slow the tool down and break it behind a proxy.
 */
describe('w2m_update channels (v1.1.18)', () => {
  it('the three channels are opt-in: a plain status reaches no network at all', async () => {
    const { tools } = await register({});
    const calls = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('status must not reach the network'); };
    try {
      const out = JSON.parse(await tools.get('w2m_update').execute({ action: 'status' }));
      assert.equal(out.ok, true);
      assert.ok(out.update, 'the local description must still be there');
      assert.equal(out.channels, undefined, 'channels require the explicit flag');
      assert.deepEqual(calls, [], 'a default status call must not touch the network');
    } finally { globalThis.fetch = previous; }
  });

  it('with the flag, an unreachable GitHub yields an explicit empty channel instead of a substituted version', async () => {
    const { tools } = await register({});
    const previous = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' });
    try {
      const out = JSON.parse(await tools.get('w2m_update').execute({ action: 'status', channels: true }));
      assert.ok(out.channels, 'the structure must be there even when both lookups fail');
      assert.equal(out.channels.stable.available, null);
      assert.equal(out.channels.beta.available, null);
      assert.equal(out.latest.channel, null, 'no channel may be invented when neither source answered');
      assert.equal(out.sources.stable.ok, false, 'the failure is carried, not hidden');
      assert.ok(/RATE_LIMITED|HTTP_/.test(out.sources.stable.code ?? ''), 'a 403 is named, not flattened');
    } finally { globalThis.fetch = previous; }
  });
});

// ---------------------------------------------------------------------------------------------
// w2m_memory append: the shared-document write (v1.2.2)
// ---------------------------------------------------------------------------------------------

describe('w2m_memory append: compare-and-swap on the shared document', () => {
  it('PUTs the records to the memory doc and returns the new revision', async () => {
    const fetchStub = installFetch([
      { method: 'PUT', path: '/v1/fleet/memory/fleet', body: { protocol_version: 1, ok: true, revision: 3, appended: 1 } },
    ]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
      const out = JSON.parse(await tools.get('w2m_memory').execute({ action: 'append', records: ['a fact'], if_revision: 2 }));
      assert.equal(out.ok, true);
      assert.equal(out.revision, 3);
      assert.equal(out.appended, 1);
      const call = fetchStub.calls.at(-1);
      assert.equal(call.method, 'PUT');
      assert.equal(call.path, '/v1/fleet/memory/fleet');
      assert.deepEqual(call.body, { records: ['a fact'], if_revision: 2 });
    } finally { fetchStub.restore(); }
  });

  it('returns a 409 as a value and does not retry it', async () => {
    const fetchStub = installFetch([
      { method: 'PUT', path: '/v1/fleet/memory/fleet', status: 409, body: { ok: false, error: { code: 'REVISION_CONFLICT' }, detail: { revision: 5, behind_by: 2 } } },
    ]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
      const out = JSON.parse(await tools.get('w2m_memory').execute({ action: 'append', records: ['late'], if_revision: 3 }));
      assert.equal(out.ok, false);
      assert.equal(out.code, 'REVISION_CONFLICT');
      assert.equal(out.detail.revision, 5);
      assert.equal(fetchStub.calls.filter((call) => call.path === '/v1/fleet/memory/fleet').length, 1, 'a conflict must not be retried');
    } finally { fetchStub.restore(); }
  });

  it('refuses an empty records list before touching the relay', async () => {
    const fetchStub = installFetch([]);
    try {
      const { tools } = await register({ rabbitUrl: RABBIT, stateDir: await makeStateDir(PAIRED_DEVICE), operatorToken: OPERATOR_TOKEN });
      await assert.rejects(() => tools.get('w2m_memory').execute({ action: 'append', records: [] }), /W2M_MEMORY_APPEND/);
      assert.equal(fetchStub.calls.length, 0, 'nothing may reach the relay');
    } finally { fetchStub.restore(); }
  });
});

