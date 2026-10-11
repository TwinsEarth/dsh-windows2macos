/**
 * W2M fleet targeting: the session's chosen machine, and the browser-facing half of it.
 *
 * # What this is for
 *
 * The plugin's eight tools all converse with the relay, and none of them takes a machine argument:
 * `w2m_run` fans out to every machine the relay holds. That is the right default for a fleet-wide
 * comparison and the wrong one for "run this on the Mac". This module is the missing half of the
 * second case — a *target selection* the operator makes in the composer, which is then applied to
 * the next dispatch **from that session** when the caller names no machines of its own.
 *
 * # Why the selection lives here and not in the browser
 *
 * Two things have to agree on it: the control the operator clicks, and `w2m_run`, which runs in the
 * host process with no browser in reach. The browser cannot be the source of truth for state the
 * dispatch path must read, so the selection is written here, in this process, and the browser is a
 * view over it. The side effect that matters: a selection survives a page reload, and the same
 * session id in a second window reads the same target.
 *
 * # Scope, and why it is per session
 *
 * `conversation.input.left` is a `session`-scoped seat, so the control renders once per session and
 * the browser sends that session's id on every call. The store is keyed by it, which is what stops
 * one chat's target from silently steering another's dispatch. A dispatch with no session in reach
 * (a bare `execute()` in a test, a future non-session caller) falls back to {@link NO_SESSION}, so
 * there is exactly one bucket for "no session" rather than an exception.
 *
 * # The wire, and why it is this small
 *
 * Two exact Fetch routes on the host's `/api` carrier, mounted inside its authentication fence:
 *
 *   GET  /w2m/target?session_id=…   the fleet and this session's selection, as one snapshot
 *   POST /w2m/target                { session_id, machine_id|null } → the same snapshot
 *
 * Plain `Response.json`, no Typert descriptor: this package is dependency-free, and a generated
 * strict Remote contribution is neither reachable from plain JavaScript nor worth a codec for one
 * object. Nothing else in the protocol changes — no new relay endpoint, no new tool parameter, no
 * `envelope_version` movement. The dispatch path is where the selection becomes real, and it is
 * spent on fields the relay already accepts (§4.1 `target_machines`, §4.3 `executor_machine_id`).
 *
 * # Failure is a value here, never an exception
 *
 * The relay may be down, this machine may be unpaired, the host may not provide a fetch-route
 * registry at all. Each of those becomes a field on the snapshot (`fleet.error`,
 * `detail_unavailable`) so the control can say what is wrong instead of rendering an empty list that
 * looks like an empty fleet. Only a *write* of a selection the relay does not list is refused with a
 * non-2xx status, because that is a caller error and the browser must not print a success it did not
 * get.
 */

/** Both routes hang off this exact path; the browser half reads the same constant. */
export const TARGET_ROUTE_PATH = '/w2m/target';

/**
 * The store bucket used when a dispatch carries no session.
 *
 * A named constant rather than `null`/`undefined`: the fallback is a real bucket with real
 * behaviour ("one target for callers that are not a session"), and naming it keeps that visible in
 * `listSelections()` instead of hiding an accidental key.
 */
export const NO_SESSION = '(no-session)';

/** Session buckets retained before the oldest is evicted; a browse session cannot grow this. */
export const MAX_SELECTIONS = 512;

/** How long the fleet roster may be reused by the control before it is asked for again. */
export const FLEET_CACHE_MS = 10_000;

/**
 * Is a fleet entry one this control may dispatch to?
 *
 * The relay reports both `online` (a boolean it computes) and `state` (`online` | `expired` | …).
 * `online` wins when present because it is the closer measurement; `state` is the fallback, and a
 * device with neither is **not** treated as online — "unknown" is not "reachable", and a target list
 * that quietly includes an unknown machine is how a dispatch goes somewhere nobody chose.
 *
 * @param {object|null|undefined} device One entry of `GET /v1/devices`'s `devices`.
 * @returns {boolean}
 */
export function isSelectableDevice(device) {
  if (device === null || typeof device !== 'object') return false;
  if (typeof device.online === 'boolean') return device.online;
  return String(device.state ?? '') === 'online';
}

