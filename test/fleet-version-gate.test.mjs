/**
 * v3.5.0 fleet governance: the minimum plugin version, its comparator, the pre-dispatch gate and
 * the drift block the devices surface reports.
 *
 * ## What this suite is protecting
 *
 * A mixed-version fleet is the normal state for a few hours after every release, and the failure
 * mode is quiet: an old machine runs a command written against a newer protocol and reports a
 * plausible wrong answer. The gate exists so that failure is a *named refusal before dispatch*
 * instead of a divergence after it. So the assertions here are about the two things an operator can
 * act on:
 *
 *  - the refusal names every affected machine, its version and the minimum, with an exact code;
 *  - the override (`allowOutdated: true`) is explicit, audited, and lists exactly what it let
 *    through — and read-only tools are never refused, because you have to be able to look at the
 *    fleet you are about to fix.
 *
 * The gate activates on a build that is at least the minimum (see `version-gate.mjs`): this source
 * tree carries version 3.4.5 while the release is prepared, so the tool-level cases set
 * `W2M_PLUGIN_VERSION` — the same override the updater uses — to make the build under test a 3.5.0
 * dispatcher. The pure cases pass the running version in directly.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import * as plugin from '../src/plugin/tools.mjs';
import { buildUiState, createSelectionStore } from '../src/plugin/fleet-target.mjs';
import {
  MIN_SUPPORTED_PLUGIN_VERSION,
  VERSION_GATE_CODES,
  comparePluginVersions,
  evaluateVersionGate,
  isPluginVersionAtLeast,
  isVersionGateActive,
  parsePluginVersion,
  summarizeVersionDashboard,
} from '../src/plugin/version-gate.mjs';

// Isolate the secure token file: this suite owns its operator-token input (config).
process.env.W2M_OPERATOR_TOKEN_FILE = path.join(os.tmpdir(), 'w2m-version-gate-test-no-token-' + process.pid);

const RABBIT = 'http://relay.test';
const OPERATOR_TOKEN = 'opr-version-gate-test';

const cleanup = [];
after(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway directory, removed after the suite. */
function tempDir(prefix = 'w2m-version-gate-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

/** A paired-device state directory. */
function makeStateDir(device) {
  const dir = tempDir('w2m-vg-state-');
  writeFileSync(path.join(dir, 'device.json'), JSON.stringify(device, null, 2), 'utf8');
  return dir;
}

/** A non-repo project directory, so `resolveGitAnchors` degrades to null anchors without spawning git on a repo. */
function makeProjectDir() {
  return tempDir('w2m-vg-project-');
}

const PAIRED_DEVICE = {
  machine_id: 'local-machine',
  machine_name: 'win-desktop',
  device_token: 'tok-test-abc',
  rabbit_url: RABBIT,
};

/** The headless Cordis-shaped context `w2m_devices` and `w2m_run` need. */
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
    logger: { warn: (message) => warnings.push(String(message)), info: () => {}, debug: () => {} },
    inject(_names, callback) {
      // This host provides no Connection service: the callback's read stays undefined and no route
      // is mounted. That is the headless composition, and it is deliberate here.
      callback(ctx);
    },
  };
  return { ctx, tools, warnings };
}

/** Register the plugin against a fake relay. */
async function register(overrides = {}) {
  const { ctx, tools, warnings } = makeCtx();
  plugin.resetDefineToolCacheForTests();
  await plugin.apply(ctx, {
    rabbitUrl: RABBIT,
    stateDir: makeStateDir(PAIRED_DEVICE),
    projectDir: makeProjectDir(),
    machineName: 'win-desktop',
    operatorToken: OPERATOR_TOKEN,
    p2pMode: 'relay',
    autoStartAgent: false,
    ...overrides,
  });
  return { tools, warnings };
}

/**
 * Run `body` with the build reporting `version` through the updater's version override.
 *
 * `null` clears the override, which is what an unpacked source checkout looks like: the compiled-in
 * placeholder resolves to "unknown", and the gate stays inactive.
 */
