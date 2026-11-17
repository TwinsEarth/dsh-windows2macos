/**
 * v3.5.0 fleet version governance: the minimum supported plugin version, its comparator, the
 * pre-dispatch gate, and the drift data a dashboard renders.
 *
 * ## Why the gate lives here and not in the relay
 *
 * The relay sees the roster anyway, but it is the *wrong* authority for this decision: it does not
 * know what a mixed fleet means for the command being dispatched, and a relay-side refusal cannot
 * name the remedy in the caller's own vocabulary ("upgrade these machines, or pass
 * `allowOutdated: true`"). The dispatch already reads `GET /v1/devices` for the composer's narrowed-
 * target revalidation, so this module is a pure decision over data the dispatch path owns.
 *
 * ## The three rules, in one place
 *
 * 1. **Below the minimum is a refusal, not a warning.** A machine running older plugin code may not
 *    implement the protocol fields a new dispatch relies on; letting it run and then reporting a
 *    divergence is how a fleet produces confident wrong answers.
 * 2. **An unreadable version is not a pass.** A machine that does not advertise `caps.plugin_version`
 *    (an agent older than the field, or a relay that dropped caps) is *unknown*, and unknown is
 *    refused for the same reason as outdated — with its own per-machine reason code so the operator
 *    can tell "upgrade it" from "pair it with an agent that reports its version".
 * 3. **`allowOutdated: true` is an audited override.** It proceeds, reports exactly which machines
 *    were waved through, and leaves an audit record in the dispatch result and the log. A refusal
 *    that can be bypassed silently is not a gate; an override that cannot be seen afterwards is not
 *    consent.
 *
 * ## When the gate is active
 *
 * The minimum is `3.5.0`, and the gate **takes effect on a build that is at least that version**.
 * A 3.4.x build does not enforce it for two reasons that are worth writing down:
 *
 *  - a 3.4.x release predates the minimum, so it cannot be asked to enforce a contract it does not
 *    know about (this source tree still carries version 3.4.5 while the release is prepared; the
 *    gate is wired and tested through `W2M_PLUGIN_VERSION`, the same override the updater uses);
 *  - "the tool that enforces X must itself speak X" is the invariant that keeps an emergency
 *    downgrade from turning into a fleet-wide refusal loop.
 *
 * The activation decision is exported (`isVersionGateActive`) and returned in every decision as
 * `active`, so a caller can never mistake "nothing was checked" for "everything was fine".
 *
 * Everything here is pure: no filesystem, no network, no clock beyond an injected `now`.
 */

/**
 * The oldest plugin version the fleet accepts dispatch targets from.
 *
 * One constant, referenced by the gate, the devices dashboard and the docs. Bumping it is a fleet
 * policy change, not a code detail: it is what makes old machines fail by name instead of failing
 * later in a comparison nobody can act on.
 */
export const MIN_SUPPORTED_PLUGIN_VERSION = '3.5.0';

/** Stable reason codes for this gate. A caller matches on these, never on a message. */
export const VERSION_GATE_CODES = Object.freeze({
  /**
   * At least one machine the dispatch would use is below the fleet minimum (or reports a version
   * that cannot be read). The overall refusal code; per-machine reasons are more specific.
   */
  MACHINE_VERSION_UNSUPPORTED: 'MACHINE_VERSION_UNSUPPORTED',
  /** The machine advertised a version, and it is below the minimum. */
  MACHINE_VERSION_OUTDATED: 'MACHINE_VERSION_OUTDATED',
  /** The machine advertised no version this build can read (missing caps, empty, or malformed). */
  MACHINE_VERSION_UNKNOWN: 'MACHINE_VERSION_UNKNOWN',
});

/**
 * `x.y.z`, an optional `-prerelease` and an optional `+build`, with an optional leading `v`.
 *
 * Deliberately a little lenient where semver is strict (leading zeros in numeric identifiers are
 * accepted): the input is a machine advertisement, and a version string that differs from strict
 * semver only in that way still orders correctly. It is deliberately strict where leniency would
 * hide a real problem: a missing component, a non-numeric core, or an empty prerelease identifier
 * is *unreadable*, which the gate refuses rather than guessing.
 */
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Parse one advertised version.
 *
 * @param {unknown} value
 * @returns {{ok: true, raw: string, major: number, minor: number, patch: number,
 *            prerelease: string[]|null, normalized: string}
 *   | {ok: false, code: string, detail: string}}
 */
export function parsePluginVersion(value) {
  if (typeof value !== 'string') {
    return { ok: false, code: VERSION_GATE_CODES.MACHINE_VERSION_UNKNOWN, detail: `a version must be a string, got ${value === null ? 'null' : typeof value}` };
  }
  const raw = value.trim();
  if (raw === '') {
    return { ok: false, code: VERSION_GATE_CODES.MACHINE_VERSION_UNKNOWN, detail: 'the advertised version is empty' };
  }
  const match = VERSION_RE.exec(raw);
  if (match === null) {
    return { ok: false, code: VERSION_GATE_CODES.MACHINE_VERSION_UNKNOWN, detail: `the advertised version ${JSON.stringify(raw)} is not x.y.z with an optional prerelease` };
  }
  const [, major, minor, patch, prerelease = null] = match;
  return {
    ok: true,
    raw,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === null ? null : prerelease.split('.'),
    normalized: `${Number(major)}.${Number(minor)}.${Number(patch)}${prerelease === null ? '' : `-${prerelease}`}`,
  };
}