/**
 * Normalize one relay device record into the shape the control renders.
 *
 * `id`/`name` are the only fields the UI depends on; everything else is detail it may show. Nulls
 * are kept rather than omitted so the browser never has to distinguish "absent" from "null" to
 * decide whether to render a line.
 *
 * @param {object|null|undefined} device One entry of `GET /v1/devices`'s `devices`.
 * @param {string|null} localMachineId This machine's id, for the "this machine" mark.
 * @returns {object}
 */
export function describeTargetMachine(device, localMachineId = null) {
  const machineId = typeof device?.machine_id === 'string' && device.machine_id !== '' ? device.machine_id : null;
  return {
    machine_id: machineId,
    name: typeof device?.machine_name === 'string' && device.machine_name !== ''
      ? device.machine_name
      : (typeof device?.name === 'string' && device.name !== '' ? device.name : null),
    os: device?.platform?.os ?? device?.os ?? null,
    arch: device?.platform?.arch ?? device?.arch ?? null,
    state: typeof device?.state === 'string' && device.state !== '' ? device.state : (isSelectableDevice(device) ? 'online' : 'unknown'),
    online: isSelectableDevice(device),
    last_seen: device?.last_seen ?? device?.last_seen_at ?? null,
    rtt_ms: typeof device?.rtt_ms === 'number' ? device.rtt_ms : null,
    local: machineId !== null && machineId === localMachineId,
  };
}

/**
 * A selection store: one chosen machine per session, in this process.
 *
 * The clock is injectable so a test can assert `selected_at` without sleeping, and the cap is a
 * constructor argument so the eviction order is testable at two entries instead of 513.
 *
 * @param {{now?: () => number, max?: number}} [options]
 * @returns {object} The store described by {@link SelectionStore} below.
 */
export function createSelectionStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : MAX_SELECTIONS;
  /** @type {Map<string, {machine_id: string, machine_name: string|null, selected_at: number, selected_by: string|null}>} */
  const selections = new Map();

  /**
   * Read one session's selection.
   *
   * @param {string} sessionId
   * @returns {object|null}
   */
  function get(sessionId) {
    return selections.get(sessionId) ?? null;
  }

  /**
   * Record a selection, replacing any earlier one for that session.
   *
   * Re-inserting on write (rather than leaving the original position) is what makes the eviction
   * order least-recently-*chosen*; a session that keeps switching targets is exactly the one that
   * must not be evicted first.
   *
   * @param {string} sessionId
   * @param {{machine_id: string, machine_name?: string|null}} machine
   * @param {{selectedBy?: string|null}} [context]
   * @returns {object} The stored selection.
   */
  function set(sessionId, machine, context = {}) {
    const selection = {
      machine_id: String(machine.machine_id),
      machine_name: typeof machine.machine_name === 'string' && machine.machine_name !== '' ? machine.machine_name : null,
      selected_at: now(),
      selected_by: typeof context.selectedBy === 'string' && context.selectedBy !== '' ? context.selectedBy : null,
    };
    selections.delete(sessionId);
    selections.set(sessionId, selection);
    while (selections.size > max) {
      const oldest = selections.keys().next();
      if (oldest.done === true) break;
      selections.delete(oldest.value);
    }
    return selection;
  }

  /**
   * Drop one session's selection: dispatch goes back to every machine the relay holds.
   *
   * @param {string} sessionId
   * @returns {boolean} Whether anything was removed.
   */
  function clear(sessionId) {
    return selections.delete(sessionId);
  }

  /**
   * Snapshot every selection, oldest chosen first. For tests and for a host-side diagnostic; no
   * tool exposes it, because who selected what is the operator's business, not the model's.
   *
   * @returns {Array<{session_id: string} & object>}
   */
  function list() {
    return [...selections.entries()].map(([session_id, selection]) => ({ session_id, ...selection }));
  }

  /**
   * Drop every selection. A test-facing reset: the installed plugin never calls it, because
   * forgetting one session's target when another asks for a fleet read would be a bug, not a
   * feature.
   *
   * @returns {number} How many selections were dropped.
   */
  function clearAll() {
    const count = selections.size;
    selections.clear();
    return count;
  }

  return { get, set, clear, clearAll, list, get size() { return selections.size; } };
}

