/**
 * Unit tests for the composer's target-machine control, host half (`src/plugin/fleet-target.mjs`)
 * and its dispatch wiring in `src/plugin/tools.mjs`.
 *
 * # What these tests cover
 *
 * Three claims, and they are the three that would make the feature a lie if they broke:
 *
 *   1. **The roster is the relay's**, with the relay's liveness per machine — not a list this
 *      package keeps. `GET /v1/devices` is the only source, and a machine the relay does not call
 *      reachable is reported as unselectable rather than hidden or assumed good.
 *   2. **The selection is per session and survives** what a re-render does to the browser: it lives
 *      in the host process, keyed by session id, and a read after a write returns it.
 *   3. **The selection reaches the dispatch path, and only when the caller named nothing.**
 *      `w2m_run` sends `target_machines: [id]` for replicate/split/pipeline and
 *      `executor_machine_id: id` for broadcast, an explicit `executor_machine_id` wins, and a
 *      dispatch belonging to another session is untouched.
 *
 * The relay calls are stubbed at `globalThis.fetch` (the same harness shape `test/tools.test.mjs`
 * uses), so these tests assert the exact bytes this plugin would put on the wire.
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
import { after, beforeEach, describe, it } from 'node:test';

import * as plugin from '../src/plugin/tools.mjs';
import {
  MAX_SELECTIONS,
  MAX_SESSION_ID_LENGTH,
  NO_SESSION,
  TARGET_REFUSAL,
  TARGET_ROUTE_PATH,
  buildUiState,
  createLocalIdentity,
  createSelectionStore,
  defaultSelectionStore,
  describeTargetMachine,
  dispatchSelectionFields,
  foldRelayItems,
  isSelectableDevice,
  parseSelectionWrite,
  probeRelays,
  readFleet,
  registerTargetRoutes,
  relayUrlsFromConfig,
  sessionKeyFor,
} from '../src/plugin/fleet-target.mjs';

const RABBIT = 'http://127.0.0.1:8787';
const OPERATOR_TOKEN = 'opr-test-xyz';
const LOCAL_MACHINE_ID = 'e94f1ce8-124d-43ee-872a-7dcc7d8b1ef6';
const REMOTE_MACHINE_ID = '71f0dd07-e957-4889-bf82-319a0d6b434a';

const PAIRED_DEVICE = {
  machine_id: LOCAL_MACHINE_ID,
  machine_name: 'win-desktop',
  device_token: 'dev-test-abc',
  rabbit_url: RABBIT,
};

/** The fleet `GET /v1/devices` answers with: two live machines and one expired lease. */
const DEVICES_BODY = {
  protocol_version: 1,
  rabbit_time: '2026-10-11T04:16:52Z',
  devices: [
    {
      machine_id: LOCAL_MACHINE_ID,
      machine_name: 'win-desktop',
      os: 'windows',
      state: 'online',
      last_seen: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      machine_id: REMOTE_MACHINE_ID,
      machine_name: 'macmini',
      os: 'macos',
      state: 'online',
      last_seen: new Date(Date.now() - 120_000).toISOString(),
    },
    {
      machine_id: '1c14d7d2-d9e2-43dd-a7e5-eda98f4864bc',
      machine_name: 'jp-shared',
      os: 'linux',
      state: 'expired',
      last_seen: new Date(Date.now() - 180_000).toISOString(),
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

const cleanup = [];
after(async () => {
  for (const entry of cleanup) await fs.rm(entry, { recursive: true, force: true }).catch(() => {});
});

/** Every test starts from "nothing is selected": the store is process-global by design. */
beforeEach(() => {
  defaultSelectionStore.clearAll();
});

/**
 * Install a routing `fetch` for one test, recording every call.
 *
 * @param {Array<{method?: string, path: string, status?: number, body?: unknown, text?: string,
 *                contentType?: string}>} routes
 * @returns {{calls: Array<{method: string, url: string, path: string, headers: object, body: unknown}>, restore: () => void}}
 */
function installFetch(routes) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const method = String(init.method ?? 'GET').toUpperCase();
    const parsed = new URL(url);
    calls.push({
      method,
      url,
      path: parsed.pathname,
      search: parsed.search,
      headers: init.headers ?? {},
      body: init.body === undefined || init.body === null ? null : JSON.parse(String(init.body)),
    });
    const route = routes.find(
      (candidate) => candidate.path === parsed.pathname && String(candidate.method ?? 'GET').toUpperCase() === method,
    );
    if (!route) throw new Error(`test route missing: ${method} ${parsed.pathname}`);
    const status = route.status ?? 200;
    const text = route.text ?? JSON.stringify(route.body ?? {});
    return new Response(text, {
      status,
      headers: { 'content-type': route.contentType ?? 'application/json' },
    });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = previousFetch;
    },
  };
}

/** A throwaway state directory holding `device.json`. */
async function makeStateDir(device) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'w2m-target-test-'));
  cleanup.push(dir);
  if (device) await fs.writeFile(path.join(dir, 'device.json'), JSON.stringify(device, null, 2), 'utf8');
  return dir;
}

/** A non-repo directory: `w2m_run` still dispatches, it just has no anchors to send. */
async function makeNonRepoDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'w2m-target-nonrepo-'));
  cleanup.push(dir);
  return dir;
}

/**
 * A fake `ctx` carrying the services this plugin injects, plus an optional fetch-route registry.
 *
 * `inject` is part of the fake on purpose: it is the *only* way this plugin may reach the optional
 * `connection` service. A plain `ctx.connection` read inside a real Cordis fiber throws
 * (`cannot get property "connection" without inject`) whether or not the service exists, which is
 * exactly how v0.5.4 took the whole entry down — so a fake that handed `connection` over as a plain
 * property would be modelling a host that cannot exist. The real `Context` runs the callback once the
 * named service is available; the fake runs it synchronously against itself, which is the same thing
 * for the "already provided" case these tests cover.
 *
 * @param {{withRoutes?: boolean}} [options]
 * @returns {{ctx: object, tools: Map<string, object>, routes: object[], warnings: string[]}}
 */
