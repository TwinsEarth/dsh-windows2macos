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
 * Two exact Fetch routes on the host's `/api` carrier, mounted inside its authentication fence.
 * The `/api` prefix is the registry's own channel — see {@link TARGET_ROUTE_PATH} — so these are the
 * paths as the host registers them, and the page fetches the same path document-relative:
 *
 *   GET  /api/w2m/target?session_id=…   the fleet and this session's selection, as one snapshot
 *   POST /api/w2m/target                { session_id, machine_id|null } → the same snapshot
 *
 * A refusal is `{ok: false, error, reason_code, detail}` with a `{@link TARGET_REFUSAL}` code and a
 * `detail` that says what would change it; a `PUT`/`DELETE`/`PATCH` is a `405` rather than a write
 * (only exactly `GET` and `POST` are answered), a machine the relay does not list is a `409` exactly
 * like one it lists as offline, and `session_id` is capped at {@link MAX_SESSION_ID_LENGTH} characters
 * on both verbs because the store keys on the whole string.
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

/**
 * Both routes hang off this exact path; the browser half reads the same constant.
 *
 * The `/api` prefix is not decoration and not ours: `@deepseek-ai/dsh-client-connection` mounts the
 * whole fetch-route registry under its `/api` channel and validates every registration with
 * `endpointFromPath('/api', path)`, which returns undefined for anything that does not start with
 * `/api/`. A `/w2m/target` registration is therefore refused — `connection: invalid exact Fetch route
 * "/w2m/target"` — inside the injected callback, where it failed the *child* fiber and left the host
 * entry looking perfectly healthy. The shipped browser halves all follow the same rule
 * (`dsh-client-file-upload` uses `/api/session/uploadFileBinary`), and the page fetches the same
 * document-relative path.
 */
export const TARGET_ROUTE_PATH = '/api/w2m/target';

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

/**
 * Longest `session_id` this route accepts, in characters (UTF-16 code units).
 *
 * `MAX_SELECTIONS` bounds how many buckets exist; it says nothing about how large one key is, and the
 * store keeps the whole string. A caller that sends a 200,000-character id therefore allocates as much
 * as it likes per request and gets it echoed back in the snapshot — the count cap bounds the *number*
 * of sessions, never the *bytes*. 200 is a bound with room to spare: a DSH session id is a UUID (36
 * characters), and 200 leaves room for a ULID, a path-shaped id or a test's own naming without
 * inviting an unbounded key.
 */
export const MAX_SESSION_ID_LENGTH = 200;

/**
 * The `/api/w2m/target` route's refusals, in the house `{reason_code, detail}` shape.
 *
 * Deliberately a map of its own rather than a widening of `tools.mjs`'s `REFUSAL_CODE`: those codes name
 * refusals on the *dispatch* path (which the eight tools report), while these name refusals at the
 * route the browser calls, and `fleet-target.mjs` is imported *by* `tools.mjs` — importing back would
 * be a cycle. `reason_code` is the greppable, stable identifier and `detail` says what would change it.
 */