/**
 * The process-wide store, used by the installed plugin.
 *
 * A module-level singleton rather than a service, because Cordis contexts are per-row and the
 * dispatch path reaches this from a tool definition, not from a service lookup; one plugin is one
 * store. Tests call {@link createSelectionStore} directly, so nothing here is load-bearing for them.
 */
export const defaultSelectionStore = createSelectionStore();

/**
 * Resolve the session id a dispatch belongs to.
 *
 * Reached through `exec.agent.session`, whose `id` is a getter over the session header. A missing
 * agent is not an error: it means "not a session", which is {@link NO_SESSION}.
 *
 * @param {object|null|undefined} exec The tool execution context.
 * @returns {string} A session id, or {@link NO_SESSION}.
 */
export function sessionKeyFor(exec) {
  const session = exec?.agent?.session ?? null;
  const id = session === null ? null : (typeof session.id === 'string' && session.id !== ''
    ? session.id
    : (typeof session.header?.id === 'string' && session.header.id !== '' ? session.header.id : null));
  return id ?? NO_SESSION;
}

/**
 * Turn one selection into the dispatch fields that make it real.
 *
 * The mapping is per mode because the relay's two selection fields are not interchangeable:
 *
 *   replicate / split / pipeline  →  `target_machines: [id]` constrains **which machines run**.
 *   broadcast                     →  `executor_machine_id: id` names **which one runs**, while the
 *                                    others stay in the task as observers. Sending
 *                                    `target_machines` here would *remove* the observers, which is a
 *                                    different task than the caller asked for.
 *
 * Both fields already exist in the relay's `POST /v1/task` (§4.1, §4.3) and neither is invented
 * here, so no protocol moves. `null` in a field means "the caller said nothing"; the caller's own
 * value always wins, which is enforced by the call site, not here.
 *
 * @param {object|null} selection A stored selection, or null for "no selection".
 * @param {string} mode The dispatch mode.
 * @returns {{fields: object, applied_as: string|null}}
 */
export function dispatchSelectionFields(selection, mode) {
  const machineId = typeof selection?.machine_id === 'string' && selection.machine_id !== ''
    ? selection.machine_id
    : null;
  if (machineId === null) return { fields: {}, applied_as: null };
  if (mode === 'broadcast') {
    return { fields: { executor_machine_id: machineId }, applied_as: 'executor_machine_id' };
  }
  return { fields: { target_machines: [machineId] }, applied_as: 'target_machines' };
}

/**
 * Read the fleet from the relay, in the shape the control renders.
 *
 * One helper behind both `w2m_devices` and the control, so the two can never disagree about who is
 * online — the failure that would matter most here, because the control's promise is "this is where
 * your next dispatch goes". The tool re-renders the machine records it gets back into its own
 * published shape; what is shared is the read, the liveness rule, and the "the local machine has no
 * identity yet" case.
 *
 * Never throws. A relay that refuses, a machine that is unpaired, a socket that is down: each is
 * reported as `{ok: false, error}` and the caller decides whether that is fatal (`w2m_devices`
 * throws a typed error) or merely reported (the control says so and shows nothing selectable).
 *
 * @param {object} deps
 * @param {string} deps.rabbitUrl Base relay URL.
 * @param {string|null} [deps.token] Device token, or null for an unpaired machine.
 * @param {string|null} [deps.localMachineId] This machine's id, for the "this machine" mark.
 * @param {AbortSignal} [deps.signal]
 * @param {(options: object) => Promise<object>} deps.request The plugin's bounded HTTP helper.
 * @returns {Promise<object>} `{ok, error, status, machines, records, online, total, rabbit_time, excluded}`.
 *   `records` are the relay's own device records, passed through for callers that report the fleet's
 *   fields rather than this module's projection of them.
 */
