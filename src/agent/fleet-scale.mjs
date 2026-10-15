/**
 * Fleet scale: what this fleet can measure about itself, and what it cannot.
 *
 * ## What the ROADMAP refuses, and why this module agrees with it
 *
 * ROADMAP §6.4 reports 30–50 agents as the practical limit of current frameworks and describes superlinear
 * "coordination collapse" beyond 100. The roadmap's own conclusion is that **a design that has not been
 * measured at 50 cannot honestly specify 1,000**. This module does not specify 1,000. It computes what the
 * observations support and says where they stop supporting anything.
 *
 * ## The hard limit on this measurement, stated first because it bounds everything below
 *
 * **This fleet has five machines.** No amount of cleverness turns five into fifty, and the number that
 * matters for the ROADMAP's question — the agent count at which coordination collapses — is *exactly* the
 * number this fleet cannot observe. Every figure derived here is a measurement of **five**, and every
 * extrapolation is labelled as one. A module that quietly produced a "scaling curve" from five points would
 * be producing fiction with a decimal point on it.
 *
 * So the honest deliverable is narrower and still useful: the fleet's **own** coordination overhead and
 * failure rates, measured, with the extrapolation performed only where the arithmetic is defensible and
 * refused where it is not.
 *
 * ## What the fleet can actually answer
 *
 * `w2m_history` and `w2m_report` provide, per task: mode, every lease's state, its outcome, its exit code, and
 * the transport it used. That is enough to measure:
 *
 *   * **lease expiry rate** — the fraction of leases that never reported. This is the coordination failure
 *     that matters, because an expired lease is work that was assigned and silently did not happen.
 *   * **refusal rate** — leases the allow-list rejected. Not a failure of the fleet but of the request.
 *   * **transport mix** — relay versus direct. Every task carried by the relay while a direct path existed is
 *     avoidable latency, and this fleet has never once established a direct path.
 *   * **fan-out efficiency** — machines that participated against machines that were online.
 */

/** Lease states as the relay reports them, grouped by what they mean for the fleet. */
export const LEASE_MEANING = Object.freeze({
  done: 'work that happened',
  expired: 'work that was assigned and silently did not happen',
  refused: 'work the allow-list rejected -- a defect in the request, not the fleet',
  cancelled: 'work the operator stopped',
  observing: 'a machine that was told the outcome without being asked to act',
});

/** Outcomes that count as coordination failure, because the work did not happen. */
export const FAILURE_STATES = Object.freeze(['expired', 'timeout']);

/** Outcomes that are not the fleet's fault, so they are counted separately. */
export const REQUEST_FAULT_STATES = Object.freeze(['refused']);

/**
 * How a lease ended, told apart properly.
 *
 * ## The conflation this exists to prevent
 *
 * This session repeatedly read `exit_code: 70` as a failure and `lease_state: expired` as the same kind of
 * failure. **They are not the same kind of thing at all**, and the difference decides where a reader looks:
 *
 *   * `exit_code: 70` with `lease_state: done` means **the command ran and reported 70**. The fleet worked.
 *     The number is the command's answer, and the machine is fine.
 *   * `exit_code: null` with `lease_state: expired` means **no result was ever produced**. The command may not
 *     have started. Nothing is known about what it did, and the machine — or the lease, or the network — is
 *     where the fault is.
 *
 * Measured: twelve consecutive real reports showed **12 acting leases, 12 `done`, 0 expired** — while several
 * runs in the same session had produced no result at all. Both facts are true; they are different failures.
 * A rate that merged them would report a healthy fleet as broken, or a broken one as healthy, depending on
 * which it happened to count.
 */
export const LEASE_OUTCOME = Object.freeze({
  RAN: 'ran',                 // a result was produced, whatever it said
  NO_RESULT: 'no_result',     // nothing came back; the command's behaviour is unknown
  REFUSED: 'refused',         // the allow-list rejected it before it could run
  OBSERVED_ONLY: 'observed',  // the machine was told the outcome without being asked to act
  UNKNOWN: 'unknown',
});

/**
 * Classify one machine entry from a task report.
 *
 * `exit_code` is the decisive field, **not** the lease state: a lease can be `done` while its command
 * returned non-zero, and that is a successful execution of a failing command.
 */