export const TARGET_REFUSAL = Object.freeze({
  /** A verb this route does not answer. Only exactly `GET` and `POST` are read or written. */
  METHOD_NOT_ALLOWED: 'TARGET_METHOD_NOT_ALLOWED',
  /** `GET` carried no `session_id`, so there is no session to answer for. */
  SESSION_ID_REQUIRED: 'TARGET_SESSION_ID_REQUIRED',
  /** `session_id` is longer than {@link MAX_SESSION_ID_LENGTH}. */
  SESSION_ID_TOO_LONG: 'TARGET_SESSION_ID_TOO_LONG',
  /** A `POST` body that could not be parsed as JSON at all. */
  BODY_NOT_JSON: 'TARGET_BODY_NOT_JSON',
  /** A `POST` body that is not a JSON object. */
  BODY_NOT_AN_OBJECT: 'TARGET_BODY_NOT_AN_OBJECT',
  /** `machine_id` was neither a string nor null. */
  MACHINE_ID_NOT_A_STRING: 'TARGET_MACHINE_ID_NOT_A_STRING',
  /** `machine_name` was neither a string nor null. */
  MACHINE_NAME_NOT_A_STRING: 'TARGET_MACHINE_NAME_NOT_A_STRING',
  /** The named machine is not one the relay lists at all. */
  MACHINE_UNKNOWN: 'TARGET_MACHINE_UNKNOWN',
  /** The named machine exists, and the relay does not call it online. */
  MACHINE_OFFLINE: 'TARGET_MACHINE_OFFLINE',
  /** The fleet could not be read, so no selection could be checked against it. */
  FLEET_UNAVAILABLE: 'TARGET_FLEET_UNAVAILABLE',
});

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
/**
 * v1.1.3: how long a machine may be unheard from before it leaves the list.
 *
 * The operator's rule: offline for 72 hours is no longer shown, **nothing is deleted**, and it comes back on its own
 * once it reports again. Hiding and deleting are deliberately different -- deleting would throw away the history of a
 * machine that is merely switched off, and re-pairing would be the only way back.
 */
const ARCHIVE_AFTER_MS = 72 * 60 * 60 * 1000;

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
  const { rabbitUrl, token = null, localMachineId = null, signal, request, include_stale = false } = deps;
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
  const allMachines = records.map((record) => describeTargetMachine(record, localMachineId));
  /**
   * Archived means "not shown", never "removed": `records` still carries every device, so a caller that asks for the
   * archived ones receives them. A missing or unparseable timestamp is NOT archived -- "unknown" must not be read as
   * "gone for three days", or a relay that omits the field would empty the list.
   */
  const isArchived = (machine) => {
    const raw = machine.last_seen;
    const at = typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''));
    return Number.isFinite(at) && (Date.now() - at) >= ARCHIVE_AFTER_MS;
  };
  const machines = include_stale === true ? allMachines : allMachines.filter((machine) => !isArchived(machine));
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
    archived: allMachines.length - machines.length,
  };
}

/**
 * v1.5.1: the relay pool the client folds, derived from configuration.
 *
 * `relayUrls` (array) is the multi-relay form; the single `rabbitUrl` stays valid and is returned
 * as a one-element pool, so a host that never configured a pool behaves exactly as it did.
 *
 * @param {{relayUrls?: unknown, rabbitUrl?: string|null}|null|undefined} cfg
 * @returns {string[]} Normalized base URLs, order preserved, duplicates removed.
 */
export function relayUrlsFromConfig(cfg) {
  const raw = Array.isArray(cfg?.relayUrls) ? cfg.relayUrls : [];
  const urls = raw
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => entry.trim().replace(/\/+$/, ''));
  if (urls.length > 0) return [...new Set(urls)];
  if (typeof cfg?.rabbitUrl === 'string' && cfg.rabbitUrl.trim() !== '') {
    return [cfg.rabbitUrl.trim().replace(/\/+$/, '')];
  }
  return [];
}

/**
 * Fold a relay pool for display: at most `limit` nodes are shown, the rest are counted.
 *
 * The client is expected to render `shown` and `hidden` exactly as given: a view that silently
 * shows every node when there are dozens is the failure this helper exists to prevent.
 *
 * @param {object[]} items Probe results, best first.
 * @param {number} [limit]
 * @returns {{shown: object[], hidden: object[], hidden_count: number, total: number, online: number}}
 */
export function foldRelayItems(items, limit = 3) {
  const list = Array.isArray(items) ? items : [];
  const shown = list.slice(0, Math.max(0, limit));
  const hidden = list.slice(Math.max(0, limit));
  return {
    shown,
    hidden,
    hidden_count: hidden.length,
    total: list.length,
    online: list.filter((item) => item?.ok === true).length,
  };
}