export async function readFleet(deps) {
  const { rabbitUrl, token = null, localMachineId = null, signal, request } = deps;
  if (typeof rabbitUrl !== 'string' || rabbitUrl === '') {
    return {
      ok: false,
      error: 'no Rabbit URL is configured, so the fleet cannot be listed',
      hint: 'set `rabbitUrl` in this plugin\'s profile patch, for example http://127.0.0.1:8787',
      status: 0,
      machines: [],
      records: [],
      online: 0,
      total: 0,
      rabbit_time: null,
      excluded: 0,
    };
  }
  let result;
  try {
    result = await request({ rabbitUrl, token, signal, pathname: '/v1/devices' });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      // The helper's own typed error carries the remediation in its `hint` ("check that the Rabbit
      // is running and that `rabbitUrl` points at it"). Dropping it here would turn a fixable
      // unreachable-relay failure into "something went wrong", so it is carried through and the
      // callers that throw re-attach it verbatim.
      hint: typeof error?.hint === 'string' && error.hint !== '' ? error.hint : null,
      status: 0,
      machines: [],
      records: [],
      online: 0,
      total: 0,
      rabbit_time: null,
      excluded: 0,
    };
  }
  if (result?.ok !== true) {
    const detail = result?.error ? ` (${result.error.code}: ${result.error.message})` : '';
    return {
      ok: false,
      error: `the Rabbit refused GET /v1/devices with HTTP ${result?.status ?? 'unknown'}${detail}`,
      hint: result?.status === 401 ? 'this machine is not paired, or its device_token is stale; pair the agent again' : 'check the Rabbit log for the reason it gave',
      status: Number.isInteger(result?.status) ? result.status : 0,
      machines: [],
      records: [],
      online: 0,
      total: 0,
      rabbit_time: null,
      excluded: 0,
    };
  }
  const records = Array.isArray(result.json?.devices)
    ? result.json.devices
    : (Array.isArray(result.json?.machines) ? result.json.machines : []);
  const machines = records.map((record) => describeTargetMachine(record, localMachineId));
  return {
    ok: true,
    error: null,
    status: Number.isInteger(result.status) ? result.status : 200,
    machines,
    records,
    online: machines.filter((machine) => machine.online).length,
    total: machines.length,
    rabbit_time: result.json?.rabbit_time ?? null,
    // Machines the relay still lists but whose lease is not live. Reported so "3 machines" is never
    // mistaken for "3 machines you can use".
    excluded: machines.filter((machine) => !machine.online).length,
  };
}

/**
 * Build the snapshot the browser renders.
 *
 * @param {object} deps
 * @param {object} deps.store A selection store.
 * @param {string} deps.sessionId The session the control belongs to.
 * @param {{ok: boolean, error: string|null, machines: object[], online: number, total: number,
 *          rabbit_time: string|null, excluded: number}} deps.fleet Output of {@link readFleet}.
 * @param {string|null} deps.localMachineName This machine's configured fleet name.
 * @param {boolean} deps.detailUnavailable True when the host provides no fetch-route registry.
 * @returns {object}
 */
export function buildUiState(deps) {
  const { store, sessionId, fleet, localMachineName = null, detailUnavailable = false } = deps;
  const selection = store.get(sessionId);
  const machines = Array.isArray(fleet?.machines) ? fleet.machines : [];
  const selected = selection === null ? null : machines.find((machine) => machine.machine_id === selection.machine_id) ?? null;
  return {
    session_id: sessionId,
    selected: selection === null
      ? { machine_id: null, name: null, selected_at: null, online: null, stale: false }
      : {
          machine_id: selection.machine_id,
          name: selected?.name ?? selection.machine_name ?? null,
          selected_at: selection.selected_at,
          // `online: null` is "the fleet could not be read", which is not "offline". The control
          // must be able to say "the target I am holding was not confirmed", not invent a state.
          online: selected === null ? (fleet?.ok === true ? false : null) : selected.online,
          stale: fleet?.ok === true && (selected === null || selected.online !== true),
        },
    machines,
    fleet: {
      ok: fleet?.ok === true,
      error: fleet?.error ?? null,
      online: fleet?.online ?? 0,
      total: fleet?.total ?? 0,
      excluded: fleet?.excluded ?? 0,
      rabbit_time: fleet?.rabbit_time ?? null,
    },
    host: {
      local_machine_name: localMachineName,
      // True when the host process has no Connection fetch registry at all: the control is rendered
      // but cannot reach this half, and the honest answer is to say so rather than to look empty.
      detail_unavailable: detailUnavailable === true,
    },
  };
}