export function classifyLease(entry) {
  if (entry === null || typeof entry !== 'object') return { outcome: LEASE_OUTCOME.UNKNOWN, ran: false, exit_code: null, detail: 'no machine entry' };
  const state = String(entry.lease_state ?? entry.outcome ?? '');
  const code = entry.exit_code;
  if (state === 'observing') return { outcome: LEASE_OUTCOME.OBSERVED_ONLY, ran: false, exit_code: null, detail: 'told the outcome, not asked to act' };
  if (state === 'refused') return { outcome: LEASE_OUTCOME.REFUSED, ran: false, exit_code: null, detail: entry.refusal_reason ?? 'refused' };
  if (state === 'done') {
    return {
      outcome: LEASE_OUTCOME.RAN,
      ran: true,
      exit_code: Number.isFinite(code) ? code : null,
      detail: Number.isFinite(code) && code !== 0
        ? `ran and reported ${code} -- the command's answer, not a fleet failure`
        : 'ran and reported success',
    };
  }
  if (state === 'expired' || state === 'timeout') {
    return { outcome: LEASE_OUTCOME.NO_RESULT, ran: false, exit_code: null, detail: 'no result was produced; what the command did is unknown' };
  }
  return { outcome: LEASE_OUTCOME.UNKNOWN, ran: false, exit_code: null, detail: `unrecognised lease state ${JSON.stringify(state)}` };
}

/**
 * Whether a non-zero exit code is a fleet failure. It is not, and this function exists so a caller does not
 * have to decide that for itself each time.
 */
export function isFleetFailure(entry) {
  return classifyLease(entry).outcome === LEASE_OUTCOME.NO_RESULT;
}

/** Refusal codes the relay writes into `p2p.reason`, grouped by what they mean for a fleet. */
export const P2P_FAILURE_KIND = Object.freeze({
  NO_CANDIDATES: 'no candidate address was known, so no punch was attempted',
  PUNCH_FAILED: 'a punch was attempted and did not complete',
  PUNCH_TIMEOUT: 'a punch was attempted and nothing answered in time',
  LEASE_NOT_RUNNABLE: 'the lease was not in a state to be handed the command',
  REVERSE_DIAL: 'the reverse dial did not complete',
  BLOCKED: 'a local condition stopped the direct path',
  OTHER: 'a reason the table does not classify',
});

/**
 * Classify one `p2p.reason` string.
 *
 * Reasons are prose with a machine-readable prefix (`P2P_NO_CANDIDATES: ...`), and reading them one at a time
 * is how a fleet's direct-path problem stays invisible: the sample that prompted this had **twelve of twelve
 * tasks on the relay** and no aggregate anywhere that said so.
 *
 * Returns `OTHER` for anything unrecognised rather than throwing or guessing, and the raw reason travels with
 * the classification so a new code is reported rather than swallowed.
 */
export function classifyP2PReason(reason) {
  if (typeof reason !== 'string' || reason === '') {
    return { kind: null, code: null, detail: 'no reason recorded, which is not the same as no failure' };
  }
  const code = (reason.split(':')[0] ?? '').trim();
  if (code === 'P2P_NO_CANDIDATES') return { kind: P2P_FAILURE_KIND.NO_CANDIDATES, code, detail: reason };
  if (code === 'P2P_PUNCH_FAILED') return { kind: P2P_FAILURE_KIND.PUNCH_FAILED, code, detail: reason };
  if (code === 'P2P_PUNCH_TIMEOUT') return { kind: P2P_FAILURE_KIND.PUNCH_TIMEOUT, code, detail: reason };
  if (code === 'P2P_LEASE_NOT_RUNNABLE') return { kind: P2P_FAILURE_KIND.LEASE_NOT_RUNNABLE, code, detail: reason };
  if (code.startsWith('P2P_REVERSE_DIAL')) return { kind: P2P_FAILURE_KIND.REVERSE_DIAL, code, detail: reason };
  if (code.startsWith('P2P_UNAVAILABLE') || code.startsWith('P2P_CRYPTO')) return { kind: P2P_FAILURE_KIND.BLOCKED, code, detail: reason };
  return { kind: P2P_FAILURE_KIND.OTHER, code, detail: reason };
}

/**
 * Count why the direct path was not used, across a set of reports.
 *
 * The number worth acting on is `relay_only_share`: the fraction of leases that travelled by relay while a
 * direct path was nominally configured. That is the fleet's avoidable latency, and it is invisible in any
 * single report.
 */