async function withRunningVersion(version, body) {
  const previous = process.env.W2M_PLUGIN_VERSION;
  if (version === null) delete process.env.W2M_PLUGIN_VERSION;
  else process.env.W2M_PLUGIN_VERSION = version;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.W2M_PLUGIN_VERSION;
    else process.env.W2M_PLUGIN_VERSION = previous;
  }
}

/**
 * Install a routing `fetch` for one test.
 *
 * @param {Array<{method?: string, path: string, status?: number, body?: unknown}>} routes
 * @returns {{calls: Array<{method: string, path: string, headers: object, body: string|null}>, restore: () => void}}
 */
function installFetch(routes) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const method = String(init.method ?? 'GET').toUpperCase();
    const parsed = new URL(url);
    calls.push({ method, path: parsed.pathname, headers: init.headers ?? {}, body: init.body ?? null });
    const route = routes.find(
      (candidate) => candidate.path === parsed.pathname && String(candidate.method ?? 'GET').toUpperCase() === method,
    );
    if (!route) throw new Error(`test route missing: ${method} ${parsed.pathname}`);
    const status = route.status ?? 200;
    const text = route.text ?? JSON.stringify(route.body ?? {});
    return new Response(text, { status, headers: { 'content-type': route.contentType ?? 'application/json' } });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = previousFetch;
    },
  };
}

/** A relay roster entry: online, with the version an agent advertises in `caps.plugin_version`. */
function rosterMachine(machineId, version, overrides = {}) {
  return {
    machine_id: machineId,
    machine_name: machineId,
    online: true,
    caps: version === undefined ? {} : { plugin_version: version },
    ...overrides,
  };
}

const CURRENT = rosterMachine('m-current', '3.5.0');
const OLD = rosterMachine('m-old', '3.4.9');
const UNKNOWN = rosterMachine('m-silent', undefined);

/** A `/v1/task` response; the leases are empty, which no assertion in this suite depends on. */
const TASK_OK = { method: 'POST', path: '/v1/task', body: { task_id: 'task-vg-1', seq: 7, leases: [] } };

const RUN_ARGS = { command_argv: ['node', '--version'] };

/** Dispatch against a roster and return the parsed result or the thrown error. */
async function dispatchWithRoster(roster, { args = RUN_ARGS, buildVersion = '3.5.0' } = {}) {
  const fetchStub = installFetch([
    { path: '/v1/devices', body: { protocol_version: 1, devices: roster } },
    TASK_OK,
  ]);
  try {
    return await withRunningVersion(buildVersion, async () => {
      const { tools, warnings } = await register();
      try {
        const value = JSON.parse(await tools.get('w2m_run').execute(args, {}));
        return { ok: true, value, warnings, calls: fetchStub.calls };
      } catch (error) {
        return { ok: false, error, warnings, calls: fetchStub.calls };
      }
    });
  } finally {
    fetchStub.restore();
  }
}

// ---------------------------------------------------------------------------------------------
// 1. The comparator
// ---------------------------------------------------------------------------------------------