/**
 * Parse the JSON body of a selection write, refusing anything outside the declared shape.
 *
 * @param {unknown} body
 * @returns {{ok: true, value: {session_id: string, machine_id: string|null, machine_name: string|null}}|{ok: false, error: string}}
 */
export function parseSelectionWrite(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const record = /** @type {Record<string, unknown>} */ (body);
  const sessionId = record.session_id;
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, error: '`session_id` must be a non-empty string' };
  }
  const machineId = record.machine_id;
  if (machineId !== null && machineId !== undefined && typeof machineId !== 'string') {
    return { ok: false, error: '`machine_id` must be a string or null' };
  }
  const machineName = record.machine_name;
  if (machineName !== null && machineName !== undefined && typeof machineName !== 'string') {
    return { ok: false, error: '`machine_name` must be a string or null' };
  }
  return {
    ok: true,
    value: {
      session_id: sessionId,
      machine_id: typeof machineId === 'string' && machineId !== '' ? machineId : null,
      machine_name: typeof machineName === 'string' && machineName !== '' ? machineName : null,
    },
  };
}

/**
 * Resolve this machine's fleet identity, once per process.
 *
 * Memoized on a **successful** read only. A machine that is not paired yet resolves to
 * `{machine_id: null}` and is re-read on the next call, because the fix for that is pairing the
 * agent — which can happen while this process is running, and a cached failure would leave the
 * control insisting this machine has no identity long after it got one.
 *
 * @param {() => Promise<{machine_id: string|null, machine_name: string|null, machineName?: string|null}>} read
 *   A reader that returns the device's identity and the configured fleet name.
 * @returns {() => Promise<{machine_id: string|null, machine_name: string|null}>}
 */
export function createLocalIdentity(read) {
  let cached = null;
  return async () => {
    if (cached !== null) return cached;
    const identity = await read();
    const resolved = {
      machine_id: typeof identity?.machine_id === 'string' && identity.machine_id !== '' ? identity.machine_id : null,
      machine_name: typeof identity?.machine_name === 'string' && identity.machine_name !== ''
        ? identity.machine_name
        : (typeof identity?.machineName === 'string' && identity.machineName !== '' ? identity.machineName : null),
    };
    if (resolved.machine_id !== null) cached = resolved;
    return resolved;
  };
}

/**
 * Mount the two browser routes, if this host has a fetch-route registry to mount them on.
 *
 * Returning a status object instead of throwing keeps the one interesting case loud *and*
 * survivable: a host built without `@deepseek-ai/dsh-client-connection` still gets a working plugin
 * with seven tools and no composer control, which is strictly better than a plugin that refuses to
 * load because a UI nicety has nowhere to attach.
 *
 * @param {object|null|undefined} ctx Cordis context; only `ctx.connection.fetch` is read, and it is
 *   read defensively because a host may not provide one.
 * @param {object} deps
 * @param {() => object} deps.cfg Current merged plugin config.
 * @param {object} deps.store The selection store.
 * @param {() => Promise<{machine_id: string|null, machine_name: string|null}>} deps.localIdentity
 * @param {(options: object) => Promise<object>} deps.request The plugin's bounded HTTP helper.
 * @param {(cfg: object) => Promise<string|null>} deps.resolveToken
 * @returns {{mounted: boolean, unexpected: boolean, reason: string|null}} `unexpected` is true only
 *   when the host has a Connection service that lacks the registry — the one case worth a warning.
 */