export function p2pReasons(reports) {
  const byCode = new Map();
  let leasesWithP2P = 0;
  let onRelay = 0;
  let onDirect = 0;
  for (const report of Array.isArray(reports) ? reports : []) {
    for (const m of Array.isArray(report?.machines) ? report.machines : []) {
      const p = m?.p2p;
      if (p === null || p === undefined || typeof p !== 'object') continue;
      leasesWithP2P += 1;
      if (p.encrypted === true || (p.peer !== null && p.peer !== undefined)) onDirect += 1;
      else onRelay += 1;
      const c = classifyP2PReason(p.reason ?? p.encryption_reason ?? null);
      if (c.code !== null) byCode.set(c.code, (byCode.get(c.code) ?? 0) + 1);
    }
  }
  return {
    leases_with_p2p: leasesWithP2P,
    on_relay: onRelay,
    on_direct: onDirect,
    // Null rather than 0 for an empty denominator, for the same reason every other rate here is: "no leases"
    // and "every lease failed" must not look alike.
    relay_only_share: leasesWithP2P === 0 ? null : Math.round((onRelay / leasesWithP2P) * 1000) / 1000,
    by_code: Object.fromEntries([...byCode].sort((a, b) => b[1] - a[1])),
    detail: leasesWithP2P === 0
      ? 'no lease carried a p2p block, so nothing can be said about the direct path'
      : `${onRelay} of ${leasesWithP2P} lease(s) used the relay; ${byCode.size} distinct reason code(s)`,
  };
}

/**
 * Summarise a set of task reports.
 *
 * @param {Array<{task_id?: string, mode?: string, counts?: object, machines?: Array<object>}>} reports
 * @returns {object} a summary whose every number is a count of something observed
 */
export function summarise(reports) {
  const tasks = Array.isArray(reports) ? reports.filter((r) => r !== null && typeof r === 'object') : [];
  const leases = { done: 0, expired: 0, refused: 0, cancelled: 0, observing: 0, other: 0 };
  const transports = { relay: 0, direct: 0, unknown: 0 };
  const p2p = { attempted: 0, delivered: 0 };
  let tasksWithAnySuccess = 0;
  let tasksWithAnyExpiry = 0;

  for (const task of tasks) {
    const machines = Array.isArray(task.machines) ? task.machines : [];
    let sawSuccess = false;
    let sawExpiry = false;
    for (const m of machines) {
      const state = String(m?.lease_state ?? m?.outcome ?? 'other');
      if (Object.prototype.hasOwnProperty.call(leases, state)) leases[state] += 1;
      else leases.other += 1;
      if (state === 'done' || m?.outcome === 'ok') sawSuccess = true;
      if (FAILURE_STATES.includes(state)) sawExpiry = true;
      // Transport is only meaningful for a lease that actually ran.
      const t = m?.transport;
      if (t === 'relay') transports.relay += 1;
      else if (t === 'direct') transports.direct += 1;
      else if (t !== undefined && t !== null) transports.unknown += 1;
      const p = m?.p2p;
      if (p !== undefined && p !== null) {
        p2p.attempted += 1;
        if (p.encrypted === true || p.peer !== null && p.peer !== undefined) p2p.delivered += 1;
      }
    }
    if (sawSuccess) tasksWithAnySuccess += 1;
    if (sawExpiry) tasksWithAnyExpiry += 1;
  }

  const acting = leases.done + leases.expired;
  const attempted = acting + leases.refused;
  return {
    tasks: tasks.length,
    leases: { ...leases },
    leases_total: Object.values(leases).reduce((a, b) => a + b, 0),
    acting_leases: acting,
    expiry_rate: acting === 0 ? null : Math.round((leases.expired / acting) * 1000) / 1000,
    refusal_rate: attempted === 0 ? null : Math.round((leases.refused / attempted) * 1000) / 1000,
    transports: { ...transports },
    direct_share: transports.relay + transports.direct === 0
      ? null
      : Math.round((transports.direct / (transports.relay + transports.direct)) * 1000) / 1000,
    p2p: { ...p2p, delivery_rate: p2p.attempted === 0 ? null : Math.round((p2p.delivered / p2p.attempted) * 1000) / 1000 },
    tasks_with_any_success: tasksWithAnySuccess,
    tasks_with_any_expiry: tasksWithAnyExpiry,
    // A rate over a denominator of zero is reported as null rather than as zero. "No leases were attempted" and
    // "every lease expired" are different facts and a zero would merge them.
    unmeasured: acting === 0 && attempted === 0,
  };
}