/**
 * Probe each relay's `/healthz` and return the pool sorted by round-trip time (fastest first).
 * A relay that fails is kept and sorted last with `ok:false` — disappearing from the list would
 * hide exactly the outage the operator needs to see.
 *
 * @param {string[]} urls
 * @param {{timeoutMs?: number, fetchImpl?: Function}} [options]
 * @returns {Promise<object[]>}
 */
export async function probeRelays(urls, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 1200;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const list = Array.isArray(urls) ? urls : [];
  const results = await Promise.all(list.map(async (url) => {
    const started = Date.now();
    try {
      const response = await fetchImpl(`${url}/healthz`, {
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true) {
        return { url, ok: false, rtt_ms: null, error: `HTTP ${response.status}` };
      }
      return {
        url, ok: true, rtt_ms: Date.now() - started, relay_id: body.relay_id ?? null,
        // v1.6.2: Whole-relay totals, shown in the panel as "N fleets · M machines online".
        // Counts only: per-fleet membership stays behind the fleet-scoped endpoints.
        stats: {
          fleets_total: Number.isInteger(body.fleets_total) ? body.fleets_total : null,
          fleets_online: Number.isInteger(body.fleets_online) ? body.fleets_online : null,
          devices_online: Number.isInteger(body.devices_online) ? body.devices_online : null,
          devices_total: Number.isInteger(body.devices_total) ? body.devices_total : null,
        },
      };
    } catch (error) {
      return { url, ok: false, rtt_ms: null, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const reachable = results.filter((item) => item.ok === true).sort((a, b) => (a.rtt_ms ?? 0) - (b.rtt_ms ?? 0));
  const unreachable = results.filter((item) => item.ok !== true);
  return [...reachable, ...unreachable];
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
  const { store, sessionId, fleet, localMachineName = null, detailUnavailable = false, relays = null } = deps;
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
    // v1.5.1: the relay pool, folded. `null` means the host did not probe (single-relay host or
    // probe disabled); the control then renders no relay section instead of inventing one.
    relays: relays === null
      ? null
      : {
          total: relays.total,
          online: relays.online,
          hidden_count: relays.hidden_count,
          shown: relays.shown,
          hidden: relays.hidden,
          // Fastest reachable relay is the one a dispatch would prefer; naming it here keeps the
          // fold honest when it hides nodes that the router would still consider.
          primary_url: relays.shown.find((item) => item.ok === true)?.url ?? null,
          // v1.5.2: a fallback relay list is never presented as settled; the panel renders it red.
          temporary: relays.temporary === true,
          // v1.6.2: whole-relay overview (fleets + online machines) for the panel header line.
          server: relays.server ?? null,
          // v1.7.2: only the configured primary's totals; null means "unavailable", never the backup's.
          server_url: relays.server_url ?? null,
          server_reachable: relays.server_reachable !== false,
        },
  };
}

/**
 * Parse the JSON body of a selection write, refusing anything outside the declared shape.
 *
 * Every refusal is a *value with a name*: `reason_code` is stable and greppable, and `detail` says what
 * would have to change for the same request to be accepted. The route turns both into the response body
 * verbatim, so the browser can show the reason without re-deriving it.
 *
 * @param {unknown} body
 * @returns {{ok: true, value: {session_id: string, machine_id: string|null, machine_name: string|null}}
 *   |{ok: false, error: string, reason_code: string, detail: string}}
 */
export function parseSelectionWrite(body) {
  const refuse = (error, reason_code, detail) => ({ ok: false, error, reason_code, detail });
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return refuse(
      'body must be a JSON object',
      TARGET_REFUSAL.BODY_NOT_AN_OBJECT,
      'send `{"session_id": "<id>", "machine_id": "<id>|null"}`',
    );
  }
  const record = /** @type {Record<string, unknown>} */ (body);
  const sessionId = record.session_id;
  if (typeof sessionId !== 'string' || sessionId === '') {
    return refuse(
      '`session_id` must be a non-empty string',
      TARGET_REFUSAL.SESSION_ID_REQUIRED,
      'send the id of the session this selection belongs to',
    );
  }
  if (sessionId.length > MAX_SESSION_ID_LENGTH) {
    return refuse(
      `\`session_id\` must be at most ${MAX_SESSION_ID_LENGTH} characters, got ${sessionId.length}`,
      TARGET_REFUSAL.SESSION_ID_TOO_LONG,
      `send the id the host gave this session (a UUID is 36 characters); anything longer than `
        + `${MAX_SESSION_ID_LENGTH} characters is not a session id`,
    );
  }
  const machineId = record.machine_id;
  if (machineId !== null && machineId !== undefined && typeof machineId !== 'string') {
    return refuse(
      '`machine_id` must be a string or null',
      TARGET_REFUSAL.MACHINE_ID_NOT_A_STRING,
      'send a `machine_id` from the roster this route reports, or null to clear the selection',
    );
  }
  const machineName = record.machine_name;
  if (machineName !== null && machineName !== undefined && typeof machineName !== 'string') {
    return refuse(
      '`machine_name` must be a string or null',
      TARGET_REFUSAL.MACHINE_NAME_NOT_A_STRING,
      'send the machine\'s display name as a string, or leave it out and the relay\'s name is used',
    );
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

/** The one diagnostic for "this host cannot carry the composer control", shared by both causes. */
const NO_ROUTE_REGISTRY =
  'this host provides no `connection.fetch` route registry, so the composer control cannot reach the plugin';

/**
 * Mount the two browser routes, if this host has a fetch-route registry to mount them on.
 *
 * Returning a status object instead of throwing keeps the one interesting case loud *and*
 * survivable: a host built without `@deepseek-ai/dsh-client-connection` still gets a working plugin
 * with all eight tools and no composer control, which is strictly better than a plugin that refuses
 * to load because a UI nicety has nowhere to attach.
 *
 * # Why the service is declared with `ctx.inject`, and never read as `ctx.connection`
 *
 * Cordis resolves services per fiber: a property read of a name this plugin did not declare in its
 * `inject` list **throws** — `cannot get property "connection" without inject` — and it throws
 * whether or not some other plugin provides that service. `ctx.inject(names, callback)` is the
 * declaration that makes the read legal, and it is the *optional* form: the plugin's own list stays
 * `['tools']`, so a host with no Connection service still activates and still registers all eight
 * tools — the callback below simply never runs. v0.5.4 shipped the plain property read, and the whole
 * entry then failed on a web host and on a base-only host alike, because the throw does not depend on
 * the service existing.
 *
 * `ctx.inject` also drops the ordering assumption a one-shot read would carry: the Loader creates
 * sibling entries concurrently (`EntryGroup.update` → `Promise.all`), so a host that *does* provide
 * Connection may still be activating it while this plugin's `apply` runs. A synchronous read would
 * report "no registry" for a control that was about to become attachable.
 *
 * The status object is mutated in place when the callback runs, so `w2m_status` — called long after
 * activation — reads what happened rather than what was knowable at `apply` time.
 *
 * @param {object|null|undefined} ctx Cordis context; `ctx.inject(['connection'], …)` is how the
 *   optional service is declared and read. A context without `inject` gets no route and no warning,
 *   which is the same status as a host that has no Connection at all.
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
  const status = {
    mounted: false,
    unexpected: false,
    reason: NO_ROUTE_REGISTRY,
  };
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['connection'], (webCtx) => {
      mountTargetRoutes(webCtx.connection, deps, status, ctx.logger);
    });
  }
  return status;
}

/**
 * Attach the route pair to one host's fetch registry, recording the outcome on `status`.
 *
 * The registration is owned by the context it is made through — `register` is a Connection method
 * bound to the calling fiber, so it is released with the injected child fiber — which is why there
 * is no `ctx.effect` wrapper here.
 *
 * @param {object|null|undefined} connection The `connection` service, when the host has one.
 * @param {object} deps
 * @param {{mounted: boolean, unexpected: boolean, reason: string|null}} status Mutated in place.
 * @param {object} [logger] The plugin's logger, for the one mismatch worth a line.
 * @returns {void}
 */
function mountTargetRoutes(connection, deps, status, logger) {
  const registry = connection?.fetch;
  if (registry === undefined || typeof registry.register !== 'function') {
    // The distinction matters to the log: a host with **no** Connection at all is simply not a web
    // composition, and warning about it would be noise on every headless run. A host that has
    // Connection but no fetch registry is a real mismatch worth one line.
    status.unexpected = connection !== null && connection !== undefined;
    if (status.unexpected) {
      logger?.warn?.(`w2m: the composer target control is inactive — ${NO_ROUTE_REGISTRY}`);
    }
    return;
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

  /** v1.5.1: relay probing is cached like the fleet: opening the menu must not turn into a burst. */
  let relayCache = { at: 0, value: null };
  const relayPoolFor = async () => {
    const now = Date.now();
    if (relayCache.value !== null && now - relayCache.at < FLEET_CACHE_MS) return relayCache.value;
    const urls = relayUrlsFromConfig(deps.cfg());
    if (urls.length === 0) {
      relayCache = { at: now, value: null };
      return null;
    }
    const probed = await probeRelays(urls);
    // v1.7.3: the role follows the CONFIGURED primary relay, not whichever relay answered fastest.
    // Ranking by latency let the backup masquerade as primary whenever it was quicker -- the panel then
    // explained one relay while showing another relay's whole-server numbers.
    const normalize = (value) => (typeof value === 'string' ? value.trim().replace(/\/+$/, '') : null);
    const configuredPrimary = normalize(deps.cfg()?.rabbitUrl) ?? normalize(urls[0]);
    const ordered = [...probed];
    const primaryIndex = ordered.findIndex((item) => normalize(item.url) === configuredPrimary);
    if (primaryIndex > 0) ordered.unshift(...ordered.splice(primaryIndex, 1));
    const items = ordered.map((item) => ({
      ...item,
      role: item.ok !== true ? 'offline' : (normalize(item.url) === configuredPrimary ? 'primary' : 'standby'),
    }));
    const folded = foldRelayItems(items, 3);
    // v1.7.2: whole-server totals come from the CONFIGURED primary relay only. v1.6.2 used "the first
    // relay that answered", so when the primary was unreachable the panel showed the BACKUP relay's
    // numbers (1/1 fleets, 2/5 machines) under the "whole server" label -- visibly wrong. An
    // unreachable primary reports `server: null` + `server_reachable: false`, and the panel says the
    // totals are unavailable instead of presenting another relay's fleet as the server's.
    const primaryItem = configuredPrimary === null
      ? items.find((item) => item.ok === true) ?? null
      : items.find((item) => normalize(item.url) === configuredPrimary) ?? null;
    const serverReachable = primaryItem?.ok === true;
    const primaryStats = serverReachable ? primaryItem.stats : null;
    const withMark = {
      ...folded,
      temporary: deps.cfg()?.relayTemporary === true,
      server: primaryStats,
      server_url: configuredPrimary ?? primaryItem?.url ?? null,
      server_reachable: serverReachable,
    };
    relayCache = { at: now, value: withMark };
    return withMark;
  };

  const snapshot = async (sessionId, signal) => {
    const cfg = deps.cfg();
    const identity = await deps.localIdentity();
    const fleet = await fleetFor(signal);
    const relays = await relayPoolFor();
    return buildUiState({
      store: deps.store,
      relays,
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
      /**
       * One refusal shape for the whole route: `{ok:false, error, reason_code, detail}`.
       *
       * @param {number} status
       * @param {string} reasonCode A {@link TARGET_REFUSAL} value.
       * @param {string} error What happened, in the host's own words (the control prints this).
       * @param {string} detail What would change it.
       * @returns {Response}
       */
      const refuse = (status, reasonCode, error, detail) =>
        Response.json({ ok: false, error, reason_code: reasonCode, detail }, { status, headers: noStore });

      // Defence in depth, and the one place it is cheap. The registration above declares
      // `methods: ['GET', 'POST']`, so the host should never route a `PUT`/`DELETE`/`PATCH` here at all
      // — but the handler used to treat *anything* that was not a GET as a write, which means a
      // registration mistake, a host that forwards other verbs, or a future `methods` change would
      // silently turn `DELETE /api/w2m/target` into "clear this selection". A route that writes must
      // say which verbs write; everything else is refused by name rather than guessed at.
      if (request.method !== 'GET' && request.method !== 'POST') {
        return refuse(
          405,
          TARGET_REFUSAL.METHOD_NOT_ALLOWED,
          `${request.method} is not a method this route answers`,
          'GET reads the fleet and this session\'s selection and POST writes one; any other verb is refused '
            + 'rather than treated as a write',
        );
      }

      if (request.method === 'GET') {
        const sessionId = url.searchParams.get('session_id');
        if (typeof sessionId !== 'string' || sessionId === '') {
          return refuse(
            400,
            TARGET_REFUSAL.SESSION_ID_REQUIRED,
            '`session_id` query parameter is required',
            'add `?session_id=<the session the control belongs to>`',
          );
        }
        if (sessionId.length > MAX_SESSION_ID_LENGTH) {
          return refuse(
            400,
            TARGET_REFUSAL.SESSION_ID_TOO_LONG,
            `\`session_id\` must be at most ${MAX_SESSION_ID_LENGTH} characters, got ${sessionId.length}`,
            `send the id the host gave this session (a UUID is 36 characters)`,
          );
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
        return refuse(
          400,
          TARGET_REFUSAL.BODY_NOT_JSON,
          'body is not JSON',
          'send `{"session_id": "<id>", "machine_id": "<id>|null"}` as a JSON object',
        );
      }
      const parsed = parseSelectionWrite(body);
      if (!parsed.ok) {
        return refuse(400, parsed.reason_code, parsed.error, parsed.detail);
      }
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
        return refuse(
          503,
          TARGET_REFUSAL.FLEET_UNAVAILABLE,
          `the fleet could not be read, so no target was changed: ${fleet.error ?? 'unknown cause'}`,
          'bring the relay back (or fix `rabbitUrl`) and choose again; nothing was selected in the meantime',
        );
      }
      const machine = fleet.machines.find((entry) => entry.machine_id === machineId) ?? null;
      // A machine the relay does not list *at all* is refused in exactly the same breath as one it lists
      // as offline. The comment above always claimed this and the code did not do it: `machine === null`
      // fell through to `store.set`, so `{"machine_id":"NOT-A-MACHINE"}` was accepted with a 200 and a
      // selection the fleet could never honour. Dispatch re-validates, which is what bounded the impact
      // — but a control whose whole promise is "you cannot select what the fleet cannot run" has to
      // refuse the id it has never heard of too.
      if (machine === null) {
        return refuse(
          409,
          TARGET_REFUSAL.MACHINE_UNKNOWN,
          `${machineId} is not a machine this relay lists`,
          'pick a machine from the roster this route reports; if it has just paired, reload the list and '
            + 'choose it again',
        );
      }
      if (machine.online !== true) {
        return refuse(
          409,
          TARGET_REFUSAL.MACHINE_OFFLINE,
          `${machine.name ?? machineId} is listed as ${machine.state}, so it cannot be selected`,
          'the machine must be online: wait for its next heartbeat, or select another machine',
        );
      }
      deps.store.set(sessionId, {
        machine_id: machineId,
        machine_name: machine?.name ?? machineName,
      }, { selectedBy: identity.machine_name ?? cfg.machineName ?? null });
      return Response.json(await snapshot(sessionId, request.signal), { headers: noStore });
    },
  });

  status.mounted = true;
  status.reason = null;
}
