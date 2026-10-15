/**
 * Fleet state: what the relay's own accounting does and does not say, and the one place it disagrees with itself.
 *
 * ## The disagreement, measured
 *
 * Two relay endpoints answer "is this machine usable?" and they do not agree:
 *
 *   * `w2m_devices` reports every paired machine as `state: "online"` -- including two that had been silent
 *     for **61,384 seconds (about 17 hours)** at the time of measurement.
 *   * `w2m_stats` reports the same two as `online: false` with `offline_reason: "silent"`, and counts
 *     `online: 3` out of `devices: 5`.
 *
 * A caller that asked the first one would plan work for five machines and get three. **A fleet whose size is
 * reported two ways is a fleet whose plans are wrong by a factor of 1.7**, and the failure is silent because
 * both answers look authoritative.
 *
 * So this module prefers `w2m_stats` — it is the one that carries a *reason* — and treats a device listing
 * without a heartbeat age as **unverified rather than online**.
 *
 * ## The second disagreement, which is about history
 *
 * `w2m_history` lists, per task, a `lease_states` map. It is NOT the execution outcome: a task that expired
 * mid-run can show `done` afterwards, because the map records the *current* lease state rather than what
 * happened. Measured directly: of forty tasks in the sample, every one recorded macmini as `done`, while the
 * session's own result envelopes included several `expired` with no exit code at all.
 *
 * Extracting the outcome requires `w2m_report`, which is a request per task. **A history listing is therefore
 * a poor input for a reliability measurement, and using it as one would have produced a fleet that looked
 * perfectly reliable** — the most dangerous possible error in a module whose purpose is to notice trouble.
 */

/** How a machine's usability was determined, in descending order of trust. */
export const EVIDENCE = Object.freeze({
  HEARTBEAT_WITH_RTT: 'a live heartbeat and a measured round trip',
  HEARTBEAT_ALONE: 'a live heartbeat with no round trip measured',
  STALE_OR_ABSENT: 'no recent heartbeat',
  UNKNOWN: 'the relay did not say',
});

/**
 * Classify one machine from a `w2m_stats` entry.
 *
 * `silent_ms` is the decisive field. A machine that is "online" but silent is not online, and the reason is
 * reported alongside so a caller can distinguish "went away" from "never arrived".
 */
export function classifyMachine(entry) {
  if (entry === null || typeof entry !== 'object' || typeof entry.machine_id !== 'string') {
    return { machine_id: null, usable: false, evidence: EVIDENCE.UNKNOWN, reason: 'no machine entry', detail: 'the relay did not describe this machine' };
  }
  const online = entry.online === true;
  const rtt = entry.rtt_ms;
  const stale = entry.rtt_stale === true;
  if (online && !stale && Number.isFinite(rtt)) {
    return { machine_id: entry.machine_id, name: entry.machine_name ?? null, usable: true, evidence: EVIDENCE.HEARTBEAT_WITH_RTT, rtt_ms: rtt, reason: null, detail: `live, ${rtt} ms` };
  }
  if (online && !stale) {
    return { machine_id: entry.machine_id, name: entry.machine_name ?? null, usable: true, evidence: EVIDENCE.HEARTBEAT_ALONE, rtt_ms: null, reason: null, detail: 'live, round trip not measured' };
  }
  return {
    machine_id: entry.machine_id,
    name: entry.machine_name ?? null,
    usable: false,
    evidence: EVIDENCE.STALE_OR_ABSENT,
    rtt_ms: Number.isFinite(rtt) && !stale ? rtt : null,
    reason: entry.offline_reason ?? 'not online',
    silent_ms: Number.isFinite(entry.silent_ms) ? entry.silent_ms : null,
    detail: entry.offline_reason === 'silent'
      ? `silent for ${Math.round((entry.silent_ms ?? 0) / 1000)}s`
      : String(entry.offline_reason ?? 'not online'),
  };
}

/**
 * Read a `w2m_stats` payload.
 *
 * @returns {{
 *   paired: number, online: number, usable: number, silent: Array<object>,
 *   usable_machines: Array<object>, detail: string
 * }}
 */