function makeCtx(options = {}) {
  const tools = new Map();
  const warnings = [];
  const routes = [];
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
  if (options.withRoutes === true) {
    ctx.connection = { fetch: { register: (route) => routes.push(route) } };
  }
  return { ctx, tools, routes, warnings };
}

/**
 * Register the plugin and hand back its tools.
 *
 * `p2pMode: 'relay'` keeps the direct path out of the call list, exactly as `test/tools.test.mjs`
 * does and for the same reason: a node that starts fires its own announcement through the same
 * helper every other call uses.
 *
 * @param {object} [config]
 * @param {{withRoutes?: boolean}} [options]
 * @returns {Promise<{tools: Map<string, object>, routes: object[], warnings: string[]}>}
 */
async function register(config = {}, options = {}) {
  const { ctx, tools, routes, warnings } = makeCtx(options);
  await applyPinned(ctx, { p2pMode: 'relay', ...config });
  return { tools, routes, warnings };
}

/** The plugin config a dispatch test needs, pointed at a throwaway state and project directory. */
async function runConfig(overrides = {}) {
  return {
    rabbitUrl: RABBIT,
    stateDir: await makeStateDir(PAIRED_DEVICE),
    projectDir: await makeNonRepoDir(),
    machineName: 'win-desktop',
    operatorToken: OPERATOR_TOKEN,
    ...overrides,
  };
}

/** Valid `w2m_run` arguments, minus the fields a test varies. */
function runArgs(overrides = {}) {
  return { command_argv: ['node', '--test'], ...overrides };
}

/** A tool execution context carrying a session, as DSH provides one. */
function execFor(sessionId) {
  return sessionId === undefined ? {} : { agent: { session: { id: sessionId } } };
}

// ---------------------------------------------------------------------------------------------
// The roster is the relay's
// ---------------------------------------------------------------------------------------------

describe('fleet-target: the roster comes from the relay', () => {
  it('reads GET /v1/devices with the device token and describes every machine the relay lists', async () => {
    const fetchStub = installFetch([{ path: '/v1/devices', body: DEVICES_BODY }]);
    try {
      const fleet = await readFleet({
        rabbitUrl: RABBIT,
        token: 'dev-test-abc',
        localMachineId: LOCAL_MACHINE_ID,
        request: async (options) => {
          const url = new URL(`${options.rabbitUrl}${options.pathname}`);
          for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value));
          const response = await globalThis.fetch(url, {
            method: options.method ?? 'GET',
            headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
          });
          return { ok: response.ok, status: response.status, json: await response.json() };
        },
      });
      assert.equal(fetchStub.calls.length, 1, 'one read, not one per machine');
      assert.equal(fetchStub.calls[0].method, 'GET');
      assert.equal(fetchStub.calls[0].path, '/v1/devices');
      assert.equal(fleet.total, 3);
      assert.deepEqual(fleet.machines.map((machine) => machine.name), ['win-desktop', 'macmini', 'jp-shared']);
    } finally {
      fetchStub.restore();
    }
  });

  it('marks liveness per machine and marks this machine as local', async () => {
    const fleet = await readFleet({
      rabbitUrl: RABBIT,
      token: 'dev-test-abc',
      localMachineId: LOCAL_MACHINE_ID,
      request: async (options) => {
        assert.equal(options.pathname, '/v1/devices');
        assert.equal(options.token, 'dev-test-abc');
        return { ok: true, status: 200, json: DEVICES_BODY };
      },
    });
    assert.equal(fleet.ok, true);
    assert.equal(fleet.total, 3);
    assert.equal(fleet.online, 2);
    assert.equal(fleet.excluded, 1, 'the expired lease is counted, not hidden');
    assert.equal(fleet.rabbit_time, '2026-10-11T04:16:52Z');
    const local = fleet.machines.find((machine) => machine.machine_id === LOCAL_MACHINE_ID);
    assert.equal(local.local, true, 'this machine is the one whose composer this is');
    assert.equal(local.online, true);
    const expired = fleet.machines.find((machine) => machine.machine_id === '1c14d7d2-d9e2-43dd-a7e5-eda98f4864bc');
    assert.equal(expired.online, false, 'an expired lease is not selectable');
    assert.equal(expired.state, 'expired');
  });

  it('reports a relay refusal as a value instead of throwing', async () => {
    const fleet = await readFleet({
      rabbitUrl: RABBIT,
      request: async () => ({ ok: false, status: 401, error: { code: 'UNAUTHORIZED', message: 'no device token' } }),
    });
    assert.equal(fleet.ok, false);
    assert.equal(fleet.status, 401);
    assert.match(fleet.error, /HTTP 401 \(UNAUTHORIZED: no device token\)/);
    assert.deepEqual(fleet.machines, []);
  });

  it('treats an unknown liveness field as NOT online', () => {
    assert.equal(isSelectableDevice({ state: 'online' }), true);
    assert.equal(isSelectableDevice({ state: 'expired' }), false);
    assert.equal(isSelectableDevice({ online: false, state: 'online' }), false, 'the boolean measurement wins');
    assert.equal(isSelectableDevice({}), false, '"unknown" is not "reachable"');
    assert.equal(isSelectableDevice(null), false);
  });

  it('names an unnamed machine by its id rather than inventing a label', () => {
    const described = describeTargetMachine({ machine_id: 'abc', state: 'online' }, null);
    assert.equal(described.name, null);
    assert.equal(described.machine_id, 'abc');
    assert.equal(described.local, false);
  });
});