describe('version gate: the comparator', () => {
  it('parses x.y.z and normalizes a leading v and numeric identifiers', () => {
    const parsed = parsePluginVersion('v3.5.0');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.normalized, '3.5.0');
    assert.deepEqual([parsed.major, parsed.minor, parsed.patch], [3, 5, 0]);
    assert.equal(parsed.prerelease, null);
  });

  it('accepts a prerelease and ignores build metadata for ordering', () => {
    const beta = parsePluginVersion('3.5.0-beta.1');
    assert.equal(beta.ok, true);
    assert.deepEqual(beta.prerelease, ['beta', '1']);
    assert.equal(comparePluginVersions('3.5.0+build.9', '3.5.0'), 0);
  });

  it('handles invalid input as unreadable instead of guessing an order', () => {
    for (const bad of ['3.5', 'not-a-version', '', '   ', '3.5.0-', '3.x.0', 42, null, undefined, {}]) {
      assert.equal(parsePluginVersion(bad).ok, false, `${JSON.stringify(bad)} must not parse`);
      assert.equal(comparePluginVersions(bad, '3.5.0'), null);
      assert.equal(isPluginVersionAtLeast(bad, '3.5.0'), null);
    }
  });

  it('orders patch, minor and major numerically', () => {
    assert.equal(comparePluginVersions('3.4.9', '3.5.0'), -1);
    assert.equal(comparePluginVersions('3.5.0', '3.5.0'), 0);
    assert.equal(comparePluginVersions('3.5.1', '3.5.0'), 1);
    assert.equal(comparePluginVersions('3.10.0', '3.9.9'), 1);
    assert.equal(comparePluginVersions('10.0.0', '9.99.99'), 1);
  });

  it('sorts a prerelease below its release, and order prereleases by semver rule', () => {
    assert.equal(comparePluginVersions('3.5.0-beta.1', '3.5.0'), -1);
    assert.equal(comparePluginVersions('3.5.0', '3.5.0-beta.1'), 1);
    assert.equal(comparePluginVersions('3.5.0-beta.1', '3.5.0-beta.2'), -1);
    assert.equal(comparePluginVersions('3.5.0-alpha', '3.5.0-beta'), -1);
    // Numeric identifiers compare numerically, not lexically: beta.2 < beta.10.
    assert.equal(comparePluginVersions('3.5.0-beta.2', '3.5.0-beta.10'), -1);
  });

  it('activates only on a build at or above the minimum', () => {
    assert.equal(isVersionGateActive('3.4.9'), false);
    assert.equal(isVersionGateActive('3.5.0-beta.1'), false);
    assert.equal(isVersionGateActive('3.5.0'), true);
    assert.equal(isVersionGateActive('3.6.1'), true);
    assert.equal(isVersionGateActive(null), false, 'a source checkout has no version and cannot enforce one');
    assert.equal(isVersionGateActive('nonsense'), false);
    assert.equal(MIN_SUPPORTED_PLUGIN_VERSION, '3.5.0');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The decision (pure)
// ---------------------------------------------------------------------------------------------

describe('version gate: the decision', () => {
  const machines = (...versions) => versions.map((version, index) => ({
    machine_id: `m-${index + 1}`,
    name: `machine-${index + 1}`,
    version,
  }));

  it('passes a fleet at or above the minimum', () => {
    const decision = evaluateVersionGate({ machines: machines('3.5.0', '3.6.2'), runningVersion: '3.5.0' });
    assert.equal(decision.ok, true);
    assert.equal(decision.active, true);
    assert.equal(decision.checked, 2);
    assert.deepEqual(decision.outdated, []);
    assert.deepEqual(decision.unknown, []);
  });

  it('refuses with the overall code and per-machine reasons, naming version and minimum', () => {
    const decision = evaluateVersionGate({ machines: machines('3.5.0', '3.4.9'), runningVersion: '3.5.0' });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason_code, VERSION_GATE_CODES.MACHINE_VERSION_UNSUPPORTED);
    assert.equal(decision.detail.supported_min, MIN_SUPPORTED_PLUGIN_VERSION);
    assert.deepEqual(decision.detail.outdated, [{ machine_id: 'm-2', version: '3.4.9', name: 'machine-2' }]);
    assert.equal(decision.detail.machines.length, 1);
    assert.equal(decision.detail.machines[0].reason_code, VERSION_GATE_CODES.MACHINE_VERSION_OUTDATED);
    assert.match(decision.detail.summary, /m-2/u);
    assert.match(decision.detail.summary, /3\.4\.9/u);
    assert.match(decision.detail.summary, /3\.5\.0/u);
  });

  it('treats an unreadable version as unknown and refuses it, with the unreadable reason code', () => {
    const decision = evaluateVersionGate({ machines: machines(undefined, 'nonsense'), runningVersion: '3.5.0' });
    assert.equal(decision.ok, false);
    assert.deepEqual(decision.unknown.map((machine) => machine.machine_id), ['m-1', 'm-2']);
    assert.deepEqual(decision.detail.machines.map((machine) => machine.reason_code), [
      VERSION_GATE_CODES.MACHINE_VERSION_UNKNOWN,
      VERSION_GATE_CODES.MACHINE_VERSION_UNKNOWN,
    ]);
    assert.equal(decision.detail.machines[0].version, null);
  });

  it('lets allowOutdated through and reports exactly what it allowed, with per-machine reasons', () => {
    const decision = evaluateVersionGate({ machines: machines('3.4.9', undefined, '3.5.1'), runningVersion: '3.5.0', allowOutdated: true });
    assert.equal(decision.ok, true);
    assert.equal(decision.allow_outdated, true);
    assert.equal(decision.outdated_allowed.length, 2);
    assert.deepEqual(decision.outdated_allowed.map((machine) => machine.machine_id), ['m-1', 'm-2']);
    assert.deepEqual(decision.outdated_allowed.map((machine) => machine.reason_code), [
      VERSION_GATE_CODES.MACHINE_VERSION_OUTDATED,
      VERSION_GATE_CODES.MACHINE_VERSION_UNKNOWN,
    ]);
  });

  it('refuses nothing when the running build predates the minimum, but still reports the drift', () => {
    const decision = evaluateVersionGate({ machines: machines('3.4.5'), runningVersion: '3.4.5' });
    assert.equal(decision.ok, true);
    assert.equal(decision.active, false);
    assert.equal(decision.outdated.length, 1, 'the drift is real even though this build cannot refuse for it');
  });

  it('grades only the machines a narrowed dispatch would use', () => {
    const fleet = [
      { machine_id: 'm-target', name: 'target', version: '3.5.0' },
      { machine_id: 'm-old-bystander', name: 'bystander', version: '3.4.0' },
    ];
    const decision = evaluateVersionGate({ machines: fleet, targetIds: ['m-target'], runningVersion: '3.5.0' });
    assert.equal(decision.ok, true, 'an old machine that will not run the command does not block it');
    assert.equal(decision.checked, 1);

    const narrowedAtOld = evaluateVersionGate({ machines: fleet, targetIds: ['m-old-bystander'], runningVersion: '3.5.0' });
    assert.equal(narrowedAtOld.ok, false, 'but it is refused on the dispatch that would use it');
    assert.deepEqual(narrowedAtOld.detail.machines.map((machine) => machine.machine_id), ['m-old-bystander']);
  });

  it('passes an empty roster: the relay, not this gate, reports that nothing is online', () => {
    const decision = evaluateVersionGate({ machines: [], runningVersion: '3.5.0' });
    assert.equal(decision.ok, true);
    assert.equal(decision.checked, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The dashboard block (pure)
// ---------------------------------------------------------------------------------------------

describe('version gate: the drift dashboard block', () => {
  it('counts every readable version and names the machines behind the two bad halves', () => {
    const block = summarizeVersionDashboard([
      CURRENT,
      rosterMachine('m-current-2', '3.5.0'),
      OLD,
      UNKNOWN,
      rosterMachine('m-new', '3.6.1'),
    ]);
    assert.equal(block.supported_min, '3.5.0');
    assert.deepEqual(block.distribution, { '3.6.1': 1, '3.5.0': 2, '3.4.9': 1 });
    assert.deepEqual(block.outdated, [{ machine_id: 'm-old', version: '3.4.9' }]);
    assert.deepEqual(block.unknown, [{ machine_id: 'm-silent' }]);
    assert.equal(block.all_current, false);
  });

  it('flips all_current exactly when every machine is at or above the minimum', () => {
    assert.equal(summarizeVersionDashboard([CURRENT, rosterMachine('m-b', '3.6.0')]).all_current, true);
    assert.equal(summarizeVersionDashboard([CURRENT, OLD]).all_current, false);
    assert.equal(summarizeVersionDashboard([CURRENT, UNKNOWN]).all_current, false);
    assert.equal(summarizeVersionDashboard([]).all_current, true, 'vacuously: an empty roster is not a stale one (see the route, which checks `fleet.ok`)');
  });

  it('does not crash on a foreign or missing roster', () => {
    for (const input of [null, undefined, 'nope', [null, 42], [{ machine_id: 'm', caps: null }]]) {
      const block = summarizeVersionDashboard(input);
      assert.equal(block.all_current, typeof input === 'string' || input === null || input === undefined ? true : block.all_current);
      assert.equal(typeof block.distribution, 'object');
      assert.ok(Array.isArray(block.outdated));
      assert.ok(Array.isArray(block.unknown));
    }
    const anonymous = summarizeVersionDashboard([{ caps: { plugin_version: '3.4.0' } }]);
    assert.deepEqual(anonymous.outdated, [], 'a machine with no id cannot be named; it is not reported as current either');
    assert.equal(anonymous.distribution['3.4.0'], 1);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The dispatch path
// ---------------------------------------------------------------------------------------------

describe('version gate: w2m_run refuses by name', () => {
  it('refuses a dispatch to a below-minimum machine, names it, and sends nothing', async () => {
    const outcome = await dispatchWithRoster([OLD]);
    assert.equal(outcome.ok, false, 'the dispatch must be refused');
    assert.equal(outcome.error.code, VERSION_GATE_CODES.MACHINE_VERSION_UNSUPPORTED);
    assert.match(outcome.error.message, /MACHINE_VERSION_UNSUPPORTED/u);
    assert.match(outcome.error.message, /m-old/u);
    assert.match(outcome.error.message, /3\.4\.9/u);
    assert.match(outcome.error.message, /3\.5\.0/u, 'the refusal names the minimum');
    assert.equal(outcome.error.detail.supported_min, MIN_SUPPORTED_PLUGIN_VERSION);
    assert.equal(outcome.error.detail.machines.length, 1);
    assert.equal(outcome.error.detail.machines[0].machine_id, 'm-old');
    assert.equal(outcome.error.detail.machines[0].version, '3.4.9');
    assert.equal(outcome.calls.filter((call) => call.path === '/v1/task').length, 0, 'nothing was dispatched');
    assert.equal(outcome.calls.filter((call) => call.path === '/v1/devices').length, 1);
  });

  it('refuses a mixed fleet and names only the machine behind the minimum', async () => {
    const outcome = await dispatchWithRoster([CURRENT, OLD]);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, VERSION_GATE_CODES.MACHINE_VERSION_UNSUPPORTED);
    assert.deepEqual(outcome.error.detail.machines.map((machine) => machine.machine_id), ['m-old']);
    assert.match(outcome.error.message, /m-old/u);
    assert.doesNotMatch(outcome.error.message, /m-current/u);
    assert.equal(outcome.calls.filter((call) => call.path === '/v1/task').length, 0);
  });

  it('refuses a machine whose version cannot be read, with the unknown reason code', async () => {
    const outcome = await dispatchWithRoster([UNKNOWN]);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, VERSION_GATE_CODES.MACHINE_VERSION_UNSUPPORTED);
    assert.equal(outcome.error.detail.machines[0].reason_code, VERSION_GATE_CODES.MACHINE_VERSION_UNKNOWN);
    assert.match(outcome.error.message, /m-silent/u);
    assert.match(outcome.error.message, /unreadable/u);
    assert.equal(outcome.calls.filter((call) => call.path === '/v1/task').length, 0);
  });

  it('dispatches normally when every target is at or above the minimum, and reports what it checked', async () => {
    const outcome = await dispatchWithRoster([CURRENT]);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.error ?? {}));
    assert.equal(outcome.value.ok, true);
    assert.equal(outcome.value.version_gate.active, true);
    assert.equal(outcome.value.version_gate.checked, 1);
    assert.equal(outcome.value.version_gate.supported_min, MIN_SUPPORTED_PLUGIN_VERSION);
    assert.equal(outcome.value.outdated_allowed, undefined, 'no override was needed, so no allowance is reported');
    assert.equal(outcome.calls.filter((call) => call.path === '/v1/task').length, 1);
  });

  it('allowOutdated:true dispatches, lists the machines it waved through, and audits the override', async () => {
    const outcome = await dispatchWithRoster([CURRENT, OLD], { args: { ...RUN_ARGS, allowOutdated: true } });
    assert.equal(outcome.ok, true, JSON.stringify(outcome.error ?? {}));
    assert.equal(outcome.value.ok, true);
    assert.equal(outcome.value.outdated_allowed.length, 1);
    assert.equal(outcome.value.outdated_allowed[0].machine_id, 'm-old');
    assert.equal(outcome.value.outdated_allowed[0].version, '3.4.9');
    assert.equal(outcome.value.outdated_allowed[0].reason_code, VERSION_GATE_CODES.MACHINE_VERSION_OUTDATED);
    assert.equal(outcome.value.version_gate.allow_outdated, true);
    assert.equal(outcome.value.version_gate.audit.event, 'dispatch.outdated_allowed');
    assert.equal(outcome.value.version_gate.audit.supported_min, MIN_SUPPORTED_PLUGIN_VERSION);
    assert.deepEqual(outcome.value.version_gate.audit.machines.map((machine) => machine.machine_id), ['m-old']);
    assert.ok(
      outcome.warnings.some((line) => /MACHINE_VERSION_UNSUPPORTED override allowed/u.test(line) && /m-old/u.test(line)),
      'the override must leave a searchable line in the host log, not only in the result',
    );
    assert.equal(outcome.calls.filter((call) => call.path === '/v1/task').length, 1, 'the dispatch really happened');
  });

  it('grades only the named executor under broadcast, so an old bystander does not block a current one', async () => {
    const roster = [CURRENT, OLD];
    const currentExecutor = await dispatchWithRoster(roster, {
      args: { ...RUN_ARGS, mode: 'broadcast', executor_machine_id: 'm-current' },
    });
    assert.equal(currentExecutor.ok, true, JSON.stringify(currentExecutor.error ?? {}));

    const oldExecutor = await dispatchWithRoster(roster, {
      args: { ...RUN_ARGS, mode: 'broadcast', executor_machine_id: 'm-old' },
    });
    assert.equal(oldExecutor.ok, false);
    assert.equal(oldExecutor.error.code, VERSION_GATE_CODES.MACHINE_VERSION_UNSUPPORTED);
    assert.match(oldExecutor.error.message, /m-old/u);
    assert.doesNotMatch(oldExecutor.error.message, /m-current/u);
  });

  it('stays inert on a build that predates the minimum, so a 3.4.x dispatcher is not refused by its own gate', async () => {
    // The source checkout reports no version, so even a below-minimum target dispatches: a build that
    // predates the minimum cannot enforce it, and pretending otherwise would break rollbacks.
    const outcome = await dispatchWithRoster([OLD], { buildVersion: null });
    assert.equal(outcome.ok, true, JSON.stringify(outcome.error ?? {}));
    assert.equal(outcome.value.version_gate, undefined);
    assert.equal(outcome.calls.filter((call) => call.path === '/v1/task').length, 1);
  });

  it('reports an unreadable roster as unchecked instead of pretending every machine is current', async () => {
    // No `/v1/devices` route at all: the roster read fails, and the dispatch proceeds on the relay's
    // authority -- but the answer says the gate could not check rather than claiming all clear.
    const fetchStub = installFetch([TASK_OK]);
    try {
      const value = await withRunningVersion('3.5.0', async () => {
        const { tools } = await register();
        return JSON.parse(await tools.get('w2m_run').execute(RUN_ARGS, {}));
      });
      assert.equal(value.ok, true);
      assert.equal(value.version_gate.active, true);
      assert.equal(value.version_gate.checked, false);
      assert.equal(value.version_gate.reason_code, 'VERSION_GATE_UNVERIFIABLE');
      assert.equal(fetchStub.calls.filter((call) => call.path === '/v1/task').length, 1);
    } finally {
      fetchStub.restore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Read-only surfaces are never gated
// ---------------------------------------------------------------------------------------------

describe('version gate: read-only surfaces still answer', () => {
  it('w2m_devices lists a below-minimum fleet and adds the drift block, instead of refusing', async () => {
    const fetchStub = installFetch([
      { path: '/v1/devices', body: { protocol_version: 1, devices: [CURRENT, OLD, UNKNOWN] } },
    ]);
    try {
      const outcome = await withRunningVersion('3.5.0', async () => {
        const { tools } = await register();
        return JSON.parse(await tools.get('w2m_devices').execute({}, {}));
      });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.count, 3);
      assert.equal(outcome.versions.supported_min, MIN_SUPPORTED_PLUGIN_VERSION);
      assert.deepEqual(outcome.versions.distribution, { '3.5.0': 1, '3.4.9': 1 });
      assert.deepEqual(outcome.versions.outdated, [{ machine_id: 'm-old', version: '3.4.9' }]);
      assert.deepEqual(outcome.versions.unknown, [{ machine_id: 'm-silent' }]);
      assert.equal(outcome.versions.all_current, false);
      // Additive: the pre-existing drift fields are still there, unchanged.
      assert.equal(outcome.version_drift.versions['3.5.0'], 1);
      assert.equal(outcome.version_drift.versions['3.4.9'], 1);
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_devices reports all_current true for a fleet at or above the minimum', async () => {
    const fetchStub = installFetch([
      { path: '/v1/devices', body: { protocol_version: 1, devices: [CURRENT, rosterMachine('m-b', '3.6.2')] } },
    ]);
    try {
      const value = await withRunningVersion('3.5.0', async () => {
        const { tools } = await register();
        return JSON.parse(await tools.get('w2m_devices').execute({}, {}));
      });
      assert.equal(value.versions.all_current, true);
      assert.deepEqual(value.versions.outdated, []);
      assert.deepEqual(value.versions.unknown, []);
    } finally {
      fetchStub.restore();
    }
  });

  it('w2m_stats is never refused by the version gate', async () => {
    const fetchStub = installFetch([
      { path: '/healthz', body: { ok: true, protocol_version: 1, devices: 2, tasks: 4 } },
      { path: '/v1/devices', body: { protocol_version: 1, devices: [CURRENT, OLD] } },
    ]);
    try {
      const value = await withRunningVersion('3.5.0', async () => {
        const { tools } = await register();
        return JSON.parse(await tools.get('w2m_stats').execute({}, {}));
      });
      assert.equal(value.ok, true);
      assert.equal(value.counts.online, 2, 'online is counted from the relay register, not filtered by version');
      assert.equal(value.machines.length, 2);
    } finally {
      fetchStub.restore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 6. The target-route snapshot (the other read-only surface that serves the device list)
// ---------------------------------------------------------------------------------------------

describe('version gate: the target-route snapshot', () => {
  const fleetWith = (records, overrides = {}) => ({
    ok: true,
    error: null,
    machines: [],
    records,
    online: records.length,
    total: records.length,
    excluded: 0,
    rabbit_time: null,
    ...overrides,
  });

  it('adds the versions block to buildUiState and leaves the existing fields unchanged', () => {
    const snapshot = buildUiState({
      store: createSelectionStore(),
      sessionId: 'session-vg',
      fleet: fleetWith([CURRENT, OLD, UNKNOWN]),
      localMachineName: 'win-desktop',
    });
    assert.equal(snapshot.versions.supported_min, MIN_SUPPORTED_PLUGIN_VERSION);
    assert.deepEqual(snapshot.versions.outdated, [{ machine_id: 'm-old', version: '3.4.9' }]);
    assert.deepEqual(snapshot.versions.unknown, [{ machine_id: 'm-silent' }]);
    assert.equal(snapshot.versions.all_current, false);
    // Additive only: the fields the composer already reads are untouched.
    assert.equal(snapshot.session_id, 'session-vg');
    assert.equal(snapshot.fleet.ok, true);
    assert.equal(snapshot.fleet.online, 3);
    assert.deepEqual(snapshot.machines, []);
    assert.equal(snapshot.host.local_machine_name, 'win-desktop');
  });

  it('reports all_current:false when the fleet could not be read', () => {
    const snapshot = buildUiState({
      store: createSelectionStore(),
      sessionId: 'session-vg',
      fleet: fleetWith([], { ok: false, error: 'relay down', online: 0, total: 0 }),
      localMachineName: 'win-desktop',
    });
    assert.equal(snapshot.versions.all_current, false, 'an empty distribution from a failed read is not "all current"');
    assert.deepEqual(snapshot.versions.outdated, []);
  });
});