/**
 * The fleet's measured coordination overhead per acting agent.
 *
 * Defined against **acting** leases rather than all leases, because an `observing` machine is not doing work
 * and counting it would dilute the number with machines that were merely told what happened.
 *
 * @returns {{acting_leases: number, expired: number, overhead_per_agent: number|null, detail: string}}
 */
export function overhead(summary) {
  if (summary === null || typeof summary !== 'object' || summary.acting_leases === undefined) {
    return { acting_leases: 0, expired: 0, overhead_per_agent: null, detail: 'no summary supplied' };
  }
  const acting = summary.acting_leases;
  if (acting === 0) {
    return { acting_leases: 0, expired: summary.leases?.expired ?? 0, overhead_per_agent: null, detail: 'no acting leases: the overhead of zero agents is not zero, it is undefined' };
  }
  return {
    acting_leases: acting,
    expired: summary.leases?.expired ?? 0,
    overhead_per_agent: Math.round((summary.leases?.expired ?? 0) / acting * 1000) / 1000,
    detail: `${summary.leases?.expired ?? 0} of ${acting} acting lease(s) never reported`,
  };
}

/** The fleet size actually observed, and the honest statement of what that bounds. */
export function scaleOf(machineIds) {
  const distinct = [...new Set((Array.isArray(machineIds) ? machineIds : []).filter((x) => typeof x === 'string' && x !== ''))];
  return {
    observed_machines: distinct.length,
    // The ROADMAP's question is about the collapse point, which is beyond anything this can see.
    can_answer_collapse_point: false,
    detail: `this observation covers ${distinct.length} machine(s); the ROADMAP asks about the collapse point near 50, which is outside what ${distinct.length} can show`,
  };
}

/**
 * Extrapolate, or refuse to.
 *
 * The rule this encodes: an extrapolation is only offered when the observation covers **more than a tenth**
 * of the target, and even then it is labelled. The boundary is exclusive deliberately — a sample that is
 * *exactly* 10% is the borderline case, and the borderline case is the one where a refusal costs nothing and
 * an estimate costs credibility. Below the boundary the function returns `null` for the estimate with a
 * reason, because the alternative — a number produced by multiplying a small sample — is exactly the fiction
 * the ROADMAP refuses to write.
 *
 * @param {number} observed agents actually measured
 * @param {number} target agents the estimate would be about
 */
export function extrapolate(observed, target) {
  if (!Number.isFinite(observed) || !Number.isFinite(target) || observed <= 0 || target <= 0) {
    return { ok: false, estimate: null, detail: 'observed and target must both be positive numbers' };
  }
  const coverage = observed / target;
  if (coverage <= 0.1) {
    return {
      ok: false,
      estimate: null,
      coverage: Math.round(coverage * 1000) / 1000,
      detail: `refusing to extrapolate from ${observed} to ${target}: that is ${(coverage * 100).toFixed(2)}% coverage, and a number produced by scaling a sample that small is fiction with a decimal point on it`,
    };
  }
  return {
    ok: true,
    estimate: target,
    coverage: Math.round(coverage * 1000) / 1000,
    detail: `extrapolating from ${observed} to ${target} at ${(coverage * 100).toFixed(0)}% coverage -- reported as an extrapolation, never as a measurement`,
  };
}

/**
 * The one claim this fleet can make about a ceiling, stated as a falsifiable inequality.
 *
 * Not a predicted collapse point. It is: **at the largest fan-out this fleet has actually exercised, the
 * expiry rate was X**. That is measurable, it is falsifiable by re-running, and it is the only form of the
 * answer the data supports.
 */
export function ceilingFrom(summary, observedFanOut) {
  if (summary === null || typeof summary !== 'object' || !Number.isFinite(observedFanOut) || observedFanOut <= 0) {
    return { claim: null, detail: 'a ceiling claim needs a summary and the fan-out it was measured at' };
  }
  const rate = summary.expiry_rate;
  if (rate === null) {
    return { claim: null, detail: 'no acting leases, so no expiry rate to state' };
  }
  return {
    claim: `at a fan-out of ${observedFanOut}, the lease expiry rate was ${(rate * 100).toFixed(1)}%`,
    fan_out: observedFanOut,
    expiry_rate: rate,
    // Explicitly not a ceiling. Naming what it is not is the point of the function.
    is_a_ceiling: false,
    detail: 'this is an observation at one fan-out, not a collapse point; a ceiling would need the rate measured at several fan-outs and trending',
  };
}