// ---------------------------------------------------------------------------------------------
// The selection store
// ---------------------------------------------------------------------------------------------

describe('fleet-target: the selection is per session and survives', () => {
  it('keeps one target per session and reports a session that has none', () => {
    const store = createSelectionStore({ now: () => 1000 });
    assert.equal(store.get('s1'), null);
    store.set('s1', { machine_id: 'm1', machine_name: 'macmini' }, { selectedBy: 'win-desktop' });
    store.set('s2', { machine_id: 'm2', machine_name: 'jp-shared' }, {});
    assert.deepEqual(store.get('s1'), {
      machine_id: 'm1',
      machine_name: 'macmini',
      selected_at: 1000,
      selected_by: 'win-desktop',
    });
    assert.equal(store.get('s2').machine_id, 'm2');
    assert.equal(store.get('s1').machine_id, 'm1', 'one session cannot overwrite another');
  });

  it('replaces rather than accumulates when a session picks again', () => {
    const store = createSelectionStore({ now: () => 1 });
    store.set('s1', { machine_id: 'm1' }, {});
    store.set('s1', { machine_id: 'm2' }, {});
    assert.equal(store.size, 1);
    assert.equal(store.get('s1').machine_id, 'm2');
  });

  it('clears a selection, which is what puts the whole fleet back in play', () => {
    const store = createSelectionStore();
    store.set('s1', { machine_id: 'm1' }, {});
    assert.equal(store.clear('s1'), true);
    assert.equal(store.get('s1'), null);
    assert.equal(store.clear('s1'), false, 'clearing twice is not an error, it is just nothing left to do');
  });

  it('evicts the least recently chosen session, not an arbitrary one', () => {
    const store = createSelectionStore({ now: () => 5, max: 2 });
    store.set('a', { machine_id: 'm1' }, {});
    store.set('b', { machine_id: 'm2' }, {});
    store.set('a', { machine_id: 'm3' }, {});
    store.set('c', { machine_id: 'm4' }, {});
    assert.deepEqual(store.list().map((entry) => entry.session_id), ['a', 'c']);
    assert.equal(store.get('b'), null, 'b was the least recently chosen');
  });

  it('has a default cap so a long-lived process cannot grow one entry per session forever', () => {
    assert.ok(MAX_SELECTIONS >= 64, 'a session count imagined as "tens" must fit');
    const store = createSelectionStore();
    for (let i = 0; i < MAX_SELECTIONS + 5; i += 1) store.set(`s${i}`, { machine_id: `m${i}` }, {});
    assert.equal(store.size, MAX_SELECTIONS);
    assert.equal(store.get('s0'), null);
    assert.equal(store.get(`s${MAX_SELECTIONS + 4}`).machine_id, `m${MAX_SELECTIONS + 4}`);
  });

  it('resolves a session id from the tool execution context, with one named bucket for "none"', () => {
    assert.equal(sessionKeyFor({ agent: { session: { id: 'sess-1' } } }), 'sess-1');
    assert.equal(sessionKeyFor({ agent: { session: { header: { id: 'sess-2' } } } }), 'sess-2');
    assert.equal(sessionKeyFor({}), NO_SESSION);
    assert.equal(sessionKeyFor(undefined), NO_SESSION);
    assert.equal(sessionKeyFor({ agent: { session: { id: '' } } }), NO_SESSION);
  });

  it('memoizes a resolved identity but retries an unresolved one', async () => {
    let reads = 0;
    const identity = createLocalIdentity(async () => {
      reads += 1;
      return reads === 1
        ? { machine_id: null, machine_name: null, machineName: 'win-desktop' }
        : { machine_id: LOCAL_MACHINE_ID, machine_name: 'win-desktop' };
    });
    const first = await identity();
    assert.equal(first.machine_id, null);
    assert.equal(first.machine_name, 'win-desktop', 'the configured name stands in until pairing');
    const second = await identity();
    assert.equal(second.machine_id, LOCAL_MACHINE_ID, 'pairing during the process lifetime must take effect');
    await identity();
    assert.equal(reads, 2, 'a resolved identity is read once');
  });
});

// ---------------------------------------------------------------------------------------------
// Mapping a selection onto the dispatch
// ---------------------------------------------------------------------------------------------

describe('fleet-target: a selection becomes the dispatch fields the relay already accepts', () => {
  const selection = { machine_id: 'm1', machine_name: 'macmini' };

  it('narrows the targets for the modes that fan out', () => {
    for (const mode of ['replicate', 'split', 'pipeline']) {
      const routed = dispatchSelectionFields(selection, mode);
      assert.deepEqual(routed.fields, { target_machines: ['m1'] }, mode);
      assert.equal(routed.applied_as, 'target_machines');
    }
  });

  it('names the executor for broadcast, and does not remove the observers', () => {
    const routed = dispatchSelectionFields(selection, 'broadcast');
    assert.deepEqual(routed.fields, { executor_machine_id: 'm1' });
    assert.equal(routed.applied_as, 'executor_machine_id');
    assert.equal('target_machines' in routed.fields, false, 'observers stay in the task');
  });

  it('sends nothing at all when there is no selection', () => {
    assert.deepEqual(dispatchSelectionFields(null, 'replicate'), { fields: {}, applied_as: null });
    assert.deepEqual(dispatchSelectionFields(undefined, 'broadcast'), { fields: {}, applied_as: null });
    assert.deepEqual(dispatchSelectionFields({ machine_id: '' }, 'split'), { fields: {}, applied_as: null });
  });
});

// ---------------------------------------------------------------------------------------------
// The browser-facing route
// ---------------------------------------------------------------------------------------------