/** Compare two prerelease identifier lists: numeric identifiers numerically, others lexically. */
function comparePrerelease(a, b) {
  // No prerelease sorts *after* any prerelease: 3.5.0 > 3.5.0-beta.1, per semver §11.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    // A shorter list has lower precedence when all preceding identifiers are equal.
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Order two advertised versions.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {-1|0|1|null} `null` when either side is unreadable. **Never a guessed 0**: treating an
 *   unparseable version as equal would make it pass a `>= minimum` test, which is the one wrong
 *   answer this function exists to prevent.
 */
export function comparePluginVersions(left, right) {
  const a = parsePluginVersion(left);
  const b = parsePluginVersion(right);
  if (a.ok !== true || b.ok !== true) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Is `version` at least `minimum`?
 *
 * @param {unknown} version
 * @param {string} [minimum]
 * @returns {boolean|null} `null` when either side is unreadable -- the caller decides whether
 *   "unknown" refuses (the dispatch gate does) or is merely reported.
 */
export function isPluginVersionAtLeast(version, minimum = MIN_SUPPORTED_PLUGIN_VERSION) {
  const compared = comparePluginVersions(version, minimum);
  return compared === null ? null : compared >= 0;
}

/**
 * The activation rule: a build enforces the minimum only once it is itself at least that old.
 *
 * @param {unknown} runningVersion This build's own version (`resolveCurrentVersion(...)`), or a
 *   source-checkout placeholder resolved to `null`.
 * @param {string} [minimum]
 * @returns {boolean}
 */
export function isVersionGateActive(runningVersion, minimum = MIN_SUPPORTED_PLUGIN_VERSION) {
  const compared = comparePluginVersions(runningVersion, minimum);
  return compared !== null && compared >= 0;
}

/**
 * Decide whether a dispatch may proceed, given the machines it would use.
 *
 * @param {object} input
 * @param {Array<{machine_id: string, name?: string|null, version?: unknown}>} input.machines The
 *   **online** machines the dispatch can reach: a machine that cannot run this task does not block
 *   it (an offline machine is gated on the dispatch that brings it back).
 * @param {string[]|Set<string>|null} [input.targetIds] When the dispatch is narrowed (composer
 *   selection, named executor, named assignee), the ids it is narrowed to. `null`/absent means the
 *   dispatch may use every machine in `machines`.
 * @param {string} [input.supportedMin]
 * @param {unknown} [input.runningVersion] This build's own version; drives {@link isVersionGateActive}.
 * @param {boolean} [input.allowOutdated] The explicit, audited override.
 * @returns {{
 *   ok: boolean, active: boolean, supported_min: string, checked: number, allow_outdated: boolean,
 *   outdated: Array<{machine_id: string, version: string, name: string|null}>,
 *   unknown: Array<{machine_id: string, name: string|null}>,
 *   outdated_allowed: Array<{machine_id: string|null, version: string|null, name: string|null, reason_code: string}>,
 *   reason_code: string|null,
 *   detail: object|null,
 * }}
 */
export function evaluateVersionGate(input = {}) {
  const supportedMin = typeof input.supportedMin === 'string' ? input.supportedMin : MIN_SUPPORTED_PLUGIN_VERSION;
  const allowOutdated = input.allowOutdated === true;
  const active = isVersionGateActive(input.runningVersion, supportedMin);
  const machines = Array.isArray(input.machines) ? input.machines : [];
  const targetIds = input.targetIds instanceof Set
    ? input.targetIds
    : (Array.isArray(input.targetIds) ? new Set(input.targetIds) : null);

  const selected = targetIds === null
    ? machines
    : machines.filter((machine) => machine !== null && typeof machine === 'object' && targetIds.has(machine.machine_id));

  const outdated = [];
  const unknown = [];
  for (const machine of selected) {
    const machineId = typeof machine?.machine_id === 'string' && machine.machine_id !== '' ? machine.machine_id : null;
    const name = typeof machine?.name === 'string' && machine.name !== '' ? machine.name : null;
    // A machine with no id cannot be named in a refusal and cannot be dispatched to either; the
    // relay's own validation owns that defect. Skipping it here is honesty, not leniency.
    if (machineId === null) continue;
    const parsed = parsePluginVersion(machine?.version);
    if (parsed.ok !== true) {
      unknown.push({ machine_id: machineId, name });
      continue;
    }
    const order = comparePluginVersions(parsed.raw, supportedMin);
    if (order !== null && order < 0) outdated.push({ machine_id: machineId, version: parsed.raw, name });
  }

  const problems = [...outdated, ...unknown];
  const allowed = allowOutdated && problems.length > 0
    ? problems.map((machine) => ({
        machine_id: machine.machine_id,
        version: typeof machine.version === 'string' ? machine.version : null,
        name: machine.name ?? null,
        // The per-machine reason survives the override: the audit record has to say *why* a machine
        // needed the override, not only that one was given.
        reason_code: typeof machine.version === 'string' && machine.version !== '' && outdated.some((row) => row.machine_id === machine.machine_id)
          ? VERSION_GATE_CODES.MACHINE_VERSION_OUTDATED
          : VERSION_GATE_CODES.MACHINE_VERSION_UNKNOWN,
      }))
    : [];

  if (problems.length === 0) {
    return {
      ok: true,
      active,
      supported_min: supportedMin,
      checked: selected.length,
      allow_outdated: false,
      outdated: [],
      unknown: [],
      outdated_allowed: [],
      reason_code: null,
      detail: null,
    };
  }

  // Inactive builds proceed but still report what they would have found: the drift is real even
  // when this build cannot refuse for it.
  if (!active || allowOutdated) {
    return {
      ok: true,
      active,
      supported_min: supportedMin,
      checked: selected.length,
      allow_outdated: allowOutdated,
      outdated,
      unknown,
      outdated_allowed: allowed,
      reason_code: null,
      detail: null,
    };
  }

  const names = [
    ...outdated.map((machine) => `${machine.machine_id} ${machine.version === undefined ? '' : `(${machine.version})`} below ${supportedMin}`.trim()),
    ...unknown.map((machine) => `${machine.machine_id} (version unreadable)`),
  ];
  return {
    ok: false,
    active,
    supported_min: supportedMin,
    checked: selected.length,
    allow_outdated: false,
    outdated,
    unknown,
    outdated_allowed: [],
    reason_code: VERSION_GATE_CODES.MACHINE_VERSION_UNSUPPORTED,
    detail: {
      supported_min: supportedMin,
      machines: [
        ...outdated.map((machine) => ({ machine_id: machine.machine_id, name: machine.name, version: machine.version, reason_code: VERSION_GATE_CODES.MACHINE_VERSION_OUTDATED })),
        ...unknown.map((machine) => ({ machine_id: machine.machine_id, name: machine.name, version: null, reason_code: VERSION_GATE_CODES.MACHINE_VERSION_UNKNOWN })),
      ],
      outdated,
      unknown,
      summary: names.join('; '),
    },
  };
}

/**
 * The drift block a dashboard renders: one distribution plus the names behind the two bad halves.
 *
 * Pure, so the panel (or a route, or a test) reuses one rule. `records` is the relay's device
 * registry (`GET /v1/devices`'s `devices`), not this module's projection, because the dashboard is
 * about the fleet the relay holds rather than about "machines a dispatch would pick right now".
 *
 * `all_current` is `true` for an empty roster (vacuously: no machine is behind). A caller that also
 * knows the roster was read successfully should gate on that separately -- `w2m_devices` throws when
 * it was not, and `buildUiState` flips the flag off for an unreadable fleet.
 *
 * Machines without a usable `machine_id` are left out of `outdated`/`unknown` (they cannot be
 * named), but they are still not counted as current: the distribution only includes readable
 * versions, and `all_current` requires both bad lists to be empty.
 *
 * @param {Array<object>|null|undefined} records Relay device records.
 * @param {{supportedMin?: string}} [options]
 * @returns {{supported_min: string, distribution: Record<string, number>,
 *   outdated: Array<{machine_id: string, version: string}>,
 *   unknown: Array<{machine_id: string}>, all_current: boolean}}
 */
export function summarizeVersionDashboard(records, options = {}) {
  const supportedMin = typeof options.supportedMin === 'string' ? options.supportedMin : MIN_SUPPORTED_PLUGIN_VERSION;
  const distribution = {};
  const outdated = [];
  const unknown = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (record === null || typeof record !== 'object') continue;
    const machineId = typeof record.machine_id === 'string' && record.machine_id !== '' ? record.machine_id : null;
    const parsed = parsePluginVersion(record?.caps?.plugin_version);
    if (parsed.ok !== true) {
      if (machineId !== null) unknown.push({ machine_id: machineId });
      continue;
    }
    distribution[parsed.raw] = (distribution[parsed.raw] ?? 0) + 1;
    if (comparePluginVersions(parsed.raw, supportedMin) < 0 && machineId !== null) {
      outdated.push({ machine_id: machineId, version: parsed.raw });
    }
  }
  // Stable key order across machines/insertion order differences, so two identical fleets render
  // the same dashboard: newest first, using the same comparator the gate uses.
  const ordered = Object.fromEntries(
    Object.keys(distribution)
      .sort((a, b) => {
        const compared = comparePluginVersions(b, a);
        return compared === null ? a.localeCompare(b) : compared;
      })
      .map((version) => [version, distribution[version]]),
  );
  return {
    supported_min: supportedMin,
    distribution: ordered,
    outdated,
    unknown,
    all_current: outdated.length === 0 && unknown.length === 0,
  };
}