export function registerTargetRoutes(ctx, deps) {
  const connection = ctx?.connection ?? null;
  const registry = connection?.fetch;
  if (registry === undefined || typeof registry.register !== 'function') {
    return {
      mounted: false,
      // The distinction matters to the caller's log: a host with **no** Connection at all is simply
      // not a web composition, and warning about it would be noise on every headless run. A host
      // that has Connection but no fetch registry is a real mismatch worth one line.
      unexpected: connection !== null && connection !== undefined,
      reason: 'this host provides no `connection.fetch` route registry, so the composer control cannot reach the plugin',
    };
  }

  let cache = { at: 0, value: null };

  /**
   * The fleet for one call, cached for {@link FLEET_CACHE_MS}.
   *
   * The control asks again every time it opens; a click-happy operator must not turn into a burst of
   * relay reads, and the relay's own answer is already seconds old by the time it arrives.
   */
  const fleetFor = async (signal) => {
    const now = Date.now();
    if (cache.value !== null && now - cache.at < FLEET_CACHE_MS) return cache.value;
    const cfg = deps.cfg();
    const identity = await deps.localIdentity();
    const value = await readFleet({
      rabbitUrl: cfg.rabbitUrl,
      token: await deps.resolveToken(cfg),
      localMachineId: identity.machine_id,
      signal,
      request: deps.request,
    });
    cache = { at: now, value };
    return value;
  };

  const snapshot = async (sessionId, signal) => {
    const cfg = deps.cfg();
    const identity = await deps.localIdentity();
    const fleet = await fleetFor(signal);
    return buildUiState({
      store: deps.store,
      sessionId,
      fleet,
      localMachineName: identity.machine_name ?? cfg.machineName ?? null,
      detailUnavailable: false,
    });
  };

  // One route object for both verbs, not two: the registry is keyed by path and a second
  // registration for the same path is refused outright (`exact Fetch route … is already
  // registered`), so the method split has to happen inside the handler.
  registry.register({
    path: TARGET_ROUTE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url);
      const noStore = { 'cache-control': 'no-store' };

      if (request.method === 'GET') {
        const sessionId = url.searchParams.get('session_id');
        if (typeof sessionId !== 'string' || sessionId === '') {
          return Response.json({ ok: false, error: '`session_id` query parameter is required' }, { status: 400 });
        }
        try {
          return Response.json(await snapshot(sessionId, request.signal), { headers: noStore });
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 502 },
          );
        }
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: 'body is not JSON' }, { status: 400 });
      }
      const parsed = parseSelectionWrite(body);
      if (!parsed.ok) return Response.json({ ok: false, error: parsed.error }, { status: 400 });
      const { session_id: sessionId, machine_id: machineId, machine_name: machineName } = parsed.value;

      if (machineId === null) {
        deps.store.clear(sessionId);
        return Response.json(await snapshot(sessionId, request.signal), { headers: noStore });
      }

      // A selection is only accepted for a machine the relay *currently* lists as online. Refusing
      // here rather than at dispatch time is the whole point of the control: "the machine I chose"
      // must not be a claim the fleet cannot honour, and the refusal reaches the operator while they
      // are still looking at the list.
      const identity = await deps.localIdentity();
      const cfg = deps.cfg();
      const fleet = await fleetFor(request.signal);
      if (fleet.ok !== true) {
        return Response.json(
          { ok: false, error: `the fleet could not be read, so no target was changed: ${fleet.error ?? 'unknown cause'}` },
          { status: 503 },
        );
      }
      const machine = fleet.machines.find((entry) => entry.machine_id === machineId) ?? null;
      if (machine !== null && machine.online !== true) {
        return Response.json(
          { ok: false, error: `${machine.name ?? machineId} is listed as ${machine.state}, so it cannot be selected` },
          { status: 409 },
        );
      }
      deps.store.set(sessionId, {
        machine_id: machineId,
        machine_name: machine?.name ?? machineName,
      }, { selectedBy: identity.machine_name ?? cfg.machineName ?? null });
      return Response.json(await snapshot(sessionId, request.signal), { headers: noStore });
    },
  });

  return { mounted: true, unexpected: false, reason: null };
}