describe('fleet-target: the browser route', () => {
  /** Build a route pair mounted on a stand-in registry, with a stubbed relay. */
  function mount(options = {}) {
    const store = createSelectionStore({ now: () => 4242 });
    const registered = [];
    const deps = {
      cfg: () => ({ rabbitUrl: RABBIT, machineName: 'win-desktop' }),
      store,
      localIdentity: async () => ({ machine_id: LOCAL_MACHINE_ID, machine_name: 'win-desktop' }),
      request: options.request ?? (async () => ({ ok: true, status: 200, json: DEVICES_BODY })),
      resolveToken: async () => 'dev-test-abc',
    };
    const ctx = {
      ...(options.noRegistry === true ? {} : { connection: { fetch: { register: (route) => registered.push(route) } } }),
      // Same cordis-shaped injection as `makeCtx`: the route is mounted from the callback.
      inject(_names, callback) {
        callback(ctx);
      },
    };
    const status = registerTargetRoutes(ctx, deps);
    return { store, registered, status, route: registered[0] ?? null };
  }

  const url = (search = '') => `http://127.0.0.1:19387${TARGET_ROUTE_PATH}${search}`;

  it('mounts ONE route object for both verbs, because the registry is keyed by path', () => {
    const { registered, status, route } = mount();
    assert.equal(status.mounted, true);
    assert.equal(registered.length, 1, 'a second registration for the same path would be refused by the host');
    assert.deepEqual(route.methods, ['GET', 'POST']);
    assert.equal(route.path, TARGET_ROUTE_PATH);
    assert.equal(route.requestBody, 'buffered');
  });

  it('answers a GET with the fleet, the selection and the local machine name', async () => {
    const { store, route } = mount();
    store.set('sess-1', { machine_id: REMOTE_MACHINE_ID, machine_name: 'macmini' }, {});
    const response = await route.fetch(new Request(url('?session_id=sess-1')));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const state = await response.json();
    assert.equal(state.session_id, 'sess-1');
    assert.equal(state.selected.machine_id, REMOTE_MACHINE_ID);
    assert.equal(state.selected.online, true);
    assert.equal(state.selected.stale, false);
    assert.equal(state.fleet.ok, true);
    assert.equal(state.fleet.online, 2);
    assert.equal(state.machines.length, 3);
    assert.equal(state.host.local_machine_name, 'win-desktop');
    assert.equal(state.host.detail_unavailable, false);
  });

  it('refuses a GET with no session id rather than answering for nobody', async () => {
    const { route } = mount();
    const response = await route.fetch(new Request(url()));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /session_id/);
  });

  it('accepts a selection for a machine the relay calls online, and echoes the new state', async () => {
    const { store, route } = mount();
    const response = await route.fetch(new Request(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', machine_id: REMOTE_MACHINE_ID, machine_name: 'macmini' }),
    }));
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.selected.machine_id, REMOTE_MACHINE_ID);
    assert.equal(store.get('sess-1').machine_name, 'macmini');
    assert.equal(store.get('sess-1').selected_by, 'win-desktop');
  });

  it('refuses a selection for a machine whose lease is not live', async () => {
    const { store, route } = mount();
    const response = await route.fetch(new Request(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', machine_id: '1c14d7d2-d9e2-43dd-a7e5-eda98f4864bc' }),
    }));
    assert.equal(response.status, 409);
    const refused = await response.json();
    assert.match(refused.error, /listed as expired/);
    assert.equal(refused.reason_code, TARGET_REFUSAL.MACHINE_OFFLINE);
    assert.match(refused.detail, /wait for its next heartbeat|select another machine/);
    assert.equal(store.get('sess-1'), null, 'a refused selection must not half-apply');
  });

  /* ------------------------------------------------------------------ */
  /* v0.5.9 LOW-7/LOW-8/LOW-9 — what the route refuses, by name          */
  /* ------------------------------------------------------------------ */

  it('refuses a machine id the relay does not list at all (LOW-7)', async () => {
    // The comment above the check always said "only accepted for a machine the relay currently lists
    // as online"; the code refused only a machine that existed *and* was offline, so `machine === null`
    // fell through to `store.set` and `{"machine_id":"NOT-A-MACHINE"}` was answered with a 200. The
    // impact was bounded -- dispatch re-validates -- but a control whose promise is "you cannot select
    // what the fleet cannot run" cannot accept an id the fleet has never heard of.
    const { store, route } = mount();
    const response = await route.fetch(new Request(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', machine_id: 'NOT-A-MACHINE' }),
    }));
    assert.equal(response.status, 409, 'the same status as the offline refusal: both are "not selectable"');
    const refused = await response.json();
    assert.equal(refused.reason_code, TARGET_REFUSAL.MACHINE_UNKNOWN);
    assert.match(refused.error, /NOT-A-MACHINE is not a machine this relay lists/);
    assert.match(refused.detail, /pick a machine from the roster/);
    assert.equal(store.get('sess-1'), null, 'an unknown id must not be stored');

    // The other direction, in the same breath: a machine the relay *does* list as online is still
    // accepted, so the refusal above is about this id and not about the route having stopped working.
    const accepted = await route.fetch(new Request(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', machine_id: REMOTE_MACHINE_ID, machine_name: 'macmini' }),
    }));
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).selected.machine_id, REMOTE_MACHINE_ID);
    assert.equal(store.get('sess-1').machine_id, REMOTE_MACHINE_ID);
  });

  it('refuses every verb that is not exactly GET or POST (LOW-8)', async () => {
    // Defence in depth: the registration declares `methods: ['GET','POST']`, so the host should never
    // route these at all. The handler used to write for *any* non-GET verb, which would turn a
    // registration mistake into "DELETE clears the selection".
    for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD']) {
      const { store, route } = mount();
      const response = await route.fetch(new Request(url(), {
        method,
        headers: { 'content-type': 'application/json' },
        // HEAD and DELETE are not given a body: `Request` itself refuses that combination for HEAD.
        body: method === 'DELETE' || method === 'HEAD'
          ? undefined
          : JSON.stringify({ session_id: 'sess-1', machine_id: REMOTE_MACHINE_ID }),
      }));
      assert.equal(response.status, 405, `${method} must be refused`);
      const refused = await response.json().catch(() => null);
      if (refused !== null) {
        assert.equal(refused.reason_code, TARGET_REFUSAL.METHOD_NOT_ALLOWED);
        assert.match(refused.detail, /POST writes one/);
      }
      assert.equal(store.get('sess-1'), null, `${method} must not have written a selection`);
    }
    // And the two verbs the route *does* answer are untouched by the guard.
    const { store, route } = mount();
    const read = await route.fetch(new Request(url('?session_id=sess-1')));
    assert.equal(read.status, 200);
    const write = await route.fetch(new Request(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', machine_id: REMOTE_MACHINE_ID }),
    }));
    assert.equal(write.status, 200);
    assert.equal(store.get('sess-1').machine_id, REMOTE_MACHINE_ID);
  });

  it('bounds the session id instead of storing and echoing whatever arrives (LOW-9)', async () => {
    // `MAX_SELECTIONS` bounds the *number* of buckets; the key is the whole string, so an unbounded id
    // is unbounded memory per request, echoed back in the snapshot.
    const { store, route } = mount();
    const huge = 'x'.repeat(200_000);
    const response = await route.fetch(new Request(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: huge, machine_id: REMOTE_MACHINE_ID }),
    }));
    assert.equal(response.status, 400);
    const refused = await response.json();
    assert.equal(refused.reason_code, TARGET_REFUSAL.SESSION_ID_TOO_LONG);
    assert.match(refused.error, new RegExp(`at most ${MAX_SESSION_ID_LENGTH} characters, got 200000`));
    assert.match(refused.detail, /UUID is 36 characters/);
    assert.equal(store.get(huge), null, 'nothing was stored under the over-long id');

    // The same bound on the read path, which echoes the id back too.
    const read = await route.fetch(new Request(url(`?session_id=${huge}`)));
    assert.equal(read.status, 400);
    assert.equal((await read.json()).reason_code, TARGET_REFUSAL.SESSION_ID_TOO_LONG);

    // And the legitimate path still works at the bound: a long-but-legal session id is accepted.
    const legal = 'y'.repeat(MAX_SESSION_ID_LENGTH);
    const ok = await route.fetch(new Request(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: legal, machine_id: REMOTE_MACHINE_ID }),
    }));
    assert.equal(ok.status, 200, `a ${MAX_SESSION_ID_LENGTH}-character session id is inside the bound`);
    assert.equal((await ok.json()).session_id, legal);
    assert.equal(store.get(legal).machine_id, REMOTE_MACHINE_ID);
  });

  it('names every refusal the route and its body parser produce (reason_code + detail)', async () => {
    const { route } = mount();
    const post = (body) => route.fetch(new Request(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }));
    const cases = [
      ['not json at all', await post('this is not json'), 400, TARGET_REFUSAL.BODY_NOT_JSON],
      ['an array', await post('[1,2,3]'), 400, TARGET_REFUSAL.BODY_NOT_AN_OBJECT],
      ['no session id', await post(JSON.stringify({})), 400, TARGET_REFUSAL.SESSION_ID_REQUIRED],
      ['a numeric machine id', await post(JSON.stringify({ session_id: 's', machine_id: 7 })), 400, TARGET_REFUSAL.MACHINE_ID_NOT_A_STRING],
      ['a numeric machine name', await post(JSON.stringify({ session_id: 's', machine_name: 7 })), 400, TARGET_REFUSAL.MACHINE_NAME_NOT_A_STRING],
    ];
    for (const [label, response, status, code] of cases) {
      assert.equal(response.status, status, label);
      const body = await response.json();
      assert.equal(body.reason_code, code, label);
      assert.equal(typeof body.detail, 'string', `${label} must say what would change it`);
      assert.ok(body.detail.length > 10, `${label} needs a real detail, not a placeholder`);
    }

    // The body parser alone, so the codes are pinned at the function rather than only through HTTP.
    assert.equal(parseSelectionWrite({ session_id: 's'.repeat(MAX_SESSION_ID_LENGTH + 1) }).reason_code,
      TARGET_REFUSAL.SESSION_ID_TOO_LONG);
    assert.equal(parseSelectionWrite(null).ok, false);
    assert.equal(parseSelectionWrite(null).reason_code, TARGET_REFUSAL.BODY_NOT_AN_OBJECT);
  });

  it('clears the selection on a null machine_id, which restores the whole fleet', async () => {
    const { store, route } = mount();
    store.set('sess-1', { machine_id: REMOTE_MACHINE_ID }, {});
    const response = await route.fetch(new Request(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', machine_id: null }),
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).selected.machine_id, null);
    assert.equal(store.get('sess-1'), null);
  });

  it('reports a fleet it cannot read instead of accepting a target against nothing', async () => {
    const { store, route } = mount({ request: async () => { throw new Error('connect ECONNREFUSED'); } });
    const write = await route.fetch(new Request(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', machine_id: REMOTE_MACHINE_ID }),
    }));
    assert.equal(write.status, 503);
    assert.match((await write.json()).error, /ECONNREFUSED/);
    assert.equal(store.get('sess-1'), null);

    const read = await route.fetch(new Request(url('?session_id=sess-1')));
    assert.equal(read.status, 200, 'a read still answers: "the relay is down" is the answer');
    const state = await read.json();
    assert.equal(state.fleet.ok, false);
    assert.equal(state.machines.length, 0);
    assert.equal(state.selected.online, null, 'not confirmed is not the same as offline');
  });

  it('keeps the selection visible when the machine it names has left the fleet', async () => {
    const { store, route } = mount();
    store.set('sess-1', { machine_id: 'gone-machine', machine_name: 'retired' }, {});
    const state = await (await route.fetch(new Request(url('?session_id=sess-1')))).json();
    assert.equal(state.selected.machine_id, 'gone-machine');
    assert.equal(state.selected.name, 'retired', 'the stored name is the only name left to show');
    assert.equal(state.selected.stale, true);
    assert.equal(state.selected.online, false);
  });

  it('says so, rather than failing to load, when the host has no route registry', async () => {
    const { status, registered } = mount({ noRegistry: true });
    assert.equal(status.mounted, false);
    assert.match(status.reason, /connection\.fetch/);
    assert.deepEqual(registered, []);
  });

  it('validates a write body field by field', () => {
    assert.deepEqual(parseSelectionWrite({ session_id: 's' }), {
      ok: true,
      value: { session_id: 's', machine_id: null, machine_name: null },
    });
    assert.equal(parseSelectionWrite(null).ok, false);
    assert.equal(parseSelectionWrite({}).ok, false);
    assert.equal(parseSelectionWrite({ session_id: '' }).ok, false);
    assert.equal(parseSelectionWrite({ session_id: 's', machine_id: 7 }).ok, false);
    assert.equal(parseSelectionWrite({ session_id: 's', machine_name: 7 }).ok, false);
  });

  it('builds the same snapshot for a session with no selection', () => {
    const store = createSelectionStore();
    const state = buildUiState({
      store,
      sessionId: 'sess-x',
      fleet: { ok: true, error: null, machines: [], online: 0, total: 0, rabbit_time: null, excluded: 0 },
      localMachineName: 'win-desktop',
      detailUnavailable: true,
    });
    assert.equal(state.selected.machine_id, null);
    assert.equal(state.selected.online, null);
    assert.equal(state.host.detail_unavailable, true);
  });
});