export function readStats(stats) {
  const machines = Array.isArray(stats?.machines) ? stats.machines : [];
  const classified = machines.map(classifyMachine);
  const paired = Number.isFinite(stats?.counts?.devices) ? stats.counts.devices : machines.length;
  const usable = classified.filter((m) => m.usable);
  const silent = classified.filter((m) => !m.usable);
  // The number a caller should plan against is the number of machines that can actually run something.
  return {
    paired,
    online: Number.isFinite(stats?.counts?.online) ? stats.counts.online : usable.length,
    usable: usable.length,
    usable_machines: usable,
    silent,
    runner_up_rtt_ms: usable.filter((m) => Number.isFinite(m.rtt_ms)).sort((a, b) => a.rtt_ms - b.rtt_ms)[0]?.rtt_ms ?? null,
    detail: `${usable.length} of ${paired} paired machine(s) can run work`,
  };
}

/**
 * Compare a device listing against the stats reading, and report every machine they disagree about.
 *
 * **The disagreement is the product.** A caller that saw only the device listing would believe the fleet is
 * larger than it is; a caller that saw only the stats would not know the listing claimed otherwise. Reporting
 * the gap makes the gap fixable, and until it is fixed the smaller number is the true one.
 */
export function reconcile(devices, stats) {
  const listed = Array.isArray(devices?.devices) ? devices.devices : [];
  const reading = readStats(stats);
  const usableIds = new Set(reading.usable_machines.map((m) => m.machine_id));
  const claimedOnline = listed.filter((d) => d?.state === 'online');
  const disagreements = claimedOnline
    .filter((d) => !usableIds.has(d.machine_id))
    .map((d) => {
      const m = reading.silent.find((s) => s.machine_id === d.machine_id);
      return {
        machine_id: d.machine_id,
        name: d.name ?? null,
        devices_says: 'online',
        stats_says: m?.reason ?? 'not usable',
        silent_ms: m?.silent_ms ?? null,
      };
    });
  return {
    devices_claims_online: claimedOnline.length,
    stats_says_usable: reading.usable,
    disagreements,
    // The trust decision, stated as a field rather than left to the reader.
    trust: 'stats',
    reason: disagreements.length === 0
      ? 'the two endpoints agree'
      : `a device listing reports a machine as online when it has not been heard from; the stats reading carries a reason and is the one to plan against`,
    detail: `${claimedOnline.length} claimed online, ${reading.usable} usable, ${disagreements.length} disagreement(s)`,
  };
}

/**
 * Whether a `w2m_history` payload can be used as a reliability measurement.
 *
 * It cannot, and this function exists so that conclusion is a checked fact rather than a comment. Every entry
 * in the sample recorded the same state for the same machine, which is exactly what a current-state map looks
 * like and exactly what an outcome record does not.
 *
 * @returns {{usable_as_outcome_record: boolean, reason: string, homogeneous: Array<string>}}
 */
export function historyIsOutcomeRecord(history) {
  const tasks = Array.isArray(history?.tasks) ? history.tasks : [];
  if (tasks.length === 0) {
    return { usable_as_outcome_record: false, reason: 'no tasks in the sample', homogeneous: [] };
  }
  // Per machine, how many distinct states appear across tasks. A machine at "done" in every task, including
  // tasks that expired, is a current-state map rather than a record of what happened.
  const states = new Map();
  for (const task of tasks) {
    for (const [id, state] of Object.entries(task?.lease_states ?? {})) {
      if (!states.has(id)) states.set(id, new Set());
      states.get(id).add(String(state));
    }
  }
  const homogeneous = [...states.entries()].filter(([, set]) => set.size === 1).map(([id]) => id);
  return {
    usable_as_outcome_record: false,
    homogeneous,
    reason: homogeneous.length === states.size && states.size > 0
      ? `every one of the ${states.size} machine(s) holds a single state across ${tasks.length} task(s) -- a current-state map, not an outcome record; use w2m_report per task instead`
      : `a lease_states map reports the current state, not what happened; use w2m_report per task instead`,
  };
}