// ---------------------------------------------------------------------------------------------
// The dispatch path
// ---------------------------------------------------------------------------------------------

describe('fleet-target: the selection routes w2m_run', () => {
  /** Register the plugin and run one dispatch, returning the body that reached POST /v1/task. */
  async function dispatch(overrides = {}, exec = {}) {
    const fetchStub = installFetch([{ method: 'POST', path: '/v1/task', body: { task_id: 'T1', seq: 1, leases: [] } }]);
    try {
      const { tools } = await register(await runConfig());
      const value = JSON.parse(await tools.get('w2m_run').execute(runArgs(overrides), exec));
      const call = fetchStub.calls.find((entry) => entry.path === '/v1/task');
      return { body: call.body, value };
    } finally {
      fetchStub.restore();
    }
  }

  it('sends no target field at all when nothing is selected', async () => {
    const { body, value } = await dispatch({}, execFor('sess-1'));
    assert.equal('target_machines' in body, false);
    assert.equal('executor_machine_id' in body, false);
    // The shape is pinned whole, so a new key is a deliberate edit here rather than a silent
    // addition: `applied: false` used to be *all* this said, and "nothing was selected" is a
    // different fact from "your selection was ignored".
    const { detail, ...selection } = value.selection;
    assert.deepEqual(selection, {
      applied: false,
      field: null,
      machine_id: null,
      machine_name: null,
      session: 'sess-1',
      reason_code: 'SELECTION_NONE',
    });
    assert.match(detail, /not narrowed/, 'and the detail says what that reason means for this dispatch');
  });

  it('narrows a replicate dispatch to the selected machine and says which field did it', async () => {
    defaultSelectionStore.set('sess-1', { machine_id: REMOTE_MACHINE_ID, machine_name: 'macmini' }, {});
    const { body, value } = await dispatch({}, execFor('sess-1'));
    assert.deepEqual(body.target_machines, [REMOTE_MACHINE_ID]);
    assert.equal('executor_machine_id' in body, false);
    assert.equal(value.selection.applied, true);
    assert.equal(value.selection.reason_code, 'SELECTION_APPLIED');
    assert.match(value.selection.detail, /target_machines=/, 'the detail names the field that carried it');
    assert.equal(value.selection.field, 'target_machines');
    assert.equal(value.selection.machine_id, REMOTE_MACHINE_ID);
    assert.equal(value.selection.session, 'sess-1');
  });

  it('leaves another session alone', async () => {
    defaultSelectionStore.set('sess-1', { machine_id: REMOTE_MACHINE_ID }, {});
    const { body } = await dispatch({}, execFor('sess-2'));
    assert.equal('target_machines' in body, false, 'a target belongs to the session that chose it');
    const noSession = await dispatch({}, {});
    assert.equal('target_machines' in noSession.body, false);
  });

  it('elects the selected machine under broadcast, where the relay reads the executor field', async () => {
    defaultSelectionStore.set('sess-1', { machine_id: REMOTE_MACHINE_ID, machine_name: 'macmini' }, {});
    const { body, value } = await dispatch({ mode: 'broadcast' }, execFor('sess-1'));
    assert.equal(body.executor_machine_id, REMOTE_MACHINE_ID);
    assert.equal('target_machines' in body, false, 'the other machines stay as observers');
    assert.equal(value.selection.field, 'executor_machine_id');
    assert.equal(value.selection.reason_code, 'SELECTION_APPLIED');
  });

  it('lets an explicit executor_machine_id win, because a caller that names a machine is not overridden', async () => {
    defaultSelectionStore.set('sess-1', { machine_id: REMOTE_MACHINE_ID }, {});
    const { body, value } = await dispatch(
      { mode: 'broadcast', executor_machine_id: LOCAL_MACHINE_ID },
      execFor('sess-1'),
    );
    assert.equal(body.executor_machine_id, LOCAL_MACHINE_ID);
    assert.equal(value.selection.applied, false, 'the answer must say the selection did not route this task');
    // The precedence rule is documented in `tools.mjs`; this is the code that makes it visible in the
    // answer, instead of an operator discovering it from a ledger entry that names the wrong machine.
    assert.equal(value.selection.reason_code, 'SELECTION_OVERRIDDEN_BY_CALLER');
    assert.match(value.selection.detail, new RegExp(LOCAL_MACHINE_ID), 'the detail names the value that won');
    assert.equal(value.selection.field, null);
    assert.equal(value.selection.machine_id, REMOTE_MACHINE_ID, 'the selection is still reported as held');
  });

  it('carries the selection for split and pipeline too', async () => {
    defaultSelectionStore.set('sess-1', { machine_id: REMOTE_MACHINE_ID }, {});
    const split = await dispatch({ mode: 'split', index_total: 2 }, execFor('sess-1'));
    assert.deepEqual(split.body.target_machines, [REMOTE_MACHINE_ID]);
    const pipeline = await dispatch({ mode: 'pipeline', command_argv: undefined, stages: ['node --test'] }, execFor('sess-1'));
    assert.deepEqual(pipeline.body.target_machines, [REMOTE_MACHINE_ID]);
  });

  it('names the selected machine when the relay says nothing is online', async () => {
    defaultSelectionStore.set('sess-1', { machine_id: REMOTE_MACHINE_ID, machine_name: 'macmini' }, {});
    const fetchStub = installFetch([{
      method: 'POST',
      path: '/v1/task',
      status: 409,
      body: { error: { code: 'NO_ONLINE_DEVICE', message: 'no paired device available for this task' } },
    }]);
    try {
      const { tools } = await register(await runConfig());
      await assert.rejects(
        () => tools.get('w2m_run').execute(runArgs(), execFor('sess-1')),
        (error) => {
          assert.match(error.message, /selected machine \(macmini\)/);
          assert.match(error.hint, /clear the composer selection/);
          return true;
        },
      );
    } finally {
      fetchStub.restore();
    }
  });

  it('reports the control as attached on a host that provides the route registry', async () => {
    const fetchStub = installFetch([
      { path: '/healthz', body: { rabbit_time: 'now', relay_id: 'r1' } },
      { path: '/v1/devices', body: DEVICES_BODY },
    ]);
    try {
      const { tools, routes } = await register(await runConfig(), { withRoutes: true });
      // v1.6.8 adds the plugin-update route to the same registry.
        // v1.7.1 adds the host capture + host clipboard fallbacks to the same registry.
        assert.equal(routes.length, 8, 'the control is mounted as its routes (target, chat GET/POST, task board, execution capability, plugin update, operator token, host capture, host clipboard)');
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(value.target_selection.attached, true);
      assert.equal(value.target_selection.route, TARGET_ROUTE_PATH);
      assert.equal(value.target_selection.sessions_with_a_target, 0);
    } finally {
      fetchStub.restore();
    }
  });

  it('reports the absence of the registry instead of pretending the control works', async () => {
    const fetchStub = installFetch([
      { path: '/healthz', body: { rabbit_time: 'now' } },
      { path: '/v1/devices', body: DEVICES_BODY },
    ]);
    try {
      const { tools, warnings } = await register(await runConfig());
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(value.target_selection.attached, false);
      assert.match(value.target_selection.detail, /connection\.fetch/);
      // `register()` also carries the offline-`defineTool` warning in this repository, so the
      // assertion is about the *control*, not about the total warning count.
      assert.deepEqual(
        warnings.filter((line) => /composer target control/.test(line)),
        [],
        'a host with no Connection at all is not a web composition, so it is not a warning',
      );
    } finally {
      fetchStub.restore();
    }
  });

  it('warns once when a host HAS a Connection service but no fetch registry', async () => {
    const fetchStub = installFetch([
      { path: '/healthz', body: { rabbit_time: 'now' } },
      { path: '/v1/devices', body: DEVICES_BODY },
    ]);
    try {
      // The one case worth a log line: something is there and the control still cannot attach.
      const { ctx, tools, warnings } = makeCtx();
      ctx.connection = {};
      await applyPinned(ctx, { p2pMode: 'relay', ...(await runConfig()) });
      const value = JSON.parse(await tools.get('w2m_status').execute({}, {}));
      assert.equal(value.target_selection.attached, false);
      const controlWarnings = warnings.filter((line) => /composer target control/.test(line));
      assert.equal(controlWarnings.length, 1);
      assert.match(controlWarnings[0], /composer target control is inactive/);
    } finally {
      fetchStub.restore();
    }
  });

  it('keeps w2m_devices listing the relay roster, expired leases included on request', async () => {
    const fetchStub = installFetch([{ path: '/v1/devices', body: DEVICES_BODY }]);
    try {
      const { tools } = await register(await runConfig());
      const live = JSON.parse(await tools.get('w2m_devices').execute({}, {}));
      assert.equal(live.count, 2, 'the expired lease is excluded by default');
      assert.equal(live.excluded_stale, 1);
      assert.deepEqual(live.devices.map((device) => device.name), ['win-desktop', 'macmini']);
      const all = JSON.parse(await tools.get('w2m_devices').execute({ include_stale: true }, {}));
      assert.equal(all.count, 3);
      assert.equal(all.excluded_stale, 0);
    } finally {
      fetchStub.restore();
    }
  });
});

/**
 * v1.1.3: a machine offline for more than 72 hours leaves the LIST and nothing else.
 *
 * The operator's rule, and the reason each assertion is here: "hide, do not delete, come back on its own". A filter that
 * merely removed the row would pass a naive test while quietly depending on the record still existing; so the tests
 * assert \`records\` (everything the relay sent) as well as \`machines\` (what is shown), and the third test proves the
 * return requires no bookkeeping at all.
 */
describe('72h archive: hidden from the list, never deleted', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const body = (archivedLastSeen) => ({
    protocol_version: 1,
    rabbit_time: new Date().toISOString(),
    devices: [
      { machine_id: 'fresh-1', machine_name: 'fresh', state: 'online', last_seen: new Date(Date.now() - 60_000).toISOString() },
      { machine_id: 'gone-1', machine_name: 'gone', state: 'expired', last_seen: archivedLastSeen },
    ],
  });
  const fleetWith = (json, extra = {}) => readFleet({
    rabbitUrl: RABBIT,
    token: 'dev-test-abc',
    request: async () => ({ ok: true, status: 200, json }),
    ...extra,
  });

  it('leaves the list when it has been offline for more than 72 hours', async () => {
    const fleet = await fleetWith(body(new Date(Date.now() - 4 * DAY).toISOString()));
    assert.deepEqual(fleet.machines.map((m) => m.machine_id), ['fresh-1']);
    assert.equal(fleet.archived, 1, 'the count must say one machine is hidden, or "1 machine" reads as "1 exists"');
  });

  it('keeps the record: records contains every device the relay sent', async () => {
    const fleet = await fleetWith(body(new Date(Date.now() - 4 * DAY).toISOString()));
    assert.equal(fleet.records.length, 2, 'hiding is a read-path decision, so the record must still be here');
    assert.ok(fleet.records.some((r) => r.machine_id === 'gone-1'));
  });

  it('comes back on its own once it reports again, and include_stale can show it meanwhile', async () => {
    const stale = await fleetWith(body(new Date(Date.now() - 4 * DAY).toISOString()), { include_stale: true });
    assert.equal(stale.machines.length, 2, 'include_stale is the operator\'s way to see archived machines');
    assert.equal(stale.archived, 0);

    // No bookkeeping: the same record, a fresh timestamp, and it is listed again.
    const back = await fleetWith(body(new Date(Date.now() - 1_000).toISOString()));
    assert.deepEqual(back.machines.map((m) => m.machine_id).sort(), ['fresh-1', 'gone-1']);
    assert.equal(back.archived, 0);
  });

  it('does not archive a device whose timestamp is missing or unparseable', async () => {
    const fleet = await fleetWith({ protocol_version: 1, devices: [{ machine_id: 'unknown-1', state: 'expired' }] });
    assert.equal(fleet.machines.length, 1, 'an unknown age must not be read as "gone for three days"');
    assert.equal(fleet.archived, 0);
  });
});

describe('relay pool folding (v1.5.1)', () => {
  it('derives the pool from relayUrls first and falls back to the single rabbitUrl', () => {
    assert.deepEqual(relayUrlsFromConfig({ relayUrls: ['http://a:1/', 'http://b:2', 'http://a:1'] }), ['http://a:1', 'http://b:2']);
    assert.deepEqual(relayUrlsFromConfig({ rabbitUrl: 'http://only:8787/' }), ['http://only:8787']);
    assert.deepEqual(relayUrlsFromConfig({}), []);
    assert.deepEqual(relayUrlsFromConfig(null), []);
  });

  it('folds more than three relays into shown/hidden and counts them honestly', () => {
    const items = [1, 2, 3, 4, 5].map((n) => ({ url: `http://r${n}:8787`, ok: n !== 5, rtt_ms: n * 10, role: n === 1 ? 'primary' : 'standby' }));
    const folded = foldRelayItems(items, 3);
    assert.equal(folded.shown.length, 3);
    assert.equal(folded.hidden.length, 2);
    assert.equal(folded.hidden_count, 2);
    assert.equal(folded.total, 5);
    assert.equal(folded.online, 4);
  });

  it('does not present another relay as the whole-server overview (v1.7.2)', () => {
    const state = buildUiState({
      store: { get: () => null },
      sessionId: 's',
      fleet: { ok: true, error: null, machines: [], online: 0, total: 0, rabbit_time: null, excluded: 0 },
      relays: {
        total: 2, online: 1, hidden_count: 0, shown: [], hidden: [], temporary: false,
        // The primary was unreachable, so the host refuses to hand over backup totals.
        server: null,
        server_url: 'http://primary:8787',
        server_reachable: false,
      },
    });
    assert.equal(state.relays.server, null);
    assert.equal(state.relays.server_reachable, false);
    assert.equal(state.relays.server_url, 'http://primary:8787');
  });
  it('probes relays and puts the fastest reachable first, keeping failures visible', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('a:1')) { await new Promise((r) => setTimeout(r, 15)); return Response.json({ ok: true, relay_id: 'A' }); }
      if (url.includes('b:2')) return Response.json({ ok: true, relay_id: 'B' });
      return new Response('bad', { status: 500 });
    };
    const probed = await probeRelays(['http://a:1', 'http://b:2', 'http://c:3'], { fetchImpl, timeoutMs: 500 });
    assert.equal(probed[0].url, 'http://b:2', 'the faster relay leads');
    assert.equal(probed[0].role, undefined, 'roles are assigned by the caller, not the probe');
    assert.equal(probed.filter((item) => item.ok !== true).length, 1);
    assert.equal(probed[probed.length - 1].url, 'http://c:3', 'a failing relay is kept, last');
  });

  it('keeps the probe exception out of the snapshot path: a throwing fetch becomes ok:false', async () => {
    const probed = await probeRelays(['http://x:1'], { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(probed[0].ok, false);
    assert.match(String(probed[0].error), /ECONNREFUSED/);
  });
});